import { createRemoteJWKSet, jwtVerify } from 'jose'
import { z } from 'zod'

import { checkDiscovery } from './checks.ts'
import { clinicalSummary } from './extensions.ts'
import { IdSchema, json, PatientSchema, EncounterSchema, referenceId, searchPath, bundle} from './http.ts'
import { DiscoverySchema } from './types.ts'
import { trustedUrl, AppError } from './config.ts'
import type { Steps } from './types.ts'
import { randomToken, fhir, age } from './http.ts'
import { createHash } from 'node:crypto'
import { displayName } from './http.ts'

const jwksByUri = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

const CallbackQuerySchema = z.object({
    state: z.string().min(1),
    code: z.string().min(1).optional(),
    error: z.string().optional(),
}) 
export const steps: Steps = {
    readLaunch(query, config) {
        return z.object({
            iss: z.literal(config.fhirBase),
            launch: z.string().min(1),
        }).parse(query)
    },
    async discover(config) {
        const discovery = await json(`${config.fhirBase}/.well-known/smart-configuration`, DiscoverySchema, {
            headers: { Accept: 'application/json' },
        })
        trustedUrl(`${config.fhirBase}/.well-known/smart-configuration`)
        checkDiscovery(discovery, config)

        return discovery
    },
    pkce() {
        const verifier = randomToken()
        const challenge = createHash('sha256').update(verifier).digest('base64url')

        return { verifier, challenge }
    },
    newTransaction(launch, discovery, proof) {
        return {
            launch,
            discovery,
            verifier: proof.verifier,
            challenge: proof.challenge,
            state: randomToken(),
            createdAt: Date.now(),
        }
    },
    authorizationUrl(config, transaction) {
        const url = new URL(transaction.discovery.authorization_endpoint)
        url.searchParams.set('scope', config.scopes)
        url.searchParams.set('aud', config.fhirBase)
        url.searchParams.set('state', transaction.state)
        url.searchParams.set('code_challenge', transaction.challenge)
        url.searchParams.set('code_challenge_method', 'S256')
        url.searchParams.set('response_type', 'code')
        url.searchParams.set('client_id', config.clientId)
        url.searchParams.set('redirect_uri', config.redirectUri)
        url.searchParams.set('launch', transaction.launch.launch)
        return url.toString()
    },
    validateCallback(query, transaction) {
        var result = CallbackQuerySchema.parse(query)
        if (result.state != transaction.state) {
            throw new Error('Invalid state')
        }
        const maxAge = 5 * 60 * 1000 // 5 minutes
        if (Date.now() - transaction.createdAt > maxAge) {
            throw new Error('Transaction expired')
        }

        if (result.error !== undefined || !result.code) {
            throw new Error('Authorization failed or authorization code is missing')
        }

        return result.code
    },
    async exchange(config, transaction, code) {
        const url = new URL(transaction.discovery.token_endpoint)
        const body = new URLSearchParams()
        body.set('grant_type', 'authorization_code')
        body.set('code', code)
        body.set('redirect_uri', config.redirectUri)
        body.set('client_id', config.clientId)
        body.set('code_verifier', transaction.verifier)

        const response = await fetch(url.toString(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body.toString(),
        })

        if (!response.ok) {
            throw new Error('Token exchange failed')
        }

        return await response.json()
    },
    async verifyIdentity(config, discovery, tokens) {
        checkDiscovery(discovery, config)

        if (!tokens.id_token) {
            throw new Error('Missing ID token; request the openid and fhirUser scopes')
        }

        let jwks = jwksByUri.get(discovery.jwks_uri)

        if (!jwks) {
            jwks = createRemoteJWKSet(new URL(discovery.jwks_uri))
            jwksByUri.set(discovery.jwks_uri, jwks)
        }

        const { payload } = await jwtVerify(tokens.id_token, jwks, {
            issuer: config.issuer,
            audience: config.clientId,
            algorithms: ['RS256', 'ES256'],
            requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp'],
            clockTolerance: 5,
        })

        const hasMultipleAudiences = Array.isArray(payload.aud) && payload.aud.length > 1

        if ((hasMultipleAudiences || payload.azp !== undefined) && payload.azp !== config.clientId) {
            throw new Error('ID token has an unexpected authorized party')
        }

        return referenceId(config, z.string().min(1).parse(payload.fhirUser), 'Practitioner')
    },
    launchContext(tokens, practitioner) {
       var patient = IdSchema.parse(tokens.patient)
       var encounter = IdSchema.parse(tokens.encounter)
       var practitioner = IdSchema.parse(practitioner)

       return {
           patient,
           encounter,
           practitioner,
       }
    },
    async loadChart(config, tokens, context) {
        const [patient, encounters] = await Promise.all([
            fhir(config, tokens.access_token, `Patient/${context.patient}`, PatientSchema),
            fhir(config, tokens.access_token, searchPath('Encounter', { patient: context.patient }),
                    bundle(EncounterSchema)),
        ])
        const encounter = encounters.find((candidate) => candidate.id === context.encounter)
        const isInProgress = encounter?.status === 'in-progress'
        const belongsToPatient = encounter !== undefined && referenceId(config, encounter.subject.reference, 'Patient') === context.patient

        if (!encounter || !isInProgress || !belongsToPatient) {
            throw new AppError(500, 'The launched encounter is not an active consultation for this patient.')
        }

        if (patient.id !== context.patient) {
            throw new AppError(400, 'The launched patient does not match the context patient.')
        }

        return {
                patientName: displayName(patient),
                age: age(patient.birthDate),
                encounter: encounter.id,
                status: encounter.status,
                started: encounter.period?.start ?? 'Not recorded',
            }
        },
        async clinicalSummary(config, tokens, context) {
            return clinicalSummary(config, tokens, context)
        }
}
