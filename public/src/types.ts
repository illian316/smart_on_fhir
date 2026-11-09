import { z } from 'zod'

import type { Config } from './config.ts'
import { IdSchema } from './http.ts'
import type { Attempt } from './progress.ts'

export const TRANSACTION_TTL_MS = 300_000

export const DiscoverySchema = z.object({
    issuer: z.url(),
    authorization_endpoint: z.url(),
    token_endpoint: z.url(),
    jwks_uri: z.url(),
    token_endpoint_auth_methods_supported: z.array(z.string()),
    code_challenge_methods_supported: z.array(z.string()),
    grant_types_supported: z.array(z.string()),
})

export type Discovery = z.infer<typeof DiscoverySchema>

export const TokenSchema = z.object({
    access_token: z.string().min(1),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive(),
    scope: z.string(),
    id_token: z.string().optional(),
    patient: IdSchema.optional(),
    encounter: IdSchema.optional(),
    refresh_token: z.string().optional(),
})

export type Tokens = z.infer<typeof TokenSchema>

export interface Launch {
    iss: string
    launch: string
}

export interface Pkce {
    verifier: string
    challenge: string
}

export interface Transaction {
    launch: Launch
    discovery: Discovery
    state: string
    verifier: string
    challenge: string
    createdAt: number
}

export interface Context {
    patient: string
    encounter: string
    practitioner: string
}

export interface Session {
    tokens: Tokens
    context: Context
    expiresAt: number
    attempt: Attempt
}

export interface Chart {
    patientName: string
    age: number | null
    encounter: string
    status: string
    started: string
    clinician?: string
    organization?: string
    practitionerRoles?: number
}

export interface Steps {
    readLaunch(query: unknown, config: Config): Launch
    discover(config: Config): Promise<Discovery>
    pkce(): Pkce
    newTransaction(launch: Launch, discovery: Discovery, proof: Pkce): Transaction
    authorizationUrl(config: Config, transaction: Transaction): string
    validateCallback(query: unknown, transaction: Transaction): string
    exchange(config: Config, transaction: Transaction, code: string): Promise<Tokens>
    verifyIdentity(config: Config, discovery: Discovery, tokens: Tokens): Promise<string>
    launchContext(tokens: Tokens, practitioner: string): Context
    loadChart(config: Config, tokens: Tokens, context: Context): Promise<Chart>
}
