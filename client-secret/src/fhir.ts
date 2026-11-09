import { z } from 'zod'

import { AppError, type Config } from './config.ts'
import { json } from './http.ts'

export const IdSchema = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)

export const PatientSchema = z.object({
    resourceType: z.literal('Patient'),
    id: IdSchema,
    name: z
        .array(
            z.object({
                text: z.string().optional(),
                given: z.array(z.string()).optional(),
                family: z.string().optional(),
            }),
        )
        .default([]),
})

export type Patient = z.infer<typeof PatientSchema>

export async function fhirGet<T>(config: Config, token: string, path: string, schema: z.ZodType<T>): Promise<T> {
    return json(`${config.fhirBase}/${path}`, schema, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/fhir+json' },
    })
}

export function referenceId(config: Config, value: string, type: string): string {
    const base = new URL(config.fhirBase)
    const url = new URL(value, `${config.fhirBase}/`)
    const prefix = `${base.pathname}/${type}/`

    const isOnFhirServer = url.origin === base.origin && url.pathname.startsWith(prefix)
    const hasForbiddenParts = Boolean(url.search || url.hash)

    if (!isOnFhirServer || hasForbiddenParts) {
        throw new AppError(400, `Expected a ${type} reference on the configured FHIR server.`)
    }

    return IdSchema.parse(url.pathname.slice(prefix.length))
}

export function displayName(patient: Patient): string {
    const name = patient.name[0]
    const joinedName = [...(name?.given ?? []), name?.family].filter(Boolean).join(' ')

    return name?.text || joinedName || 'Name unavailable'
}
