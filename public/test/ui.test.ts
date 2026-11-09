import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildApp } from '../src/app.ts'
import { page } from '../src/http.ts'

import { shapeSteps } from './fakes.ts'
import { fixture } from './fixture.ts'
import { callbackPath, cookieValue, startBrowserLaunch } from './launch-helpers.ts'

test('UI: landing and error pages share a local, script-free accessible shell', async (t) => {
    const f = await fixture()
    t.after(f.close)
    const app = await buildApp(f.config, shapeSteps(f))
    t.after(async () => app.close())

    for (const url of ['/', '/app']) {
        const response = await app.inject({ url })
        assert.equal(response.statusCode, url === '/' ? 200 : 401)
        assert.match(response.body, /href="\/styles.css"/)
        assert.match(response.body, /href="#main">Skip to content/)
        assert.match(response.body, /<main id="main" tabindex="-1">/)
        assert.doesNotMatch(response.body, /<script|style=/)
        assert.match(String(response.headers['content-security-policy']), /default-src 'none'; style-src 'self';/)
        assert.equal(response.headers['cache-control'], 'no-store')
    }

    const landing = await app.inject({ url: '/' })
    assert.match(landing.body, /does not create patient context/)
    assert.match(landing.body, /id="launch-guide"/)
    assert.equal(f.requests.length, 0, 'Landing and stylesheet must not fetch clinical data')

    const css = await app.inject({ url: '/styles.css' })
    assert.equal(css.statusCode, 200)
    assert.match(String(css.headers['content-type']), /text\/css/)
    assert.match(css.body, /--orange: #c75b0a/)
    assert.match(css.body, /--green: #287a35/)
    assert.match(css.body, /--light-blue: #147ca8/)
    assert.match(css.body, /\.topbar[^}]*linear-gradient\(180deg, #67b4ff/)
    assert.match(css.body, /\.panel[^}]*inset 1px 1px #fff/)
    assert.match(css.body, /\.button[^}]*#c75b0a/)
    assert.match(css.body, /max-width: 600px/)
    assert.match(css.body, /prefers-reduced-motion/)

    const writebackScript = await app.inject({ url: '/writeback.js' })
    assert.equal(writebackScript.statusCode, 200)
    assert.match(writebackScript.body, /button\.disabled = true/)
    assert.match(writebackScript.body, /body\.location/)
    assert.match(writebackScript.body, /fetch\('\/app'/)
    assert.match(writebackScript.body, /current\.replaceChildren/)

    const escaped = page('<Patient & clinician>', '<p>Content</p>')
    assert.match(escaped, /<title>&lt;Patient &amp; clinician&gt;<\/title>/)
    assert.doesNotMatch(escaped, /<Patient/)
})

test('UI: consultation retains patient context, scope details, readings and launch diagnostics', async (t) => {
    const f = await fixture()
    t.after(f.close)
    const app = await buildApp(
        f.config,
        shapeSteps(f, {
            exchange: async () => f.tokens({ scope: `${f.config.scopes} patient/Condition.s patient/Observation.s` }),
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
    const policy = String(response.headers['content-security-policy'])
    assert.match(policy, /(?:^|; )connect-src 'self'(?:;|$)/)
    assert.match(policy, /(?:^|; )default-src 'none'(?:;|$)/)
    assert.match(response.body, /class="workspace"/)
    assert.match(response.body, /Synthetic &lt;Patient&gt;/)
    assert.doesNotMatch(response.body, /Synthetic <Patient>/)
    assert.match(response.body, /<dt>Age<\/dt><dd>35<\/dd>/)
    assert.match(response.body, /<span class="badge">in-progress<\/span>/)
    assert.match(response.body, /Requested/)
    assert.match(response.body, /Granted/)
    assert.match(response.body, /class="temperature-value">36.3 /)
    assert.match(response.body, /<polyline class="chart-line"/)
    assert.match(response.body, /View all readings &amp; clinical codes \(3\)/)
    assert.match(response.body, /Launch diagnostics/)
    assert.match(response.body, /Progress: 10 of 10 steps OK/)
})

test('UI: new write-back readings appear in the summary and create a trend at three matching units', async (t) => {
    const f = await fixture()
    t.after(f.close)
    f.measurements.splice(2)
    const app = await buildApp(
        f.config,
        shapeSteps(f, {
            exchange: async () =>
                f.tokens({
                    scope: `${f.config.scopes} patient/Condition.s patient/Observation.cs`,
                }),
        }),
    )
    t.after(async () => app.close())

    const { state, launchCookie } = await startBrowserLaunch(app, f)
    const callback = await app.inject({ url: callbackPath(state), cookies: { smart_launch: launchCookie } })
    const cookies = { smart_session: cookieValue(callback, 'smart_session') }
    const before = await app.inject({ url: '/app', cookies })
    const csrf = before.body.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1]
    assert.ok(csrf)
    assert.match(before.body, /2 readings recorded/)
    assert.doesNotMatch(before.body, /<polyline/)

    const saved = await app.inject({
        method: 'POST',
        url: '/app/write',
        cookies,
        headers: {
            origin: new URL(f.config.redirectUri).origin,
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
        },
        payload: new URLSearchParams({ kind: 'temperature', csrf, value: '37.4' }).toString(),
    })
    assert.equal(saved.statusCode, 201)

    const after = await app.inject({ url: '/app', cookies })
    assert.equal(after.statusCode, 200)
    assert.match(after.body, /class="temperature-value">37\.4 /)
    assert.match(after.body, /37\.4 degrees Celsius \(Cel\)/)
    assert.match(after.body, /http:\/\/loinc.org \| 8310-5/)
    assert.match(after.body, /Unit system: http:\/\/unitsofmeasure.org/)
    assert.match(after.body, /3 readings recorded/)
    assert.match(after.body, /<polyline/)
    assert.equal((after.body.match(/class="chart-marker"/g) ?? []).length, 3)
    assert.match(after.body, /37\.4 Cel \(http:\/\/unitsofmeasure.org\); http:\/\/loinc.org \| 8310-5/)

    f.measurements[0]!.valueQuantity.code = '[degF]'
    const mixed = await app.inject({ url: '/app', cookies })
    assert.match(mixed.body, /Mixed units/)
    assert.doesNotMatch(mixed.body, /<polyline/)
    assert.equal(f.created.size, 1, 'Refreshing the summary must not resubmit a write')
})
