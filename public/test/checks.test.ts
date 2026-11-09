import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { checkAuthorizationUrl, checkLaunch, checkPkce, checkTransaction } from '../src/checks.ts'
import type { Config } from '../src/config.ts'
import type { Discovery, Transaction } from '../src/types.ts'

const config: Config = {
    port: 3100,
    fhirBase: 'https://ehr.example/fhir',
    issuer: 'https://ehr.example/oidc',
    clientId: 'test-team',
    redirectUri: 'http://localhost:3100/callback',
    scopes: 'openid fhirUser launch patient/Patient.r',
}

const discovery = {
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/authorize`,
    token_endpoint: `${config.issuer}/token`,
    jwks_uri: `${config.issuer}/jwks`,
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code'],
} satisfies Discovery

const launch = { iss: config.fhirBase, launch: 'synthetic-launch-id' }
const verifier = 'abc.def~ghi-jkl_mno'.padEnd(43, 'x')
const challenge = createHash('sha256').update(verifier).digest('base64url')

const transaction: Transaction = {
    launch,
    discovery,
    state: 'a'.repeat(21),
    verifier,
    challenge,
    createdAt: Date.now(),
}

function authorizationUrl(overrides: Record<string, string> = {}, extra = ''): string {
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: 'patient/Patient.r launch fhirUser openid',
        aud: launch.iss,
        launch: launch.launch,
        state: transaction.state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...overrides,
    })

    return `${discovery.authorization_endpoint}?${params}${extra}`
}

test('Checks: a correct implementation is not rejected for harmless variation', () => {
    checkPkce({ verifier, challenge })
    checkTransaction(transaction, launch, discovery, { verifier, challenge })
    checkAuthorizationUrl(authorizationUrl(), config, transaction)
})

test('Checks: state shorter than 21 characters is rejected', () => {
    assert.throws(
        () => checkTransaction({ ...transaction, state: 'a'.repeat(20) }, launch, discovery, { verifier, challenge }),
        /at least 21/,
    )
})

test('Checks: two missing values never count as a match', () => {
    assert.throws(() => checkLaunch({ iss: config.fhirBase, launch: '' }, {}, config), /launch/)
    assert.throws(() => checkLaunch({ iss: config.fhirBase }, { launch: undefined }, config), /launch/)
})

test('Checks: duplicate or missing authorization parameters are rejected without echoing values', () => {
    assert.throws(
        () => checkAuthorizationUrl(authorizationUrl({}, '&state=other'), config, transaction),
        /exactly once/,
    )
    assert.throws(
        () => checkAuthorizationUrl(authorizationUrl({ scope: 'openid' }), config, transaction),
        /exactly the scopes in SCOPES/,
    )

    const withoutAudience = new URL(authorizationUrl())
    withoutAudience.searchParams.delete('aud')

    assert.throws(
        () => checkAuthorizationUrl(withoutAudience.href, config, transaction),
        (error: Error) => error.message.includes('aud') && !error.message.includes(launch.iss),
    )
})
