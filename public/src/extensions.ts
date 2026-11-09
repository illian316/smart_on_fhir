import { z } from 'zod'

import { AppError, type Config } from './config.ts'
import { bundle, fhir, fhirUrl, IdSchema, referenceId, request, searchPath, UpstreamStatusError } from './http.ts'
import type { Context, Tokens } from './types.ts'

export const LOINC_SYSTEM = 'http://loinc.org'
const UCUM_SYSTEM = 'http://unitsofmeasure.org'

export const BODY_TEMPERATURE_LOINC = '8310-5'
const MIN_TREND_READINGS = 3

const UNCERTAIN_CREATE_MESSAGE =
    'The EPJ did not confirm the save. It may already have been saved, so check the EPJ before submitting again.'

const ConditionSchema = z.object({ resourceType: z.literal('Condition') }).passthrough()

const ObservationSchema = z.object({
    resourceType: z.literal('Observation'),
    id: IdSchema,
    effectiveDateTime: z.iso.datetime({ offset: true }),
    valueQuantity: z.object({
        value: z.number().finite(),
        unit: z.string(),
        system: z.literal(UCUM_SYSTEM),
        code: z.string(),
    }),
})

const CreatedResourceSchema = z.object({ resourceType: z.string(), id: IdSchema }).passthrough()

type Condition = z.infer<typeof ConditionSchema>
type Measurement = z.infer<typeof ObservationSchema>
type CreatedResource = z.infer<typeof CreatedResourceSchema>

interface Reference {
    reference: string
}

interface Coding {
    system: string
    code: string
    display?: string
}

export interface ClinicalSummary {
    conditions: Condition[]
    measurements: Measurement[]
    trendReady: boolean
}

export interface TemperatureObservation {
    resourceType: 'Observation'
    status: string
    code: { coding: Coding[] }
    subject: Reference
    encounter: Reference
    effectiveDateTime: string
    valueQuantity: { value: number; unit: string; system: string; code: string }
}

export interface JournalNote {
    resourceType: 'DocumentReference'
    status: string
    type: { coding: Coding[] }
    subject: Reference
    context: { encounter: Reference[] }
    description: string
    content: { attachment: { contentType: string } }[]
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

export function temperature(context: Context, celsius: number, effective = new Date()): TemperatureObservation {
    z.number().finite().parse(celsius)

    return {
        resourceType: 'Observation',
        status: 'final',
        code: { coding: [{ system: LOINC_SYSTEM, code: BODY_TEMPERATURE_LOINC, display: 'Body temperature' }] },
        subject: resourceReference('Patient', context.patient),
        encounter: resourceReference('Encounter', context.encounter),
        effectiveDateTime: effective.toISOString(),
        valueQuantity: { value: celsius, unit: 'degrees Celsius', system: UCUM_SYSTEM, code: 'Cel' },
    }
}

export function journalNote(context: Context, text: string): JournalNote {
    return {
        resourceType: 'DocumentReference',
        status: 'current',
        type: { coding: [{ system: 'urn:oid:2.16.578.1.12.4.1.1.9602', code: 'J01-2' }] },
        subject: resourceReference('Patient', context.patient),
        context: { encounter: [resourceReference('Encounter', context.encounter)] },
        description: z.string().trim().min(1).parse(text),
        // nav-epj stores the description, not an uploaded PDF. Its write contract rejects attachment.data.
        content: [{ attachment: { contentType: 'application/pdf' } }],
    }
}

export async function createResource(
    config: Config,
    tokens: Tokens,
    resource: TemperatureObservation | JournalNote,
): Promise<CreatedResource> {
    try {
        const response = await request(fhirUrl(config, resource.resourceType), {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${tokens.access_token}`,
                'Content-Type': 'application/fhir+json',
                Accept: 'application/fhir+json',
            },
            body: JSON.stringify(resource),
        })

        const created = CreatedResourceSchema.parse(await response.json())
        const location = response.headers.get('Location')

        const isCreatedResponse = response.status === 201 && created.resourceType === resource.resourceType

        if (!isCreatedResponse || !location || referenceId(config, location, resource.resourceType) !== created.id) {
            throw new Error('Unexpected create response')
        }

        return created
    } catch (error) {
        // A 4xx means the server refused the write. Anything else (disconnect, timeout, 5xx, an unreadable or
        // unexpected 201) leaves it unknown whether the resource was stored. The cause is dropped on purpose:
        // it can contain upstream content.
        if (error instanceof UpstreamStatusError && error.upstreamStatus >= 400 && error.upstreamStatus < 500) {
            throw error
        }

        throw new AppError(502, UNCERTAIN_CREATE_MESSAGE)
    }
}

function resourceReference(type: 'Patient' | 'Encounter', id: string): Reference {
    return { reference: `${type}/${IdSchema.parse(id)}` }
}
