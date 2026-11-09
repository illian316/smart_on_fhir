import { SignJWT } from 'jose'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { buildApp } from '../src/app.ts'
import { age } from '../src/http.ts'
import * as api from '../src/reference.ts'
import type { Steps } from '../src/steps.ts'
import { TRANSACTION_TTL_MS } from '../src/types.ts'

import { callbackPath, completeBrowserLaunch, sessionCookieValue, startBrowserLaunch } from './browser.ts'
import { fixture, launchContext } from './fixture.ts'
import { IMPLEMENTATIONS } from './implementations.ts'

const CARE_TEAM_SCOPES = 'patient/PractitionerRole.s patient/Organization.r'

for (const [name, impl] of Object.entries(IMPLEMENTATIONS)) {
    test(`${name} launch: protocol functions`, async (t) => {
        const f = await fixture()
        t.after(f.close)

        const launch = { iss: f.config.fhirBase, launch: 'one-time-launch' }
        const proof = impl.pkce()
        const transaction = impl.newTransaction(launch, f.metadata, proof)
        const tokens = await f.tokens()

        await t.test('trusted launch parameters', () => {
            assert.deepEqual(impl.readLaunch(launch, f.config), launch)
            assert.throws(
                () => impl.readLaunch({ ...launch, iss: 'https://untrusted.invalid/fhir' }, f.config),
                (error: Error) =>
                    error.message.includes('https://untrusted.invalid/fhir') &&
                    error.message.includes(f.config.fhirBase),
                'The mismatch error must show the received iss and FHIR_BASE_URL',
            )
            assert.throws(() => impl.readLaunch({ iss: launch.iss }, f.config), /launch ID/)
        })

        await t.test('trust discovery and reject invalid metadata', async () => {
            const original = structuredClone(f.metadata)

            assert.deepEqual(
                await impl.discover(f.config),
                original,
                'Valid discovery must succeed before checking rejection cases',
            )

            const attacks = [
                { issuer: 'https://wrong.invalid/oidc' },
                { authorization_endpoint: 'https://wrong.invalid/authorize' },
                { token_endpoint: 'https://wrong.invalid/token' },
                { jwks_uri: 'https://wrong.invalid/jwks' },
                { token_endpoint_auth_methods_supported: [] },
                { grant_types_supported: [] },
                { code_challenge_methods_supported: ['plain'] },
            ]

            for (const attack of attacks) {
                Object.assign(f.metadata, original, attack)

                try {
                    await assert.rejects(impl.discover(f.config), `Discovery must reject ${Object.keys(attack)[0]}`)
                } finally {
                    Object.assign(f.metadata, original)
                }
            }
        })

        await t.test('S256 PKCE', () => {
            const actual = impl.pkce()

            assert.match(actual.verifier, /^[A-Za-z0-9_-]{43,128}$/)
            assert.equal(actual.challenge, createHash('sha256').update(actual.verifier).digest('base64url'))
            assert.notEqual(actual.verifier, impl.pkce().verifier)
        })

        await t.test('server-side transaction and state', () => {
            const actual = impl.newTransaction(launch, f.metadata, proof)

            assert.match(actual.state, /^[A-Za-z0-9_-]{43,}$/)
            assert.notEqual(actual.state, impl.newTransaction(launch, f.metadata, proof).state)
            assert.equal(actual.verifier, proof.verifier)
            assert.equal(actual.launch.iss, launch.iss)
            assert.ok(Math.abs(Date.now() - actual.createdAt) < 1000)
        })

        await t.test('authorization request', () => {
            const url = new URL(impl.authorizationUrl(f.config, transaction))
            const expectedParams = {
                response_type: 'code',
                client_id: f.config.clientId,
                redirect_uri: f.config.redirectUri,
                scope: f.config.scopes,
                aud: launch.iss,
                launch: launch.launch,
                state: transaction.state,
                code_challenge: proof.challenge,
                code_challenge_method: 'S256',
            }

            for (const [key, value] of Object.entries(expectedParams)) {
                assert.equal(url.searchParams.get(key), value)
            }

            assert.equal(url.searchParams.has('code_verifier'), false)
        })

        await t.test('callback state', () => {
            const expired = { ...transaction, createdAt: Date.now() - TRANSACTION_TTL_MS - 1000 }

            assert.equal(impl.validateCallback({ code: 'code', state: transaction.state }, transaction), 'code')
            assert.throws(() => impl.validateCallback({ code: 'code', state: 'tampered' }, transaction))
            assert.throws(() => impl.validateCallback({ code: 'code' }, transaction))
            assert.throws(() => impl.validateCallback({ code: 'code', state: transaction.state }, expired))
        })

        await t.test('authenticated code exchange', async () => {
            f.registerCode('code', proof.challenge)

            const exchanged = await impl.exchange(f.config, transaction, 'code')

            assert.ok(f.issued.has(exchanged.access_token), 'Exchange must return a token issued by the server')
            assert.equal(f.lastBody().get('grant_type'), 'authorization_code')

            if (f.config.variant === 'public') {
                assert.equal(f.lastAuthorization(), undefined)
                assert.equal(f.lastBody().has('client_assertion'), false)
            }
        })

        await t.test('verify ID-token signature and claims', async () => {
            const nowSeconds = Math.floor(Date.now() / 1000)
            const claims = {
                iss: f.config.issuer,
                aud: f.config.clientId,
                sub: 'h1',
                iat: nowSeconds,
                exp: nowSeconds + 300,
                fhirUser: 'Practitioner/h1',
            }
            const signed = { ...tokens, id_token: await f.signIdentity(claims) }

            assert.equal(await impl.verifyIdentity(f.config, f.metadata, signed), 'h1', 'A valid ID token must succeed')
            await assert.rejects(
                impl.verifyIdentity(f.config, f.metadata, { ...signed, id_token: undefined }),
                'Missing ID token must be rejected',
            )

            const attacks = [
                { aud: 'wrong' },
                { iss: 'https://wrong.invalid' },
                { exp: 1 },
                { exp: undefined },
                { sub: undefined },
                { iat: undefined },
                { fhirUser: 'https://wrong.invalid/Practitioner/h1' },
                { fhirUser: 'Patient/p1' },
                { azp: 'wrong' },
            ]

            for (const attack of attacks) {
                const invalid = await f.signIdentity({ ...claims, ...attack })

                await assert.rejects(
                    impl.verifyIdentity(f.config, f.metadata, { ...signed, id_token: invalid }),
                    `ID-token verification must reject ${Object.keys(attack)[0]}`,
                )
            }

            const wrongAlgorithm = await new SignJWT(claims)
                .setProtectedHeader({ alg: 'ES384' })
                .sign(f.client.privateKey)

            await assert.rejects(impl.verifyIdentity(f.config, f.metadata, { ...signed, id_token: wrongAlgorithm }))

            const parts = signed.id_token.split('.')
            const signature = Buffer.from(parts[2]!, 'base64url')
            signature[0] = signature[0]! ^ 1
            parts[2] = signature.toString('base64url')

            await assert.rejects(
                impl.verifyIdentity(f.config, f.metadata, { ...signed, id_token: parts.join('.') }),
                'Decoding is not verification: a tampered RS256 signature must be rejected',
            )
        })

        await t.test('launch context', () => {
            assert.deepEqual(impl.launchContext(tokens, 'h1'), launchContext)
            assert.throws(() => impl.launchContext({ ...tokens, patient: undefined }, 'h1'))
            assert.throws(() => impl.launchContext({ ...tokens, encounter: undefined }, 'h1'))
        })

        await t.test('patient and consultation', async () => {
            const chart = await impl.loadChart(f.config, tokens, launchContext)

            assert.equal(chart.patientName, 'Synthetic <Patient>')
            assert.equal(chart.encounter, 'e1')
            assert.equal('clinician' in chart, false)
            assert.equal('organization' in chart, false)
            assert.equal('practitionerRoles' in chart, false)
            assert.equal(chart.age, age(f.patient.birthDate))

            f.encounter.subject.reference = 'Patient/p2'

            await assert.rejects(
                impl.loadChart(f.config, tokens, launchContext),
                "Do not display another patient's encounter",
            )

            f.encounter.subject.reference = 'Patient/p1'
            f.encounter.status = 'finished'

            await assert.rejects(
                impl.loadChart(f.config, tokens, launchContext),
                'Do not display a finished encounter as active',
            )
        })
    })
}

test('Reference launch: complete browser launch and escaped patient page', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const app = await buildApp(f.config, true)
    t.after(async () => app.close())

    const { authorizeUrl, state, launchCookie } = await startBrowserLaunch(app, f)

    assert.ok(launchCookie.httpOnly)
    assert.equal(launchCookie.sameSite, 'Lax')

    f.registerCode('browser-code', authorizeUrl.searchParams.get('code_challenge')!)

    const callbackUrl = callbackPath(state, 'browser-code')
    const withoutCookie = await app.inject(callbackUrl)

    assert.equal(withoutCookie.statusCode, 400)
    assert.equal(f.tokenCalls(), 0)

    const callback = await app.inject({ url: callbackUrl, cookies: { smart_launch: launchCookie.value } })

    assert.equal(callback.statusCode, 302)
    assert.equal(callback.headers.location, '/app')

    const replay = await app.inject({ url: callbackUrl, cookies: { smart_launch: launchCookie.value } })

    assert.equal(replay.statusCode, 400)

    const chart = await app.inject({ url: '/app', cookies: { smart_session: sessionCookieValue(callback) } })

    assert.equal(chart.statusCode, 200)
    assert.match(chart.body, /Synthetic &lt;Patient&gt;/)
    assert.doesNotMatch(chart.body, /Test clinician|Test practice|practitionerRoles/)

    const fhirPaths = f.requests
        .filter((r) => r.path.startsWith('/fhir/') && !r.path.includes('.well-known'))
        .map((r) => r.path)
        .sort()

    assert.deepEqual(fhirPaths, ['/fhir/Encounter', '/fhir/Patient/p1'])
    assert.equal(chart.headers['cache-control'], 'no-store')

    const browserOutput = chart.body + JSON.stringify(callback.headers)

    for (const token of f.issued.keys()) {
        assert.equal(browserOutput.includes(token), false)
    }

    assert.doesNotMatch(browserOutput, /id_token|code_verifier/)
})

test('Reference launch: care-team reads are opt-in and require their permissions', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const tokens = await f.tokens({ scope: `${f.config.scopes} ${CARE_TEAM_SCOPES}` })
    const basic = await api.loadChart(f.config, tokens, launchContext)

    assert.deepEqual(Object.keys(basic).sort(), ['age', 'encounter', 'patientName', 'started', 'status'])
    assert.deepEqual(
        f.requests.map((r) => r.path).sort(),
        ['/fhir/Encounter', '/fhir/Patient/p1'],
        'Granting extra permissions must not enable extra reads',
    )

    const detailed = await api.loadChart(f.config, tokens, launchContext, { includeCareTeam: true })

    assert.deepEqual(detailed, {
        ...basic,
        clinician: 'Test clinician',
        organization: 'Test practice',
        practitionerRoles: 1,
    })

    const unknownEncounter = { ...launchContext, encounter: 'unknown' }

    await assert.rejects(api.loadChart(f.config, tokens, unknownEncounter), /not an active consultation/)
    await assert.rejects(
        api.loadChart(f.config, tokens, unknownEncounter, { includeCareTeam: true }),
        /not an active consultation/,
    )

    const narrowTokens = await f.tokens()

    await assert.rejects(
        api.loadChart(f.config, narrowTokens, launchContext, { includeCareTeam: true }),
        /HTTP 403/,
        'Opting in must not silently swallow missing permissions',
    )
})

test('Reference launch: a missing organization does not block the basic chart', async (t) => {
    const f = await fixture()
    t.after(f.close)

    f.encounter.serviceProvider = undefined
    const tokens = await f.tokens()

    assert.equal((await api.loadChart(f.config, tokens, launchContext)).encounter, 'e1')
    await assert.rejects(api.loadChart(f.config, tokens, launchContext, { includeCareTeam: true }), /serviceProvider/)
})

test('Reference launch: the existing renderer displays explicitly enabled care-team details', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const tokens = await f.tokens({ scope: `${f.config.scopes} ${CARE_TEAM_SCOPES}` })
    const implementation: Steps = {
        ...api,
        exchange: async () => tokens,
        loadChart: async (config, sessionTokens, context) =>
            api.loadChart(config, sessionTokens, context, { includeCareTeam: true }),
    }
    const app = await buildApp(f.config, true, implementation)
    t.after(async () => app.close())

    const callback = await completeBrowserLaunch(app, f)

    assert.equal(callback.statusCode, 302)

    const chart = await app.inject({ url: '/app', cookies: { smart_session: sessionCookieValue(callback) } })

    assert.equal(chart.statusCode, 200)
    assert.match(chart.body, /Test clinician/)
    assert.match(chart.body, /Test practice/)
    assert.match(chart.body, /practitionerRoles/)
})

test('Reference launch: tampered state never reaches the token endpoint', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const app = await buildApp(f.config, true)
    t.after(async () => app.close())

    const { launchCookie } = await startBrowserLaunch(app, f)
    const result = await app.inject({
        url: '/callback?state=wrong&code=stolen',
        cookies: { smart_launch: launchCookie.value },
    })

    assert.equal(result.statusCode, 400)
    assert.equal(f.tokenCalls(), 0)
})

test('Reference launch: expired app session requires a new launch', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const implementation: Steps = { ...api, exchange: async () => ({ ...(await f.tokens()), expires_in: -1 }) }
    const app = await buildApp(f.config, true, implementation)
    t.after(async () => app.close())

    const callback = await completeBrowserLaunch(app, f)

    assert.equal(callback.statusCode, 302, callback.body)

    const expired = await app.inject({ url: '/app', cookies: { smart_session: sessionCookieValue(callback) } })

    assert.equal(expired.statusCode, 401)
})
