import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'

import { buildApp } from '../src/app.ts'
import { runProbe } from '../src/scope-detective.ts'
import { grantsInteraction } from '../src/scopes.ts'

import { signIn } from './browser.ts'
import { fixture, UPSTREAM_DETAIL, type Fixture } from './fixture.ts'

const MINIMAL_SCOPES = 'openid fhirUser launch patient/Patient.r patient/Encounter.s'

async function startDetective(
    t: TestContext,
    extraGranted = '',
    extraRequested = '',
): Promise<{ f: Fixture; response: string }> {
    const f = await fixture()
    t.after(f.close)

    const app = await buildApp({ ...f.config, scopes: `${f.config.scopes} ${extraRequested}`.trim() })
    t.after(async () => app.close())

    const session = await signIn(app, f, `${f.config.scopes} ${extraGranted}`.trim())
    const response = await app.inject({ url: '/scopes', cookies: { smart_session: session } })

    assert.equal(response.statusCode, 200, response.body)

    for (const token of f.issued.keys()) {
        assert.equal(response.body.includes(token), false)
    }

    return { f, response: response.body }
}

function readRequests(f: Fixture): { path: string; status: number }[] {
    return f.requests
        .filter((r) => r.path.startsWith('/fhir/') && !r.path.includes('.well-known'))
        .map(({ path, status }) => ({ path, status }))
        .sort((a, b) => a.path.localeCompare(b.path))
}

test('Scope detective: default scopes show an allowed Patient read and a refused Condition read', async (t) => {
    const { f, response } = await startDetective(t)

    assert.match(response, /<code>GET Patient\/p1<\/code>/)
    assert.match(response, /<td>allowed<\/td>\s*<td>HTTP 200<\/td>/)
    assert.match(response, /<code>GET Condition\?subject=p1&amp;encounter=e1<\/code>/)
    assert.match(response, /<td>refused<\/td>\s*<td>HTTP 403, error \/ forbidden<\/td>/)
    assert.equal(response.includes(UPSTREAM_DETAIL), false, 'Upstream diagnostics must not reach the page')
    assert.deepEqual(readRequests(f), [
        { path: '/fhir/Condition', status: 403 },
        { path: '/fhir/Patient/p1', status: 200 },
    ])
})

test('Scope detective: probes Observation when Condition is allowed', async (t) => {
    const { f, response } = await startDetective(t, 'patient/Condition.s')

    assert.match(response, /<code>GET Observation\?/)
    assert.match(response, /HTTP 403, error \/ forbidden/)
    assert.deepEqual(readRequests(f), [
        { path: '/fhir/Observation', status: 403 },
        { path: '/fhir/Patient/p1', status: 200 },
    ])
})

test('Scope detective: when everything is allowed it says so and does not fake a refusal', async (t) => {
    const { f, response } = await startDetective(t, 'patient/Condition.s patient/Observation.s')

    assert.match(response, /no refused read to show/)
    assert.ok(response.includes(`SCOPES=${MINIMAL_SCOPES}`))
    assert.doesNotMatch(response, /HTTP 403/)
    assert.deepEqual(readRequests(f), [{ path: '/fhir/Patient/p1', status: 200 }])
})

test('Scope detective: compares requested scopes with the scopes the server granted', async (t) => {
    const { response } = await startDetective(t, '', 'patient/Condition.s')

    assert.match(response, /Requested but not granted: patient\/Condition\.s/)
    assert.match(response, /Granted but not requested: none/)
})

test('Scope detective: needs a session', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const app = await buildApp(f.config)
    t.after(async () => app.close())

    assert.equal((await app.inject('/scopes')).statusCode, 401)
})

test('Scope probe: keeps only the status, issue severity and issue code of a rejected read', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const tokens = await f.tokens()
    const refused = await runProbe(f.config, tokens.access_token, 'Condition?subject=p1')

    assert.deepEqual(refused, {
        request: 'Condition?subject=p1',
        status: 403,
        issues: [{ severity: 'error', code: 'forbidden' }],
    })

    const unauthenticated = await runProbe(f.config, 'not-a-token', 'Patient/p1')

    assert.equal(unauthenticated.status, 401)
    assert.equal(JSON.stringify([refused, unauthenticated]).includes(UPSTREAM_DETAIL), false)
    await assert.rejects(runProbe(f.config, tokens.access_token, 'https://elsewhere.invalid/Patient/p1'))
})

test('Scope parsing: only SMART v2 patient and user resource scopes grant an interaction', () => {
    assert.equal(grantsInteraction('patient/*.cruds', 'Condition', 's'), true)
    assert.equal(grantsInteraction('user/Condition.rs', 'Condition', 's'), true)
    assert.equal(grantsInteraction('patient/Condition.r', 'Condition', 's'), false)
    assert.equal(grantsInteraction('patient/Patient.rs', 'Condition', 's'), false)
    assert.equal(grantsInteraction('patient/ConditionX.s', 'Condition', 's'), false)
    assert.equal(grantsInteraction('system/Condition.s', 'Condition', 's'), false)
    assert.equal(grantsInteraction('', 'Condition', 's'), false)
})
