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
