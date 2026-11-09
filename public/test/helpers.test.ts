import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'

import { configProblems, readConfig } from '../src/config.ts'
import { age, bundle, fhirUrl, isSameSecret, json, PatientSchema, referenceId } from '../src/http.ts'

import { fixture } from './fixture.ts'

test('Scaffolding: host configuration is validated without event access', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const env = {
        FHIR_BASE_URL: f.config.fhirBase,
        AUTH_ISSUER: f.config.issuer,
        CLIENT_ID: f.config.clientId,
        SCOPES: f.config.scopes,
    }
    const config = readConfig(env)

    assert.equal(config.port, 3100)
    assert.throws(() => readConfig({ ...env, CLIENT_ID: '' }))
    assert.throws(
        () => readConfig({ ...env, CLIENT_ID: 'replace-me' }),
        (error) =>
            configProblems(error)?.[0] ===
            'CLIENT_ID: Set CLIENT_ID in .env to the client ID the host registered for you',
    )
    assert.throws(() => readConfig({ ...env, FHIR_BASE_URL: 'http://insecure.example/fhir' }))
})

test('Scaffolding: FHIR URLs cannot leak bearer tokens to another origin or path', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const foreignPaths = [
        'https://wrong.invalid/Patient/p1',
        '//wrong.invalid/p1',
        '../oidc/token',
        '/other/Patient/p1',
    ]

    for (const path of foreignPaths) {
        assert.throws(() => fhirUrl(f.config, path))
    }

    assert.equal(referenceId(f.config, `${f.config.fhirBase}/Practitioner/h1`, 'Practitioner'), 'h1')
    assert.throws(() => referenceId(f.config, 'Patient/p1', 'Practitioner'))
})

test('Scaffolding: isSameSecret compares equal-length secrets only', () => {
    assert.equal(isSameSecret('abc123', 'abc123'), true)
    assert.equal(isSameSecret('abc123', 'abc124'), false)
    assert.equal(isSameSecret('abc', 'abc123'), false)
})

test('Scaffolding: age boundaries and incomplete FHIR data are honest', () => {
    assert.equal(age('1990-06-15', new Date('2026-06-14T12:00:00Z')), 35)
    assert.equal(age('1990-06-15', new Date('2026-06-15T12:00:00Z')), 36)
    assert.equal(age('1990-06-15', new Date('2026-06-14T22:30:00Z')), 36, 'Oslo is already on June 15')
    assert.equal(age('1990-06-15', new Date('2026-06-14T21:30:00Z')), 35)
    assert.equal(age('1990'), null)
    assert.equal(age(undefined), null)
    assert.throws(() => age('2026-02-30'))

    const patients = bundle(PatientSchema)
    const paginated = {
        resourceType: 'Bundle',
        type: 'searchset',
        link: [{ relation: 'next', url: 'https://example.invalid' }],
    }

    assert.deepEqual(patients.parse({ resourceType: 'Bundle', type: 'searchset' }), [])
    assert.throws(() => patients.parse(paginated), /pagination/)
})

test('Scaffolding: unparsable or unexpected upstream JSON never reaches the error message', async (t) => {
    const secret = 'synthetic-secret-in-upstream-body'
    const bodies = [`{"${secret}`, JSON.stringify({ access_token: secret, token_type: 42 })]

    for (const body of bodies) {
        t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 200 }))

        await assert.rejects(
            json('https://ehr.example/x', z.object({ token_type: z.literal('Bearer') })),
            (error: Error) => error.message.startsWith('Upstream') && !error.message.includes(secret),
        )
    }
})
