import Fastify, { LogController, type FastifyInstance } from 'fastify'

import type { Config } from './config.ts'
import { displayName, searchPatients } from './fhir.ts'
import { escapeHtml, page } from './http.ts'
import { configureServer } from './server.ts'
import { tokenProvider } from './smart.ts'

const NO_MATCH_CONTENT = '<p>No patient matched the configured identifier.</p>'

export async function buildApp(config: Config): Promise<FastifyInstance> {
    const app = Fastify({ logger: true, logController: new LogController({ disableRequestLogging: true }) })
    configureServer(app)

    const accessToken = tokenProvider(config)

    app.get('/', async (_request, reply) => {
        const patients = await searchPatients(config, await accessToken())
        const names = patients.map((patient) => `<li>${escapeHtml(displayName(patient))}</li>`).join('')
        const content = patients.length ? `<ul>${names}</ul>` : NO_MATCH_CONTENT

        return reply.type('text/html').send(page('Patient search', content))
    })

    return app
}
