import { createLocalJWKSet, importJWK, jwtVerify, SignJWT } from 'jose'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'

import { AppError, splitScopes, trustedUrl, type Config, type Variant } from './config.ts'
import {
    age,
    bundle,
    displayName,
    EncounterSchema,
    fhir,
    IdSchema,
    isSameSecret,
    json,
    OrganizationSchema,
    PatientSchema,
    PractitionerSchema,
    randomToken,
    referenceId,
    RoleSchema,
    searchPath,
    type Encounter,
    type Patient,
} from './http.ts'
import {
    DiscoverySchema,
    TokenSchema,
    TRANSACTION_TTL_MS,
    type Chart,
    type Context,
    type Discovery,
    type Launch,
    type Pkce,
    type Tokens,
    type Transaction,
} from './types.ts'

const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
const CLIENT_ASSERTION_LIFETIME = '2m'

const ID_TOKEN_CLOCK_TOLERANCE_SECONDS = 5
const MAX_BACKEND_TOKEN_LIFETIME_SECONDS = 300

const TOKEN_AUTH_METHODS: Record<Variant, string> = {
    public: 'none',
    'client-secret': 'client_secret_basic',
    'private-key-jwt': 'private_key_jwt',
    'backend-services': 'private_key_jwt',
}

const LaunchQuerySchema = z.object({
    iss: z.string().max(2048),
    launch: z.string().min(1).max(2048),
})

const CallbackQuerySchema = z.object({
    state: z.string().min(1),
    code: z.string().min(1).optional(),
    error: z.string().optional(),
})

const ClientKeySchema = z.looseObject({
    kid: z.string().min(1),
    use: z.literal('sig'),
    alg: z.enum(['RS384', 'ES384']),
})

const JwksSchema = z.object({
    keys: z.array(z.object({ kty: z.string() }).passthrough()),
})

export function readLaunch(query: unknown, config: Config): Launch {
    const result = LaunchQuerySchema.safeParse(query)

    if (!result.success) {
        throw new AppError(400, 'Launch requires iss and a launch ID.')
    }

    if (result.data.iss !== config.fhirBase) {
        throw new AppError(400, `Launch iss "${result.data.iss}" does not match FHIR_BASE_URL "${config.fhirBase}".`)
    }

    return result.data
}

export async function discover(config: Config): Promise<Discovery> {
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

    const method = TOKEN_AUTH_METHODS[config.variant]
    const grant = config.variant === 'backend-services' ? 'client_credentials' : 'authorization_code'

    const supportsMethod = metadata.token_endpoint_auth_methods_supported.includes(method)
    const supportsGrant = metadata.grant_types_supported.includes(grant)
    const supportsPkce = grant !== 'authorization_code' || metadata.code_challenge_methods_supported.includes('S256')

    if (!supportsMethod || !supportsGrant || !supportsPkce) {
        throw new AppError(400, 'Server does not advertise the required authentication, grant or PKCE method.')
    }

    return metadata
}

export function pkce(): Pkce {
    const verifier = randomToken()
    const challenge = createHash('sha256').update(verifier).digest('base64url')

    return { verifier, challenge }
}

export function newTransaction(launch: Launch, discovery: Discovery, proof: Pkce): Transaction {
    return {
        launch,
        discovery,
        ...proof,
        state: randomToken(),
        createdAt: Date.now(),
    }
}

export function authorizationUrl(config: Config, transaction: Transaction): string {
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
}

export function validateCallback(query: unknown, transaction: Transaction): string {
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
}

export async function clientAssertion(config: Config, tokenEndpoint: string): Promise<string> {
    if (!config.privateJwkPath) {
        throw new AppError(400, 'Missing PRIVATE_JWK_PATH.')
    }

    const jwk = ClientKeySchema.parse(JSON.parse(await readFile(config.privateJwkPath, 'utf8')))
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

export async function tokenRequest(config: Config, discovery: Discovery, body: URLSearchParams): Promise<Tokens> {
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
    body.set('client_id', config.clientId)

    if (config.variant === 'client-secret') {
        if (!config.secret) {
            throw new AppError(400, 'Missing CLIENT_SECRET.')
        }

        const credentials = `${formUrlEncode(config.clientId)}:${formUrlEncode(config.secret)}`
        headers.Authorization = `Basic ${Buffer.from(credentials).toString('base64')}`
    } else if (config.variant !== 'public') {
        body.set('client_assertion_type', CLIENT_ASSERTION_TYPE)
        body.set('client_assertion', await clientAssertion(config, discovery.token_endpoint))
    }

    return json(discovery.token_endpoint, TokenSchema, { method: 'POST', headers, body })
}

export async function exchange(config: Config, transaction: Transaction, code: string): Promise<Tokens> {
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
}

export async function verifyIdentity(config: Config, discovery: Discovery, tokens: Tokens): Promise<string> {
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

    const hasMultipleAudiences = Array.isArray(payload.aud) && payload.aud.length > 1
    const hasAuthorizedParty = payload.azp !== undefined
    const authorizedPartyIsThisClient = payload.azp === config.clientId

    if ((hasMultipleAudiences || hasAuthorizedParty) && !authorizedPartyIsThisClient) {
        throw new AppError(400, 'ID token has an unexpected authorized party.')
    }

    // nav-epj signs ID tokens with RS256; ES384 is for client assertions, not ID tokens.
    return referenceId(config, z.string().parse(payload.fhirUser), 'Practitioner')
}

export function launchContext(tokens: Tokens, practitioner: string): Context {
    if (!tokens.patient || !tokens.encounter) {
        throw new AppError(400, 'Missing patient/encounter launch context. Check the granted launch scope.')
    }

    return {
        patient: tokens.patient,
        encounter: tokens.encounter,
        practitioner: IdSchema.parse(practitioner),
    }
}

export async function loadChart(
    config: Config,
    tokens: Tokens,
    context: Context,
    options: { includeCareTeam?: boolean } = {},
): Promise<Chart> {
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

    if (!isActiveConsultation(config, encounter, context.patient)) {
        throw new AppError(400, 'The launched encounter is not an active consultation for this patient.')
    }

    const chart: Chart = {
        patientName: displayName(patient),
        age: age(patient.birthDate),
        encounter: encounter.id,
        status: encounter.status,
        started: encounter.period?.start ?? 'Not recorded',
    }

    if (!options.includeCareTeam) {
        return chart
    }

    return { ...chart, ...(await loadCareTeam(config, tokens, context, encounter)) }
}

export async function backendToken(config: Config, discovery: Discovery): Promise<Tokens> {
    if (config.variant !== 'backend-services') {
        throw new AppError(400, 'Use the Backend Services starter.')
    }

    const tokens = await tokenRequest(
        config,
        discovery,
        new URLSearchParams({
            grant_type: 'client_credentials',
            scope: config.scopes,
        }),
    )

    const requestedScopes = splitScopes(config.scopes)

    const hasUserContext = Boolean(tokens.patient || tokens.encounter || tokens.id_token || tokens.refresh_token)
    const isTooLongLived = tokens.expires_in > MAX_BACKEND_TOKEN_LIFETIME_SECONDS
    const hasUnexpectedScope =
        !tokens.scope ||
        splitScopes(tokens.scope).some((scope) => !scope.startsWith('system/') || !requestedScopes.includes(scope))

    if (hasUserContext || isTooLongLived || hasUnexpectedScope) {
        throw new AppError(502, 'Backend token violates the patient-less, system-scope, five-minute contract.')
    }

    return tokens
}

export async function backendSearch(config: Config, tokens: Tokens): Promise<Patient[]> {
    if (!config.patientIdentifier) {
        throw new AppError(400, 'Set PATIENT_IDENTIFIER from your synthetic cohort roster.')
    }

    return fhir(
        config,
        tokens.access_token,
        searchPath('Patient', { identifier: config.patientIdentifier }),
        bundle(PatientSchema),
    )
}

function formUrlEncode(value: string): string {
    return new URLSearchParams({ v: value }).toString().slice(2)
}

function isActiveConsultation(
    config: Config,
    encounter: Encounter | undefined,
    patientId: string,
): encounter is Encounter {
    if (!encounter || encounter.status !== 'in-progress') {
        return false
    }

    return referenceId(config, encounter.subject.reference, 'Patient') === patientId
}

async function loadCareTeam(
    config: Config,
    tokens: Tokens,
    context: Context,
    encounter: Encounter,
): Promise<Pick<Chart, 'clinician' | 'organization' | 'practitionerRoles'>> {
    if (!encounter.serviceProvider) {
        throw new AppError(400, 'The optional care-team view needs an encounter serviceProvider.')
    }

    const organizationId = referenceId(config, encounter.serviceProvider.reference, 'Organization')

    const [practitioner, roles, organization] = await Promise.all([
        fhir(config, tokens.access_token, `Practitioner/${context.practitioner}`, PractitionerSchema),
        fhir(
            config,
            tokens.access_token,
            searchPath('PractitionerRole', { practitioner: context.practitioner }),
            bundle(RoleSchema),
        ),
        fhir(config, tokens.access_token, `Organization/${organizationId}`, OrganizationSchema),
    ])

    return {
        clinician: displayName(practitioner),
        organization: organization.name ?? 'Name unavailable',
        practitionerRoles: roles.length,
    }
}
