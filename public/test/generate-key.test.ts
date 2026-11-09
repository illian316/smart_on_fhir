import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Config } from '../src/config.ts'
import { generateKey } from '../src/generate-key.ts'
import { clientAssertion } from '../src/reference.ts'

const TOKEN_ENDPOINT = 'https://ehr.example/token'

test('Scaffolding: generated key signs assertions that the printed public JWK Set verifies', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'sof-key-'))
    t.after(async () => rm(directory, { recursive: true, force: true }))

    const path = join(directory, 'keys', 'private.jwk.json')
    const { publicJwkSet } = await generateKey(path)

    assert.equal((await stat(path)).mode & 0o777, 0o600)
    await assert.rejects(generateKey(path), { code: 'EEXIST' })

    const config: Config = {
        variant: 'private-key-jwt',
        port: 3100,
        fhirBase: 'https://ehr.example/fhir',
        issuer: 'https://ehr.example/oidc',
        clientId: 'me-key',
        redirectUri: 'http://localhost:3100/callback',
        scopes: 'openid',
        privateJwkPath: path,
    }
    const jwt = await clientAssertion(config, TOKEN_ENDPOINT)
    const storedKey = JSON.parse(await readFile(path, 'utf8'))

    assert.equal(decodeProtectedHeader(jwt).kid, storedKey.kid)

    const { payload } = await jwtVerify(jwt, createLocalJWKSet(publicJwkSet as never), {
        audience: TOKEN_ENDPOINT,
        issuer: 'me-key',
        algorithms: ['RS384'],
    })

    assert.equal(payload.sub, 'me-key')
})
