import { createRemoteJWKSet, jwtVerify } from 'jose'
import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

import { AppError, trustedUrl, type Config } from './config.ts'
import { IdSchema, referenceId } from './fhir.ts'
import { json, randomToken } from './http.ts'

export const TRANSACTION_TTL_MS = 300_000

const MAX_SESSION_SECONDS = 1800
const ID_TOKEN_CLOCK_TOLERANCE_SECONDS = 5

const DiscoverySchema = z.object({
    issuer: z.url(),
    authorization_endpoint: z.url(),
    token_endpoint: z.url(),
    jwks_uri: z.url(),
    token_endpoint_auth_methods_supported: z.array(z.string()),
    code_challenge_methods_supported: z.array(z.string()),
    grant_types_supported: z.array(z.string()),
})

const TokenSchema = z.object({
    access_token: z.string().min(1),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive(),
    scope: z.string(),
    id_token: z.string().min(1),
    patient: IdSchema,
    encounter: IdSchema.optional(),
})

const LaunchQuerySchema = z.object({
    iss: z.string().max(2048),
    launch: z.string().min(1).max(2048),
})

const CallbackQuerySchema = z.object({
    state: z.string().min(1),
    code: z.string().min(1).optional(),
    error: z.string().optional(),
})

type Discovery = z.infer<typeof DiscoverySchema>
type Tokens = z.infer<typeof TokenSchema>

export interface Transaction {
    iss: string
    discovery: Discovery
    state: string
    verifier: string
    createdAt: number
}

export interface Session {
    accessToken: string
    patient: string
    encounter?: string
    fhirUser: string
    scope: string
    expiresAt: number
}

const jwksByUri = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

async function discover(config: Config): Promise<Discovery> {
    const metadata = await json(`${config.fhirBase}/.well-known/smart-configuration`, DiscoverySchema)

    if (metadata.issuer !== config.issuer) {
        throw new AppError(400, 'Unexpected authorization issuer.')
    }

    const issuerOrigin = new URL(config.issuer).origin
    const endpoints = [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]

    for (const endpoint of endpoints) {
        if (trustedUrl(endpoint).origin !== issuerOrigin) {
            throw new AppError(400, 'Discovery endpoint is outside the trusted authorization origin.')
        }
    }

    const supportsClientSecretBasic = metadata.token_endpoint_auth_methods_supported.includes('client_secret_basic')
    const supportsAuthorizationCode = metadata.grant_types_supported.includes('authorization_code')
    const supportsPkce = metadata.code_challenge_methods_supported.includes('S256')

    if (!supportsClientSecretBasic || !supportsAuthorizationCode || !supportsPkce) {
        throw new AppError(400, 'Server does not advertise client_secret_basic, authorization_code or S256.')
    }

    return metadata
}

export async function startLaunch(config: Config, query: unknown): Promise<{ transaction: Transaction; url: string }> {
    const launch = LaunchQuerySchema.safeParse(query)

    if (!launch.success) {
        throw new AppError(400, 'Launch requires iss and a launch ID.')
    }

    if (launch.data.iss !== config.fhirBase) {
        throw new AppError(400, `Launch iss "${launch.data.iss}" does not match FHIR_BASE_URL "${config.fhirBase}".`)
    }

    const discovery = await discover(config)
    const verifier = randomToken()

    const transaction: Transaction = {
        iss: launch.data.iss,
        discovery,
        verifier,
        state: randomToken(),
        createdAt: Date.now(),
    }

    const url = new URL(discovery.authorization_endpoint)

    url.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: config.scopes,
        aud: transaction.iss,
        launch: launch.data.launch,
        state: transaction.state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
    }).toString()

    return { transaction, url: url.href }
}

function callbackCode(query: unknown, transaction: Transaction): string {
    const result = CallbackQuerySchema.safeParse(query)

    const receivedState = Buffer.from(result.success ? result.data.state : '')
    const expectedState = Buffer.from(transaction.state)

    const stateMatches = receivedState.length === expectedState.length && timingSafeEqual(receivedState, expectedState)
    const isExpired = Date.now() - transaction.createdAt > TRANSACTION_TTL_MS

    if (!result.success || !stateMatches || isExpired) {
        throw new AppError(400, 'Missing, expired or mismatched OAuth state. Launch again from the EPJ.')
    }

    const { code, error } = result.data

    if (error || !code) {
        throw new AppError(400, 'Authorization was declined or no code was returned. Launch again.')
    }

    return code
}

function formUrlEncode(value: string): string {
    return new URLSearchParams({ v: value }).toString().slice(2)
}

async function exchange(config: Config, transaction: Transaction, code: string): Promise<Tokens> {
    const credentials = `${formUrlEncode(config.clientId)}:${formUrlEncode(config.secret)}`

    return json(transaction.discovery.token_endpoint, TokenSchema, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from(credentials).toString('base64')}`,
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            code_verifier: transaction.verifier,
            redirect_uri: config.redirectUri,
        }),
    })
}

async function verifiedFhirUser(config: Config, jwksUri: string, idToken: string): Promise<string> {
    let jwks = jwksByUri.get(jwksUri)

    if (!jwks) {
        jwks = createRemoteJWKSet(new URL(jwksUri))
        jwksByUri.set(jwksUri, jwks)
    }

    const { payload } = await jwtVerify(idToken, jwks, {
        issuer: config.issuer,
        audience: config.clientId,
        algorithms: ['RS256', 'ES256'],
        requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp'],
        clockTolerance: ID_TOKEN_CLOCK_TOLERANCE_SECONDS,
    })

    const hasMultipleAudiences = Array.isArray(payload.aud) && payload.aud.length > 1
    const hasAuthorizedParty = payload.azp !== undefined
    const authorizedPartyIsThisClient = payload.azp === config.clientId

    if ((hasMultipleAudiences || hasAuthorizedParty) && !authorizedPartyIsThisClient) {
        throw new AppError(400, 'ID token has an unexpected authorized party.')
    }

    return `Practitioner/${referenceId(config, z.string().parse(payload.fhirUser), 'Practitioner')}`
}

export async function completeLaunch(config: Config, transaction: Transaction, query: unknown): Promise<Session> {
    const code = callbackCode(query, transaction)
    const tokens = await exchange(config, transaction, code)
    const fhirUser = await verifiedFhirUser(config, transaction.discovery.jwks_uri, tokens.id_token)
    const sessionSeconds = Math.min(tokens.expires_in, MAX_SESSION_SECONDS)

    return {
        accessToken: tokens.access_token,
        patient: tokens.patient,
        encounter: tokens.encounter,
        fhirUser,
        scope: tokens.scope,
        expiresAt: Date.now() + sessionSeconds * 1000,
    }
}
