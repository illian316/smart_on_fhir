import { z } from 'zod'

export interface Config {
    port: number
    fhirBase: string
    issuer: string
    clientId: string
    redirectUri: string
    scopes: string
}

export class AppError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message)
    }
}

const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]']

const EnvSchema = z.object({
    PORT: z.coerce.number().int().min(1024).max(65535).default(3100),
    FHIR_BASE_URL: z.url(),
    AUTH_ISSUER: z.url(),
    CLIENT_ID: z
        .string()
        .min(1)
        .refine(
            (value) => !value.startsWith('replace-'),
            'Set CLIENT_ID in .env to the client ID the host registered for you',
        ),
    REDIRECT_URI: z.url().default('http://localhost:3100/callback'),
    SCOPES: z.string().trim().min(1),
})

export class UnfinishedError extends AppError {
    constructor(step: number, task: string) {
        super(501, `TODO ${step}: ${task}. See src/steps.ts.`)
    }
}

export function unfinished(step: number, task: string): never {
    throw new UnfinishedError(step, task)
}

export function splitScopes(scopes: string): string[] {
    return scopes.split(/\s+/)
}

export function trustedUrl(value: string): URL {
    const url = new URL(value)

    const isLoopback = LOOPBACK_HOSTNAMES.includes(url.hostname)
    const isSecureTransport = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback)
    const hasForbiddenParts = Boolean(url.username || url.password || url.hash || url.search)

    if (!isSecureTransport || hasForbiddenParts) {
        throw new AppError(400, 'Use HTTPS URLs, or HTTP on localhost, without credentials/query/fragment.')
    }

    return url
}

function trustedBaseUrl(value: string): string {
    return trustedUrl(value).href.replace(/\/$/, '')
}

export function configProblems(error: unknown): string[] | undefined {
    if (error instanceof z.ZodError) {
        return error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
    }

    return error instanceof AppError ? [error.message] : undefined
}

export function readConfig(env = process.env): Config {
    const values = EnvSchema.parse(env)

    const fhirBase = trustedBaseUrl(values.FHIR_BASE_URL)
    const issuer = trustedBaseUrl(values.AUTH_ISSUER)
    trustedUrl(values.REDIRECT_URI)

    return {
        port: values.PORT,
        fhirBase,
        issuer,
        clientId: values.CLIENT_ID,
        redirectUri: values.REDIRECT_URI,
        scopes: values.SCOPES,
    }
}
