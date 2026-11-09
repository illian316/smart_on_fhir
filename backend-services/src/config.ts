import { z } from 'zod'

export interface Config {
    port: number
    fhirBase: string
    issuer: string
    clientId: string
    scopes: string
    privateJwkPath: string
    patientIdentifier: string
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
            'Set CLIENT_ID in .env to the client ID registered for your app',
        ),
    SCOPES: z
        .string()
        .trim()
        .min(1)
        .refine(
            (value) => splitScopes(value).every((scope) => scope.startsWith('system/')),
            'Backend Services only uses system/ scopes',
        ),
    PRIVATE_JWK_PATH: z.string().min(1, 'Set PRIVATE_JWK_PATH in .env (run npm run generate-key to create the key)'),
    PATIENT_IDENTIFIER: z.string().min(1, 'Set PATIENT_IDENTIFIER in .env, e.g. system|value'),
})

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

    return {
        port: values.PORT,
        fhirBase: trustedBaseUrl(values.FHIR_BASE_URL),
        issuer: trustedBaseUrl(values.AUTH_ISSUER),
        clientId: values.CLIENT_ID,
        scopes: values.SCOPES,
        privateJwkPath: values.PRIVATE_JWK_PATH,
        patientIdentifier: values.PATIENT_IDENTIFIER,
    }
}
