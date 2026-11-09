import type { FastifyInstance } from 'fastify'
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'

import { buildApp } from '../src/app.ts'

import { signIn, type LaunchResponse } from './browser.ts'
import { fixture, UPSTREAM_DETAIL, type Fixture } from './fixture.ts'

const WRITE_SCOPES = 'patient/Observation.cr patient/DocumentReference.cr'
const TRUSTED_ORIGIN = 'http://localhost:3100'
const FORM = 'application/x-www-form-urlencoded'

interface WriteApp {
    f: Fixture
    app: FastifyInstance
    cookies: { smart_session: string }
    csrf: string
}

async function startWriteApp(t: TestContext, scopes = WRITE_SCOPES): Promise<WriteApp> {
    const f = await fixture()
    t.after(f.close)

    const app = await buildApp(f.config)
    t.after(async () => app.close())

    const cookies = { smart_session: await signIn(app, f, `${f.config.scopes} ${scopes}`) }

    return { f, app, cookies, csrf: await csrfToken(app, cookies) }
}

async function csrfToken(app: FastifyInstance, cookies: { smart_session: string }): Promise<string> {
    const page = await app.inject({ url: '/write', cookies })
    const token = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1]

    assert.ok(token, page.body)

    return token
}

interface PostOptions {
    origin?: string | null
    contentType?: string
    cookies?: { smart_session: string } | undefined
}

async function post(
    { app, cookies }: WriteApp,
    path: string,
    payload: string,
    { origin = TRUSTED_ORIGIN, contentType = FORM, ...options }: PostOptions = {},
): Promise<LaunchResponse> {
    return app.inject({
        method: 'POST',
        url: path,
        cookies: 'cookies' in options ? options.cookies : cookies,
        headers: { 'content-type': contentType, ...(origin === null ? {} : { origin }) },
        payload,
    })
}

function form(fields: Record<string, string>): string {
    return new URLSearchParams(fields).toString()
}

function postedResources(f: Fixture): number {
    return f.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/fhir/')).length
}

test('GET /write renders forms with a session token and writes nothing', async (t) => {
    const w = await startWriteApp(t)
    const page = await w.app.inject({ url: '/write', cookies: w.cookies })

    assert.equal(page.statusCode, 200)
    assert.match(page.body, /action="\/write\/temperature"/)
    assert.match(page.body, /action="\/write\/note"/)
    assert.equal(w.f.created.size, 0)
    assert.equal(postedResources(w.f), 0)
    assert.equal(page.headers['content-security-policy']?.includes("form-action 'self'"), true)
})

test('GET /write without a session is refused', async (t) => {
    const w = await startWriteApp(t)
    const page = await w.app.inject({ url: '/write' })

    assert.equal(page.statusCode, 401)
    assert.doesNotMatch(page.body, /name="csrf"/)
})

test('GET /write offers a form only when create and read scopes are granted', async (t) => {
    const w = await startWriteApp(t, 'patient/Observation.cr patient/DocumentReference.c')
    const page = await w.app.inject({ url: '/write', cookies: w.cookies })

    assert.match(page.body, /action="\/write\/temperature"/)
    assert.doesNotMatch(page.body, /action="\/write\/note"/)
    assert.match(page.body, /patient\/DocumentReference\.r/)
})

test('temperature: writes for the session patient and encounter, then shows the read-back', async (t) => {
    const w = await startWriteApp(t)
    const response = await post(w, '/write/temperature', form({ csrf: w.csrf, celsius: '37,4' }))

    assert.equal(response.statusCode, 200, response.body)
    assert.match(response.body, /Observation\/created-1/)
    assert.match(response.body, /37\.4 degrees Celsius/)
    assert.match(response.body, /Patient\/p1/)
    assert.match(response.body, /Encounter\/e1/)

    const stored = w.f.created.get('Observation/created-1') as { valueQuantity: { value: number } }

    assert.equal(stored.valueQuantity.value, 37.4)
    assert.equal(postedResources(w.f), 1)
    assert.ok(w.f.requests.some((r) => r.method === 'GET' && r.path === '/fhir/Observation/created-1'))
})

test('note: writes a DocumentReference and escapes the text it echoes', async (t) => {
    const w = await startWriteApp(t)
    const response = await post(w, '/write/note', form({ csrf: w.csrf, note: '  <script>alert(1)</script> ok  ' }))

    assert.equal(response.statusCode, 200, response.body)
    assert.match(response.body, /DocumentReference\/created-1/)
    assert.doesNotMatch(response.body, /<script>/)
    assert.match(response.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt; ok/)
})

test('CSRF token absent, wrong or from another session is refused without writing', async (t) => {
    const w = await startWriteApp(t)
    const other = { smart_session: await signIn(w.app, w.f, `${w.f.config.scopes} ${WRITE_SCOPES}`) }
    const otherToken = await csrfToken(w.app, other)

    assert.notEqual(otherToken, w.csrf)

    for (const payload of [
        form({ celsius: '37.0' }),
        form({ csrf: '', celsius: '37.0' }),
        form({ csrf: 'guess', celsius: '37.0' }),
        form({ csrf: otherToken, celsius: '37.0' }),
    ]) {
        const response = await post(w, '/write/temperature', payload)

        assert.equal(response.statusCode, 403, payload)
    }

    const note = await post(w, '/write/note', form({ csrf: otherToken, note: 'hello' }))

    assert.equal(note.statusCode, 403)
    assert.equal(w.f.created.size, 0)
    assert.equal(postedResources(w.f), 0)
})

test('Origin missing, wrong, null or taken from the Host header is refused without writing', async (t) => {
    const w = await startWriteApp(t)
    const payload = form({ csrf: w.csrf, celsius: '37.0' })

    for (const origin of [null, 'null', 'https://evil.example', 'http://localhost:3101', 'http://localhost:3100/']) {
        const response = await post(w, '/write/temperature', payload, { origin })

        assert.equal(response.statusCode, 403, String(origin))
    }

    const hostForged = await w.app.inject({
        method: 'POST',
        url: '/write/temperature',
        cookies: w.cookies,
        headers: { 'content-type': FORM, host: 'evil.example', origin: 'http://evil.example' },
        payload,
    })

    assert.equal(hostForged.statusCode, 403)
    assert.equal(w.f.created.size, 0)
    assert.equal(postedResources(w.f), 0)
})

test('POST without a session is refused without writing', async (t) => {
    const w = await startWriteApp(t)

    for (const path of ['/write/temperature', '/write/note']) {
        const response = await post(w, path, form({ csrf: w.csrf, celsius: '37', note: 'x' }), { cookies: undefined })

        assert.equal(response.statusCode, 401, path)
    }

    assert.equal(postedResources(w.f), 0)
})

test('invalid input is rejected without writing', async (t) => {
    const w = await startWriteApp(t)
    const cases: [string, Record<string, string>][] = [
        ['/write/temperature', { celsius: 'NaN' }],
        ['/write/temperature', { celsius: 'Infinity' }],
        ['/write/temperature', { celsius: '1e2' }],
        ['/write/temperature', { celsius: 'abc' }],
        ['/write/temperature', { celsius: '' }],
        ['/write/temperature', { celsius: '24.9' }],
        ['/write/temperature', { celsius: '45.1' }],
        ['/write/temperature', { celsius: '37.123' }],
        ['/write/temperature', {}],
        ['/write/note', { note: '' }],
        ['/write/note', { note: '   \n ' }],
        ['/write/note', { note: 'x'.repeat(2001) }],
        ['/write/note', {}],
    ]

    for (const [path, fields] of cases) {
        const response = await post(w, path, form({ csrf: w.csrf, ...fields }))

        assert.equal(response.statusCode, 400, `${path} ${JSON.stringify(fields).slice(0, 40)}`)
    }

    assert.equal(w.f.created.size, 0)
    assert.equal(postedResources(w.f), 0)
})

test('a client-supplied patient or encounter is rejected, not used', async (t) => {
    const w = await startWriteApp(t)

    const forged: Record<string, string>[] = [{ patient: 'p2' }, { encounter: 'e2' }, { subject: 'Patient/p2' }]

    for (const extra of forged) {
        const response = await post(w, '/write/temperature', form({ csrf: w.csrf, celsius: '37.0', ...extra }))

        assert.equal(response.statusCode, 400, JSON.stringify(extra))
    }

    assert.equal(postedResources(w.f), 0)

    const ok = await post(w, '/write/temperature', form({ csrf: w.csrf, celsius: '37.0' }))

    assert.equal(ok.statusCode, 200)
    assert.match(ok.body, /Patient\/p1/)
})

test('repeated fields, other content types and oversized bodies are rejected', async (t) => {
    const w = await startWriteApp(t)
    const repeated = `csrf=${w.csrf}&celsius=37&celsius=38`
    const json = JSON.stringify({ csrf: w.csrf, celsius: '37' })
    const huge = form({ csrf: w.csrf, note: 'x'.repeat(40_000) })

    assert.equal((await post(w, '/write/temperature', repeated)).statusCode, 400)
    assert.equal((await post(w, '/write/temperature', json, { contentType: 'application/json' })).statusCode, 415)
    assert.equal((await post(w, '/write/temperature', 'celsius=37', { contentType: 'text/plain' })).statusCode, 415)
    assert.equal((await post(w, '/write/note', huge)).statusCode, 413)
    assert.equal(postedResources(w.f), 0)
})

test('missing scope is refused without calling the FHIR server', async (t) => {
    // Each session still shows one form, which is where the test gets its CSRF token.
    const noTemperature = await startWriteApp(t, 'patient/Observation.r patient/DocumentReference.cr')
    const temperature = await post(
        noTemperature,
        '/write/temperature',
        form({ csrf: noTemperature.csrf, celsius: '37' }),
    )

    assert.equal(temperature.statusCode, 403)
    assert.match(temperature.body, /patient\/Observation\.c/)
    assert.equal(postedResources(noTemperature.f), 0)

    const noNote = await startWriteApp(t, 'patient/Observation.cr patient/DocumentReference.c')
    const note = await post(noNote, '/write/note', form({ csrf: noNote.csrf, note: 'hello' }))

    assert.equal(note.statusCode, 403)
    assert.match(note.body, /patient\/DocumentReference\.r/)
    assert.equal(postedResources(noNote.f), 0)
})

test('an unexpected create response is not reported as saved and is not retried', async (t) => {
    const w = await startWriteApp(t)

    for (const change of [{ location: 'missing' }, { location: 'wrong' }, { status: 200 }] as const) {
        w.f.createResponse.location = 'correct'
        w.f.createResponse.status = 201
        Object.assign(w.f.createResponse, change)

        const before = postedResources(w.f)
        const response = await post(w, '/write/temperature', form({ csrf: w.csrf, celsius: '37.0' }))

        assert.equal(response.statusCode, 502, JSON.stringify(change))
        assert.doesNotMatch(response.body, /Created <code>/)
        assert.equal(postedResources(w.f) - before, 1, 'One attempt only')
    }
})

test('an unknown create outcome warns that the resource may exist and is not retried', async (t) => {
    const w = await startWriteApp(t)

    const outcomes = [
        { delivery: 'disconnect' },
        { delivery: 'empty' },
        { delivery: 'malformed' },
        { delivery: 'normal', status: 500 },
    ] as const

    for (const outcome of outcomes) {
        for (const [path, fields] of [
            ['/write/temperature', { celsius: '37.0' }],
            ['/write/note', { note: 'hello' }],
        ] as const) {
            Object.assign(w.f.createResponse, { status: 201, delivery: 'normal' }, outcome)

            const stored = w.f.created.size
            const before = postedResources(w.f)
            const response = await post(w, path, form({ csrf: w.csrf, ...fields }))
            const label = `${JSON.stringify(outcome)} ${path}`

            assert.equal(response.statusCode, 502, label)
            assert.match(response.body, /may already have been saved/, label)
            assert.match(response.body, /check the EPJ before submitting again/, label)
            assert.doesNotMatch(response.body, /Check registration and try a new launch/, label)
            assert.doesNotMatch(response.body, /Created <code>/, label)
            assert.equal(response.body.includes(UPSTREAM_DETAIL), false, label)
            assert.equal(postedResources(w.f) - before, 1, `${label} must not be retried`)
            assert.equal(w.f.created.size - stored, 1, label)
        }
    }
})

test('an upstream rejection of the create is not reported as possibly saved', async (t) => {
    const w = await startWriteApp(t)

    w.f.createResponse.status = 403

    const response = await post(w, '/write/temperature', form({ csrf: w.csrf, celsius: '37.0' }))

    assert.equal(response.statusCode, 502)
    assert.match(response.body, /Upstream returned HTTP 403/)
    assert.doesNotMatch(response.body, /may already have been saved/)
    assert.equal(postedResources(w.f), 1)
})

test('a read-back that does not match the session is reported as unverified', async (t) => {
    const w = await startWriteApp(t)

    for (const readback of ['wrong-id', 'other-patient', 'missing'] as const) {
        w.f.createResponse.readback = readback

        for (const [path, fields] of [
            ['/write/temperature', { celsius: '37.0' }],
            ['/write/note', { note: 'hello' }],
        ] as const) {
            const before = postedResources(w.f)
            const response = await post(w, path, form({ csrf: w.csrf, ...fields }))

            assert.equal(response.statusCode, 502, `${readback} ${path}`)
            assert.match(response.body, /read-back failed/)
            assert.match(response.body, /created-\d+/)
            assert.doesNotMatch(response.body, /HTTP 201, Location matches/)
            assert.equal(response.body.includes(UPSTREAM_DETAIL), false)
            assert.equal(postedResources(w.f) - before, 1)
        }
    }
})

test('responses never contain tokens or upstream error details', async (t) => {
    const w = await startWriteApp(t, 'patient/Observation.r patient/DocumentReference.cr')
    const denied = await post(w, '/write/temperature', form({ csrf: w.csrf, celsius: '37.0' }))
    const page = await w.app.inject({ url: '/write', cookies: w.cookies })

    for (const body of [denied.body, page.body]) {
        assert.doesNotMatch(body, /synthetic-|Bearer|access_token/)
    }
})
