import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { z } from 'zod'

import { buildApp } from '../src/app.ts'
import * as extensions from '../src/extensions.ts'

import { shapeSteps } from './fakes.ts'
import { bearer, fixture, launchContext } from './fixture.ts'
import { callbackPath, cookieValue, startBrowserLaunch, type InjectResponse } from './launch-helpers.ts'

type ResourceType = 'Observation' | 'DocumentReference'

const RESOURCE_TYPES: ResourceType[] = ['Observation', 'DocumentReference']
const MEASURED_AT = new Date('2026-01-01T10:00:00Z')

function makeResource(type: ResourceType): extensions.TemperatureObservation | extensions.JournalNote {
    if (type === 'Observation') {
        return extensions.temperature(launchContext, 37.2, MEASURED_AT)
    }

    return extensions.journalNote(launchContext, 'Synthetic note')
}

function lastPostStatus(
    requests: { method: string; path: string; status: number }[],
    type: ResourceType,
): number | undefined {
    return requests.filter((r) => r.method === 'POST' && r.path.endsWith(type)).at(-1)?.status
}

for (const type of RESOURCE_TYPES) {
    test(`Reference ${type}: construct the supported resource shape from launch context`, async (t) => {
        const f = await fixture()
        t.after(f.close)

        const tokens = await f.tokens({ scope: `patient/${type}.cr` })
        const resource = makeResource(type)

        assert.equal(resource.resourceType, type)
        assert.equal(resource.subject.reference, 'Patient/p1')
        assert.equal('id' in resource, false, 'Creation must let the server assign an ID')

        if (resource.resourceType === 'Observation') {
            assert.equal(resource.encounter.reference, 'Encounter/e1')
            assert.equal(resource.effectiveDateTime, MEASURED_AT.toISOString())
            assert.equal(resource.valueQuantity.value, 37.2)
            assert.equal(resource.valueQuantity.code, 'Cel')
            assert.throws(() => extensions.temperature(launchContext, Number.NaN, MEASURED_AT))
        } else {
            assert.equal(resource.context.encounter[0]?.reference, 'Encounter/e1')
            assert.equal(resource.description, 'Synthetic note')
            assert.throws(() => extensions.journalNote(launchContext, ' '))
        }

        const response = await fetch(`${f.config.fhirBase}/${type}`, {
            method: 'POST',
            headers: { ...bearer(tokens), 'Content-Type': 'application/fhir+json' },
            body: JSON.stringify(resource),
        })

        assert.equal(response.status, 201, "The fixture validates LOINC/UCUM and nav-epj's narrow document shape")
    })

    test(`Reference ${type}: create, verify Location and read back the persisted resource`, async (t) => {
        const f = await fixture()
        t.after(f.close)

        const tokens = await f.tokens({ scope: `patient/${type}.cr` })
        const created = await extensions.createResource(f.config, tokens, makeResource(type))

        assert.equal(created.resourceType, type)
        assert.ok(f.created.has(`${type}/${created.id}`), 'Returning a fabricated ID is not a successful write')

        const read = await fetch(`${f.config.fhirBase}/${type}/${created.id}`, { headers: bearer(tokens) })

        assert.equal(read.status, 200)
        assert.deepEqual(await read.json(), created)
        assert.equal(f.created.size, 1)
    })

    test(`Reference ${type}: reject missing create scope and another patient's subject without writing`, async (t) => {
        const f = await fixture()
        t.after(f.close)

        const tokens = await f.tokens({ scope: `patient/${type}.cr` })
        await extensions.createResource(f.config, tokens, makeResource(type))

        assert.equal(f.created.size, 1)

        const readOnlyTokens = await f.tokens({ scope: `patient/${type}.r` })

        await assert.rejects(extensions.createResource(f.config, readOnlyTokens, makeResource(type)))
        assert.equal(lastPostStatus(f.requests, type), 403)

        const otherPatient = { ...makeResource(type), subject: { reference: 'Patient/p2' } }

        await assert.rejects(extensions.createResource(f.config, tokens, otherPatient))
        assert.equal(lastPostStatus(f.requests, type), 404)
        assert.equal(f.created.size, 1, 'Rejected writes must not persist anything')
    })

    test(`Reference ${type}: do not report success for a malformed create response`, async (t) => {
        const f = await fixture()
        t.after(f.close)

        const tokens = await f.tokens({ scope: `patient/${type}.cr` })
        await extensions.createResource(f.config, tokens, makeResource(type))

        for (const location of ['missing', 'wrong'] as const) {
            f.createResponse.location = location

            await assert.rejects(
                extensions.createResource(f.config, tokens, makeResource(type)),
                `Reject ${location} Location`,
            )
        }

        f.createResponse.location = 'correct'
        f.createResponse.status = 200

        await assert.rejects(
            extensions.createResource(f.config, tokens, makeResource(type)),
            'FHIR create requires HTTP 201',
        )
        assert.equal(f.created.size, 4, 'Do not automatically retry writes with uncertain outcomes')
    })
}

test('Reference create accepts a FHIR versioned Location header', async (t) => {
    const f = await fixture()
    t.after(f.close)
    const tokens = await f.tokens({ scope: 'patient/Observation.c' })
    f.createResponse.location = 'history'

    const created = await extensions.createResource(f.config, tokens, extensions.temperature(launchContext, 37.2))

    assert.ok(f.created.has(`Observation/${created.id}`))
})

test('Reference write shapes reject unsupported fields and invalid measurements before POST', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const tokens = await f.tokens({ scope: 'patient/Observation.cr patient/DocumentReference.cr' })
    const observation = extensions.temperature(launchContext, 37.2, MEASURED_AT)
    const note = extensions.journalNote(launchContext, 'Synthetic note')
    const observationWithComponent = { ...observation, component: [] }
    const noteWithCategory = { ...note, category: [] }
    const noteWithAttachmentData = {
        ...note,
        content: [{ attachment: { contentType: 'application/pdf' as const, data: 'unsupported' } }],
    }
    const requestCount = f.requests.length

    assert.equal(observation.code.coding.length, 1)
    assert.match(observation.effectiveDateTime, /Z$/)
    assert.equal(extensions.temperature(launchContext, 25, MEASURED_AT).valueQuantity.value, 25)
    assert.equal(extensions.temperature(launchContext, 45, MEASURED_AT).valueQuantity.value, 45)
    assert.equal(extensions.temperature(launchContext, 37.1234, MEASURED_AT).valueQuantity.value, 37.1234)
    for (const invalid of [-1, 0, 24.9999, 45.0001, 50, Infinity, NaN, 37.12345]) {
        assert.throws(() => extensions.temperature(launchContext, invalid, MEASURED_AT))
        await assert.rejects(
            extensions.createResource(f.config, tokens, {
                ...observation,
                valueQuantity: { ...observation.valueQuantity, value: invalid },
            }),
        )
    }
    assert.throws(() => extensions.temperature(launchContext, 100_000_000, MEASURED_AT))

    await assert.rejects(
        extensions.createResource(f.config, tokens, {
            ...observation,
            code: {
                coding: [
                    ...observation.code.coding,
                    { system: 'http://loinc.org', code: '29463-7', display: 'Body weight' },
                ],
            },
        }),
    )
    await assert.rejects(
        extensions.createResource(f.config, tokens, {
            ...observation,
            effectiveDateTime: '2026-01-01T10:00:00+01:00',
        }),
    )
    await assert.rejects(extensions.createResource(f.config, tokens, observationWithComponent))
    await assert.rejects(extensions.createResource(f.config, tokens, noteWithCategory))
    await assert.rejects(extensions.createResource(f.config, tokens, noteWithAttachmentData))

    assert.equal(f.requests.length, requestCount, 'Invalid shapes must be rejected before reaching the FHIR server')
})

test('Consultation view writes launch-bound measurements and notes with CSRF and same-origin checks', async (t) => {
    const f = await fixture()
    t.after(f.close)
    const scopes = `${f.config.scopes} patient/Observation.cr patient/DocumentReference.cr`
    const app = await buildApp(f.config, shapeSteps(f, { exchange: async () => f.tokens({ scope: scopes }) }))
    t.after(async () => app.close())

    const { state, launchCookie } = await startBrowserLaunch(app, f)
    const callback = await app.inject({ url: callbackPath(state), cookies: { smart_launch: launchCookie } })
    const sessionCookie = cookieValue(callback, 'smart_session')
    const cookies = { smart_session: sessionCookie }
    const view = await app.inject({ url: '/app', cookies })
    const csrf = view.body.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1]

    assert.equal(view.statusCode, 200)
    assert.match(view.body, /aria-labelledby="writeback-title"/)
    assert.match(view.body, /name="kind" value="temperature"/)
    assert.match(view.body, /name="kind" value="note"/)
    assert.match(view.body, /<script src="\/writeback\.js" defer><\/script>/)
    assert.ok(csrf, 'Render a session-bound CSRF token into the forms')
    assert.match(view.body, /min="25" max="45"/)

    for (const value of ['0', '-1', '24.9999', '45.0001', '50', '', 'NaN', 'Infinity', '37.12345']) {
        const rejected: InjectResponse = await app.inject({
            method: 'POST',
            url: '/app/write',
            cookies,
            headers: {
                origin: new URL(f.config.redirectUri).origin,
                accept: 'application/json',
                'content-type': 'application/x-www-form-urlencoded',
            },
            payload: new URLSearchParams({ kind: 'temperature', csrf, value }).toString(),
        })
        assert.equal(rejected.statusCode, 400, `Reject temperature ${value}`)
        assert.match(rejected.body, /temperature from 25 to 45/)
    }
    assert.equal(f.created.size, 0)
    assert.equal(
        f.requests.some((request) => request.method === 'POST'),
        false,
    )

    for (const [kind, field, value, type] of [
        ['temperature', 'value', '37.4', 'Observation'],
        ['note', 'text', 'Patient reports improvement.', 'DocumentReference'],
    ] as const) {
        const response: InjectResponse = await app.inject({
            method: 'POST',
            url: '/app/write',
            cookies,
            headers: {
                origin: new URL(f.config.redirectUri).origin,
                accept: 'application/json',
                'content-type': 'application/x-www-form-urlencoded',
            },
            payload: new URLSearchParams({ kind, csrf, [field]: value }).toString(),
        })

        assert.equal(response.statusCode, 201)
        const result = z
            .object({ resourceType: z.string(), id: z.string(), location: z.string() })
            .parse(response.json())
        assert.equal(result.resourceType, type)
        assert.match(result.location, new RegExp(`/${type}/${result.id}$`))
        assert.equal(result.location, `${f.config.fhirBase}/${type}/${result.id}`)
        assert.ok(f.created.has(`${type}/${result.id}`))
        assert.equal(response.headers['content-type']?.split(';')[0], 'application/json')
    }

    const savedObservation = [...f.created.values()].find((resource) => resource.resourceType === 'Observation')
    assert.ok(savedObservation)
    const savedReferences = z
        .object({ subject: z.object({ reference: z.string() }), encounter: z.object({ reference: z.string() }) })
        .parse(savedObservation)
    assert.equal(savedReferences.subject.reference, 'Patient/p1')
    assert.equal(savedReferences.encounter.reference, 'Encounter/e1')

    const nativeSubmit = await app.inject({
        method: 'POST',
        url: '/app/write',
        cookies,
        headers: {
            origin: new URL(f.config.redirectUri).origin,
            'content-type': 'application/x-www-form-urlencoded',
        },
        payload: new URLSearchParams({ kind: 'note', csrf, text: 'Saved without JavaScript.' }).toString(),
    })

    assert.equal(nativeSubmit.statusCode, 201)
    assert.match(nativeSubmit.headers['content-type'] ?? '', /text\/html/)
    assert.ok(nativeSubmit.body.includes(`Location: <a href="${f.config.fhirBase}/DocumentReference/created-3`))
    assert.equal(f.created.size, 3)
})

test('Write-back rejects cross-origin, invalid CSRF and ungranted create scopes before FHIR POST', async (t) => {
    const f = await fixture()
    t.after(f.close)
    const app = await buildApp(f.config, shapeSteps(f))
    t.after(async () => app.close())

    const { state, launchCookie } = await startBrowserLaunch(app, f)
    const callback = await app.inject({ url: callbackPath(state), cookies: { smart_launch: launchCookie } })
    const cookies = { smart_session: cookieValue(callback, 'smart_session') }
    const view = await app.inject({ url: '/app', cookies })
    const csrf = view.body.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1]

    assert.ok(csrf)
    assert.match(view.body, /patient\/Observation\.c/)
    assert.match(view.body, /patient\/DocumentReference\.c/)
    assert.match(view.body, /<button class="button" type="submit" disabled>/)

    const submit = async (origin: string | undefined, formToken: string): Promise<InjectResponse> =>
        app.inject({
            method: 'POST',
            url: '/app/write',
            cookies,
            headers: {
                ...(origin ? { origin } : {}),
                accept: 'application/json',
                'content-type': 'application/x-www-form-urlencoded',
            },
            payload: new URLSearchParams({ kind: 'temperature', csrf: formToken, value: '37.4' }).toString(),
        })
    const crossOrigin = await submit('https://attacker.example', csrf)
    const missingOrigin = await submit(undefined, csrf)
    const invalidCsrf = await submit(new URL(f.config.redirectUri).origin, 'not-the-session-token')
    const missingScope = await submit(new URL(f.config.redirectUri).origin, csrf)

    assert.equal(crossOrigin.statusCode, 403)
    assert.deepEqual(crossOrigin.json(), { error: 'Write-back requires a same-origin request.' })
    assert.equal(missingOrigin.statusCode, 403)
    assert.equal(invalidCsrf.statusCode, 403)
    assert.equal(missingScope.statusCode, 403)
    assert.equal(f.requests.filter((request) => request.method === 'POST').length, 0)
})

test('Break it: authorization server rejects a reused code and an incorrect PKCE verifier', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const verifier = 'synthetic-verifier-for-break-it'
    const challenge = createHash('sha256').update(verifier).digest('base64url')

    async function exchange(code: string, codeVerifier: string): Promise<Response> {
        return fetch(`${f.config.issuer}/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: f.config.redirectUri,
                client_id: f.config.clientId,
                code_verifier: codeVerifier,
            }),
        })
    }

    f.registerCode('single-use-code', challenge)
    const first = await exchange('single-use-code', verifier)

    assert.equal(first.status, 200)

    const replay = await exchange('single-use-code', verifier)

    assert.equal(replay.status, 400)
    assert.deepEqual(await replay.json(), { error: 'invalid_grant' })

    f.registerCode('wrong-verifier-code', challenge)
    const wrongVerifier = await exchange('wrong-verifier-code', `${verifier}-wrong`)

    assert.equal(wrongVerifier.status, 400)
    assert.deepEqual(await wrongVerifier.json(), { error: 'invalid_grant' })
    assert.equal(f.tokenCalls(), 3)
})

test('Break it: FHIR server rejects a resource outside granted scopes with OperationOutcome', async (t) => {
    const f = await fixture()
    t.after(f.close)
    const tokens = await f.tokens()
    const response = await fetch(`${f.config.fhirBase}/Observation`, {
        method: 'POST',
        headers: { ...bearer(tokens), 'Content-Type': 'application/fhir+json' },
        body: JSON.stringify(extensions.temperature(launchContext, 37.4)),
    })

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), {
        resourceType: 'OperationOutcome',
        issue: [{ severity: 'error', code: 'forbidden' }],
    })
    assert.equal(f.created.size, 0)
})

test('Break it: FHIR server rejects an access token issued for another audience', async (t) => {
    const f = await fixture()
    t.after(f.close)
    const tokens = await f.tokens({ audience: 'https://another-fhir.example/fhir' })
    const response = await fetch(`${f.config.fhirBase}/Patient/p1`, { headers: bearer(tokens) })

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), {
        resourceType: 'OperationOutcome',
        issue: [{ severity: 'error', code: 'login' }],
    })
})
