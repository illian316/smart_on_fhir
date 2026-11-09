import type { FastifyInstance } from 'fastify'
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'

import { buildApp } from '../src/app.ts'
import { describeTrend, summarizeCondition } from '../src/clinical-app.ts'
import type { ClinicalSummary } from '../src/extensions.ts'

import { signIn } from './browser.ts'
import { fixture, type Fixture } from './fixture.ts'

const CLINICAL_SCOPES = 'patient/Condition.s patient/Observation.s'

interface ClinicalApp {
    f: Fixture
    app: FastifyInstance
    cookies: { smart_session: string }
}

async function startClinicalApp(t: TestContext, scopes?: string): Promise<ClinicalApp> {
    const f = await fixture()
    t.after(f.close)

    const app = await buildApp(f.config)
    t.after(async () => app.close())

    const session = await signIn(app, f, scopes && `${f.config.scopes} ${scopes}`)

    return { f, app, cookies: { smart_session: session } }
}

function reading(value: number, code = 'Cel'): ClinicalSummary['measurements'][number] {
    return {
        resourceType: 'Observation',
        id: `obs-${value}`,
        effectiveDateTime: '2026-01-01T10:00:00Z',
        valueQuantity: { value, unit: 'degrees Celsius', system: 'http://unitsofmeasure.org', code },
    }
}

function summaryOf(values: number[]): ClinicalSummary {
    const measurements = values.map((value) => reading(value))

    return { conditions: [], measurements, trendReady: measurements.length >= 3 }
}

function observationRequests(f: Fixture): string[] {
    return f.requests.filter((r) => ['/fhir/Condition', '/fhir/Observation'].includes(r.path)).map((r) => r.path)
}

test('Clinical app: shows diagnoses with code system and chronological temperatures with LOINC, unit and trend', async (t) => {
    const { f, app, cookies } = await startClinicalApp(t, CLINICAL_SCOPES)

    const chart = await app.inject({ url: '/app', cookies })

    assert.match(chart.body, /href="\/clinical"/, 'The mini-app is reachable from /app')

    const response = await app.inject({ url: '/clinical', cookies })

    assert.equal(response.statusCode, 200, response.body)
    assert.match(response.body, /R05/)
    assert.match(response.body, /urn:oid:2\.16\.578\.1\.12\.4\.1\.1\.7170/)
    assert.match(response.body, /LOINC <code>8310-5<\/code> in <code>http:\/\/loinc\.org<\/code>/)
    assert.match(response.body, /degrees Celsius \(<code>Cel<\/code> in <code>http:\/\/unitsofmeasure\.org<\/code>\)/)
    assert.match(response.body, /Trend over 3 readings in degrees Celsius: rising, from 36\.1 to 36\.3/)

    const order = ['2026-01-01', '2026-01-02', '2026-01-03'].map((day) => response.body.indexOf(day))

    assert.deepEqual(
        order,
        order.toSorted((a, b) => a - b),
    )
    assert.ok(order.every((position) => position > 0))
    assert.equal(
        f.requests.some((r) => r.method !== 'GET' && r.path.startsWith('/fhir/')),
        false,
    )

    for (const token of f.issued.keys()) {
        assert.equal(response.body.includes(token), false)
    }
})

test('Clinical app: without Condition and Observation scopes it explains what to add and calls nothing', async (t) => {
    const { f, app, cookies } = await startClinicalApp(t)

    const response = await app.inject({ url: '/clinical', cookies })

    assert.equal(response.statusCode, 403)
    assert.match(response.body, /patient\/Condition\.s/)
    assert.match(response.body, /patient\/Observation\.s/)
    assert.match(response.body, /launch again/)
    assert.deepEqual(observationRequests(f), [])
})

test('Clinical app: fewer than three readings give no trend', async (t) => {
    const { f, app, cookies } = await startClinicalApp(t, CLINICAL_SCOPES)

    f.measurements.splice(2)

    const response = await app.inject({ url: '/clinical', cookies })

    assert.equal(response.statusCode, 200)
    assert.match(response.body, /No trend: it needs at least three readings in the same unit, and there are 2/)
    assert.doesNotMatch(response.body, /Trend over/)
})

test('Clinical app: mixed units are refused instead of trended', async (t) => {
    const { f, app, cookies } = await startClinicalApp(t, CLINICAL_SCOPES)

    f.measurements[0]!.valueQuantity.code = '[degF]'

    const response = await app.inject({ url: '/clinical', cookies })

    assert.equal(response.statusCode, 400)
    assert.match(response.body, /Mixed units/)
    assert.doesNotMatch(response.body, /Trend over/)
})

test('Clinical app: FHIR data is escaped and the page needs a session', async (t) => {
    const { f, app, cookies } = await startClinicalApp(t, CLINICAL_SCOPES)

    f.measurements[0]!.valueQuantity.unit = '<img src=x onerror=alert(1)>'

    const response = await app.inject({ url: '/clinical', cookies })

    assert.doesNotMatch(response.body, /<img/)
    assert.match(response.body, /&lt;img src=x onerror=alert\(1\)&gt;/)

    assert.equal((await app.inject('/clinical')).statusCode, 401)
})

test('Clinical summary helpers: condition label falls back to code, trend needs three readings', () => {
    const coded = { code: { coding: [{ system: 'sys', code: 'R05' }] } }

    assert.deepEqual(summarizeCondition(coded), {
        label: 'R05',
        code: 'R05',
        system: 'sys',
        status: undefined,
        since: undefined,
    })
    assert.equal(summarizeCondition({ code: { text: 'Cough' } }).label, 'Cough')
    assert.equal(summarizeCondition({ code: 'broken' }).label, 'Condition in an unrecognised format')

    assert.equal(describeTrend(summaryOf([36.1, 36.2])), undefined)
    assert.deepEqual(describeTrend(summaryOf([37, 36.5, 36])), {
        direction: 'falling',
        first: 37,
        last: 36,
        change: -1,
        min: 36,
        max: 37,
        unit: 'degrees Celsius',
    })
    assert.equal(describeTrend(summaryOf([36, 37, 36]))?.direction, 'steady')
})
