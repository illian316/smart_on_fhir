import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as extensions from '../src/extensions.ts'

import { bearer, fixture, launchContext } from './fixture.ts'

type ResourceType = 'Observation' | 'DocumentReference'

const RESOURCE_TYPES: ResourceType[] = ['Observation', 'DocumentReference']
const MEASURED_AT = new Date('2026-01-01T10:00:00Z')

function makeResource(type: ResourceType): extensions.TemperatureObservation | extensions.JournalNote {
    if (type === 'Observation') {
        return extensions.temperature(launchContext, 37.2, MEASURED_AT)
    }

    return extensions.journalNote(launchContext, 'Synthetic note')
}

function lastPostStatus(
    requests: { method: string; path: string; status: number }[],
    type: ResourceType,
): number | undefined {
    return requests.filter((r) => r.method === 'POST' && r.path.endsWith(type)).at(-1)?.status
}

for (const type of RESOURCE_TYPES) {
    test(`Reference ${type}: construct the supported resource shape from launch context`, async (t) => {
        const f = await fixture()
        t.after(f.close)

        const tokens = await f.tokens({ scope: `patient/${type}.cr` })
        const resource = makeResource(type)

        assert.equal(resource.resourceType, type)
        assert.equal(resource.subject.reference, 'Patient/p1')
        assert.equal('id' in resource, false, 'Creation must let the server assign an ID')

        if (resource.resourceType === 'Observation') {
            assert.equal(resource.encounter.reference, 'Encounter/e1')
            assert.equal(resource.effectiveDateTime, MEASURED_AT.toISOString())
            assert.equal(resource.valueQuantity.value, 37.2)
            assert.equal(resource.valueQuantity.code, 'Cel')
            assert.throws(() => extensions.temperature(launchContext, Number.NaN, MEASURED_AT))
        } else {
            assert.equal(resource.context.encounter[0]?.reference, 'Encounter/e1')
            assert.equal(resource.description, 'Synthetic note')
            assert.throws(() => extensions.journalNote(launchContext, ' '))
        }

        const response = await fetch(`${f.config.fhirBase}/${type}`, {
            method: 'POST',
            headers: { ...bearer(tokens), 'Content-Type': 'application/fhir+json' },
            body: JSON.stringify(resource),
        })

        assert.equal(response.status, 201, "The fixture validates LOINC/UCUM and nav-epj's narrow document shape")
    })

    test(`Reference ${type}: create, verify Location and read back the persisted resource`, async (t) => {
        const f = await fixture()
        t.after(f.close)

        const tokens = await f.tokens({ scope: `patient/${type}.cr` })
        const created = await extensions.createResource(f.config, tokens, makeResource(type))

        assert.equal(created.resourceType, type)
        assert.ok(f.created.has(`${type}/${created.id}`), 'Returning a fabricated ID is not a successful write')

        const read = await fetch(`${f.config.fhirBase}/${type}/${created.id}`, { headers: bearer(tokens) })

        assert.equal(read.status, 200)
        assert.deepEqual(await read.json(), created)
        assert.equal(f.created.size, 1)
    })

    test(`Reference ${type}: reject missing create scope and another patient's subject without writing`, async (t) => {
        const f = await fixture()
        t.after(f.close)

        const tokens = await f.tokens({ scope: `patient/${type}.cr` })
        await extensions.createResource(f.config, tokens, makeResource(type))

        assert.equal(f.created.size, 1)

        const readOnlyTokens = await f.tokens({ scope: `patient/${type}.r` })

        await assert.rejects(extensions.createResource(f.config, readOnlyTokens, makeResource(type)))
        assert.equal(lastPostStatus(f.requests, type), 403)

        const otherPatient = { ...makeResource(type), subject: { reference: 'Patient/p2' } }

        await assert.rejects(extensions.createResource(f.config, tokens, otherPatient))
        assert.equal(lastPostStatus(f.requests, type), 404)
        assert.equal(f.created.size, 1, 'Rejected writes must not persist anything')
    })

    test(`Reference ${type}: do not report success for a malformed create response`, async (t) => {
        const f = await fixture()
        t.after(f.close)

        const tokens = await f.tokens({ scope: `patient/${type}.cr` })
        await extensions.createResource(f.config, tokens, makeResource(type))

        for (const location of ['missing', 'wrong'] as const) {
            f.createResponse.location = location

            await assert.rejects(
                extensions.createResource(f.config, tokens, makeResource(type)),
                `Reject ${location} Location`,
            )
        }

        f.createResponse.location = 'correct'
        f.createResponse.status = 200

        await assert.rejects(
            extensions.createResource(f.config, tokens, makeResource(type)),
            'FHIR create requires HTTP 201',
        )
        assert.equal(f.created.size, 4, 'Do not automatically retry writes with uncertain outcomes')
    })
}
