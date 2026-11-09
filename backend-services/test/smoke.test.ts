import Fastify, { type FastifyInstance } from 'fastify'
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { buildApp } from '../src/app.ts'
import type { Config } from '../src/config.ts'
import { generateKey } from '../src/generate-key.ts'

const CLIENT_ID = 'smoke-backend'
const PATIENT_IDENTIFIER = 'urn:oid:2.16.578.1.12.4.1.4.1|synthetic'
const SCOPES = 'system/Patient.rs'
const DEFAULT_EXPIRES_IN_SECONDS = 300

interface IssuedToken {
    header: ReturnType<typeof decodeProtectedHeader>
    scope: string | null
}

interface Harness {
    app: FastifyInstance
    tokens: IssuedToken[]
}

async function setup(t: TestContext, expiresIn = DEFAULT_EXPIRES_IN_SECONDS): Promise<Harness> {
    const mock = Fastify()
    const tokens: IssuedToken[] = []

    const directory = await mkdtemp(join(tmpdir(), 'smart-backend-test-'))
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
        token_endpoint: `${origin()}/oidc/token`,
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        grant_types_supported: ['client_credentials'],
    }))

    mock.post<{ Body: URLSearchParams }>('/oidc/token', async (request, reply) => {
        const assertion = request.body.get('client_assertion') ?? ''

        await jwtVerify(assertion, clientKeys, {
            issuer: CLIENT_ID,
            subject: CLIENT_ID,
            audience: `${origin()}/oidc/token`,
            algorithms: ['RS384'],
            requiredClaims: ['exp', 'iat', 'jti'],
        })

        if (request.body.get('grant_type') !== 'client_credentials') {
            return reply.code(400).send({ error: 'unsupported_grant_type' })
        }

        tokens.push({ header: decodeProtectedHeader(assertion), scope: request.body.get('scope') })

        return {
            access_token: `synthetic-token-${tokens.length}`,
            token_type: 'Bearer',
            expires_in: expiresIn,
            scope: SCOPES,
        }
    })

    mock.get<{ Querystring: Record<string, string> }>('/fhir/Patient', async (request, reply) => {
        const hasBearerToken = request.headers.authorization?.startsWith('Bearer ')
        const isExpectedSearch = request.query.identifier === PATIENT_IDENTIFIER

        if (!hasBearerToken || !isExpectedSearch) {
            return reply.code(401).send({})
        }

        const patient = { resourceType: 'Patient', id: 'p1', name: [{ given: ['Smoke'], family: '<Patient>' }] }

        return { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: patient }] }
    })

    await mock.listen({ port: 0, host: '127.0.0.1' })

    const config: Config = {
        port: 3100,
        fhirBase: `${origin()}/fhir`,
        issuer: `${origin()}/oidc`,
        clientId: CLIENT_ID,
        scopes: SCOPES,
        privateJwkPath,
        patientIdentifier: PATIENT_IDENTIFIER,
    }
    const app = await buildApp(config)

    t.after(async () => {
        await app.close()
        await mock.close()
        await rm(directory, { recursive: true, force: true })
    })

    return { app, tokens }
}

test('signs an assertion, gets a system token and searches Patient', async (t) => {
    const { app, tokens } = await setup(t)

    const result = await app.inject({ url: '/' })

    assert.equal(result.statusCode, 200)
    assert.match(result.body, /Smoke &lt;Patient&gt;/)
    assert.equal(tokens.length, 1)
    assert.equal(tokens[0]!.header.alg, 'RS384')
    assert.equal(tokens[0]!.header.typ, 'JWT')
    assert.ok(tokens[0]!.header.kid)
    assert.equal(tokens[0]!.scope, SCOPES)
})

test('reuses the token until it is near expiry', async (t) => {
    const { app, tokens } = await setup(t)

    await app.inject({ url: '/' })
    await app.inject({ url: '/' })

    assert.equal(tokens.length, 1)

    const expiring = await setup(t, 20)

    await expiring.app.inject({ url: '/' })
    await expiring.app.inject({ url: '/' })

    assert.equal(expiring.tokens.length, 2)
})

test('caps a long token lifetime at five minutes', async (t) => {
    const { app, tokens } = await setup(t, 86400)

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })

    await app.inject({ url: '/' })
    t.mock.timers.tick(269_000)
    await app.inject({ url: '/' })

    assert.equal(tokens.length, 1)

    t.mock.timers.tick(2_000)
    await app.inject({ url: '/' })

    assert.equal(tokens.length, 2)
})
