import type { FastifyInstance } from 'fastify'
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'

import { buildApp } from '../src/app.ts'
import { steps, type Steps } from '../src/steps.ts'

import { callbackPath, completeBrowserLaunch, signIn, startBrowserLaunch } from './browser.ts'
import { fixture, type Fixture } from './fixture.ts'

// These tests use buildApp with its default steps (the solutions in src/steps.ts), not reference mode.
async function start(
    t: TestContext,
    override?: (f: Fixture) => Partial<Steps>,
): Promise<{ f: Fixture; app: FastifyInstance }> {
    const f = await fixture()
    t.after(f.close)

    const app = await buildApp(f.config, false, override && { ...steps, ...override(f) })
    t.after(async () => app.close())

    return { f, app }
}

function fhirPaths(f: Fixture): string[] {
    return f.requests
        .filter((r) => r.path.startsWith('/fhir/') && !r.path.includes('.well-known'))
        .map((r) => r.path)
        .sort()
}

async function signedIdentity(f: Fixture, claims: Record<string, unknown>): Promise<string> {
    const nowSeconds = Math.floor(Date.now() / 1000)

    return f.signIdentity({
        iss: f.config.issuer,
        aud: f.config.clientId,
        sub: 'h1',
        iat: nowSeconds,
        exp: nowSeconds + 300,
        fhirUser: 'Practitioner/h1',
        ...claims,
    })
}

test('Solution launch: default steps complete launch, callback and chart', async (t) => {
    const { f, app } = await start(t)

    const { authorizeUrl, state, launchCookie } = await startBrowserLaunch(app, f)

    assert.equal(authorizeUrl.origin + authorizeUrl.pathname, f.metadata.authorization_endpoint)
    assert.equal(authorizeUrl.searchParams.get('response_type'), 'code')
    assert.equal(authorizeUrl.searchParams.get('client_id'), f.config.clientId)
    assert.equal(authorizeUrl.searchParams.get('aud'), f.config.fhirBase)
    assert.equal(authorizeUrl.searchParams.get('scope'), f.config.scopes)
    assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(authorizeUrl.searchParams.has('code_verifier'), false)
    assert.ok(launchCookie.httpOnly)
    assert.equal(launchCookie.sameSite, 'Lax')

    // The fixture only issues tokens when the verifier hashes to this challenge, which proves PKCE end to end.
    f.registerCode('solution-code', authorizeUrl.searchParams.get('code_challenge')!)

    const callbackUrl = callbackPath(state, 'solution-code')
    const callback = await app.inject({ url: callbackUrl, cookies: { smart_launch: launchCookie.value } })

    assert.equal(callback.statusCode, 302, callback.body)
    assert.equal(callback.headers.location, '/app')
    assert.equal(f.lastBody().get('grant_type'), 'authorization_code')
    assert.equal(f.lastBody().get('redirect_uri'), f.config.redirectUri)
    assert.equal(f.lastAuthorization(), undefined, 'A public client sends no client credentials')

    const session = callback.cookies.find((c) => c.name === 'smart_session')!
    const chart = await app.inject({ url: '/app', cookies: { smart_session: session.value } })

    assert.equal(chart.statusCode, 200, chart.body)
    assert.match(chart.body, /Synthetic &lt;Patient&gt;/)
    assert.match(chart.body, /in-progress/)
    assert.doesNotMatch(chart.body, /Test clinician|practitionerRoles/)
    assert.deepEqual(fhirPaths(f), ['/fhir/Encounter', '/fhir/Patient/p1'])

    const browserOutput = chart.body + JSON.stringify(callback.headers)

    for (const token of f.issued.keys()) {
        assert.equal(browserOutput.includes(token), false)
    }

    assert.doesNotMatch(browserOutput, /id_token|code_verifier/)

    const replay = await app.inject({ url: callbackUrl, cookies: { smart_launch: launchCookie.value } })

    assert.equal(replay.statusCode, 400, 'A callback can only be used once')
    assert.equal(f.tokenCalls(), 1)
})

test('Solution launch: bad state, missing cookie and declined authorization never reach the token endpoint', async (t) => {
    const { f, app } = await start(t)

    const { authorizeUrl, state, launchCookie } = await startBrowserLaunch(app, f)
    f.registerCode('stolen', authorizeUrl.searchParams.get('code_challenge')!)

    const withoutCookie = await app.inject(callbackPath(state, 'stolen'))

    assert.equal(withoutCookie.statusCode, 400)

    const cookies = { smart_launch: launchCookie.value }

    for (const query of ['state=wrong&code=stolen', 'code=stolen', `state=${state}&error=access_denied`]) {
        const rejected = await app.inject({ url: `/callback?${query}`, cookies })

        assert.equal(rejected.statusCode, 400, query)
    }

    assert.equal(f.tokenCalls(), 0)

    // Every failed callback consumed the transaction, so even the right state is now refused.
    const afterwards = await app.inject({ url: callbackPath(state, 'stolen'), cookies })

    assert.equal(afterwards.statusCode, 400)
    assert.equal(f.tokenCalls(), 0)
})

test('Solution launch: foreign iss and a poisoned discovery document are refused before redirecting', async (t) => {
    const { f, app } = await start(t)

    const foreign = await app.inject(
        `/launch?${new URLSearchParams({ iss: 'https://untrusted.invalid/fhir', launch: 'x' })}`,
    )

    assert.equal(foreign.statusCode, 400)
    assert.equal(foreign.headers.location, undefined)
    assert.equal(foreign.cookies.length, 0)

    const original = structuredClone(f.metadata)

    for (const poison of [
        { issuer: 'https://wrong.invalid/oidc' },
        { token_endpoint: 'https://wrong.invalid/token' },
    ]) {
        Object.assign(f.metadata, original, poison)

        try {
            const response = await app.inject(`/launch?${new URLSearchParams({ iss: f.config.fhirBase, launch: 'x' })}`)

            assert.equal(response.statusCode, 400, JSON.stringify(poison))
            assert.equal(response.headers.location, undefined)
        } finally {
            Object.assign(f.metadata, original)
        }
    }
})

test('Solution launch: an ID token for another client creates no session', async (t) => {
    const { f, app } = await start(t, (f) => ({
        exchange: async () => f.tokens({ id_token: await signedIdentity(f, { aud: 'another-client' }) }),
    }))

    const callback = await completeBrowserLaunch(app, f)

    assert.ok(callback.statusCode >= 400, callback.body)
    assert.equal(
        callback.cookies.some((c) => c.name === 'smart_session'),
        false,
    )
})

test('Solution launch: an ID token that is not signed by the issuer creates no session', async (t) => {
    const { f, app } = await start(t, (f) => ({
        exchange: async () => {
            const forged = (await signedIdentity(f, {})).split('.')
            forged[1] = Buffer.from(
                JSON.stringify({
                    iss: f.config.issuer,
                    aud: f.config.clientId,
                    sub: 'h2',
                    fhirUser: 'Practitioner/h2',
                    iat: 1,
                    exp: 9_999_999_999,
                }),
            ).toString('base64url')

            return f.tokens({ id_token: forged.join('.') })
        },
    }))

    const callback = await completeBrowserLaunch(app, f)

    assert.ok(callback.statusCode >= 400, callback.body)
    assert.equal(
        callback.cookies.some((c) => c.name === 'smart_session'),
        false,
    )
})

test('Solution launch: a token response without encounter or patient creates no session', async (t) => {
    for (const missing of ['encounter', 'patient'] as const) {
        const { f, app } = await start(t, (f) => ({ exchange: async () => f.tokens({ [missing]: undefined }) }))

        const callback = await completeBrowserLaunch(app, f)

        assert.equal(callback.statusCode, 400, missing)
        assert.equal(
            callback.cookies.some((c) => c.name === 'smart_session'),
            false,
        )
    }
})

test('Solution launch: the launched encounter must be an active consultation for the launched patient', async (t) => {
    const { f, app } = await start(t)

    const session = await signIn(app, f)
    const cookies = { smart_session: session }

    assert.equal((await app.inject({ url: '/app', cookies })).statusCode, 200)

    f.encounter.subject.reference = 'Patient/p2'
    assert.equal((await app.inject({ url: '/app', cookies })).statusCode, 400, 'Encounter of another patient')

    f.encounter.subject.reference = 'Patient/p1'
    f.encounter.status = 'finished'
    assert.equal((await app.inject({ url: '/app', cookies })).statusCode, 400, 'Finished encounter')

    f.encounter.status = 'in-progress'
    f.patient.id = 'p2'
    assert.equal((await app.inject({ url: '/app', cookies })).statusCode, 502, 'FHIR server returned another patient')
})

test('Solution launch: a rejected access token ends in a generic error without leaking tokens', async (t) => {
    const { f, app } = await start(t)

    const session = await signIn(app, f)

    for (const token of f.issued.values()) {
        token.expiresAt = 0
    }

    const chart = await app.inject({ url: '/app', cookies: { smart_session: session } })

    assert.equal(chart.statusCode, 502)
    assert.ok(f.requests.some((r) => r.path.startsWith('/fhir/') && r.status === 401))

    for (const token of f.issued.keys()) {
        assert.equal(chart.body.includes(token), false)
    }
})
