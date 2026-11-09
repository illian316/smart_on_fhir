import cookie from '@fastify/cookie'
import Fastify, { LogController, type FastifyInstance } from 'fastify'

import { AppError, type Config } from './config.ts'
import { displayName, fhirGet, PatientSchema } from './fhir.ts'
import { escapeHtml, page, randomToken } from './http.ts'
import { configureServer } from './server.ts'
import { completeLaunch, startLaunch, TRANSACTION_TTL_MS, type Session, type Transaction } from './smart.ts'

const LAUNCH_COOKIE = 'smart_launch'
const SESSION_COOKIE = 'smart_session'

const MAX_PENDING_LAUNCHES = 1000
const MAX_SESSIONS = 1000

export async function buildApp(config: Config): Promise<FastifyInstance> {
    const app = Fastify({ logger: true, logController: new LogController({ disableRequestLogging: true }) })
    configureServer(app)
    await app.register(cookie)

    const transactions = new Map<string, Transaction>()
    const sessions = new Map<string, Session>()

    const cookieOptions = {
        path: '/',
        httpOnly: true,
        sameSite: 'lax' as const,
        secure: new URL(config.redirectUri).protocol === 'https:',
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

    app.get('/launch', async (request, reply) => {
        if (transactions.size >= MAX_PENDING_LAUNCHES) {
            throw new AppError(503, 'Too many pending launches; try again later.')
        }

        const { transaction, url } = await startLaunch(config, request.query)

        const previousTransactionId = request.cookies[LAUNCH_COOKIE]

        if (previousTransactionId) {
            transactions.delete(previousTransactionId)
        }

        const transactionId = randomToken()
        transactions.set(transactionId, transaction)
        reply.setCookie(LAUNCH_COOKIE, transactionId, { ...cookieOptions, maxAge: TRANSACTION_TTL_MS / 1000 })

        return reply.redirect(url)
    })

    app.get('/callback', async (request, reply) => {
        const transactionId = request.cookies[LAUNCH_COOKIE]
        const transaction = transactionId ? transactions.get(transactionId) : undefined

        if (!transactionId || !transaction) {
            throw new AppError(400, 'No pending launch in this browser. Launch again.')
        }

        if (sessions.size >= MAX_SESSIONS) {
            throw new AppError(503, 'Too many sessions; try again later.')
        }

        transactions.delete(transactionId)
        reply.clearCookie(LAUNCH_COOKIE, cookieOptions)

        const session = await completeLaunch(config, transaction, request.query)

        const previousSessionId = request.cookies[SESSION_COOKIE]

        if (previousSessionId) {
            sessions.delete(previousSessionId)
        }

        const sessionId = randomToken()
        sessions.set(sessionId, session)
        reply.setCookie(SESSION_COOKIE, sessionId, {
            ...cookieOptions,
            maxAge: Math.floor((session.expiresAt - Date.now()) / 1000),
        })

        return reply.redirect('/')
    })

    app.get('/', async (request, reply) => {
        const session = sessions.get(request.cookies[SESSION_COOKIE] ?? '')

        if (!session) {
            throw new AppError(401, 'No session. Launch this app from the EPJ app picker.')
        }

        const patient = await fhirGet(config, session.accessToken, `Patient/${session.patient}`, PatientSchema)

        if (patient.id !== session.patient) {
            throw new AppError(502, 'Unexpected Patient resource.')
        }

        const content = `
            <p>${escapeHtml(displayName(patient))}</p>
            <p>Signed in as ${escapeHtml(session.fhirUser)}</p>
        `

        return reply.type('text/html').send(page('Patient', content))
    })

    return app
}
