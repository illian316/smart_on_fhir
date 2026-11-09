import { decodeJwt } from 'jose'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import { splitScopes, trustedUrl, type Config } from './config.ts'
import { IdSchema, referenceId } from './http.ts'
import { CheckError } from './progress.ts'
import {
    TokenSchema,
    type Chart,
    type Context,
    type Discovery,
    type Launch,
    type Pkce,
    type Tokens,
    type Transaction,
} from './types.ts'

const MIN_STATE_LENGTH = 21
const MAX_TRANSACTION_CLOCK_SKEW_MS = 60_000
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/

type Fields = Record<string, unknown>

function fields(value: unknown, what: string): Fields {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new CheckError(`${what} must be an object.`)
    }

    return value as Fields
}

function text(value: unknown, what: string): string {
    if (typeof value !== 'string' || value === '') {
        throw new CheckError(`${what} must be a non-empty string.`)
    }

    return value
}

function same(actual: unknown, expected: unknown, what: string): void {
    if (typeof actual !== 'string' || actual === '' || actual !== expected) {
        throw new CheckError(`${what} is missing or does not match the expected value.`)
    }
}

function queryValue(query: unknown, key: string): string | undefined {
    const value = typeof query === 'object' && query !== null ? (query as Fields)[key] : undefined

    return typeof value === 'string' ? value : undefined
}

function hasMethod(values: unknown, method: string): boolean {
    return Array.isArray(values) && values.includes(method)
}

function trustedEndpoint(value: unknown, name: string, issuerOrigin: string): URL {
    let url: URL

    try {
        url = trustedUrl(text(value, name))
    } catch (error) {
        if (error instanceof CheckError) {
            throw error
        }

        throw new CheckError(
            `${name} must be an HTTPS URL (or HTTP on localhost) without credentials, query or fragment.`,
        )
    }

    if (url.origin !== issuerOrigin) {
        throw new CheckError(`${name} must be on the same origin as AUTH_ISSUER.`)
    }

    return url
}

export function checkLaunch(value: unknown, query: unknown, config: Config): void {
    const launch = fields(value, 'The launch')

    same(launch.iss, config.fhirBase, 'iss')
    same(launch.launch, queryValue(query, 'launch'), 'launch')
}

export function checkDiscovery(value: unknown, config: Config): void {
    const metadata = fields(value, 'The discovery document')
    const issuerOrigin = new URL(config.issuer).origin

    same(metadata.issuer, config.issuer, 'issuer')

    for (const name of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
        trustedEndpoint(metadata[name], name, issuerOrigin)
    }

    const capabilities = [
        ['token_endpoint_auth_methods_supported', 'none'],
        ['grant_types_supported', 'authorization_code'],
        ['code_challenge_methods_supported', 'S256'],
    ] as const

    for (const [name, required] of capabilities) {
        if (!hasMethod(metadata[name], required)) {
            throw new CheckError(`${name} must be an array that includes ${required}.`)
        }
    }
}

export function checkPkce(value: unknown): void {
    const proof = fields(value, 'The PKCE pair')
    const verifier = text(proof.verifier, 'verifier')

    if (!VERIFIER_PATTERN.test(verifier)) {
        throw new CheckError(
            'verifier must be 43 to 128 characters from A-Z, a-z, 0-9, hyphen, dot, underscore and tilde.',
        )
    }

    same(proof.challenge, createHash('sha256').update(verifier).digest('base64url'), 'challenge')
}

export function checkTransaction(value: unknown, launch: Launch, discovery: Discovery, proof: Pkce): void {
    const transaction = fields(value, 'The transaction')
    const state = text(transaction.state, 'state')

    if (state.length < MIN_STATE_LENGTH) {
        throw new CheckError(`state must be at least ${MIN_STATE_LENGTH} characters.`)
    }

    if (!isDeepStrictEqual(transaction.launch, launch)) {
        throw new CheckError('launch must be the launch returned by the first step.')
    }

    if (!isDeepStrictEqual(transaction.discovery, discovery)) {
        throw new CheckError('discovery must be the discovery document returned by the second step.')
    }

    same(transaction.verifier, proof.verifier, 'verifier')
    same(transaction.challenge, proof.challenge, 'challenge')

    const createdAt = transaction.createdAt

    if (typeof createdAt !== 'number' || Math.abs(Date.now() - createdAt) > MAX_TRANSACTION_CLOCK_SKEW_MS) {
        throw new CheckError('createdAt must be Date.now() from when the transaction was created.')
    }
}

export function checkAuthorizationUrl(value: unknown, config: Config, transaction: Transaction): void {
    let url: URL

    try {
        url = new URL(text(value, 'The authorization URL'))
    } catch (error) {
        if (error instanceof CheckError) {
            throw error
        }

        throw new CheckError('The authorization URL must be an absolute URL.')
    }

    const endpoint = new URL(transaction.discovery.authorization_endpoint)

    if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname) {
        throw new CheckError('The authorization URL must start at authorization_endpoint.')
    }

    if (url.username || url.password || url.hash) {
        throw new CheckError('The authorization URL must not contain credentials or a fragment.')
    }

    for (const key of new Set(url.searchParams.keys())) {
        if (url.searchParams.getAll(key).length !== 1) {
            throw new CheckError(`The parameter ${key} must appear exactly once.`)
        }
    }

    if (url.searchParams.has('code_verifier')) {
        throw new CheckError('code_verifier belongs in the token request. Never put it in the authorization URL.')
    }

    const expected: Record<string, string> = {
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        aud: transaction.launch.iss,
        launch: transaction.launch.launch,
        state: transaction.state,
        code_challenge: transaction.challenge,
        code_challenge_method: 'S256',
    }

    for (const [key, expectedValue] of Object.entries(expected)) {
        same(url.searchParams.get(key) ?? undefined, expectedValue, `The parameter ${key}`)
    }

    const requested = splitScopes(url.searchParams.get('scope') ?? '').filter(Boolean)
    const configured = splitScopes(config.scopes).filter(Boolean)

    if (requested.length !== configured.length || !configured.every((scope) => requested.includes(scope))) {
        throw new CheckError('The scope parameter must contain exactly the scopes in SCOPES, in any order.')
    }
}

export function checkCode(value: unknown, query: unknown): void {
    same(value, queryValue(query, 'code'), 'The returned code')
}

export function checkTokens(value: unknown): void {
    const result = TokenSchema.safeParse(value)

    if (!result.success) {
        const names = [...new Set(result.error.issues.map((issue) => issue.path.join('.') || 'response'))]

        throw new CheckError(`The token response has the wrong shape (check: ${names.slice(0, 8).join(', ')}).`)
    }
}

export function checkIdentity(value: unknown, tokens: Tokens, config: Config): void {
    const practitioner = text(value, 'The practitioner ID')

    if (!IdSchema.safeParse(practitioner).success) {
        throw new CheckError('The practitioner ID must be a FHIR ID, not a URL or a reference.')
    }

    if (!tokens.id_token) {
        throw new CheckError('The token response has no id_token. Check that SCOPES includes openid and fhirUser.')
    }

    let expected: string

    try {
        expected = referenceId(config, text(decodeJwt(tokens.id_token).fhirUser, 'fhirUser'), 'Practitioner')
    } catch {
        throw new CheckError('The ID token has no usable fhirUser claim for a Practitioner.')
    }

    same(practitioner, expected, 'The practitioner ID')
}

export function checkContext(value: unknown, tokens: Tokens, practitioner: string): void {
    const context = fields(value, 'The launch context') as Partial<Context>

    for (const key of ['patient', 'encounter', 'practitioner'] as const) {
        if (!IdSchema.safeParse(context[key]).success) {
            throw new CheckError(`${key} must be a FHIR ID.`)
        }
    }

    same(context.patient, tokens.patient, 'patient')
    same(context.encounter, tokens.encounter, 'encounter')
    same(context.practitioner, practitioner, 'practitioner')
}

export function checkChart(value: unknown, context: Context): void {
    const chart = fields(value, 'The chart') as Partial<Record<keyof Chart, unknown>>

    text(chart.patientName, 'patientName')
    text(chart.started, 'started')

    if (chart.age !== null && (typeof chart.age !== 'number' || !Number.isFinite(chart.age))) {
        throw new CheckError('age must be a number, or null when the birth date is unknown.')
    }

    same(chart.encounter, context.encounter, 'encounter')
    same(chart.status, 'in-progress', 'status')

    for (const key of ['clinician', 'organization'] as const) {
        if (chart[key] !== undefined && typeof chart[key] !== 'string') {
            throw new CheckError(`${key} must be a string when present.`)
        }
    }

    if (chart.practitionerRoles !== undefined && typeof chart.practitionerRoles !== 'number') {
        throw new CheckError('practitionerRoles must be a number when present.')
    }
}
