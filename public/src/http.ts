import { randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

import { AppError, type Config } from './config.ts'

export const REQUEST_TIMEOUT_MS = 10_000

const RANDOM_TOKEN_BYTES = 32

const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
}

const osloDateFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
})

export const IdSchema = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)

export const ReferenceSchema = z.object({ reference: z.string().min(1) })

const NamesSchema = z
    .array(
        z.object({
            text: z.string().optional(),
            given: z.array(z.string()).optional(),
            family: z.string().optional(),
        }),
    )
    .default([])

export const PatientSchema = z.object({
    resourceType: z.literal('Patient'),
    id: IdSchema,
    name: NamesSchema,
    birthDate: z.string().optional(),
})

export type Patient = z.infer<typeof PatientSchema>

export const PractitionerSchema = z.object({
    resourceType: z.literal('Practitioner'),
    id: IdSchema,
    name: NamesSchema,
})

export const EncounterSchema = z.object({
    resourceType: z.literal('Encounter'),
    id: IdSchema,
    status: z.string(),
    subject: ReferenceSchema,
    serviceProvider: ReferenceSchema.optional(),
    period: z
        .object({
            start: z.string().optional(),
            end: z.string().optional(),
        })
        .optional(),
})

export type Encounter = z.infer<typeof EncounterSchema>

export const OrganizationSchema = z.object({
    resourceType: z.literal('Organization'),
    id: IdSchema,
    name: z.string().optional(),
})

export const RoleSchema = z
    .object({
        resourceType: z.literal('PractitionerRole'),
        id: IdSchema.optional(),
    })
    .passthrough()

// Carries the upstream status so a caller that writes can tell a definite rejection (4xx) from an unknown outcome.
export class UpstreamStatusError extends AppError {
    constructor(
        public upstreamStatus: number,
        message: string,
    ) {
        super(502, message)
    }
}

export async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
        // Never include upstream bodies: they can contain credentials or patient data.
        throw new UpstreamStatusError(
            response.status,
            `Upstream returned HTTP ${response.status}. Check scopes, registration and mentor logs.`,
        )
    }

    return response
}

export async function json<T>(url: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const response = await request(url, init)

    return schema.parse(await response.json())
}

export function bundle<T>(resource: z.ZodType<T>): z.ZodType<T[]> {
    return z
        .object({
            resourceType: z.literal('Bundle'),
            type: z.literal('searchset'),
            entry: z.array(z.object({ resource })).default([]),
            link: z.array(z.object({ relation: z.string(), url: z.string() })).optional(),
        })
        .transform((searchset) => {
            const hasNextPage = searchset.link?.some((link) => link.relation === 'next')

            if (hasNextPage) {
                throw new AppError(
                    502,
                    'This starter does not implement pagination; do not present a partial result as complete.',
                )
            }

            return searchset.entry.map((entry) => entry.resource)
        })
}

export function fhirUrl(config: Config, path: string): string {
    const base = new URL(`${config.fhirBase}/`)
    const url = new URL(path, base)

    const isOutsideFhirServer = url.origin !== base.origin || !url.pathname.startsWith(base.pathname)
    const hasForbiddenParts = Boolean(url.username || url.password || url.hash)

    if (isOutsideFhirServer || hasForbiddenParts) {
        throw new AppError(400, 'FHIR reference points outside the configured FHIR server.')
    }

    return url.href
}

export function searchPath(resourceType: string, params: Record<string, string>): string {
    return `${resourceType}?${new URLSearchParams(params)}`
}

export function referenceId(config: Config, value: string, type: string): string {
    const url = new URL(fhirUrl(config, value))
    const prefix = `${new URL(config.fhirBase).pathname}/${type}/`

    if (!url.pathname.startsWith(prefix) || url.search) {
        throw new AppError(400, `Expected a ${type} reference.`)
    }

    return IdSchema.parse(url.pathname.slice(prefix.length))
}

export async function fhir<T>(config: Config, token: string, path: string, schema: z.ZodType<T>): Promise<T> {
    return json(fhirUrl(config, path), schema, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/fhir+json' },
    })
}

export function displayName(resource: { name: z.infer<typeof NamesSchema> }): string {
    const name = resource.name[0]
    const joinedName = [...(name?.given ?? []), name?.family].filter(Boolean).join(' ')

    return name?.text || joinedName || 'Name unavailable'
}

export function age(birthDate: string | undefined, today = new Date()): number | null {
    if (!birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
        return null
    }

    const birth = new Date(`${birthDate}T00:00:00Z`)
    const osloToday = osloDateFormat.format(today)

    const isRealDate = Number.isFinite(birth.getTime()) && birth.toISOString().slice(0, 10) === birthDate
    const isInFuture = birthDate > osloToday

    if (!isRealDate || isInFuture) {
        throw new AppError(502, 'Patient has an invalid birth date.')
    }

    const birthdayIsPending = osloToday.slice(5) < birthDate.slice(5)
    const years = Number(osloToday.slice(0, 4)) - birth.getUTCFullYear()

    return birthdayIsPending ? years - 1 : years
}

export function escapeHtml(value: unknown): string {
    return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char as keyof typeof HTML_ESCAPES])
}

export function page(title: string, content: string): string {
    const heading = escapeHtml(title)

    return `
        <!doctype html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width">
                <title>${heading}</title>
            </head>
            <body>
                <main>
                    <h1>${heading}</h1>
                    ${content}
                </main>
            </body>
        </html>
    `.trim()
}

export function randomToken(): string {
    return randomBytes(RANDOM_TOKEN_BYTES).toString('base64url')
}

export function isSameSecret(received: string, expected: string): boolean {
    const receivedBytes = Buffer.from(received)
    const expectedBytes = Buffer.from(expected)

    return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes)
}
