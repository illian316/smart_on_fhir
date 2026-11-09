import Fastify, { type FastifyInstance } from 'fastify'
import { createLocalJWKSet, decodeProtectedHeader, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { buildApp } from '../src/app.ts'
import type { Config } from '../src/config.ts'
import { generateKey } from '../src/generate-key.ts'

const CLIENT_ID = 'smoke-client'
const ACCESS_TOKEN = 'synthetic-access-token'
const SCOPES = 'openid fhirUser launch patient/Patient.r'
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
const MAX_ASSERTION_LIFETIME_SECONDS = 120

interface RecordedAssertion {
    header: ReturnType<typeof decodeProtectedHeader>
    jti?: string
    lifetime: number
}

interface LaunchResult {
    authorizeUrl: URL
    cookies: { smart_launch: string }
    callback: string
    state: string
}

interface Harness {
    app: FastifyInstance
    config: Config
    launch: () => Promise<LaunchResult>
    assertions: RecordedAssertion[]
}

async function setup(t: TestContext, idTokenAudience = CLIENT_ID): Promise<Harness> {
    const mock = Fastify()
    const signing = await generateKeyPair('RS256')
    const challenges = new Map<string, string>()
    const assertions: RecordedAssertion[] = []

    const directory = await mkdtemp(join(tmpdir(), 'smart-pkjwt-test-'))
    const privateJwkPath = join(directory, 'private.jwk.json')
    const { publicJwkSet } = await generateKey(privateJwkPath)
    const clientKeys = createLocalJWKSet(publicJwkSet as Parameters<typeof createLocalJWKSet>[0])

    function origin(): string {
        return `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`
    }

    mock.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) =>
        done(null, new URLSearchParams(String(body))),
    )

    mock.get('/fhir/.well-known/smart-configuration', async () => ({
        issuer: `${origin()}/oidc`,
        authorization_endpoint: `${origin()}/oidc/authorize`,
        token_endpoint: `${origin()}/oidc/token`,
        jwks_uri: `${origin()}/oidc/jwks`,
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code'],
    }))

    mock.get<{ Querystring: Record<string, string> }>('/oidc/authorize', async (request, reply) => {
        const code = `code-${challenges.size + 1}`
        challenges.set(code, request.query.code_challenge!)

        const callbackQuery = new URLSearchParams({ code, state: request.query.state! })

        return reply.redirect(`${request.query.redirect_uri}?${callbackQuery}`)
    })

    mock.post<{ Body: URLSearchParams }>('/oidc/token', async (request, reply) => {
        const body = request.body
        const assertion = body.get('client_assertion') ?? ''

        const { payload } = await jwtVerify(assertion, clientKeys, {
            issuer: CLIENT_ID,
            subject: CLIENT_ID,
            audience: `${origin()}/oidc/token`,
            algorithms: ['RS384'],
            requiredClaims: ['exp', 'iat', 'jti'],
        })

        assertions.push({
            header: decodeProtectedHeader(assertion),
            jti: payload.jti,
            lifetime: payload.exp! - payload.iat!,
        })

        const code = body.get('code') ?? ''
        const verifier = body.get('code_verifier') ?? ''
        const challenge = challenges.get(code)
        challenges.delete(code)

        const hasValidAssertionType = body.get('client_assertion_type') === CLIENT_ASSERTION_TYPE
        const hasValidProof =
            challenge !== undefined && createHash('sha256').update(verifier).digest('base64url') === challenge

        if (!hasValidAssertionType || !hasValidProof) {
            return reply.code(400).send({ error: 'invalid_grant' })
        }

        return {
            access_token: ACCESS_TOKEN,
            token_type: 'Bearer',
            expires_in: 300,
            scope: SCOPES,
            patient: 'p1',
            encounter: 'e1',
            id_token: await new SignJWT({ fhirUser: 'Practitioner/h1' })
                .setProtectedHeader({ alg: 'RS256' })
                .setIssuer(`${origin()}/oidc`)
                .setAudience(idTokenAudience)
                .setSubject('h1')
                .setIssuedAt()
                .setExpirationTime('5m')
                .sign(signing.privateKey),
        }
    })

    mock.get('/oidc/jwks', async () => ({ keys: [await exportJWK(signing.publicKey)] }))

    mock.get('/fhir/Patient/p1', async (request, reply) => {
        if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
            return reply.code(401).send({})
        }

        return { resourceType: 'Patient', id: 'p1', name: [{ given: ['Smoke'], family: '<Patient>' }] }
    })

    await mock.listen({ port: 0, host: '127.0.0.1' })

    const config: Config = {
        port: 3100,
        fhirBase: `${origin()}/fhir`,
        issuer: `${origin()}/oidc`,
        clientId: CLIENT_ID,
        redirectUri: 'http://localhost:3100/callback',
        scopes: SCOPES,
        privateJwkPath,
    }
    const app = await buildApp(config)

    t.after(async () => {
        await app.close()
        await mock.close()
        await rm(directory, { recursive: true, force: true })
    })

    async function launch(): Promise<LaunchResult> {
        const started = await app.inject({
            url: `/launch?${new URLSearchParams({ iss: config.fhirBase, launch: 'L1' })}`,
        })

        assert.equal(started.statusCode, 302)

        const authorizeUrl = new URL(started.headers.location as string)
        const cookies = { smart_launch: started.cookies.find((c) => c.name === 'smart_launch')!.value }

        const authorized = await fetch(authorizeUrl, { redirect: 'manual' })
        const callback = new URL(authorized.headers.get('location')!)

        return {
            authorizeUrl,
            cookies,
            callback: `/callback${callback.search}`,
            state: callback.searchParams.get('state')!,
        }
    }

    return { app, config, launch, assertions }
}

test('launch, callback and Patient page', async (t) => {
    const { app, config, launch, assertions } = await setup(t)
    const { authorizeUrl, cookies, callback } = await launch()
    const params = authorizeUrl.searchParams

    assert.equal(params.get('aud'), config.fhirBase)
    assert.equal(params.get('launch'), 'L1')
    assert.equal(params.get('redirect_uri'), config.redirectUri)
    assert.equal(params.get('code_challenge_method'), 'S256')
    assert.ok(params.get('state') && params.get('code_challenge'))

    const finished = await app.inject({ url: callback, cookies })

    assert.equal(finished.statusCode, 302)
    assert.equal(assertions.length, 1)
    assert.equal(assertions[0]!.header.alg, 'RS384')
    assert.equal(assertions[0]!.header.typ, 'JWT')
    assert.ok(assertions[0]!.header.kid)
    assert.ok(assertions[0]!.lifetime <= MAX_ASSERTION_LIFETIME_SECONDS)

    const sessionCookie = finished.cookies.find((c) => c.name === 'smart_session')!
    const home = await app.inject({ url: '/', cookies: { smart_session: sessionCookie.value } })

    assert.equal(home.statusCode, 200)
    assert.match(home.body, /Smoke &lt;Patient&gt;/)
    assert.match(home.body, /Practitioner\/h1/)

    const replayed = await app.inject({ url: callback, cookies })

    assert.equal(replayed.statusCode, 400)
    assert.equal(assertions.length, 1)
})

test('rejects bad state and foreign iss', async (t) => {
    const { app, launch, assertions } = await setup(t)
    const { cookies, callback, state } = await launch()

    const tampered = await app.inject({ url: callback.replace(state, 'wrong'), cookies })

    assert.equal(tampered.statusCode, 400)
    assert.equal(assertions.length, 0)

    const foreign = await app.inject({ url: '/launch?iss=https://untrusted.invalid/fhir&launch=L1' })

    assert.equal(foreign.statusCode, 400)
})

test('rejects an ID token issued for another client', async (t) => {
    const { app, launch } = await setup(t, 'someone-else')
    const { cookies, callback } = await launch()

    const finished = await app.inject({ url: callback, cookies })

    assert.equal(finished.statusCode, 502)
    assert.equal(
        finished.cookies.find((c) => c.name === 'smart_session'),
        undefined,
    )
})
