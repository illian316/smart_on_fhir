import cookie from '@fastify/cookie'
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify'

import { registerClinicalApp } from './clinical-app.ts'
import { AppError, type Config } from './config.ts'
import { escapeHtml, page, randomToken } from './http.ts'
import * as reference from './reference.ts'
import { appPage } from './routes.ts'
import { registerScopeDetective } from './scope-detective.ts'
import { configureServer } from './server.ts'
import { steps, type Steps } from './steps.ts'
import { TRANSACTION_TTL_MS, type Chart, type Session, type Transaction } from './types.ts'
import { registerWriteBack } from './write-back.ts'

const LAUNCH_COOKIE = 'smart_launch'
const SESSION_COOKIE = 'smart_session'

const MAX_PENDING_LAUNCHES = 1000
const MAX_SESSIONS = 1000
const MAX_SESSION_SECONDS = 1800

export async function buildApp(
    config: Config,
    referenceMode = false,
    implementation?: Steps,
): Promise<FastifyInstance> {
    const app = Fastify({ logger: true, logController: new LogController({ disableRequestLogging: true }) })
    configureServer(app)
    await app.register(cookie)

    const api = implementation ?? (referenceMode ? reference : steps)
    const transactions = new Map<string, Transaction>()
    const sessions = new Map<string, Session>()

    const cookieOptions = {
        path: '/',
        httpOnly: true,
        sameSite: 'lax' as const,
        secure: new URL(config.redirectUri).protocol === 'https:',
    }

    function requireSession(request: FastifyRequest): Session {
        const session = sessions.get(request.cookies[SESSION_COOKIE] ?? '')

        if (!session) {
            throw new AppError(401, 'Session missing or expired. Launch again from the EPJ.')
        }

        return session
    }

    app.addHook('onRequest', async () => {
        const now = Date.now()

        for (const [key, transaction] of transactions) {
            if (now - transaction.createdAt > TRANSACTION_TTL_MS) {
                transactions.delete(key)
            }
        }

        for (const [key, session] of sessions) {
            if (session.expiresAt <= now) {
                sessions.delete(key)
            }
        }
    })

    app.get('/', async (_request, reply) => {
        const title = `SMART ${config.variant} ${referenceMode ? 'reference' : 'starter'}`
        const content =
            '<p>Launch this app from the EPJ app picker. Opening this page does not create patient context.</p>'

        return reply.type('text/html').send(page(title, content))
    })

    app.get('/launch', async (request, reply) => {
        if (transactions.size >= MAX_PENDING_LAUNCHES) {
            throw new AppError(503, 'Too many pending launches; try again later.')
        }

        const launch = api.readLaunch(request.query, config)
        const discovery = await api.discover(config)
        const transaction = api.newTransaction(launch, discovery, api.pkce())

        const previousTransactionId = request.cookies[LAUNCH_COOKIE]

        if (previousTransactionId) {
            transactions.delete(previousTransactionId)
        }

        const transactionId = randomToken()
        transactions.set(transactionId, transaction)
        reply.setCookie(LAUNCH_COOKIE, transactionId, { ...cookieOptions, maxAge: TRANSACTION_TTL_MS / 1000 })

        return reply.redirect(api.authorizationUrl(config, transaction))
    })

    app.get('/callback', async (request, reply) => {
        const transactionId = request.cookies[LAUNCH_COOKIE]
        const transaction = transactionId ? transactions.get(transactionId) : undefined

        if (!transactionId || !transaction) {
            throw new AppError(400, 'No pending launch in this browser. Launch again.')
        }

        transactions.delete(transactionId)
        reply.clearCookie(LAUNCH_COOKIE, cookieOptions)

        const code = api.validateCallback(request.query, transaction)
        const tokens = await api.exchange(config, transaction, code)
        const practitioner = await api.verifyIdentity(config, transaction.discovery, tokens)
        const context = api.launchContext(tokens, practitioner)

        if (sessions.size >= MAX_SESSIONS) {
            throw new AppError(503, 'Too many sessions; try again later.')
        }

        const previousSessionId = request.cookies[SESSION_COOKIE]

        if (previousSessionId) {
            sessions.delete(previousSessionId)
        }

        const sessionId = randomToken()
        const maxAge = Math.min(tokens.expires_in, MAX_SESSION_SECONDS)
        sessions.set(sessionId, {
            tokens,
            context,
            expiresAt: Date.now() + maxAge * 1000,
            csrfToken: randomToken(),
        })
        reply.setCookie(SESSION_COOKIE, sessionId, { ...cookieOptions, maxAge })

        return reply.redirect('/app')
    })

    app.get('/app', async (request, reply) => {
        const session = requireSession(request)
        const chart = await api.loadChart(config, session.tokens, session.context)

        return reply.type('text/html').send(appPage('Active consultation', chartContent(chart, config, session)))
    })

    const routeDeps = { config, requireSession }

    registerClinicalApp(app, routeDeps)
    registerScopeDetective(app, routeDeps)
    registerWriteBack(app, routeDeps)

    return app
}

function chartContent(chart: Chart, config: Config, session: Session): string {
    const rows = Object.entries(chart)
        .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value ?? 'Not available')}</dd>`)
        .join('')

    return `
        <dl>${rows}</dl>
        <h2>Scopes</h2>
        <p>Requested: ${escapeHtml(config.scopes)}</p>
        <p>Granted: ${escapeHtml(session.tokens.scope)}</p>
    `
}
