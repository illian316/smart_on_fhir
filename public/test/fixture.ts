import Fastify, { type FastifyReply } from 'fastify'
import { errors, exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWTPayload } from 'jose'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import { splitScopes, type Config } from '../src/config.ts'
import type { Encounter, Patient } from '../src/http.ts'
import type { Context, Discovery, Tokens } from '../src/types.ts'
import { variant } from '../src/variant.ts'

const CLIENT_KEY_ID = 'test-key'
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
const MAX_ASSERTION_LIFETIME_SECONDS = 300

const LOINC_SYSTEM = 'http://loinc.org'
const UCUM_SYSTEM = 'http://unitsofmeasure.org'

const ReferenceSchema = z.object({ reference: z.string() }).strict()

const MeasurementInputSchema = z
    .object({
        resourceType: z.literal('Observation'),
        id: z.string().optional(),
        status: z.literal('final'),
        code: z
            .object({
                coding: z
                    .array(
                        z
                            .object({
                                system: z.literal(LOINC_SYSTEM),
                                code: z.literal('8310-5'),
                                display: z.string().min(1),
                            })
                            .strict(),
                    )
                    .length(1),
            })
            .strict(),
        subject: ReferenceSchema,
        encounter: ReferenceSchema,
        effectiveDateTime: z.iso.datetime({ offset: true }),
        valueQuantity: z
            .object({
                value: z.number().finite(),
                unit: z.string().min(1),
                system: z.literal(UCUM_SYSTEM),
                code: z.literal('Cel'),
            })
            .strict(),
    })
    .strict()

const DocumentInputSchema = z
    .object({
        resourceType: z.literal('DocumentReference'),
        id: z.string().optional(),
        status: z.literal('current'),
        type: z
            .object({
                coding: z
                    .array(
                        z
                            .object({
                                system: z.literal('urn:oid:2.16.578.1.12.4.1.1.9602'),
                                code: z.literal('J01-2'),
                            })
                            .strict(),
                    )
                    .length(1),
            })
            .strict(),
        subject: ReferenceSchema,
        context: z.object({ encounter: z.array(ReferenceSchema).length(1) }).strict(),
        description: z.string().trim().min(1),
        content: z
            .array(
                z
                    .object({
                        attachment: z.object({ contentType: z.literal('application/pdf') }).strict(),
                    })
                    .strict(),
            )
            .length(1),
    })
    .strict()

// Sent in every fixture OperationOutcome, like a real server's diagnostics: the app must never show it.
export const UPSTREAM_DETAIL = 'upstream-detail-must-not-leak'

export const launchContext: Context = { patient: 'p1', encounter: 'e1', practitioner: 'h1' }

export function bearer(tokens: Tokens): { Authorization: string } {
    return { Authorization: `Bearer ${tokens.access_token}` }
}

interface IssuedToken {
    scopes: string[]
    expiresAt: number
    patient?: string
}

interface RecordedRequest {
    path: string
    query: Record<string, string>
    method: string
    status: number
}

interface FixtureObservation {
    resourceType: string
    id: string
    effectiveDateTime: string
    code: { coding: { system: string; code: string; display: string }[] }
    subject: { reference: string }
    encounter: { reference: string }
    valueQuantity: { value: number; unit: string; system: string; code: string }
}

interface CreateResponse {
    status: number
    location: 'correct' | 'missing' | 'wrong'
    readback: 'correct' | 'missing' | 'wrong-id' | 'other-patient'
    // What the server does after it has stored the resource.
    delivery: 'normal' | 'disconnect' | 'empty' | 'malformed'
}

export interface Fixture {
    config: Config
    metadata: Discovery
    patient: Patient
    encounter: Encounter
    measurements: FixtureObservation[]
    tokens: (overrides?: Partial<Tokens>) => Promise<Tokens>
    client: Awaited<ReturnType<typeof generateKeyPair>>
    issued: Map<string, IssuedToken>
    requests: RecordedRequest[]
    created: Map<string, Record<string, unknown>>
    createResponse: CreateResponse
    registeredScopes: string[]
    registerCode: (code: string, challenge: string, scope?: string) => void
    tokenCalls: () => number
    lastBody: () => URLSearchParams
    lastAuthorization: () => string | undefined
    signIdentity: (claims: JWTPayload) => Promise<string>
    close: () => Promise<void>
}

export async function fixture(clientAlg: 'ES384' | 'RS384' = 'ES384', modulusLength = 3072): Promise<Fixture> {
    const server = Fastify()
    const signing = await generateKeyPair('RS256')
    const client = await generateKeyPair(clientAlg, { extractable: true, modulusLength })

    const directory = await mkdtemp(join(tmpdir(), 'smart-starter-test-'))
    const keyPath = join(directory, 'private.json')
    const clientJwk = { ...(await exportJWK(client.privateKey)), kid: CLIENT_KEY_ID, alg: clientAlg, use: 'sig' }
    await writeFile(keyPath, JSON.stringify(clientJwk), { mode: 0o600 })

    const config = createConfig(keyPath)
    const registeredScopes = splitScopes(config.scopes)
    const metadata = createMetadata()
    const patient = createPatient()
    const encounter = createEncounter()
    const measurements = [3, 1, 2].map(createTemperatureObservation)

    const issued = new Map<string, IssuedToken>()
    const requests: RecordedRequest[] = []
    const created = new Map<string, Record<string, unknown>>()
    const createResponse: CreateResponse = { status: 201, location: 'correct', readback: 'correct', delivery: 'normal' }
    const usedAssertions = new Set<string>()
    const codes = new Map<string, { challenge: string; scope: string }>()

    let tokenCalls = 0
    let lastBody = new URLSearchParams()
    let lastAuthorization: string | undefined

    async function issueTokens(overrides: Partial<Tokens> = {}): Promise<Tokens> {
        const userContext: Partial<Tokens> =
            config.variant === 'backend-services'
                ? {}
                : {
                      patient: 'p1',
                      encounter: 'e1',
                      id_token: await new SignJWT({ fhirUser: 'Practitioner/h1' })
                          .setProtectedHeader({ alg: 'RS256' })
                          .setIssuer(config.issuer)
                          .setAudience(config.clientId)
                          .setSubject('h1')
                          .setIssuedAt()
                          .setExpirationTime('5m')
                          .sign(signing.privateKey),
                  }

        const tokens: Tokens = {
            access_token: `synthetic-${randomUUID()}`,
            token_type: 'Bearer',
            scope: config.scopes,
            expires_in: 300,
            ...userContext,
            ...overrides,
        }

        issued.set(tokens.access_token, {
            scopes: splitScopes(tokens.scope),
            expiresAt: Date.now() + tokens.expires_in * 1000,
            patient: tokens.patient,
        })

        return tokens
    }

    async function isValidClientAssertion(body: URLSearchParams): Promise<boolean> {
        if (body.get('client_assertion_type') !== CLIENT_ASSERTION_TYPE) {
            return false
        }

        try {
            const { payload, protectedHeader } = await jwtVerify(body.get('client_assertion') ?? '', client.publicKey, {
                issuer: config.clientId,
                subject: config.clientId,
                audience: metadata.token_endpoint,
                algorithms: [clientAlg],
                requiredClaims: ['iss', 'sub', 'aud', 'exp', 'jti'],
            })
            const { jti, exp } = payload

            const hasExpectedHeader = protectedHeader.kid === CLIENT_KEY_ID && protectedHeader.typ === 'JWT'
            const isReplay = !jti || usedAssertions.has(jti)
            const isTooLongLived = !exp || exp > Math.floor(Date.now() / 1000) + MAX_ASSERTION_LIFETIME_SECONDS

            if (!hasExpectedHeader || isReplay || isTooLongLived) {
                return false
            }

            usedAssertions.add(jti)

            return true
        } catch (error) {
            if (!(error instanceof errors.JOSEError)) {
                throw error
            }

            return false
        }
    }

    async function isClientAuthenticated(body: URLSearchParams, authorization?: string): Promise<boolean> {
        if (body.get('client_id') !== config.clientId) {
            return false
        }

        if (config.variant === 'public') {
            return !(authorization || body.has('client_assertion') || body.has('client_secret'))
        }

        if (config.variant === 'client-secret') {
            const basic = decodeBasic(authorization)

            return basic?.id === config.clientId && basic.secret === config.secret && !body.has('client_secret')
        }

        return isValidClientAssertion(body)
    }

    async function exchangeAuthorizationCode(body: URLSearchParams, reply: FastifyReply): Promise<unknown> {
        const code = body.get('code') ?? ''
        const authorization = codes.get(code)
        codes.delete(code)

        const proof = createHash('sha256')
            .update(body.get('code_verifier') ?? '')
            .digest('base64url')
        const isValidGrant = authorization?.challenge === proof && body.get('redirect_uri') === config.redirectUri

        if (!authorization || !isValidGrant) {
            return reply.code(400).send({ error: 'invalid_grant' })
        }

        return issueTokens({ scope: authorization.scope })
    }

    async function issueClientCredentials(body: URLSearchParams, reply: FastifyReply): Promise<unknown> {
        const requested = splitScopes(body.get('scope') ?? '')

        if (requested.some((scope) => !registeredScopes.includes(scope))) {
            return reply.code(400).send({ error: 'invalid_scope' })
        }

        return issueTokens({ scope: requested.join(' ') })
    }

    function registerTokenEndpoint(): void {
        server.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
            done(null, new URLSearchParams(String(body))),
        )

        server.post<{ Body: URLSearchParams }>('/oidc/token', async (request, reply) => {
            tokenCalls++
            lastBody = request.body
            lastAuthorization = request.headers.authorization

            if (!(await isClientAuthenticated(lastBody, lastAuthorization))) {
                return reply.code(401).send({ error: 'invalid_client' })
            }

            const isBackendServices = config.variant === 'backend-services'
            const grantType = lastBody.get('grant_type')

            if (grantType === 'authorization_code' && !isBackendServices) {
                return exchangeAuthorizationCode(lastBody, reply)
            }

            if (grantType !== 'client_credentials' || !isBackendServices) {
                return reply.code(400).send({ error: 'unsupported_grant_type' })
            }

            return issueClientCredentials(lastBody, reply)
        })
    }

    function registerFhirAuthorization(): void {
        server.addHook('preHandler', async (request, reply) => {
            if (!request.url.startsWith('/fhir/') || request.url.includes('.well-known')) {
                return
            }

            const authorization = request.headers.authorization
            const token = issued.get(authorization?.replace(/^Bearer /, '') ?? '')

            if (!token || token.expiresAt <= Date.now() || !authorization?.startsWith('Bearer ')) {
                return outcome(reply, 401, 'login')
            }

            const parts = new URL(request.url, 'http://localhost').pathname.split('/')
            const resource = parts[2]
            const interaction = requiredInteraction(request.method, parts)
            const isSystemToken = token.scopes.some((scope) => scope.startsWith('system/'))

            // Match nav-epj's self-practitioner and non-system organization read exceptions.
            const isSelfPractitionerRead =
                interaction === 'r' &&
                resource === 'Practitioner' &&
                parts[3] === 'h1' &&
                token.scopes.includes('fhirUser')
            const isOrganizationRead = interaction === 'r' && resource === 'Organization' && !isSystemToken

            if (isSelfPractitionerRead || isOrganizationRead) {
                return
            }

            const prefix = `${isSystemToken ? 'system' : 'patient'}/${resource}.`
            const isPermitted = token.scopes.some(
                (scope) => scope.startsWith(prefix) && scope.slice(prefix.length).includes(interaction),
            )

            if (!isPermitted) {
                return outcome(reply, 403, 'forbidden')
            }
        })
    }

    function registerReadRoutes(): void {
        server.get('/fhir/Patient/p1', async () => patient)

        server.get('/fhir/Patient', async (request, reply) => {
            const params = searchParamsOf(request.url)

            if (!usesOnlyParams(params, ['identifier']) || params.get('identifier') !== config.patientIdentifier) {
                return outcome(reply, 400, 'invalid')
            }

            return searchset([patient])
        })

        server.get('/fhir/Encounter', async (request, reply) => {
            const params = searchParamsOf(request.url)

            if (!usesOnlyParams(params, ['patient', 'subject']) || !isSearchForPatient(params)) {
                return outcome(reply, 400, 'invalid')
            }

            return searchset([encounter])
        })

        server.get('/fhir/Practitioner/h1', async () => ({
            resourceType: 'Practitioner',
            id: 'h1',
            name: [{ text: 'Test clinician' }],
        }))

        server.get('/fhir/PractitionerRole', async (request, reply) => {
            const params = searchParamsOf(request.url)
            const isForPractitioner = ['h1', 'Practitioner/h1'].includes(params.get('practitioner') ?? '')

            if (!usesOnlyParams(params, ['practitioner']) || !isForPractitioner) {
                return outcome(reply, 400, 'invalid')
            }

            return searchset([{ resourceType: 'PractitionerRole', id: 'r1' }])
        })

        server.get('/fhir/Organization/o1', async () => ({
            resourceType: 'Organization',
            id: 'o1',
            name: 'Test practice',
        }))

        server.get('/fhir/Condition', async (request, reply) => {
            const params = searchParamsOf(request.url)
            const isForEncounter =
                !params.has('encounter') || ['e1', 'Encounter/e1'].includes(params.get('encounter') ?? '')

            if (
                !usesOnlyParams(params, ['patient', 'subject', 'encounter']) ||
                !isSearchForPatient(params) ||
                !isForEncounter
            ) {
                return outcome(reply, 400, 'invalid')
            }

            return searchset([
                {
                    resourceType: 'Condition',
                    id: 'c1',
                    subject: { reference: 'Patient/p1' },
                    encounter: { reference: 'Encounter/e1' },
                    code: { coding: [{ system: 'urn:oid:2.16.578.1.12.4.1.1.7170', code: 'R05' }] },
                },
            ])
        })

        server.get('/fhir/Observation', async (request, reply) => {
            const params = searchParamsOf(request.url)
            const code = params.get('code')?.replace(/^http:\/\/loinc.org\|/, '')
            const isSupportedCode = ['8310-5', '8867-4'].includes(code ?? '')

            if (
                !usesOnlyParams(params, ['patient', 'subject', 'code']) ||
                !isSearchForPatient(params) ||
                !isSupportedCode
            ) {
                return outcome(reply, 400, 'invalid')
            }

            return searchset(measurements.filter((m) => m.code.coding.some((coding) => coding.code === code)))
        })
    }

    function registerWriteRoutes(): void {
        server.addContentTypeParser(
            'application/fhir+json',
            { parseAs: 'string' },
            server.getDefaultJsonParser('error', 'error'),
        )

        for (const type of ['Observation', 'DocumentReference']) {
            server.post(`/fhir/${type}`, async (request, reply) => {
                const inputSchema = type === 'Observation' ? MeasurementInputSchema : DocumentInputSchema
                const parsed = inputSchema.safeParse(request.body)

                if (!parsed.success) {
                    return outcome(reply, 400, 'invalid')
                }

                const body = parsed.data
                const token = issued.get(request.headers.authorization!.slice('Bearer '.length))!

                if (token.patient && body.subject.reference !== `Patient/${token.patient}`) {
                    return outcome(reply, 404, 'not-found')
                }

                const encounterReference =
                    body.resourceType === 'Observation'
                        ? body.encounter.reference
                        : body.context.encounter[0]!.reference

                if (body.subject.reference !== 'Patient/p1' || encounterReference !== 'Encounter/e1') {
                    return outcome(reply, 400, 'invalid')
                }

                const resource = { ...body, id: `created-${created.size + 1}` }
                created.set(`${type}/${resource.id}`, resource)

                if (createResponse.delivery === 'disconnect') {
                    // Stored, then the connection drops before any response. A hijacked reply skips onResponse.
                    requests.push({ path: `/fhir/${type}`, query: {}, method: 'POST', status: 0 })
                    reply.hijack()
                    request.raw.socket.destroy()

                    return reply
                }

                if (createResponse.location !== 'missing') {
                    const locationId = createResponse.location === 'correct' ? resource.id : 'wrong-id'
                    reply.header('Location', `${config.fhirBase}/${type}/${locationId}`)
                }

                if (createResponse.delivery === 'empty') {
                    return reply.code(createResponse.status).send('')
                }

                if (createResponse.delivery === 'malformed') {
                    return reply.code(createResponse.status).type('application/fhir+json').send('{not json')
                }

                return reply.code(createResponse.status).send(resource)
            })

            server.get<{ Params: { id: string } }>(`/fhir/${type}/:id`, async (request, reply) => {
                const resource = created.get(`${type}/${request.params.id}`)

                if (!resource || createResponse.readback === 'missing') {
                    return outcome(reply, 404, 'not-found')
                }

                if (createResponse.readback === 'wrong-id') {
                    return { ...resource, id: 'someone-elses-resource' }
                }

                if (createResponse.readback === 'other-patient') {
                    return { ...resource, subject: { reference: 'Patient/p2' } }
                }

                return resource
            })
        }
    }

    server.addHook('onResponse', async (request, reply) => {
        const url = new URL(request.url, 'http://localhost')

        requests.push({
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            method: request.method,
            status: reply.statusCode,
        })
    })

    server.get('/fhir/.well-known/smart-configuration', async () => metadata)
    server.get('/oidc/jwks', async () => ({ keys: [await exportJWK(signing.publicKey)] }))
    registerTokenEndpoint()
    registerFhirAuthorization()
    registerReadRoutes()
    registerWriteRoutes()

    const origin = await server.listen({ port: 0, host: '127.0.0.1' })
    config.fhirBase = `${origin}/fhir`
    config.issuer = `${origin}/oidc`

    Object.assign(metadata, {
        issuer: config.issuer,
        authorization_endpoint: `${config.issuer}/authorize`,
        token_endpoint: `${config.issuer}/token`,
        jwks_uri: `${config.issuer}/jwks`,
    })

    return {
        config,
        metadata,
        patient,
        encounter,
        measurements,
        tokens: issueTokens,
        client,
        issued,
        requests,
        created,
        createResponse,
        registeredScopes,
        registerCode: (code, challenge, scope = config.scopes) => {
            const grantedScopes = splitScopes(scope).filter((candidate) => registeredScopes.includes(candidate))

            codes.set(code, { challenge, scope: grantedScopes.join(' ') })
        },
        tokenCalls: () => tokenCalls,
        lastBody: () => lastBody,
        lastAuthorization: () => lastAuthorization,
        signIdentity: async (claims) =>
            new SignJWT(claims).setProtectedHeader({ alg: 'RS256' }).sign(signing.privateKey),
        close: async () => {
            await server.close()
            await rm(directory, { recursive: true, force: true })
        },
    }
}

function createConfig(keyPath: string): Config {
    return {
        variant,
        port: 3100,
        fhirBase: '',
        issuer: '',
        clientId: 'test-team',
        redirectUri: 'http://localhost:3100/callback',
        secret: 'synthetic-test-secret',
        privateJwkPath: keyPath,
        patientIdentifier: 'urn:oid:2.16.578.1.12.4.1.4.1|synthetic',
        scopes:
            variant === 'backend-services'
                ? 'system/Patient.rs'
                : 'openid fhirUser launch patient/Patient.r patient/Encounter.s',
    }
}

function createMetadata(): Discovery {
    return {
        issuer: '',
        authorization_endpoint: '',
        token_endpoint: '',
        jwks_uri: '',
        token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'private_key_jwt'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'client_credentials'],
    }
}

function createPatient(): Patient {
    return {
        resourceType: 'Patient',
        id: 'p1',
        name: [{ given: ['Synthetic'], family: '<Patient>' }],
        birthDate: '1990-06-15',
    }
}

function createEncounter(): Encounter {
    return {
        resourceType: 'Encounter',
        id: 'e1',
        status: 'in-progress',
        subject: { reference: 'Patient/p1' },
        serviceProvider: { reference: 'Organization/o1' },
        period: { start: '2026-01-01T10:00:00Z' },
    }
}

function createTemperatureObservation(day: number): FixtureObservation {
    return {
        resourceType: 'Observation',
        id: `obs${day}`,
        effectiveDateTime: `2026-01-0${day}T10:00:00Z`,
        code: { coding: [{ system: LOINC_SYSTEM, code: '8310-5', display: 'Body temperature' }] },
        subject: { reference: 'Patient/p1' },
        encounter: { reference: 'Encounter/e1' },
        valueQuantity: {
            value: 36 + day / 10,
            unit: 'degrees Celsius',
            system: UCUM_SYSTEM,
            code: 'Cel',
        },
    }
}

function formDecode(value: string): string | null {
    return new URLSearchParams(`v=${value}`).get('v')
}

function decodeBasic(header = ''): { id: string | null; secret: string | null } | undefined {
    const [scheme, encoded] = header.split(' ')

    if (scheme !== 'Basic' || !encoded) {
        return undefined
    }

    const credentials = Buffer.from(encoded, 'base64').toString()
    const separator = credentials.indexOf(':')

    if (separator < 0) {
        return undefined
    }

    return {
        id: formDecode(credentials.slice(0, separator)),
        secret: formDecode(credentials.slice(separator + 1)),
    }
}

function searchset(resources: unknown[]): object {
    return {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: resources.map((resource) => ({ resource })),
    }
}

function outcome(reply: FastifyReply, status: number, code: string): FastifyReply {
    return reply
        .code(status)
        .send({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code, diagnostics: UPSTREAM_DETAIL }] })
}

function requiredInteraction(method: string, pathParts: string[]): 'c' | 's' | 'r' {
    if (method === 'POST') {
        return 'c'
    }

    return pathParts.length === 3 ? 's' : 'r'
}

function searchParamsOf(url: string): URLSearchParams {
    return new URL(url, 'http://localhost').searchParams
}

function usesOnlyParams(params: URLSearchParams, allowed: string[]): boolean {
    return [...params.keys()].every((key) => allowed.includes(key) && params.getAll(key).length === 1)
}

function isSearchForPatient(params: URLSearchParams): boolean {
    const values = [...params.getAll('patient'), ...params.getAll('subject')]

    return values.length === 1 && ['p1', 'Patient/p1'].includes(values[0]!)
}
