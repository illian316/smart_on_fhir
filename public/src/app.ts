import cookie from '@fastify/cookie'
import Fastify, { LogController, type FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
    checkAuthorizationUrl,
    checkChart,
    checkCode,
    checkContext,
    checkDiscovery,
    checkIdentity,
    checkLaunch,
    checkPkce,
    checkTokens,
    checkTransaction,
} from './checks.ts'
import { AppError, splitScopes, type Config } from './config.ts'
import {
    clinicalSummary,
    createResourceWithLocation,
    journalNote,
    renderClinicalSummary,
    temperature,
} from './extensions.ts'
import { escapeHtml, isSameSecret, page, randomToken } from './http.ts'
import { Attempts, renderChecklist, type Attempt } from './progress.ts'
import { configureServer } from './server.ts'
import { steps } from './steps.ts'
import { TRANSACTION_TTL_MS, type Chart, type Session, type Steps, type Transaction } from './types.ts'

const LAUNCH_COOKIE = 'smart_launch'
const SESSION_COOKIE = 'smart_session'
const PROGRESS_COOKIE = 'smart_progress'

const MAX_PENDING_LAUNCHES = 1000
const MAX_SESSIONS = 1000
const MAX_SESSION_SECONDS = 1800
const PROGRESS_SECONDS = 1800
const WriteFormSchema = z.discriminatedUnion('kind', [
    z
        .object({
            kind: z.literal('temperature'),
            csrf: z.string().min(1),
            value: z
                .string()
                .regex(/^-?\d{1,8}(?:\.\d{1,4})?$/)
                .transform(Number),
        })
        .strict(),
    z
        .object({
            kind: z.literal('note'),
            csrf: z.string().min(1),
            text: z.string().trim().min(1).max(2000),
        })
        .strict(),
])

interface PendingLaunch {
    transaction: Transaction
    attempt: Attempt
    storedAt: number
}

export async function buildApp(config: Config, implementation: Steps = steps): Promise<FastifyInstance> {
    const app = Fastify({ logger: true, logController: new LogController({ disableRequestLogging: true }) })
    configureServer(app)
    await app.register(cookie)
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) =>
        done(null, new URLSearchParams(String(body))),
    )

    const api = implementation
    const attempts = new Attempts()
    const transactions = new Map<string, PendingLaunch>()
    const sessions = new Map<string, Session>()

    const cookieOptions = {
        path: '/',
        httpOnly: true,
        sameSite: 'lax' as const,
        secure: new URL(config.redirectUri).protocol === 'https:',
    }

    app.addHook('onRequest', async () => {
        const now = Date.now()

        attempts.prune()

        for (const [key, pending] of transactions) {
            if (now - pending.storedAt > TRANSACTION_TTL_MS) {
                transactions.delete(key)
            }
        }

        for (const [key, session] of sessions) {
            if (session.expiresAt <= now) {
                sessions.delete(key)
            }
        }
    })

    app.get('/', async (request, reply) => {
        const attempt = attempts.get(request.cookies[PROGRESS_COOKIE])
        const intro = `
            <section class="panel hero" aria-labelledby="welcome-title">
                <div>
                    <span class="badge">EHR-connected workspace</span>
                    <h2 id="welcome-title">A clearer view.<br><span>A connected consultation.</span></h2>
                    <p>Patient context, clinical insights and your SMART launch journey. One focused workspace.</p>
                    <a class="button" href="#launch-guide">Explore the launch flow <span aria-hidden="true">&nbsp; &rarr;</span></a>
                </div>
                <div class="orbital" aria-hidden="true"><div class="orbital-core">+</div></div>
            </section>
            <section id="launch-guide" class="guide-grid" aria-label="Getting started">
                <article class="panel"><span class="eyebrow">01 / Launch</span><h3>Start in your EHR</h3>
                    <p>Launch this app from the EPJ app picker. Opening this page does not create patient context.</p></article>
                <article class="panel"><span class="eyebrow">02 / Connect</span><h3>Bring the right context</h3>
                    <p>The SMART authorization flow supplies the patient, encounter and permissions for your consultation.</p></article>
                <article class="panel"><span class="eyebrow">03 / Explore</span><h3>Focus on the patient</h3>
                    <p>Review encounter diagnoses and coded temperature readings when clinical search permissions are granted.</p></article>
            </section>`
        const progress = attempt ? renderChecklist(attempt.checklist()) : ''

        return reply.type('text/html').send(page('Your clinical launchpad', intro + progress))
    })

    app.get('/launch', async (request, reply) => {
        if (transactions.size >= MAX_PENDING_LAUNCHES) {
            throw new AppError(503, 'Too many pending launches; try again later.')
        }

        const attempt = attempts.create()
        reply.setCookie(PROGRESS_COOKIE, attempt.id, { ...cookieOptions, maxAge: PROGRESS_SECONDS })
        attempt.remember(queryText(request.query, 'launch'))

        const launch = await attempt.run(
            1,
            () => api.readLaunch(request.query, config),
            (value) => checkLaunch(value, request.query, config),
        )
        const discovery = await attempt.run(
            2,
            async () => api.discover(config),
            (value) => checkDiscovery(value, config),
        )
        const proof = await attempt.run(3, () => api.pkce(), checkPkce)
        const transaction = await attempt.run(
            4,
            () => api.newTransaction(launch, discovery, proof),
            (value) => checkTransaction(value, launch, discovery, proof),
        )
        const location = await attempt.run(
            5,
            () => api.authorizationUrl(config, transaction),
            (value) => checkAuthorizationUrl(value, config, transaction),
        )

        const previousTransactionId = request.cookies[LAUNCH_COOKIE]

        if (previousTransactionId) {
            transactions.delete(previousTransactionId)
        }

        const transactionId = randomToken()
        transactions.set(transactionId, { transaction, attempt, storedAt: Date.now() })
        reply.setCookie(LAUNCH_COOKIE, transactionId, { ...cookieOptions, maxAge: TRANSACTION_TTL_MS / 1000 })

        return reply.redirect(location)
    })

    app.get('/callback', async (request, reply) => {
        const transactionId = request.cookies[LAUNCH_COOKIE]
        const pending = transactionId ? transactions.get(transactionId) : undefined

        if (!transactionId || !pending) {
            throw new AppError(400, 'No pending launch in this browser. Launch again.')
        }

        if (sessions.size >= MAX_SESSIONS) {
            throw new AppError(503, 'Too many sessions; try again later.')
        }

        const { transaction, attempt } = pending

        transactions.delete(transactionId)
        reply.clearCookie(LAUNCH_COOKIE, cookieOptions)
        attempt.remember(queryText(request.query, 'code'), queryText(request.query, 'state'))

        const code = await attempt.run(
            6,
            () => api.validateCallback(request.query, transaction),
            (value) => checkCode(value, request.query),
        )
        const tokens = await attempt.run(7, async () => api.exchange(config, transaction, code), checkTokens)
        const practitioner = await attempt.run(
            8,
            async () => api.verifyIdentity(config, transaction.discovery, tokens),
            (value) => checkIdentity(value, tokens, config),
        )
        const context = await attempt.run(
            9,
            () => api.launchContext(tokens, practitioner),
            (value) => checkContext(value, tokens, practitioner),
        )

        const previousSessionId = request.cookies[SESSION_COOKIE]

        if (previousSessionId) {
            sessions.delete(previousSessionId)
        }

        const sessionId = randomToken()
        const maxAge = Math.min(tokens.expires_in, MAX_SESSION_SECONDS)
        sessions.set(sessionId, {
            tokens,
            context,
            csrfToken: randomToken(),
            expiresAt: Date.now() + maxAge * 1000,
            attempt,
        })
        reply.setCookie(SESSION_COOKIE, sessionId, { ...cookieOptions, maxAge })
        reply.setCookie(PROGRESS_COOKIE, attempt.id, { ...cookieOptions, maxAge: PROGRESS_SECONDS })

        return reply.redirect('/app')
    })

    app.post<{ Body: URLSearchParams }>('/app/write', async (request, reply) => {
        const session = sessions.get(request.cookies[SESSION_COOKIE] ?? '')

        if (!session) {
            throw new AppError(401, 'Session missing or expired. Launch again from the EPJ.')
        }

        if (request.headers.origin !== new URL(config.redirectUri).origin) {
            throw new AppError(403, 'Write-back requires a same-origin request.')
        }

        const entries = [...request.body.entries()]
        const fields = Object.fromEntries(entries)

        if (entries.length !== Object.keys(fields).length) {
            throw new AppError(400, 'Write-back form contains duplicate fields.')
        }

        const form = WriteFormSchema.safeParse(fields)

        if (!form.success) {
            throw new AppError(400, 'Enter a valid temperature or a journal note of up to 2000 characters.')
        }

        if (!isSameSecret(form.data.csrf, session.csrfToken)) {
            throw new AppError(403, 'Write-back session check failed. Reload the consultation and try again.')
        }

        const resourceType = form.data.kind === 'temperature' ? 'Observation' : 'DocumentReference'

        if (!hasCreateScope(session.tokens.scope, resourceType)) {
            throw new AppError(403, `The ${resourceType} create scope was not granted.`)
        }

        const resource =
            form.data.kind === 'temperature'
                ? temperature(session.context, form.data.value)
                : journalNote(session.context, form.data.text)
        const { resource: created, location } = await createResourceWithLocation(config, session.tokens, resource)

        if (request.headers.accept?.includes('application/json')) {
            return reply.code(201).send({ ...created, location })
        }

        return reply
            .code(201)
            .type('text/html')
            .send(
                page(
                    'Write-back saved',
                    `<section class="panel"><h2>Resource saved</h2><p>${escapeHtml(created.resourceType)}/${escapeHtml(created.id)}</p>` +
                        `<p>Location: <a href="${escapeHtml(location)}">${escapeHtml(location)}</a></p>` +
                        '<a class="button" href="/app">Return to consultation</a></section>',
                ),
            )
    })

    app.get('/app', async (request, reply) => {
        const session = sessions.get(request.cookies[SESSION_COOKIE] ?? '')

        if (!session) {
            throw new AppError(401, 'Session missing or expired. Launch again from the EPJ.')
        }

        const { attempt } = session
        const chart = await attempt.run(
            10,
            async () => api.loadChart(config, session.tokens, session.context),
            (value) => checkChart(value, session.context),
        )
        const scopes = splitScopes(session.tokens.scope)
        const canSearch = (resource: string): boolean =>
            scopes.some((scope) => {
                const [permission, interactions = ''] = scope.split('.')

                return (
                    [`patient/${resource}`, `user/${resource}`, 'patient/*', 'user/*'].includes(permission ?? '') &&
                    (interactions.includes('s') || interactions === 'read' || interactions === '*')
                )
            })
        let clinicalContent =
            '<section class="panel"><h2>Clinical Summary</h2><p class="empty-state">Unavailable: clinical search permissions were not granted.</p></section>'

        if (canSearch('Condition') && canSearch('Observation')) {
            try {
                const summary = api.clinicalSummary
                    ? await api.clinicalSummary(config, session.tokens, session.context)
                    : await clinicalSummary(config, session.tokens, session.context)
                clinicalContent = renderClinicalSummary(summary)
            } catch (error) {
                if (!(error instanceof AppError)) {
                    throw error
                }

                clinicalContent = `<section class="panel"><h2>Clinical Summary</h2><p class="empty-state">Unavailable: ${escapeHtml(error.message)}</p></section>`
            }
        }

        return reply
            .type('text/html')
            .send(
                page(
                    'Active consultation',
                    `<div class="workspace">${chartContent(chart, config, session)}${clinicalContent}</div>` +
                        writebackContent(session) +
                        `<details class="panel progress-panel"><summary>Launch diagnostics</summary>${renderChecklist(attempt.checklist())}</details>` +
                        '<script src="/writeback.js" defer></script>',
                ),
            )
    })

    return app
}

function hasCreateScope(scopeText: string, resource: string): boolean {
    return splitScopes(scopeText).some((scope) => {
        const [permission, interactions = ''] = scope.split('.')

        return (
            [`patient/${resource}`, `user/${resource}`, 'patient/*', 'user/*'].includes(permission ?? '') &&
            interactions.includes('c')
        )
    })
}

function writebackContent(session: Session): string {
    const observationScope = hasCreateScope(session.tokens.scope, 'Observation')
    const noteScope = hasCreateScope(session.tokens.scope, 'DocumentReference')
    const disabledMessage = (scope: string): string =>
        `<p class="empty-state">Scope <code>${scope}</code> was not granted. Add it to <code>SCOPES</code>, restart the app and launch again.</p>`

    return `
        <section class="panel writeback-panel" aria-labelledby="writeback-title">
            <h2 id="writeback-title"><span class="section-number">03</span>Write to this consultation</h2>
            <p>Writes use the patient and encounter from this EHR launch.</p>
            <div class="writeback-grid">
                <form method="post" action="/app/write" data-write-form>
                    <input type="hidden" name="kind" value="temperature">
                    <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}">
                    <label for="temperature-value">Body temperature (degrees Celsius)</label>
                    <input id="temperature-value" name="value" type="number" min="-99999999.9999" max="99999999.9999" step="0.0001" required>
                    <button class="button" type="submit"${observationScope ? '' : ' disabled'}>Save measurement</button>
                    ${observationScope ? '' : disabledMessage('patient/Observation.c')}
                </form>
                <form method="post" action="/app/write" data-write-form>
                    <input type="hidden" name="kind" value="note">
                    <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}">
                    <label for="journal-note">Journal note</label>
                    <textarea id="journal-note" name="text" rows="4" maxlength="2000" required></textarea>
                    <button class="button" type="submit"${noteScope ? '' : ' disabled'}>Save note</button>
                    ${noteScope ? '' : disabledMessage('patient/DocumentReference.c')}
                </form>
            </div>
            <p class="write-result" data-write-result aria-live="polite"></p>
        </section>
    `
}

function queryText(query: unknown, key: string): string | undefined {
    const value = typeof query === 'object' && query !== null ? (query as Record<string, unknown>)[key] : undefined

    return typeof value === 'string' ? value : undefined
}

const CHART_FIELDS = {
    age: 'Age',
    encounter: 'Encounter',
    started: 'Started',
    clinician: 'Clinician',
    organization: 'Organization',
    practitionerRoles: 'Practitioner roles',
} satisfies Partial<Record<keyof Chart, string>>

function chartContent(chart: Chart, config: Config, session: Session): string {
    const rows = (Object.keys(CHART_FIELDS) as (keyof typeof CHART_FIELDS)[])
        .filter((key) => key in chart)
        .map(
            (key) =>
                `<div class="context-field"><dt>${CHART_FIELDS[key]}</dt><dd>${escapeHtml(chart[key] ?? 'Not available')}</dd></div>`,
        )
        .join('')
    const initials = chart.patientName
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part.charAt(0))
        .join('')

    return `
        <aside class="context-column" aria-label="Consultation context">
            <section class="panel" aria-labelledby="patient-title">
                <div class="patient-heading">
                    <div class="avatar" aria-hidden="true">${escapeHtml(initials)}</div>
                    <span class="eyebrow">Patient context</span>
                    <h2 class="patient-name" id="patient-title">${escapeHtml(chart.patientName)}</h2>
                    <span class="badge">${escapeHtml(chart.status)}</span>
                </div>
                <dl>${rows}</dl>
            </section>
            <section class="panel" aria-labelledby="scopes-title">
                <h2 id="scopes-title"><span class="section-number">/</span>Scopes</h2>
                <span class="scope-label">Requested</span><p class="scope-text">${escapeHtml(config.scopes)}</p>
                <span class="scope-label">Granted</span><p class="scope-text">${escapeHtml(session.tokens.scope)}</p>
            </section>
        </aside>
    `
}
