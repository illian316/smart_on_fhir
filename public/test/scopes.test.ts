import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as reference from '../src/reference.ts'

import { bearer, fixture, launchContext } from './fixture.ts'

test('Reference scopes: requested, granted and actually enforced are different things', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const fullTokens = await f.tokens({ scope: `${f.config.scopes} patient/PractitionerRole.s patient/Organization.r` })
    await reference.loadChart(f.config, fullTokens, launchContext, { includeCareTeam: true })

    const granted = f.config.scopes
    const requested = `${granted} patient/PractitionerRole.s`
    const config = { ...f.config, scopes: requested }
    const transaction = reference.newTransaction(
        { iss: config.fhirBase, launch: 'launch' },
        f.metadata,
        reference.pkce(),
    )
    const authorizeUrl = new URL(reference.authorizationUrl(config, transaction))

    assert.equal(authorizeUrl.searchParams.get('scope'), requested, 'Do not hardcode the default scope set')

    f.registerCode('narrow-code', transaction.challenge, requested)
    const tokens = await reference.exchange(config, transaction, 'narrow-code')

    assert.equal(tokens.scope, granted, 'Use the actual granted scopes, not the request')
    assert.ok(f.issued.has(tokens.access_token))

    const patientResponse = await fetch(`${config.fhirBase}/Patient/p1`, { headers: bearer(tokens) })

    assert.equal(patientResponse.status, 200)

    await reference.loadChart(config, tokens, launchContext)
    await assert.rejects(reference.loadChart(config, tokens, launchContext, { includeCareTeam: true }), /HTTP 403/)

    const denied = await fetch(`${config.fhirBase}/PractitionerRole?practitioner=h1`, { headers: bearer(tokens) })

    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).resourceType, 'OperationOutcome')
    assert.equal(
        f.requests.some((r) => r.path === '/fhir/PractitionerRole' && r.status === 403),
        true,
    )
})
