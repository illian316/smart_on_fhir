import type { FastifyInstance } from 'fastify'

import { AppError } from './config.ts'
import { escapeHtml, page } from './http.ts'
import { renderChecklist, StepError } from './progress.ts'

const CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"

const UNEXPECTED_ERROR = {
    status: 502,
    message:
        'Request failed validation, token verification or upstream communication. Check registration and try a new launch.',
}

export function configureServer(app: FastifyInstance): void {
    app.addHook('onSend', async (_request, reply) => {
        reply.header('Cache-Control', 'no-store')
        reply.header('Referrer-Policy', 'same-origin')
        reply.header('X-Content-Type-Options', 'nosniff')
        reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY)
    })

    app.setErrorHandler((error, request, reply) => {
        request.log.warn({ category: error instanceof Error ? error.name : 'UnknownError' }, 'SMART request failed')

        if (error instanceof StepError) {
            return reply
                .code(error.status)
                .type('text/html')
                .send(page(`SMART launch: TODO ${error.step} needs work`, renderChecklist(error.checklist)))
        }

        const { status, message } = error instanceof AppError ? error : UNEXPECTED_ERROR

        return reply
            .code(status)
            .type('text/html')
            .send(page('SMART request failed', `<p>${escapeHtml(message)}</p>`))
    })
}
