import { z } from 'zod'

import { AppError, type Config } from './config.ts'
import { json } from './http.ts'

const PatientSchema = z.object({
    resourceType: z.literal('Patient'),
    id: z.string().regex(/^[A-Za-z0-9.-]{1,64}$/),
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

const BundleSchema = z.object({
    resourceType: z.literal('Bundle'),
    type: z.literal('searchset'),
    entry: z.array(z.object({ resource: PatientSchema })).default([]),
    link: z.array(z.object({ relation: z.string() })).optional(),
})

export type Patient = z.infer<typeof PatientSchema>

export async function searchPatients(config: Config, token: string): Promise<Patient[]> {
    const query = new URLSearchParams({ identifier: config.patientIdentifier })
    const bundle = await json(`${config.fhirBase}/Patient?${query}`, BundleSchema, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/fhir+json' },
    })

    const hasNextPage = bundle.link?.some((link) => link.relation === 'next')

    if (hasNextPage) {
        throw new AppError(502, 'Result is paginated; this template does not follow next links.')
    }

    return bundle.entry.map((entry) => entry.resource)
}

export function displayName(patient: Patient): string {
    const name = patient.name[0]
    const joinedName = [...(name?.given ?? []), name?.family].filter(Boolean).join(' ')

    return name?.text || joinedName || 'Name unavailable'
}
