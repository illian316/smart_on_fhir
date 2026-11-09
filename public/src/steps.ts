import { createLocalJWKSet, jwtVerify } from 'jose'
import { createHash } from 'node:crypto'
import { z } from 'zod'

import { AppError, trustedUrl } from './config.ts'
import {
    age,
    bundle,
    displayName,
    EncounterSchema,
    fhir,
    IdSchema,
    isSameSecret,
    json,
    PatientSchema,
    randomToken,
    referenceId,
    searchPath,
} from './http.ts'
import type * as reference from './reference.ts'
import { tokenRequest } from './reference.ts'
import { DiscoverySchema, TRANSACTION_TTL_MS } from './types.ts'

export type Steps = Pick<
    typeof reference,
    | 'readLaunch'
    | 'discover'
    | 'pkce'
    | 'newTransaction'
    | 'authorizationUrl'
    | 'validateCallback'
    | 'exchange'
    | 'verifyIdentity'
    | 'launchContext'
    | 'loadChart'
>

const ID_TOKEN_CLOCK_TOLERANCE_SECONDS = 5

const LaunchQuerySchema = z.object({
    iss: z.string().max(2048),
    launch: z.string().min(1).max(2048),
})

const CallbackQuerySchema = z.object({
    state: z.string().min(1),
    code: z.string().min(1).optional(),
    error: z.string().optional(),
})

const JwksSchema = z.object({
    keys: z.array(z.looseObject({ kty: z.string() })),
})

export const steps: Steps = {
    // 1. The launch URL is public, so iss and launch are attacker-controlled input. Only a launch from
    // the FHIR server we are configured for is accepted, and the comparison is exact (no prefix match).
    readLaunch(query, config) {
        const result = LaunchQuerySchema.safeParse(query)

        if (!result.success) {
            throw new AppError(400, 'Launch requires iss and a launch ID.')
        }

        if (result.data.iss !== config.fhirBase) {
            throw new AppError(
                400,
                `Launch iss "${result.data.iss}" does not match FHIR_BASE_URL "${config.fhirBase}".`,
            )
        }

        return result.data
    },

    // 2. Endpoints come from the server's discovery document, so the document itself must be pinned to the
    // issuer from .env. Every endpoint must live on the issuer's origin, otherwise a poisoned document
    // could send the authorization code (and later the client credentials) somewhere else.
    async discover(config) {
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

        // A public client has no secret, so PKCE is the only proof of who redeems the code. Refuse a server
        // that does not offer S256, and do not fall back to plain.
        const supportsNoClientAuth = metadata.token_endpoint_auth_methods_supported.includes('none')
        const supportsAuthorizationCode = metadata.grant_types_supported.includes('authorization_code')
        const supportsPkce = metadata.code_challenge_methods_supported.includes('S256')

        if (!supportsNoClientAuth || !supportsAuthorizationCode || !supportsPkce) {
            throw new AppError(400, 'Server does not advertise the required authentication, grant or PKCE method.')
        }

        return metadata
    },

    // 3. The verifier stays on the server. Only its SHA-256 hash (the challenge) goes through the browser.
    // 32 random bytes encode to 43 base64url characters, the minimum length RFC 7636 allows.
    pkce() {
        const verifier = randomToken()
        const challenge = createHash('sha256').update(verifier).digest('base64url')

        return { verifier, challenge }
    },

    // 4. state ties the callback to this browser's launch (CSRF protection for the redirect). It must be
    // unguessable, so it is random and not derived from the launch ID. Everything else stays server-side.
    newTransaction(launch, discovery, proof) {
        return {
            launch,
            discovery,
            ...proof,
            state: randomToken(),
            createdAt: Date.now(),
        }
    },

    // 5. aud is the FHIR base URL: it tells the authorization server which resource server the access token
    // is for. The launch ID is the one-time handle the EPJ gave us. The verifier is never sent here.
    authorizationUrl(config, transaction) {
        const url = new URL(transaction.discovery.authorization_endpoint)

        url.search = new URLSearchParams({
            response_type: 'code',
            client_id: config.clientId,
            redirect_uri: config.redirectUri,
            scope: config.scopes,
            aud: transaction.launch.iss,
            launch: transaction.launch.launch,
            state: transaction.state,
            code_challenge: transaction.challenge,
            code_challenge_method: 'S256',
        }).toString()

        return url.href
    },

    // 6. Check state before looking at anything else, including an error response: otherwise anyone who can
    // send a link to the user could drive the flow. The comparison is constant-time and the transaction
    // expires, so a stale launch cannot be completed later.
    validateCallback(query, transaction) {
        const result = CallbackQuerySchema.safeParse(query)

        const stateMatches = result.success && isSameSecret(result.data.state, transaction.state)
        const isExpired = Date.now() - transaction.createdAt > TRANSACTION_TTL_MS

        if (!result.success || !stateMatches || isExpired) {
            throw new AppError(400, 'Missing, expired or mismatched OAuth state. Launch again from the EPJ.')
        }

        const { code, error } = result.data

        if (error || !code) {
            throw new AppError(400, 'Authorization was declined or no code was returned. Launch again.')
        }

        return code
    },

    // 7. The code is redeemed server-side so the tokens never reach the browser. code_verifier proves we are
    // the client that started this flow, and redirect_uri must repeat the value from the authorization request.
    // tokenRequest adds client_id and this variant's client authentication (none for a public client).
    async exchange(config, transaction, code) {
        return tokenRequest(
            config,
            transaction.discovery,
            new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                code_verifier: transaction.verifier,
                redirect_uri: config.redirectUri,
            }),
        )
    },

    // 8. jwtVerify checks the signature against the issuer's keys before any claim is trusted. issuer and
    // audience pin the token to this server and this client ID (an ID token for another app is rejected).
    // Only RS256 is allowed, so a token cannot choose a weaker algorithm. fhirUser is read last.
    async verifyIdentity(config, discovery, tokens) {
        if (!tokens.id_token) {
            throw new AppError(400, 'No ID token: request and register openid and fhirUser.')
        }

        const jwks = await json(discovery.jwks_uri, JwksSchema)

        const { payload } = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
            issuer: config.issuer,
            audience: config.clientId,
            algorithms: ['RS256'],
            requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp'],
            clockTolerance: ID_TOKEN_CLOCK_TOLERANCE_SECONDS,
        })

        // OpenID Connect Core 3.1.3.7: with several audiences, or an azp claim, azp must be this client.
        const hasMultipleAudiences = Array.isArray(payload.aud) && payload.aud.length > 1
        const hasAuthorizedParty = payload.azp !== undefined
        const authorizedPartyIsThisClient = payload.azp === config.clientId

        if ((hasMultipleAudiences || hasAuthorizedParty) && !authorizedPartyIsThisClient) {
            throw new AppError(400, 'ID token has an unexpected authorized party.')
        }

        // referenceId rejects a fhirUser that is not a Practitioner on our FHIR server.
        return referenceId(config, z.string().parse(payload.fhirUser), 'Practitioner')
    },

    // 9. patient and encounter come back beside access_token in the token response (not in the ID token).
    // Both are required: without them this is not a launch from an ongoing consultation.
    launchContext(tokens, practitioner) {
        if (!tokens.patient || !tokens.encounter) {
            throw new AppError(400, 'Missing patient/encounter launch context. Check the granted launch scope.')
        }

        return {
            patient: tokens.patient,
            encounter: tokens.encounter,
            practitioner: IdSchema.parse(practitioner),
        }
    },

    // 10. The launched encounter, not just any encounter, must be in progress and belong to the launched
    // patient (encounter binding). Otherwise a mismatch between the two would show the wrong chart as active.
    // The optional care-team lookup is left out: it needs extra scopes.
    async loadChart(config, tokens, context) {
        const [patient, encounters] = await Promise.all([
            fhir(config, tokens.access_token, `Patient/${context.patient}`, PatientSchema),
            fhir(
                config,
                tokens.access_token,
                searchPath('Encounter', { patient: context.patient }),
                bundle(EncounterSchema),
            ),
        ])

        const encounter = encounters.find((candidate) => candidate.id === context.encounter)

        const isInProgress = encounter?.status === 'in-progress'
        const belongsToPatient =
            encounter !== undefined && referenceId(config, encounter.subject.reference, 'Patient') === context.patient

        if (!encounter || !isInProgress || !belongsToPatient) {
            throw new AppError(400, 'The launched encounter is not an active consultation for this patient.')
        }

        if (patient.id !== context.patient) {
            throw new AppError(502, 'The FHIR server returned a different patient than the one launched.')
        }

        return {
            patientName: displayName(patient),
            age: age(patient.birthDate),
            encounter: encounter.id,
            status: encounter.status,
            started: encounter.period?.start ?? 'Not recorded',
        }
    },
}
