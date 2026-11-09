import assert from 'node:assert/strict'
import { test } from 'node:test'

import { configProblems, readConfig } from '../src/config.ts'
import { age, bundle, fhirUrl, PatientSchema, referenceId } from '../src/http.ts'

import { fixture } from './fixture.ts'

test('Scaffolding: host configuration is validated without event access', async (t) => {
    const f = await fixture()
    t.after(f.close)

    const env = {
        FHIR_BASE_URL: f.config.fhirBase,
        AUTH_ISSUER: f.config.issuer,
        CLIENT_ID: f.config.clientId,
        SCOPES: f.config.scopes,
        CLIENT_SECRET: f.config.secret,
        PRIVATE_JWK_PATH: f.config.privateJwkPath,
        PATIENT_IDENTIFIER: f.config.patientIdentifier,
    }
    const config = readConfig(env)

    assert.equal(config.variant, f.config.variant)
    assert.equal(config.port, 3100)
    assert.throws(() => readConfig({ ...env, CLIENT_ID: '' }))
    assert.throws(
        () => readConfig({ ...env, CLIENT_ID: 'replace-me' }),
        (error) =>
            configProblems(error)?.[0] ===
            'CLIENT_ID: Set CLIENT_ID in .env to the client ID the host registered for you',
    )
    assert.throws(() => readConfig({ ...env, FHIR_BASE_URL: 'http://insecure.example/fhir' }))

    if (config.variant === 'client-secret') {
        assert.throws(() => readConfig({ ...env, CLIENT_SECRET: undefined }))
    }

    if (config.variant === 'private-key-jwt' || config.variant === 'backend-services') {
        assert.throws(() => readConfig({ ...env, PRIVATE_JWK_PATH: undefined }))
    }
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
