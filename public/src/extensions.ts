import { z } from 'zod'

import { AppError, type Config } from './config.ts'
import { bundle, escapeHtml, fhir, fhirUrl, IdSchema, request, searchPath } from './http.ts'
import type { Context, Tokens } from './types.ts'

const LOINC_SYSTEM = 'http://loinc.org'
const UCUM_SYSTEM = 'http://unitsofmeasure.org'

const BODY_TEMPERATURE_LOINC = '8310-5'
const MIN_TREND_READINGS = 3

const ClinicalCodeSchema = z.object({
    text: z.string().optional(),
    coding: z
        .array(
            z.object({
                system: z.string().optional(),
                code: z.string().optional(),
                display: z.string().optional(),
            }),
        )
        .default([]),
})

const ConditionSchema = z
    .object({
        resourceType: z.literal('Condition'),
        code: ClinicalCodeSchema.optional(),
    })
    .passthrough()

const ObservationSchema = z.object({
    resourceType: z.literal('Observation'),
    id: IdSchema,
    code: ClinicalCodeSchema,
    effectiveDateTime: z.iso.datetime({ offset: true }),
    valueQuantity: z.object({
        value: z.number().finite(),
        unit: z.string(),
        system: z.literal(UCUM_SYSTEM),
        code: z.string(),
    }),
})

const CreatedResourceSchema = z.object({ resourceType: z.string(), id: IdSchema }).passthrough()

const LoincCodingSchema = z
    .object({
        system: z.literal(LOINC_SYSTEM),
        code: z.string().min(1),
        display: z.string().optional(),
    })
    .strict()
const PatientReferenceSchema = z.object({ reference: z.string().regex(/^Patient\/[A-Za-z0-9.-]{1,64}$/) }).strict()
const EncounterReferenceSchema = z.object({ reference: z.string().regex(/^Encounter\/[A-Za-z0-9.-]{1,64}$/) }).strict()
const QuantityValueSchema = z
    .number()
    .finite()
    .min(-99_999_999.9999)
    .max(99_999_999.9999)
    .refine((value) => Number(value.toFixed(4)) === value)

export const TEMPERATURE_MIN_CELSIUS = 25
export const TEMPERATURE_MAX_CELSIUS = 45
export const TemperatureValueSchema = QuantityValueSchema.min(TEMPERATURE_MIN_CELSIUS).max(TEMPERATURE_MAX_CELSIUS)

const ObservationWriteSchema = z
    .object({
        resourceType: z.literal('Observation'),
        status: z.literal('final'),
        code: z.object({ coding: z.array(LoincCodingSchema).length(1) }).strict(),
        subject: PatientReferenceSchema,
        encounter: EncounterReferenceSchema,
        effectiveDateTime: z.iso.datetime(),
        valueQuantity: z
            .object({
                value: QuantityValueSchema,
                unit: z.string().min(1),
                system: z.literal(UCUM_SYSTEM),
                code: z.string().min(1),
            })
            .strict(),
    })
    .strict()
    .superRefine((resource, ctx) => {
        if (
            resource.code.coding.some((coding) => coding.code === BODY_TEMPERATURE_LOINC) &&
            resource.valueQuantity.code === 'Cel' &&
            !TemperatureValueSchema.safeParse(resource.valueQuantity.value).success
        ) {
            ctx.addIssue({
                code: 'custom',
                path: ['valueQuantity', 'value'],
                message: 'Body temperature must be between 25 and 45 degrees Celsius, with at most four decimals.',
            })
        }
    })

const JournalNoteWriteSchema = z
    .object({
        resourceType: z.literal('DocumentReference'),
        status: z.literal('current'),
        type: z
            .object({
                coding: z
                    .array(
                        z
                            .object({
                                system: z.literal('urn:oid:2.16.578.1.12.4.1.1.9602'),
                                code: z.literal('J01-2'),
                            })
                            .strict(),
                    )
                    .length(1),
            })
            .strict(),
        subject: PatientReferenceSchema,
        context: z
            .object({
                encounter: z.array(EncounterReferenceSchema).length(1),
            })
            .strict(),
        description: z.string().trim().min(1),
        content: z
            .array(
                z
                    .object({
                        attachment: z.object({ contentType: z.literal('application/pdf') }).strict(),
                    })
                    .strict(),
            )
            .length(1),
    })
    .strict()

type Condition = z.infer<typeof ConditionSchema>
type Measurement = z.infer<typeof ObservationSchema>
export type CreatedResource = z.infer<typeof CreatedResourceSchema>
export interface CreatedResourceResult {
    resource: CreatedResource
    location: string
}
export type TemperatureObservation = z.infer<typeof ObservationWriteSchema>
export type JournalNote = z.infer<typeof JournalNoteWriteSchema>

export interface ClinicalSummary {
    conditions: Condition[]
    measurements: Measurement[]
    trendReady: boolean
}

export async function clinicalSummary(
    config: Config,
    tokens: Tokens,
    context: Context,
    loinc = BODY_TEMPERATURE_LOINC,
): Promise<ClinicalSummary> {
    const [conditions, measurements] = await Promise.all([
        fhir(
            config,
            tokens.access_token,
            searchPath('Condition', { subject: context.patient, encounter: context.encounter }),
            bundle(ConditionSchema),
        ),
        fhir(
            config,
            tokens.access_token,
            searchPath('Observation', { subject: context.patient, code: `${LOINC_SYSTEM}|${loinc}` }),
            bundle(ObservationSchema),
        ),
    ])

    const units = new Set(measurements.map((measurement) => measurement.valueQuantity.code))

    if (units.size > 1) {
        throw new AppError(400, 'Mixed units: convert explicitly before presenting a trend.')
    }

    return {
        conditions,
        measurements: measurements.toSorted(
            (a, b) => Date.parse(a.effectiveDateTime) - Date.parse(b.effectiveDateTime),
        ),
        trendReady: measurements.length >= MIN_TREND_READINGS,
    }
}

export function renderClinicalSummary(summary: ClinicalSummary): string {
    const diagnoses = summary.conditions
        .map((condition) => {
            const codes = condition.code?.coding
                .map(
                    (coding) =>
                        `${escapeHtml(coding.display ?? condition.code?.text ?? 'Diagnosis')} ` +
                        `(${escapeHtml(coding.system ?? 'Code system unavailable')} | ${escapeHtml(coding.code ?? 'Code unavailable')})`,
                )
                .join('; ')

            return `<li>${codes || escapeHtml(condition.code?.text ?? 'Uncoded diagnosis')}</li>`
        })
        .join('')
    const rows = summary.measurements
        .map((measurement) => {
            const quantity = measurement.valueQuantity
            const codes = measurementCodes(measurement)

            return (
                `<li><time>${escapeHtml(measurement.effectiveDateTime)}</time>: ` +
                `<strong>${escapeHtml(quantity.value)} ${escapeHtml(quantity.unit)} (${escapeHtml(quantity.code)})</strong>` +
                `<br>Unit system: ${escapeHtml(quantity.system)}<br>Observation code: ${codes}</li>`
            )
        })
        .join('')
    const readings = summary.measurements
    const firstReading = readings[0]
    const units = new Set(readings.map((reading) => reading.valueQuantity.code))
    let trend = ''

    if (firstReading && summary.trendReady && readings.length >= MIN_TREND_READINGS && units.size === 1) {
        const values = readings.map((reading) => reading.valueQuantity.value)
        const times = readings.map((reading) => Date.parse(reading.effectiveDateTime))
        const minimum = Math.min(...values)
        const range = Math.max(...values) - minimum || 1
        const firstTime = Math.min(...times)
        const timeRange = Math.max(...times) - firstTime
        const points = readings.map((reading, index) => ({
            x:
                45 +
                (timeRange
                    ? (Date.parse(reading.effectiveDateTime) - firstTime) / timeRange
                    : index / (readings.length - 1)) *
                    490,
            y: 145 - ((reading.valueQuantity.value - minimum) / range) * 110,
            reading,
        }))
        const unit = escapeHtml(firstReading.valueQuantity.code)
        const markers = points
            .map(
                ({ x, y, reading }) =>
                    `<circle class="chart-marker" cx="${x}" cy="${y}" r="4"><title>` +
                    `${escapeHtml(reading.effectiveDateTime)}: ${escapeHtml(reading.valueQuantity.value)} ${unit}` +
                    ` (${escapeHtml(reading.valueQuantity.system)}); ${measurementCodes(reading)}` +
                    `</title></circle>`,
            )
            .join('')

        trend =
            `<figure><figcaption>Temperature trend (UCUM: ${unit}) / ${readings.length} readings` +
            `<br>${measurementCodes(firstReading)}; Unit system: ${escapeHtml(firstReading.valueQuantity.system)}</figcaption>` +
            `<svg class="trend-chart" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 580 180" width="100%" height="180" role="img" aria-label="Temperature over time in ${unit}">` +
            `<path class="chart-grid" d="M45 35H550M45 90H550" fill="none"/>` +
            `<path class="chart-axis" d="M45 20V150H550" fill="none"/>` +
            `<text class="chart-label" x="0" y="35" font-size="12">${escapeHtml(Math.max(...values))} ${unit}</text>` +
            `<text class="chart-label" x="0" y="145" font-size="12">${escapeHtml(minimum)} ${unit}</text>` +
            `<text class="chart-label" x="45" y="172" font-size="12">Earlier</text><text class="chart-label" x="510" y="172" font-size="12">Later</text>` +
            `<path class="chart-area" d="M45 150 ${points.map(({ x, y }) => `L${x} ${y}`).join(' ')} L535 150Z"/>` +
            `<polyline class="chart-line" points="${points.map(({ x, y }) => `${x},${y}`).join(' ')}" fill="none"/>` +
            `${markers}</svg></figure>`
    }

    const latest = readings.at(-1)
    const latestValue = latest
        ? `<div class="temperature-value">${escapeHtml(latest.valueQuantity.value)} <small>${escapeHtml(latest.valueQuantity.unit)} (${escapeHtml(latest.valueQuantity.code)})</small></div>` +
          `<p class="measurement-codes">${measurementCodes(latest)}<br>Unit system: ${escapeHtml(latest.valueQuantity.system)}</p>`
        : ''

    return (
        `<section class="panel" aria-label="Clinical summary"><div class="clinical-header"><h2><span class="section-number">01</span>Clinical Summary</h2><span class="eyebrow">Encounter insights</span></div>` +
        `<h3>Encounter diagnoses</h3>${diagnoses ? `<ul class="diagnoses">${diagnoses}</ul>` : '<p class="empty-state">No diagnoses recorded.</p>'}` +
        `<div class="temperature-stat"><div><h3>Body temperature</h3>${latestValue}</div><span class="reading-count">${readings.length} readings recorded<br>Latest recorded measurement</span></div>${trend}` +
        (rows
            ? `<details><summary>View all readings &amp; clinical codes (${readings.length})</summary><ul class="readings">${rows}</ul></details>`
            : '<p class="empty-state">No temperature readings recorded.</p>') +
        '</section>'
    )
}

function measurementCodes(measurement: Measurement): string {
    return measurement.code.coding
        .map(
            (coding) =>
                `${escapeHtml(coding.system ?? 'Code system unavailable')} | ${escapeHtml(coding.code ?? 'Code unavailable')}`,
        )
        .join('; ')
}

export function temperature(context: Context, celsius: number, effective = new Date()): TemperatureObservation {
    TemperatureValueSchema.parse(celsius)

    return ObservationWriteSchema.parse({
        resourceType: 'Observation',
        status: 'final',
        code: { coding: [{ system: LOINC_SYSTEM, code: BODY_TEMPERATURE_LOINC, display: 'Body temperature' }] },
        subject: resourceReference('Patient', context.patient),
        encounter: resourceReference('Encounter', context.encounter),
        effectiveDateTime: effective.toISOString(),
        valueQuantity: { value: celsius, unit: 'degrees Celsius', system: UCUM_SYSTEM, code: 'Cel' },
    })
}

export function journalNote(context: Context, text: string): JournalNote {
    return JournalNoteWriteSchema.parse({
        resourceType: 'DocumentReference',
        status: 'current',
        type: { coding: [{ system: 'urn:oid:2.16.578.1.12.4.1.1.9602', code: 'J01-2' }] },
        subject: resourceReference('Patient', context.patient),
        context: { encounter: [resourceReference('Encounter', context.encounter)] },
        description: text,
        content: [{ attachment: { contentType: 'application/pdf' } }],
    })
}

export async function createResource(
    config: Config,
    tokens: Tokens,
    resource: TemperatureObservation | JournalNote,
): Promise<CreatedResource> {
    return (await createResourceWithLocation(config, tokens, resource)).resource
}

export async function createResourceWithLocation(
    config: Config,
    tokens: Tokens,
    resource: TemperatureObservation | JournalNote,
): Promise<CreatedResourceResult> {
    const writeResource =
        resource.resourceType === 'Observation'
            ? ObservationWriteSchema.parse(resource)
            : JournalNoteWriteSchema.parse(resource)
    const response = await request(fhirUrl(config, writeResource.resourceType), {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            'Content-Type': 'application/fhir+json',
            Accept: 'application/fhir+json',
        },
        body: JSON.stringify(writeResource),
    })

    const created = CreatedResourceSchema.parse(await response.json())
    const location = response.headers.get('Location')
    const safeLocation = location ? fhirUrl(config, location) : undefined
    const locationId = safeLocation ? createdLocationId(config, safeLocation, writeResource.resourceType) : undefined

    const isCreatedResponse = response.status === 201 && created.resourceType === writeResource.resourceType

    if (!isCreatedResponse || !safeLocation || locationId !== created.id) {
        throw new AppError(502, 'Create response must be 201 with a server ID and matching Location.')
    }

    return { resource: created, location: safeLocation }
}

function createdLocationId(config: Config, location: string, type: string): string {
    const url = new URL(location)
    const basePath = new URL(config.fhirBase).pathname.replace(/\/$/, '')
    const prefix = `${basePath}/${type}/`
    const resourcePath = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : ''
    const match = resourcePath.match(/^([A-Za-z0-9.-]{1,64})(?:\/_history\/[A-Za-z0-9.-]{1,64})?$/)

    if (url.search || !match) {
        throw new AppError(502, 'Create response must include a valid Location for the created resource.')
    }

    return IdSchema.parse(match[1])
}

function resourceReference(type: 'Patient' | 'Encounter', id: string): { reference: string } {
    return { reference: `${type}/${IdSchema.parse(id)}` }
}
