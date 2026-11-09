import { decodeJwt } from 'jose'
import { createHash } from 'node:crypto'

import { unfinished } from '../src/config.ts'
import type { Steps } from '../src/types.ts'

import type { Fixture } from './fixture.ts'

const VERIFIER = 'synthetic-verifier-0123456789-abcdefghijklmnopqrstuvwxyz'

export const unfinishedSteps: Steps = {
    readLaunch: () => unfinished(1, 'test'),
    discover: async () => unfinished(2, 'test'),
    pkce: () => unfinished(3, 'test'),
    newTransaction: () => unfinished(4, 'test'),
    authorizationUrl: () => unfinished(5, 'test'),
    validateCallback: () => unfinished(6, 'test'),
    exchange: async () => unfinished(7, 'test'),
    verifyIdentity: async () => unfinished(8, 'test'),
    launchContext: () => unfinished(9, 'test'),
    loadChart: async () => unfinished(10, 'test'),
}

export function shapeSteps(f: Fixture, overrides: Partial<Steps> = {}): Steps {
    let transactions = 0

    return {
        readLaunch: (query) => {
            const { iss, launch } = query as { iss: string; launch: string }

            return { iss, launch }
        },
        discover: async () => structuredClone(f.metadata),
        pkce: () => ({ verifier: VERIFIER, challenge: createHash('sha256').update(VERIFIER).digest('base64url') }),
        newTransaction: (launch, discovery, proof) => ({
            launch,
            discovery,
            ...proof,
            state: `synthetic-state-${++transactions}-0123456789`,
            createdAt: Date.now(),
        }),
        authorizationUrl: (config, transaction) => {
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
        validateCallback: (query) => (query as { code: string }).code,
        exchange: async () => f.tokens(),
        verifyIdentity: async (_config, _discovery, tokens) =>
            String(decodeJwt(tokens.id_token ?? '').fhirUser)
                .split('/')
                .pop() ?? '',
        launchContext: (tokens, practitioner) => ({
            patient: tokens.patient ?? '',
            encounter: tokens.encounter ?? '',
            practitioner,
        }),
        loadChart: async (_config, _tokens, context) => ({
            patientName: 'Synthetic <Patient>',
            age: 35,
            encounter: context.encounter,
            status: 'in-progress',
            started: '2026-01-01T10:00:00Z',
        }),
        ...overrides,
    }
}
