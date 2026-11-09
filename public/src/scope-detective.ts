import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { splitScopes, type Config } from './config.ts'
import { BODY_TEMPERATURE_LOINC, LOINC_SYSTEM } from './extensions.ts'
import { escapeHtml, fhirUrl, REQUEST_TIMEOUT_MS, searchPath } from './http.ts'
import { appPage, type RouteDeps } from './routes.ts'
import { grantsInteraction } from './scopes.ts'
import type { Context, Session } from './types.ts'

const MINIMAL_SCOPES = 'openid fhirUser launch patient/Patient.r patient/Encounter.s'
const MAX_ISSUES = 10

// Only these two fields of an OperationOutcome ever reach the page. diagnostics, details and text can hold
// credentials or patient data, and an upstream body is not ours to repeat.
const IssueSchema = z.object({
    severity: z.enum(['fatal', 'error', 'warning', 'information']),
    code: z.string().regex(/^[a-z][a-z-]{0,39}$/),
})

const OutcomeSchema = z.object({
    resourceType: z.literal('OperationOutcome'),
    issue: z.array(z.unknown()).max(MAX_ISSUES),
})

export interface ProbeResult {
    request: string
    status: number
    issues: z.infer<typeof IssueSchema>[]
}

interface Probe {
    resourceType: string
    interaction: 'r' | 's'
    path: string
}

export async function runProbe(config: Config, accessToken: string, path: string): Promise<ProbeResult> {
    // Not request() from http.ts: that throws on a non-2xx status, and the status is exactly what we want here.
    const response = await fetch(fhirUrl(config, path), {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/fhir+json' },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (response.ok) {
        await response.body?.cancel()

        return { request: path, status: response.status, issues: [] }
    }

    const body: unknown = await response.json().catch(() => undefined)
    const outcome = OutcomeSchema.safeParse(body)

    const issues = outcome.success
        ? outcome.data.issue.flatMap((issue) => {
              const parsed = IssueSchema.safeParse(issue)

              return parsed.success ? [parsed.data] : []
          })
        : []

    return { request: path, status: response.status, issues }
}

export function registerScopeDetective(app: FastifyInstance, { config, requireSession }: RouteDeps): void {
    app.get('/scopes', async (request, reply) => {
        const session = requireSession(request)

        const allowed: Probe = {
            resourceType: 'Patient',
            interaction: 'r',
            path: `Patient/${session.context.patient}`,
        }

        const refused = pickRefusedProbe(session)
        const probes = refused ? [allowed, refused] : [allowed]

        const results = await Promise.all(
            probes.map(async (candidate) => ({
                candidate,
                result: await runProbe(config, session.tokens.access_token, candidate.path),
            })),
        )

        const content = `
            ${scopeComparison(config.scopes, session.tokens.scope)}
            ${probeContent(session.tokens.scope, results)}
            ${refused ? '' : noRefusedReadContent()}
        `

        return reply.type('text/html').send(appPage('Scope detective', content))
    })
}

// Condition and Observation are left out of the default SCOPES, so one of them is normally refused. If the
// launch was granted both (for example with patient/*.cruds), say so rather than invent a refusal.
function pickRefusedProbe(session: Session): Probe | undefined {
    const candidates = refusedCandidates(session.context)

    return candidates.find((candidate) => !grantsInteraction(session.tokens.scope, candidate.resourceType, 's'))
}

function refusedCandidates(context: Context): Probe[] {
    return [
        {
            resourceType: 'Condition',
            interaction: 's',
            path: searchPath('Condition', { subject: context.patient, encounter: context.encounter }),
        },
        {
            resourceType: 'Observation',
            interaction: 's',
            path: searchPath('Observation', {
                subject: context.patient,
                code: `${LOINC_SYSTEM}|${BODY_TEMPERATURE_LOINC}`,
            }),
        },
    ]
}

function scopeComparison(requested: string, granted: string): string {
    const requestedScopes = splitScopes(requested)
    const grantedScopes = splitScopes(granted)

    const notGranted = requestedScopes.filter((scope) => !grantedScopes.includes(scope))
    const notRequested = grantedScopes.filter((scope) => !requestedScopes.includes(scope))

    return `
        <h2>Requested and granted</h2>
        <p>Requested: ${escapeHtml(requested)}</p>
        <p>Granted: ${escapeHtml(granted)}</p>
        <p>Requested but not granted: ${scopeList(notGranted)}</p>
        <p>Granted but not requested: ${scopeList(notRequested)}</p>
    `
}

function scopeList(scopes: string[]): string {
    return scopes.length > 0 ? escapeHtml(scopes.join(' ')) : 'none'
}

function probeContent(granted: string, results: { candidate: Probe; result: ProbeResult }[]): string {
    const rows = results.map(({ candidate, result }) => probeRow(granted, candidate, result))

    return `
        <h2>Two reads</h2>
        <table>
            <thead><tr><th>Request</th><th>Granted scopes say</th><th>Server answered</th><th>Outcome</th></tr></thead>
            <tbody>${rows.join('')}</tbody>
        </table>
    `
}

function probeRow(granted: string, probeRequest: Probe, result: ProbeResult): string {
    const predictedAllowed = grantsInteraction(granted, probeRequest.resourceType, probeRequest.interaction)
    const isSuccess = result.status >= 200 && result.status < 300

    const issues = result.issues.map((issue) => `${escapeHtml(issue.severity)} / ${escapeHtml(issue.code)}`).join(', ')
    const answer = `HTTP ${result.status}${issues ? `, ${issues}` : ''}`
    const matches = predictedAllowed === isSuccess

    return `
        <tr>
            <td><code>GET ${escapeHtml(result.request)}</code></td>
            <td>${predictedAllowed ? 'allowed' : 'refused'}</td>
            <td>${answer}</td>
            <td>${matches ? 'as the scopes predict' : 'differs from the scopes: check wildcard scopes and server rules'}</td>
        </tr>
    `
}

function noRefusedReadContent(): string {
    return `
        <p>The granted scopes allow both Condition and Observation, so there is no refused read to show here.
        To see one, set <code>SCOPES=${escapeHtml(MINIMAL_SCOPES)}</code> in <code>.env</code>, restart the app
        and launch again from the EPJ.</p>
    `
}
