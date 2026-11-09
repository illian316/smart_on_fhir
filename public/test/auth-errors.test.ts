import { decodeJwt } from 'jose'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { steps } from '../src/steps.ts'

import { fixture, launchContext } from './fixture.ts'
import { IMPLEMENTATIONS } from './implementations.ts'

for (const [name, impl] of Object.entries(IMPLEMENTATIONS)) {
    test(`${name} authentication: reject code replay, wrong PKCE and a changed redirect URI`, async (t) => {
        const f = await fixture()
        t.after(f.close)

        const transaction = impl.newTransaction({ iss: f.config.fhirBase, launch: 'launch' }, f.metadata, impl.pkce())

        f.registerCode('once', transaction.challenge)
        const tokens = await impl.exchange(f.config, transaction, 'once')
        assert.ok(f.issued.has(tokens.access_token))

        await assert.rejects(impl.exchange(f.config, transaction, 'once'))
        assert.equal(f.requests.filter((r) => r.path === '/oidc/token').at(-1)?.status, 400)

        f.registerCode('pkce', transaction.challenge)
        const wrongVerifier = { ...transaction, verifier: impl.pkce().verifier }
        await assert.rejects(impl.exchange(f.config, wrongVerifier, 'pkce'))

        f.registerCode('redirect', transaction.challenge)
        const changedRedirect = { ...f.config, redirectUri: 'http://localhost:3100/changed' }
        await assert.rejects(impl.exchange(changedRedirect, transaction, 'redirect'))

        assert.equal(f.tokenCalls(), 4, 'These attacks must exercise the token server, not merely throw locally')
    })

    test(`${name} authentication: expired access tokens are not accepted`, async (t) => {
        const f = await fixture()
        t.after(f.close)

        const tokens = await f.tokens()
        await impl.loadChart(f.config, tokens, launchContext)

        f.issued.get(tokens.access_token)!.expiresAt = 0

        await assert.rejects(impl.loadChart(f.config, tokens, launchContext))
        assert.ok(f.requests.some((r) => r.path.startsWith('/fhir/') && r.status === 401))
    })

    test(`${name} authentication: state is required even when an authorization error is returned`, async (t) => {
        const f = await fixture()
        t.after(f.close)

        const transaction = impl.newTransaction({ iss: f.config.fhirBase, launch: 'launch' }, f.metadata, impl.pkce())
        const rejectedCallbacks = [
            { code: 'stolen' },
            { state: 'wrong', code: 'stolen' },
            { error: 'access_denied' },
            { state: transaction.state, error: 'access_denied' },
        ]

        assert.equal(impl.validateCallback({ state: transaction.state, code: 'valid' }, transaction), 'valid')

        for (const query of rejectedCallbacks) {
            assert.throws(() => impl.validateCallback(query, transaction))
        }
    })
}

test('Confidential client comparison: client_secret_basic form-encodes the credentials and the secret stays in the header', async (t) => {
    const f = await fixture()
    t.after(f.close)

    f.config.variant = 'client-secret'
    f.config.secret = 'p&ss w/+rd=\u00e9'

    const transaction = steps.newTransaction({ iss: f.config.fhirBase, launch: 'launch' }, f.metadata, steps.pkce())

    f.registerCode('basic', transaction.challenge)
    const tokens = await steps.exchange(f.config, transaction, 'basic')

    assert.ok(f.issued.has(tokens.access_token))

    const [scheme, encoded] = f.lastAuthorization()!.split(' ')

    assert.equal(scheme, 'Basic')
    assert.equal(Buffer.from(encoded!, 'base64').toString(), 'test-team:p%26ss+w%2F%2Brd%3D%C3%A9')
    assert.equal(f.lastBody().has('client_secret'), false)
    assert.equal(f.lastBody().get('client_id'), 'test-team')

    f.registerCode('wrong-secret', transaction.challenge)

    await assert.rejects(steps.exchange({ ...f.config, secret: 'wrong' }, transaction, 'wrong-secret'))
    assert.equal(f.requests.filter((r) => r.path === '/oidc/token').at(-1)?.status, 401)
})

test('Asymmetric client authentication: every token request carries a fresh signed assertion', async (t) => {
    const f = await fixture()
    t.after(f.close)

    f.config.variant = 'private-key-jwt'

    const transaction = steps.newTransaction({ iss: f.config.fhirBase, launch: 'launch' }, f.metadata, steps.pkce())
    const assertionIds: (string | undefined)[] = []

    // The fixture rejects a wrong key, audience, lifetime or a reused jti with 401 invalid_client.
    for (const code of ['first', 'second']) {
        f.registerCode(code, transaction.challenge)

        const tokens = await steps.exchange(f.config, transaction, code)

        assert.ok(f.issued.has(tokens.access_token))
        assert.equal(f.lastAuthorization(), undefined)
        assert.equal(f.lastBody().has('client_secret'), false)
        assertionIds.push(decodeJwt(f.lastBody().get('client_assertion')!).jti)
    }

    assert.equal(assertionIds.length, 2)
    assert.notEqual(assertionIds[0], assertionIds[1])
    assert.equal(f.tokenCalls(), 2)
})
