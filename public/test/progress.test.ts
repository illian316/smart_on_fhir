import type { FastifyInstance } from 'fastify'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildApp } from '../src/app.ts'
import { Attempts } from '../src/progress.ts'
import type { Steps } from '../src/types.ts'

import { shapeSteps, unfinishedSteps } from './fakes.ts'
import { fixture, type Fixture } from './fixture.ts'
import { callbackPath, cookieValue, launchPath, startBrowserLaunch } from './launch-helpers.ts'

const PASSED = '✅'
const FAILED = '❌'
const PENDING = '⬜'

function count(body: string, icon: string): number {
    return body.split(`<li>${icon}`).length - 1
}

function itemFor(body: string, step: number): string {
    const item = body
        .split('<li>')
        .slice(1)
        .find((candidate) => candidate.includes(`TODO ${step} `))

    assert.ok(item, `TODO ${step} is missing from the checklist`)

    return item
}

async function setup(
    t: { after: (fn: () => Promise<void>) => void },
    overrides: (f: Fixture) => Partial<Steps>,
): Promise<{ f: Fixture; app: FastifyInstance }> {
    const f = await fixture()
    t.after(f.close)

    const app = await buildApp(f.config, shapeSteps(f, overrides(f)))
    t.after(async () => app.close())

    return { f, app }
}

test('Progress: unfinished steps return 501 with the first TODO failing and the rest pending', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const app = await buildApp(f.config, unfinishedSteps)
    t.after(async () => app.close())

    const response = await app.inject(launchPath(f))

    assert.equal(response.statusCode, 501)
    assert.match(itemFor(response.body, 1), /❌/)
    assert.match(itemFor(response.body, 1), /Not implemented yet/)
    assert.match(response.body, /Hint: Return \{ iss, launch \}/)
    assert.match(response.body, /refresh this tab/)
    assert.equal(count(response.body, FAILED), 1)
    assert.equal(count(response.body, PENDING), 9)
    assert.match(
        response.body,
        /href="https:\/\/build\.fhir\.org\/ig\/HL7\/smart-app-launch\/en\/app-launch\.html#step-3-discovery"/,
    )
    assert.match(response.body, /pre-registers hackathon-public/)
    assert.match(response.body, /not a security certification/)
    assert.match(itemFor(response.body, 1), /Why: iss names the FHIR server/)
    assert.match(itemFor(response.body, 1), /href="[^"]*app-launch\.html#step-2-launch-ehr">SMART spec/)
    assert.match(itemFor(response.body, 1), /public\/src\/steps\.ts">solved steps\.ts/)
    assert.match(itemFor(response.body, 1), /read and compare this step/)
    assert.match(itemFor(response.body, 1), /README\.md#stuck">Stuck\?/)
    assert.doesNotMatch(response.body, /git (fetch|checkout)/)
    assert.doesNotMatch(response.body, /Before you build/)
    assert.doesNotMatch(itemFor(response.body, 2), /Why:|Rescue:/)
})

test('Progress: a wrong PKCE challenge fails step 3 after steps 1 and 2 pass', async (t) => {
    const { f, app } = await setup(t, () => ({
        pkce: () => ({ verifier: 'v'.repeat(43), challenge: 'not-the-hash' }),
    }))

    const response = await app.inject(launchPath(f))

    assert.equal(response.statusCode, 502)
    assert.match(itemFor(response.body, 1), /✅/)
    assert.match(itemFor(response.body, 2), /✅/)
    assert.match(itemFor(response.body, 3), /❌/)
    assert.match(itemFor(response.body, 3), /challenge is missing or does not match/)
    assert.match(itemFor(response.body, 4), /⬜/)
})

test('Progress: code_verifier in the authorization URL fails step 5', async (t) => {
    const { f, app } = await setup(t, (f) => {
        const base = shapeSteps(f)

        return {
            authorizationUrl: (config, transaction) =>
                `${base.authorizationUrl(config, transaction)}&code_verifier=${transaction.verifier}`,
        }
    })

    const response = await app.inject(launchPath(f))

    assert.equal(response.statusCode, 502)
    assert.match(itemFor(response.body, 4), /✅/)
    assert.match(itemFor(response.body, 5), /❌/)
    assert.match(response.body, /Never put it in the authorization URL/)
    assert.equal(response.body.includes('synthetic-verifier'), false)
})

test('Progress: a TypeError message is shown escaped and truncated', async (t) => {
    const { f, app } = await setup(t, () => ({
        discover: async () => {
            throw new TypeError(`<script>alert(1)</script>${'x'.repeat(1000)}`)
        },
    }))

    const response = await app.inject(launchPath(f))

    assert.equal(response.statusCode, 502)
    assert.match(response.body, /TypeError: &lt;script&gt;alert\(1\)&lt;\/script&gt;x+\.\.\./)
    assert.doesNotMatch(response.body, /<script>/)
    assert.ok(response.body.length < 20_000)
    assert.doesNotMatch(response.body, /x{400}/)
})

test('Progress: known secrets are redacted from errors thrown by later steps', async (t) => {
    const tokens = { value: undefined as Awaited<ReturnType<Fixture['tokens']>> | undefined }
    const captured = { verifier: '', state: '' }
    const code = 'synthetic code/with+chars-0123'
    const launch = 'synthetic-launch-id-secret-01'

    const { f, app } = await setup(t, (f) => ({
        newTransaction: (l, d, proof) => {
            const transaction = shapeSteps(f).newTransaction(l, d, proof)
            captured.verifier = transaction.verifier
            captured.state = transaction.state

            return transaction
        },
        exchange: async () => {
            tokens.value = await f.tokens({ refresh_token: 'synthetic-refresh-token-0123' })

            return tokens.value
        },
        verifyIdentity: async (_config, _discovery, received) => {
            throw new Error(
                [
                    received.access_token,
                    received.id_token,
                    received.refresh_token,
                    code,
                    encodeURIComponent(code),
                    captured.verifier,
                    captured.state,
                    launch,
                ].join(' | '),
            )
        },
    }))

    const { state, launchCookie } = await startBrowserLaunch(app, f, launch)
    const response = await app.inject({ url: callbackPath(state, code), cookies: { smart_launch: launchCookie } })

    assert.equal(response.statusCode, 502)
    assert.match(response.body, /\[redacted\]/)
    assert.match(itemFor(response.body, 7), /✅/)
    assert.match(itemFor(response.body, 8), /❌/)

    const secrets = [
        tokens.value?.access_token,
        tokens.value?.id_token,
        tokens.value?.refresh_token,
        code,
        encodeURIComponent(code),
        captured.verifier,
        captured.state,
        launch,
    ]

    for (const secret of secrets) {
        assert.equal(response.body.includes(secret as string), false, `${String(secret).slice(0, 12)} leaked`)
    }
})

test('Progress: a failed shape check does not expose the returned token response', async (t) => {
    const tokens = { value: undefined as Awaited<ReturnType<Fixture['tokens']>> | undefined }

    const { f, app } = await setup(t, (f) => ({
        exchange: async () => {
            tokens.value = await f.tokens()

            return { ...tokens.value, token_type: 'MAC' } as never
        },
    }))

    const { state, launchCookie } = await startBrowserLaunch(app, f)
    const response = await app.inject({ url: callbackPath(state), cookies: { smart_launch: launchCookie } })

    assert.equal(response.statusCode, 502)
    assert.match(itemFor(response.body, 7), /token_type/)
    assert.equal(response.body.includes(tokens.value?.access_token as string), false)
    assert.equal(response.body.includes(tokens.value?.id_token as string), false)
})

test('Progress: overlapping launches keep separate checklists and each browser sees only its own', async (t) => {
    let failIdentity = false

    const { f, app } = await setup(t, () => ({
        verifyIdentity: async () => {
            if (failIdentity) {
                throw new Error('step 8 broke')
            }

            return 'h1'
        },
    }))

    const first = await startBrowserLaunch(app, f, 'synthetic-launch-id-0001')
    const second = await startBrowserLaunch(app, f, 'synthetic-launch-id-0002')

    assert.notEqual(first.progressCookie, second.progressCookie)

    failIdentity = true

    const failed = await app.inject({ url: callbackPath(second.state), cookies: { smart_launch: second.launchCookie } })

    failIdentity = false

    const succeeded = await app.inject({
        url: callbackPath(first.state),
        cookies: { smart_launch: first.launchCookie },
    })

    assert.equal(failed.statusCode, 502)
    assert.equal(succeeded.statusCode, 302)

    const firstHome = await app.inject({
        url: '/',
        cookies: { smart_progress: cookieValue(succeeded, 'smart_progress') },
    })
    const secondHome = await app.inject({ url: '/', cookies: { smart_progress: second.progressCookie } })
    const strangerHome = await app.inject('/')

    assert.equal(count(firstHome.body, PASSED), 1 + 9)
    assert.equal(count(firstHome.body, PENDING), 1)
    assert.equal(count(secondHome.body, PASSED), 1 + 7)
    assert.equal(count(secondHome.body, FAILED), 1)
    assert.equal(count(secondHome.body, PENDING), 2)
    assert.doesNotMatch(strangerHome.body, /Progress:/)
    assert.doesNotMatch(strangerHome.body, /TODO 1/)
})

test('Progress: shape-correct steps reach the chart with every step passing and only allowlisted fields', async (t) => {
    const { f, app } = await setup(t, () => ({
        loadChart: async (_config, tokens, context) => ({
            patientName: 'Synthetic <Patient>',
            age: null,
            encounter: context.encounter,
            status: 'in-progress',
            started: '2026-01-01T10:00:00Z',
            clinician: 'Test clinician',
            ...({ access_token: tokens.access_token, refresh_token: 'leaked-refresh-token' } as object),
        }),
    }))

    const { state, launchCookie } = await startBrowserLaunch(app, f)
    const callback = await app.inject({ url: callbackPath(state), cookies: { smart_launch: launchCookie } })
    const chart = await app.inject({ url: '/app', cookies: { smart_session: cookieValue(callback, 'smart_session') } })

    assert.equal(chart.statusCode, 200)
    assert.equal(count(chart.body, PASSED), 1 + 10)
    assert.equal(count(chart.body, FAILED) + count(chart.body, PENDING), 0)
    assert.match(chart.body, /Progress: 10 of 10 steps OK/)
    assert.match(itemFor(chart.body, 3), /<details><summary>Why this step<\/summary>/)
    assert.doesNotMatch(chart.body, /Rescue:/)
    assert.match(chart.body, /<h2>Before you build<\/h2>/)
    assert.match(chart.body, /network tab/)
    assert.match(chart.body, /public\/EXERCISES\.md#problem-cards/)
    assert.match(chart.body, /<dt>clinician<\/dt><dd>Test clinician<\/dd>/)
    assert.doesNotMatch(chart.body, /<dt>(access_token|refresh_token)<\/dt>|leaked-refresh-token/)
    assert.equal(chart.body.includes((await f.tokens()).access_token), false)
})

test('Progress: a chart failure keeps steps 1 to 9 passing', async (t) => {
    const { f, app } = await setup(t, () => ({
        loadChart: async (_config, _tokens, context) => ({
            patientName: 'Synthetic Patient',
            age: 40,
            encounter: context.encounter,
            status: 'finished',
            started: '2026-01-01T10:00:00Z',
        }),
    }))

    const { state, launchCookie } = await startBrowserLaunch(app, f)
    const callback = await app.inject({ url: callbackPath(state), cookies: { smart_launch: launchCookie } })
    const chart = await app.inject({ url: '/app', cookies: { smart_session: cookieValue(callback, 'smart_session') } })

    assert.equal(chart.statusCode, 502)
    assert.equal(count(chart.body, PASSED), 1 + 9)
    assert.match(itemFor(chart.body, 10), /❌/)
    assert.match(itemFor(chart.body, 10), /status is missing or does not match/)
    assert.doesNotMatch(chart.body, /Before you build/)
})

test('Progress: errors outside a step keep the generic page', async (t) => {
    const { app } = await setup(t, () => ({}))

    const response = await app.inject('/callback')

    assert.equal(response.statusCode, 400)
    assert.match(response.body, /No pending launch in this browser/)
    assert.doesNotMatch(response.body, /Progress:/)
})

test('Progress: the attempt store is bounded and attempts expire', async (t) => {
    const attempts = new Attempts()
    const first = attempts.create()

    for (let i = 0; i < 600; i++) {
        attempts.create()
    }

    assert.equal(attempts.get(first.id), undefined)

    const latest = attempts.create()
    const now = Date.now()

    assert.equal(attempts.get(latest.id), latest)

    t.mock.method(Date, 'now', () => now + 1_900_000)

    assert.equal(attempts.get(latest.id), undefined)
})
