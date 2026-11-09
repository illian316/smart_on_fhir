import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { AppError, type Config } from './config.ts'
import { createResource, journalNote, temperature } from './extensions.ts'
import { escapeHtml, fhir, IdSchema, isSameSecret, ReferenceSchema, referenceId } from './http.ts'
import { appPage, scopeHint, type RouteDeps } from './routes.ts'
import { missingScopes } from './scopes.ts'
import type { Session } from './types.ts'

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded'

const MIN_CELSIUS = 25
const MAX_CELSIUS = 45
const MAX_NOTE_LENGTH = 2000

// A note of 2000 characters can be six times as long once percent-encoded, plus the field names.
const MAX_FORM_BYTES = 32_768

const CsrfSchema = z.object({ csrf: z.string().min(1).max(256) })

const CelsiusSchema = z
    .string()
    .trim()
    .regex(/^\d{1,2}(?:[.,]\d{1,2})?$/, 'Temperature must be a number in degrees Celsius with at most two decimals.')
    .transform((text) => Number(text.replace(',', '.')))
    .refine(
        (value) => value >= MIN_CELSIUS && value <= MAX_CELSIUS,
        `Temperature must be between ${MIN_CELSIUS} and ${MAX_CELSIUS} degrees Celsius.`,
    )

// strictObject rejects unknown fields, so a forged patient or encounter field fails instead of being ignored.
const TemperatureFormSchema = z.strictObject({
    csrf: z.string(),
    celsius: CelsiusSchema,
})

const NoteFormSchema = z.strictObject({
    csrf: z.string(),
    note: z
        .string()
        .trim()
        .min(1, 'The note is empty.')
        .max(MAX_NOTE_LENGTH, `The note is longer than ${MAX_NOTE_LENGTH} characters.`),
})

const ObservationReadBackSchema = z.object({
    resourceType: z.literal('Observation'),
    id: IdSchema,
    subject: ReferenceSchema,
    encounter: ReferenceSchema,
    valueQuantity: z.object({ value: z.number().finite(), unit: z.string() }),
})

const DocumentReadBackSchema = z.object({
    resourceType: z.literal('DocumentReference'),
    id: IdSchema,
    subject: ReferenceSchema,
    context: z.object({ encounter: z.array(ReferenceSchema).min(1) }),
    description: z.string(),
})

interface ReadBack {
    id: string
    resourceType: string
    summary: string
}

type CreateKind = 'Observation' | 'DocumentReference'

export function registerWriteBack(app: FastifyInstance, deps: RouteDeps): void {
    // The only URL-encoded bodies this app accepts are its own two forms, so a small parser is enough.
    // Repeated fields are refused: which one wins is a classic way to bypass validation.
    app.addContentTypeParser(
        FORM_CONTENT_TYPE,
        { parseAs: 'string', bodyLimit: MAX_FORM_BYTES },
        (_request, body, done) => {
            const fields = new Map<string, string>()

            for (const [key, value] of new URLSearchParams(String(body))) {
                if (fields.has(key)) {
                    return done(new AppError(400, 'A form field was sent more than once.'))
                }

                fields.set(key, value)
            }

            done(null, Object.fromEntries(fields))
        },
    )

    // GET only renders forms. Nothing is written until the user submits one.
    app.get('/write', async (request, reply) => {
        const session = deps.requireSession(request)

        return reply.type('text/html').send(appPage('Write back', formsContent(session)))
    })

    app.post('/write/temperature', async (request, reply) => {
        const session = authorizePost(request, deps, 'Observation')
        const { celsius } = parseForm(TemperatureFormSchema, request.body)

        // Patient and encounter come from the session, never from the form.
        const created = await createResource(deps.config, session.tokens, temperature(session.context, celsius))

        return sendResult(reply, deps.config, session, created)
    })

    app.post('/write/note', async (request, reply) => {
        const session = authorizePost(request, deps, 'DocumentReference')
        const { note } = parseForm(NoteFormSchema, request.body)

        const created = await createResource(deps.config, session.tokens, journalNote(session.context, note))

        return sendResult(reply, deps.config, session, created)
    })
}

// Order matters: who is asking (session), where the request came from (Origin), proof that our own page
// produced it (CSRF token), and only then whether the data is valid and the scopes are enough.
function authorizePost(request: FastifyRequest, deps: RouteDeps, kind: CreateKind): Session {
    const session = deps.requireSession(request)

    // The trusted origin is fixed by configuration. Trusting the Host header would let a request
    // name its own trusted origin. Browsers always send Origin on a cross-site POST, and a missing one is refused.
    const trustedOrigin = new URL(deps.config.redirectUri).origin

    if (request.headers.origin !== trustedOrigin) {
        throw new AppError(403, 'Request origin not allowed. Use the app from the address in REDIRECT_URI.')
    }

    // The forms post URL-encoded fields. Any other body type (JSON, text) is not something our pages send.
    if (!request.headers['content-type']?.startsWith(FORM_CONTENT_TYPE)) {
        throw new AppError(415, 'Submit the form from the Write back page.')
    }

    // The token is random per session, so a token from another session or an attacker's page does not match.
    const csrf = CsrfSchema.safeParse(request.body)

    if (!csrf.success || !isSameSecret(csrf.data.csrf, session.csrfToken)) {
        throw new AppError(403, 'Missing or invalid form token. Reload the form and try again.')
    }

    const missing = missingScopes(session.tokens.scope, requiredScopes(kind))

    if (missing.length > 0) {
        throw new AppError(403, `Missing scopes ${missing.join(' ')}. Add them to SCOPES and launch again.`)
    }

    return session
}

function parseForm<T>(schema: z.ZodType<T>, body: unknown): T {
    const result = schema.safeParse(body)

    if (!result.success) {
        throw new AppError(400, result.error.issues[0]?.message ?? 'The form could not be read.')
    }

    return result.data
}

// Reading back needs .r on top of .c: a write nobody can verify is not reported as a success.
function requiredScopes(kind: CreateKind): { resourceType: string; interaction: 'c' | 'r' }[] {
    return [
        { resourceType: kind, interaction: 'c' },
        { resourceType: kind, interaction: 'r' },
    ]
}

async function sendResult(
    reply: FastifyReply,
    config: Config,
    session: Session,
    created: { resourceType: string; id: string },
): Promise<FastifyReply> {
    const title = 'Saved to the EPJ'
    const identity = `${created.resourceType}/${created.id}`

    try {
        const readBack = await readBackCreated(config, session, created)

        return reply
            .code(200)
            .type('text/html')
            .send(appPage(title, savedContent(identity, readBack)))
    } catch (error) {
        // The resource exists, so say so and never suggest posting again.
        const reason = error instanceof AppError ? error.message : 'The response was not what was expected.'

        return reply
            .code(502)
            .type('text/html')
            .send(appPage(title, unverifiedContent(identity, reason)))
    }
}

// createResource has already checked status 201, the ID and the Location header. This is the second,
// independent check: fetch the resource with the user's token and compare it with the launch session.
async function readBackCreated(
    config: Config,
    session: Session,
    created: { resourceType: string; id: string },
): Promise<ReadBack> {
    const path = `${created.resourceType}/${created.id}`
    const { patient, encounter } = session.context

    if (created.resourceType === 'Observation') {
        const read = await fhir(config, session.tokens.access_token, path, ObservationReadBackSchema)

        assertReadBack(config, created.id, read.id, read.subject.reference, [read.encounter.reference], session)

        return {
            id: read.id,
            resourceType: read.resourceType,
            summary: `${read.valueQuantity.value} ${read.valueQuantity.unit} for Patient/${patient}, Encounter/${encounter}`,
        }
    }

    const read = await fhir(config, session.tokens.access_token, path, DocumentReadBackSchema)
    const encounterReferences = read.context.encounter.map((reference) => reference.reference)

    assertReadBack(config, created.id, read.id, read.subject.reference, encounterReferences, session)

    return {
        id: read.id,
        resourceType: read.resourceType,
        summary: `${read.description} (Patient/${patient}, Encounter/${encounter})`,
    }
}

function assertReadBack(
    config: Config,
    expectedId: string,
    readId: string,
    subject: string,
    encounters: string[],
    session: Session,
): void {
    const isSameResource = readId === expectedId
    const isForPatient = referenceId(config, subject, 'Patient') === session.context.patient
    const isForEncounter = encounters.some(
        (reference) => referenceId(config, reference, 'Encounter') === session.context.encounter,
    )

    if (!isSameResource || !isForPatient || !isForEncounter) {
        throw new AppError(502, 'The read-back does not match the created resource or the launched consultation.')
    }
}

function formsContent(session: Session): string {
    const token = escapeHtml(session.csrfToken)

    const temperatureForm = formOrHint(
        session,
        'Observation',
        `
            <h2>Record a temperature</h2>
            <form method="post" action="/write/temperature">
                <input type="hidden" name="csrf" value="${token}">
                <label>Temperature in degrees Celsius
                    <input type="text" name="celsius" inputmode="decimal" maxlength="5" required>
                </label>
                <button type="submit">Record temperature</button>
            </form>
        `,
    )

    const noteForm = formOrHint(
        session,
        'DocumentReference',
        `
            <h2>Write a journal note</h2>
            <form method="post" action="/write/note">
                <input type="hidden" name="csrf" value="${token}">
                <label>Note
                    <textarea name="note" rows="4" cols="60" maxlength="${MAX_NOTE_LENGTH}" required></textarea>
                </label>
                <button type="submit">Save note</button>
            </form>
        `,
    )

    return `
        <p>Both forms write to the patient and encounter of this launch.</p>
        ${temperatureForm}
        ${noteForm}
    `
}

function formOrHint(session: Session, kind: CreateKind, form: string): string {
    const missing = missingScopes(session.tokens.scope, requiredScopes(kind))

    return missing.length > 0 ? scopeHint(missing) : form
}

function savedContent(identity: string, readBack: ReadBack): string {
    return `
        <p>Created <code>${escapeHtml(identity)}</code> (HTTP 201, Location matches).</p>
        <h2>Read back from the FHIR server</h2>
        <p>${escapeHtml(readBack.resourceType)}/${escapeHtml(readBack.id)}: ${escapeHtml(readBack.summary)}</p>
    `
}

function unverifiedContent(identity: string, reason: string): string {
    return `
        <p>Created <code>${escapeHtml(identity)}</code>, but the read-back failed: ${escapeHtml(reason)}</p>
        <p>Check the EPJ before submitting again, the resource may already exist.</p>
    `
}
