import cookie from '@fastify/cookie'
import Fastify, { LogController, type FastifyInstance } from 'fastify'

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
import { AppError, type Config } from './config.ts'
import { escapeHtml, page, randomToken } from './http.ts'
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

interface PendingLaunch {
    transaction: Transaction
    attempt: Attempt
    storedAt: number
}

export async function buildApp(config: Config, implementation: Steps = steps): Promise<FastifyInstance> {
    const app = Fastify({ logger: true, logController: new LogController({ disableRequestLogging: true }) })
    configureServer(app)
    await app.register(cookie)

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
        const intro =
            '<p>Launch this app from the EPJ app picker. Opening this page does not create patient context.</p>'
        const progress = attempt ? renderChecklist(attempt.checklist()) : ''

        return reply.type('text/html').send(page('SMART public starter', intro + progress))
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
        sessions.set(sessionId, { tokens, context, expiresAt: Date.now() + maxAge * 1000, attempt })
        reply.setCookie(SESSION_COOKIE, sessionId, { ...cookieOptions, maxAge })
        reply.setCookie(PROGRESS_COOKIE, attempt.id, { ...cookieOptions, maxAge: PROGRESS_SECONDS })

        return reply.redirect('/app')
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

        return reply
            .type('text/html')
            .send(
                page(
                    'Active consultation',
                    chartContent(chart, config, session) + renderChecklist(attempt.checklist()),
                ),
            )
    })

    return app
}

function queryText(query: unknown, key: string): string | undefined {
    const value = typeof query === 'object' && query !== null ? (query as Record<string, unknown>)[key] : undefined

    return typeof value === 'string' ? value : undefined
}

const CHART_FIELDS: (keyof Chart)[] = [
    'patientName',
    'age',
    'encounter',
    'status',
    'started',
    'clinician',
    'organization',
    'practitionerRoles',
]

function chartContent(chart: Chart, config: Config, session: Session): string {
    const rows = CHART_FIELDS.filter((key) => key in chart)
        .map((key) => `<dt>${key}</dt><dd>${escapeHtml(chart[key] ?? 'Not available')}</dd>`)
        .join('')

    return `
        <dl>${rows}</dl>
        <h2>Scopes</h2>
        <p>Requested: ${escapeHtml(config.scopes)}</p>
        <p>Granted: ${escapeHtml(session.tokens.scope)}</p>
    `
}
