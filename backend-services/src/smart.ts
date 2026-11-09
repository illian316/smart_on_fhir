import { importJWK, SignJWT } from 'jose'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'

import { AppError, splitScopes, trustedUrl, type Config } from './config.ts'
import { json } from './http.ts'

const REFRESH_MARGIN_MS = 30_000
const MAX_CACHE_SECONDS = 300
const CLIENT_ASSERTION_LIFETIME = '2m'
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

const DiscoverySchema = z.object({
    issuer: z.url(),
    token_endpoint: z.url(),
    token_endpoint_auth_methods_supported: z.array(z.string()),
    grant_types_supported: z.array(z.string()),
})

const TokenSchema = z.object({
    access_token: z.string().min(1),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive(),
    scope: z.string().min(1),
    patient: z.never().optional(),
    encounter: z.never().optional(),
    id_token: z.never().optional(),
    refresh_token: z.never().optional(),
})

const PrivateJwkSchema = z.looseObject({
    kid: z.string().min(1),
    use: z.literal('sig'),
    alg: z.enum(['RS384', 'ES384']),
})

type Tokens = z.infer<typeof TokenSchema>

interface CachedToken {
    accessToken: string
    expiresAt: number
}

async function discoverTokenEndpoint(config: Config): Promise<string> {
    const metadata = await json(`${config.fhirBase}/.well-known/smart-configuration`, DiscoverySchema)

    const isTrustedIssuer = metadata.issuer === config.issuer
    const isTrustedEndpoint = trustedUrl(metadata.token_endpoint).origin === new URL(config.issuer).origin

    if (!isTrustedIssuer || !isTrustedEndpoint) {
        throw new AppError(400, 'Unexpected authorization issuer or token endpoint.')
    }

    const supportsPrivateKeyJwt = metadata.token_endpoint_auth_methods_supported.includes('private_key_jwt')
    const supportsClientCredentials = metadata.grant_types_supported.includes('client_credentials')

    if (!supportsPrivateKeyJwt || !supportsClientCredentials) {
        throw new AppError(400, 'Server does not advertise private_key_jwt with client_credentials.')
    }

    return metadata.token_endpoint
}

async function clientAssertion(config: Config, tokenEndpoint: string): Promise<string> {
    const jwk = PrivateJwkSchema.parse(JSON.parse(await readFile(config.privateJwkPath, 'utf8')))
    const { kid, alg } = jwk
    const key = await importJWK(jwk, alg)

    return new SignJWT({})
        .setProtectedHeader({ alg, typ: 'JWT', kid })
        .setIssuer(config.clientId)
        .setSubject(config.clientId)
        .setAudience(tokenEndpoint)
        .setIssuedAt()
        .setExpirationTime(CLIENT_ASSERTION_LIFETIME)
        .setJti(randomUUID())
        .sign(key)
}

async function requestToken(config: Config): Promise<Tokens> {
    const tokenEndpoint = await discoverTokenEndpoint(config)

    const tokens = await json(tokenEndpoint, TokenSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            scope: config.scopes,
            client_id: config.clientId,
            client_assertion_type: CLIENT_ASSERTION_TYPE,
            client_assertion: await clientAssertion(config, tokenEndpoint),
        }),
    })

    const requestedScopes = splitScopes(config.scopes)
    const hasUnrequestedScope = splitScopes(tokens.scope).some((scope) => !requestedScopes.includes(scope))

    if (hasUnrequestedScope) {
        throw new AppError(502, 'Token response contains scopes that were not requested.')
    }

    return tokens
}

export function tokenProvider(config: Config): () => Promise<string> {
    let cached: CachedToken | undefined

    return async () => {
        if (cached && Date.now() < cached.expiresAt - REFRESH_MARGIN_MS) {
            return cached.accessToken
        }

        const tokens = await requestToken(config)
        const lifetimeSeconds = Math.min(tokens.expires_in, MAX_CACHE_SECONDS)

        cached = { accessToken: tokens.access_token, expiresAt: Date.now() + lifetimeSeconds * 1000 }

        return cached.accessToken
    }
}
