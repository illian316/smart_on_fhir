import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildApp } from '../src/app.ts'
import { TRANSACTION_TTL_MS } from '../src/types.ts'

import { shapeSteps } from './fakes.ts'
import { fixture } from './fixture.ts'
import { callbackPath, completeBrowserLaunch, cookieValue, startBrowserLaunch } from './launch-helpers.ts'

test('Scaffolding: launch cookie, single-use transaction and escaped patient page', async (t) => {
    const f = await fixture()
    t.after(f.close)

    let exchanges = 0
    const steps = shapeSteps(f, {
        exchange: async () => {
            exchanges++

            return f.tokens()
        },
    })
    const app = await buildApp(f.config, steps)
    t.after(async () => app.close())

    const { response, state, launchCookie } = await startBrowserLaunch(app, f)
    const cookie = response.cookies.find((candidate) => candidate.name === 'smart_launch')

    assert.ok(cookie?.httpOnly)
    assert.equal(cookie.sameSite, 'Lax')
    assert.equal(cookie.secure, undefined)

    const callbackUrl = callbackPath(state)
    const withoutCookie = await app.inject(callbackUrl)

    assert.equal(withoutCookie.statusCode, 400)
    assert.equal(exchanges, 0)

    const callback = await app.inject({ url: callbackUrl, cookies: { smart_launch: launchCookie } })

    assert.equal(callback.statusCode, 302)
    assert.equal(callback.headers.location, '/app')

    const replay = await app.inject({ url: callbackUrl, cookies: { smart_launch: launchCookie } })

    assert.equal(replay.statusCode, 400)
    assert.equal(exchanges, 1)

    const chart = await app.inject({ url: '/app', cookies: { smart_session: cookieValue(callback, 'smart_session') } })

    assert.equal(chart.statusCode, 200)
    assert.match(chart.body, /Synthetic &lt;Patient&gt;/)
    assert.equal(chart.headers['cache-control'], 'no-store')
    assert.match(String(chart.headers['content-security-policy']), /default-src 'none'/)
})

test('Scaffolding: cookies are Secure when the redirect URI is HTTPS', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const app = await buildApp({ ...f.config, redirectUri: 'https://app.example/callback' }, shapeSteps(f))
    t.after(async () => app.close())

    const { response } = await startBrowserLaunch(app, f)
    const cookies = response.cookies.filter((candidate) => candidate.name.startsWith('smart_'))

    assert.equal(cookies.length, 2)
    assert.ok(cookies.every((candidate) => candidate.secure && candidate.httpOnly))
})

test('Scaffolding: a new launch in the same browser invalidates the previous transaction', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const app = await buildApp(f.config, shapeSteps(f))
    t.after(async () => app.close())

    const first = await startBrowserLaunch(app, f, 'synthetic-launch-id-0001')
    const second = await startBrowserLaunch(app, f, 'synthetic-launch-id-0002', { smart_launch: first.launchCookie })

    const stale = await app.inject({ url: callbackPath(first.state), cookies: { smart_launch: first.launchCookie } })
    const fresh = await app.inject({ url: callbackPath(second.state), cookies: { smart_launch: second.launchCookie } })

    assert.equal(stale.statusCode, 400)
    assert.equal(fresh.statusCode, 302)
})

test('Scaffolding: pages never contain tokens, codes or the PKCE verifier', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const tokens = await f.tokens()
    const steps = shapeSteps(f, { exchange: async () => tokens })
    const app = await buildApp(f.config, steps)
    t.after(async () => app.close())

    const { state, launchCookie } = await startBrowserLaunch(app, f)
    const callback = await app.inject({
        url: callbackPath(state, 'synthetic-code-0123456789'),
        cookies: { smart_launch: launchCookie },
    })
    const chart = await app.inject({ url: '/app', cookies: { smart_session: cookieValue(callback, 'smart_session') } })

    const browserOutput = chart.body + JSON.stringify(callback.headers) + JSON.stringify(chart.headers)
    const forbidden = [tokens.access_token, tokens.id_token, 'synthetic-code-0123456789', 'synthetic-verifier']

    for (const secret of forbidden) {
        assert.equal(browserOutput.includes(secret as string), false, `${String(secret).slice(0, 12)} leaked`)
    }

    assert.doesNotMatch(browserOutput, /(id_token|code_verifier)(=|&quot;|")/)
})

test('Scaffolding: the app session expires with the token and never outlives 30 minutes', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const lifetimes = [
        { expiresIn: 300, valid: 299_000, expired: 301_000 },
        { expiresIn: 7200, valid: 1_799_000, expired: 1_801_000 },
    ]

    for (const { expiresIn, valid, expired } of lifetimes) {
        const steps = shapeSteps(f, { exchange: async () => f.tokens({ expires_in: expiresIn }) })
        const app = await buildApp(f.config, steps)
        const callback = await completeBrowserLaunch(app, f)
        const cookies = { smart_session: cookieValue(callback, 'smart_session') }
        const now = Date.now()

        assert.equal(callback.statusCode, 302)

        t.mock.method(Date, 'now', () => now + valid)
        assert.equal((await app.inject({ url: '/app', cookies })).statusCode, 200)

        t.mock.method(Date, 'now', () => now + expired)
        assert.equal((await app.inject({ url: '/app', cookies })).statusCode, 401)

        t.mock.restoreAll()
        await app.close()
    }
})

test('Scaffolding: a pending launch expires after the transaction lifetime', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const app = await buildApp(f.config, shapeSteps(f))
    t.after(async () => app.close())

    const { state, launchCookie } = await startBrowserLaunch(app, f)
    const now = Date.now()

    t.mock.method(Date, 'now', () => now + TRANSACTION_TTL_MS + 1000)

    const late = await app.inject({ url: callbackPath(state), cookies: { smart_launch: launchCookie } })

    assert.equal(late.statusCode, 400)
})
