import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildApp } from '../src/app.ts'
import * as extensions from '../src/extensions.ts'

import { shapeSteps } from './fakes.ts'
import { fixture, launchContext } from './fixture.ts'
import { callbackPath, cookieValue, startBrowserLaunch } from './launch-helpers.ts'

const CLINICAL_SCOPES = 'patient/Condition.s patient/Observation.s'
const TEMPERATURE_CODE = '8310-5'
const HEART_RATE_CODE = '8867-4'

test('Clinical page: granted scopes show coded readings and a trend', async (t) => {
    const f = await fixture()
    t.after(f.close)
    const app = await buildApp(
        f.config,
        shapeSteps(f, {
            exchange: async () => f.tokens({ scope: `${f.config.scopes} ${CLINICAL_SCOPES}` }),
        }),
    )
    t.after(async () => app.close())
    const { state, launchCookie } = await startBrowserLaunch(app, f)
    const callback = await app.inject({ url: callbackPath(state), cookies: { smart_launch: launchCookie } })
    const response = await app.inject({
        url: '/app',
        cookies: { smart_session: cookieValue(callback, 'smart_session') },
    })

    assert.equal(response.statusCode, 200)
    assert.match(response.body, /Clinical Summary/)
    assert.match(response.body, /<polyline/)
    assert.match(response.body, /36.1 degrees Celsius/)
    assert.match(response.body, /http:\/\/loinc.org \| 8310-5/)

    f.measurements[0]!.valueQuantity.code = '[degF]'
    const mixed = await app.inject({ url: '/app', cookies: { smart_session: cookieValue(callback, 'smart_session') } })
    assert.equal(mixed.statusCode, 200)
    assert.match(mixed.body, /Mixed units/)
    assert.doesNotMatch(mixed.body, /<polyline/)
})

test('Clinical page: missing search scopes do not prevent the chart from loading', async (t) => {
    const f = await fixture()
    t.after(f.close)
    const app = await buildApp(f.config, shapeSteps(f))
    t.after(async () => app.close())
    const { state, launchCookie } = await startBrowserLaunch(app, f)
    const callback = await app.inject({ url: callbackPath(state), cookies: { smart_launch: launchCookie } })
    const response = await app.inject({
        url: '/app',
        cookies: { smart_session: cookieValue(callback, 'smart_session') },
    })

    assert.equal(response.statusCode, 200)
    assert.match(response.body, /clinical search permissions were not granted/)
    assert.equal(
        f.requests.some((request) => request.path === '/fhir/Observation'),
        false,
    )
})

test('Reference clinical summary: patient/encounter diagnoses and chronological LOINC/UCUM trend', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const tokens = await f.tokens({ scope: CLINICAL_SCOPES })
    const result = await extensions.clinicalSummary(f.config, tokens, launchContext, TEMPERATURE_CODE)

    assert.equal(result.conditions.length, 1)
    assert.deepEqual(
        result.measurements.map((m) => m.id),
        ['obs1', 'obs2', 'obs3'],
    )
    assert.deepEqual(
        result.measurements.map((m) => m.valueQuantity.value),
        [36.1, 36.2, 36.3],
    )
    assert.ok(result.measurements.every((m) => m.valueQuantity.system === 'http://unitsofmeasure.org'))
    assert.equal(result.trendReady, true)

    const html = extensions.renderClinicalSummary(result)
    assert.match(html, /<polyline/)
    assert.match(html, /http:\/\/loinc.org \| 8310-5/)
    assert.match(html, /http:\/\/unitsofmeasure.org/)
    assert.match(html, /36.1 degrees Celsius \(Cel\)/)
    assert.match(html, /urn:oid:2.16.578.1.12.4.1.1.7170/)

    result.conditions[0]!.code!.coding[0]!.display = '<script>alert(1)</script>'
    assert.doesNotMatch(extensions.renderClinicalSummary(result), /<script>/)

    const conditionQuery = f.requests.find((r) => r.path === '/fhir/Condition')?.query
    assert.ok(
        ['e1', 'Encounter/e1'].includes(conditionQuery?.encounter ?? ''),
        'Limit diagnoses to the active encounter',
    )
    assert.equal(f.requests.filter((r) => r.path === '/fhir/Observation').length, 1)

    f.measurements.push({
        ...f.measurements[0]!,
        id: 'pulse',
        code: { coding: [{ system: 'http://loinc.org', code: HEART_RATE_CODE, display: 'Heart rate' }] },
        valueQuantity: { value: 80, unit: 'beats per minute', system: 'http://unitsofmeasure.org', code: '/min' },
    })

    const pulse = await extensions.clinicalSummary(f.config, tokens, launchContext, HEART_RATE_CODE)

    assert.deepEqual(
        pulse.measurements.map((m) => m.id),
        ['pulse'],
        'Use the requested LOINC code, not a hardcoded one',
    )
    assert.equal(pulse.trendReady, false)

    f.measurements.splice(2)
    const pair = await extensions.clinicalSummary(f.config, tokens, launchContext, TEMPERATURE_CODE)
    assert.equal(pair.trendReady, false)
    assert.doesNotMatch(extensions.renderClinicalSummary(pair), /<polyline/)

    f.measurements.splice(1)
    const single = await extensions.clinicalSummary(f.config, tokens, launchContext, TEMPERATURE_CODE)

    assert.equal(single.trendReady, false, 'One measurement is not a trend')
    assert.doesNotMatch(extensions.renderClinicalSummary(single), /<polyline/)

    f.measurements.splice(0)
    const empty = await extensions.clinicalSummary(f.config, tokens, launchContext, TEMPERATURE_CODE)

    assert.equal(empty.trendReady, false)
    assert.deepEqual(empty.measurements, [])
    assert.match(extensions.renderClinicalSummary(empty), /No temperature readings recorded/)
})

test('Reference clinical summary: never combine incompatible units into a trend', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const tokens = await f.tokens({ scope: CLINICAL_SCOPES })
    await extensions.clinicalSummary(f.config, tokens, launchContext)

    f.measurements[0]!.valueQuantity.code = '[degF]'

    await assert.rejects(
        async () => extensions.clinicalSummary(f.config, tokens, launchContext),
        'Mixed units must not be silently compared',
    )
})
