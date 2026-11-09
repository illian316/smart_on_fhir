import type { FastifyInstance } from 'fastify'

import { AppError } from './config.ts'
import { escapeHtml, page } from './http.ts'
import { renderChecklist, StepError } from './progress.ts'
import { stylesheet } from './styles.ts'

const CONTENT_SECURITY_POLICY =
    "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"

const WRITEBACK_SCRIPT = `
document.querySelectorAll('form[data-write-form]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
        event.preventDefault()

        const button = form.querySelector('button[type="submit"]')
        const result = document.querySelector('[data-write-result]')

        if (!(button instanceof HTMLButtonElement) || !(result instanceof HTMLElement)) return

        button.disabled = true
        result.textContent = 'Saving to the patient record...'

        try {
            const response = await fetch(form.action, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
                body: new URLSearchParams(new FormData(form)),
            })
            const body = await response.json().catch(() => ({}))

            if (!response.ok) throw new Error(body.error || 'Write-back failed (HTTP ' + response.status + ')')

            result.replaceChildren(document.createTextNode('Saved ' + body.resourceType + '/' + body.id + '. Location: '))
            const link = document.createElement('a')
            link.href = body.location
            link.textContent = body.location
            result.append(link)
        } catch (error) {
            result.textContent = error instanceof Error ? error.message : 'Write-back failed.'
        } finally {
            button.disabled = false
        }
    })
})
`

const UNEXPECTED_ERROR = {
    status: 502,
    message:
        'Request failed validation, token verification or upstream communication. Check registration and try a new launch.',
}

export function configureServer(app: FastifyInstance): void {
    app.get('/styles.css', async (_request, reply) => reply.type('text/css').send(stylesheet))
    app.get('/writeback.js', async (_request, reply) => reply.type('application/javascript').send(WRITEBACK_SCRIPT))

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

        if (request.headers.accept?.includes('application/json')) {
            return reply.code(status).send({ error: message })
        }

        return reply
            .code(status)
            .type('text/html')
            .send(page('SMART request failed', `<p>${escapeHtml(message)}</p>`))
    })
}
