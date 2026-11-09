import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { BODY_TEMPERATURE_LOINC, clinicalSummary, LOINC_SYSTEM, type ClinicalSummary } from './extensions.ts'
import { escapeHtml } from './http.ts'
import { appPage, scopeHint, type RouteDeps } from './routes.ts'
import { missingScopes } from './scopes.ts'

type Measurement = ClinicalSummary['measurements'][number]

const CodingSchema = z.object({
    system: z.string().optional(),
    code: z.string().optional(),
    display: z.string().optional(),
})

const ConditionDisplaySchema = z.object({
    code: z.object({ text: z.string().optional(), coding: z.array(CodingSchema).default([]) }).optional(),
    clinicalStatus: z.object({ coding: z.array(CodingSchema).default([]) }).optional(),
    onsetDateTime: z.string().optional(),
    recordedDate: z.string().optional(),
})

export interface ConditionSummary {
    label: string
    code?: string
    system?: string
    status?: string
    since?: string
}

export interface Trend {
    direction: 'rising' | 'falling' | 'steady'
    first: number
    last: number
    change: number
    min: number
    max: number
    unit: string
}

// A diagnosis is only useful with its code and the code system next to it: the same code means something
// else in another system (ICPC-2 and ICD-10 overlap). Display text is optional in FHIR, so fall back to the code.
export function summarizeCondition(condition: unknown): ConditionSummary {
    const parsed = ConditionDisplaySchema.safeParse(condition)

    if (!parsed.success) {
        return { label: 'Condition in an unrecognised format' }
    }

    const { code, clinicalStatus, onsetDateTime, recordedDate } = parsed.data
    const coding = code?.coding[0]

    return {
        label: coding?.display ?? code?.text ?? coding?.code ?? 'No description recorded',
        code: coding?.code,
        system: coding?.system,
        status: clinicalStatus?.coding[0]?.code,
        since: onsetDateTime ?? recordedDate,
    }
}

// clinicalSummary has already refused mixed units, so every reading here shares one UCUM code and the
// difference between the first and the last reading is meaningful. Fewer than three readings is not a trend.
export function describeTrend(summary: ClinicalSummary): Trend | undefined {
    const [first] = summary.measurements
    const last = summary.measurements.at(-1)

    if (!summary.trendReady || !first || !last) {
        return undefined
    }

    const values = summary.measurements.map((measurement) => measurement.valueQuantity.value)
    const change = Number((last.valueQuantity.value - first.valueQuantity.value).toFixed(2))

    return {
        direction: change > 0 ? 'rising' : change < 0 ? 'falling' : 'steady',
        first: first.valueQuantity.value,
        last: last.valueQuantity.value,
        change,
        min: Math.min(...values),
        max: Math.max(...values),
        unit: first.valueQuantity.unit,
    }
}

export function registerClinicalApp(app: FastifyInstance, { config, requireSession }: RouteDeps): void {
    app.get('/clinical', async (request, reply) => {
        const session = requireSession(request)

        // Explain a missing scope here instead of sending two requests that are certain to return 403.
        const missing = missingScopes(session.tokens.scope, [
            { resourceType: 'Condition', interaction: 's' },
            { resourceType: 'Observation', interaction: 's' },
        ])

        if (missing.length > 0) {
            return reply
                .code(403)
                .type('text/html')
                .send(appPage('Clinical summary', scopeHint(missing)))
        }

        const summary = await clinicalSummary(config, session.tokens, session.context)

        return reply.type('text/html').send(appPage('Clinical summary', summaryContent(summary)))
    })
}

function summaryContent(summary: ClinicalSummary): string {
    return `
        <h2>Diagnoses in this consultation</h2>
        ${conditionsContent(summary.conditions)}
        <h2>Body temperature</h2>
        <p>Searched with LOINC <code>${escapeHtml(BODY_TEMPERATURE_LOINC)}</code> in <code>${escapeHtml(LOINC_SYSTEM)}</code>.</p>
        ${measurementsContent(summary)}
    `
}

function conditionsContent(conditions: ClinicalSummary['conditions']): string {
    if (conditions.length === 0) {
        return '<p>No diagnoses recorded for this consultation.</p>'
    }

    const items = conditions.map(summarizeCondition).map((condition) => {
        const coding = condition.code
            ? `code <code>${escapeHtml(condition.code)}</code> in <code>${escapeHtml(condition.system ?? 'unknown system')}</code>`
            : 'no code recorded'
        const details = [
            condition.status && `status ${escapeHtml(condition.status)}`,
            condition.since && `since ${escapeHtml(condition.since)}`,
        ]

        return `<li><strong>${escapeHtml(condition.label)}</strong>: ${[coding, ...details].filter(Boolean).join(', ')}</li>`
    })

    return `<ul>${items.join('')}</ul>`
}

function measurementsContent(summary: ClinicalSummary): string {
    if (summary.measurements.length === 0) {
        return '<p>No temperature readings recorded.</p>'
    }

    const rows = summary.measurements.map(measurementRow).join('')
    const trend = describeTrend(summary)

    const trendContent = trend
        ? `<p>Trend over ${summary.measurements.length} readings in ${escapeHtml(trend.unit)}: ${trend.direction}, from ${trend.first} to ${trend.last} (change ${trend.change}, range ${trend.min} to ${trend.max}).</p>`
        : `<p>No trend: it needs at least three readings in the same unit, and there are ${summary.measurements.length}.</p>`

    return `
        <table>
            <thead><tr><th>Measured</th><th>Value</th><th>Unit</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
        ${trendContent}
    `
}

function measurementRow(measurement: Measurement): string {
    const { value, unit, system, code } = measurement.valueQuantity

    return `
        <tr>
            <td>${escapeHtml(measurement.effectiveDateTime)}</td>
            <td>${escapeHtml(value)}</td>
            <td>${escapeHtml(unit)} (<code>${escapeHtml(code)}</code> in <code>${escapeHtml(system)}</code>)</td>
        </tr>
    `
}
