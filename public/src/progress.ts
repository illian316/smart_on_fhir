import { AppError, UnfinishedError } from './config.ts'
import { escapeHtml, randomToken } from './http.ts'

const SPEC_BASE = 'https://build.fhir.org/ig/HL7/smart-app-launch/en'
const SPEC = `${SPEC_BASE}/app-launch.html`
const SPEC_SCOPES = `${SPEC_BASE}/scopes-and-launch-context.html`
const REPO = 'https://github.com/navikt/smart-on-fhir-templates/blob'
const BREAK_IT = `${REPO}/main/public/EXERCISES.md#break-it`
const PROBLEM_CARDS = `${REPO}/main/public/EXERCISES.md#problem-cards`
const STUCK = `${REPO}/main/public/README.md#stuck`
const SOLVED_STEPS = `${REPO}/solutions/public/src/steps.ts`
const SOLUTIONS_GUIDE = `${REPO}/solutions/public/SOLUTIONS.md`

const MAX_ATTEMPTS = 500
const ATTEMPT_TTL_MS = 1_800_000
const MAX_SECRETS = 32
const MIN_SECRET_LENGTH = 8
const MAX_MESSAGE_LENGTH = 300
const REDACTED = '[redacted]'

export type StepState = 'passed' | 'failed' | 'pending'

export interface ChecklistItem {
    step: number
    state: StepState
    message?: string
}

export type Checklist = ChecklistItem[]

interface Phase {
    id: string
    title: string
}

interface StepDefinition {
    step: number
    name: string
    phase: string
    title: string
    hint: string
    why: string
    spec: string
    retry: 'reload' | 'relaunch'
    caveat?: string
}

const PHASES: Phase[] = [
    { id: 'step-1-register', title: 'Register App with EHR' },
    { id: 'step-2-launch-ehr', title: 'Launch App: EHR Launch' },
    { id: 'step-3-discovery', title: 'Retrieve .well-known/smart-configuration' },
    { id: 'step-4-authorization-code', title: 'Obtain authorization code' },
    { id: 'step-5-access-token', title: 'Obtain access token' },
    { id: 'step-6-fhir-api', title: 'Access FHIR API' },
]

const DEFINITIONS: StepDefinition[] = [
    {
        step: 1,
        name: 'readLaunch',
        phase: 'step-2-launch-ehr',
        title: 'Receive iss and launch',
        hint: 'Return { iss, launch } from the query. iss must equal FHIR_BASE_URL and launch must be the non-empty launch value from the URL.',
        why: 'iss names the FHIR server that started the launch and launch is the one-time ID for it. An app that accepts any iss can be sent to a server it was never meant to talk to, and would hand that server its launch ID.',
        spec: `${SPEC}#step-2-launch-ehr`,
        retry: 'reload',
    },
    {
        step: 2,
        name: 'discover',
        phase: 'step-3-discovery',
        title: 'Fetch the SMART configuration',
        hint: 'Fetch FHIR_BASE_URL/.well-known/smart-configuration and return it only if issuer equals AUTH_ISSUER, the authorization, token and JWKS endpoints use HTTPS on the issuer origin, and it advertises none, authorization_code and S256.',
        why: 'The configuration tells the app where to send the user, the code and later the tokens. If it accepts endpoints from any host, a wrong or tampered document sends authorization traffic somewhere else.',
        spec: `${SPEC}#step-3-discovery`,
        retry: 'reload',
    },
    {
        step: 3,
        name: 'pkce',
        phase: 'step-4-authorization-code',
        title: 'Generate the PKCE pair',
        hint: 'The verifier is 43 to 128 characters from A-Z, a-z, 0-9, hyphen, dot, underscore and tilde. The challenge is the base64url SHA-256 of the verifier, without padding.',
        why: 'The challenge goes in the browser redirect and the verifier stays on your server. Someone who intercepts the authorization code cannot exchange it without the verifier. A public client has no secret, so this is its proof.',
        spec: `${SPEC}#considerations-for-pkce-support`,
        retry: 'reload',
    },
    {
        step: 4,
        name: 'newTransaction',
        phase: 'step-4-authorization-code',
        title: 'Create state and a server-side transaction',
        hint: 'Return launch, discovery, verifier and challenge unchanged, plus a random state of at least 21 characters and createdAt set to Date.now().',
        why: 'state links a callback to the launch that started it. If it is guessable, or the launch is not stored on the server, an attacker can make your app accept a callback it never asked for (login CSRF). The verifier must stay server-side, never in the browser.',
        spec: `${SPEC}#step-4-authorization-code`,
        retry: 'reload',
        caveat: 'The check only looks at the length of state. It cannot tell whether state is random.',
    },
    {
        step: 5,
        name: 'authorizationUrl',
        phase: 'step-4-authorization-code',
        title: 'Build the authorization URL',
        hint: 'Start from authorization_endpoint and add response_type=code, client_id, redirect_uri, scope (the SCOPES set), aud (the iss), launch, state, code_challenge and code_challenge_method=S256, each exactly once. Never add code_verifier.',
        why: 'aud tells the authorization server which FHIR server the token is for, so it is not issued for a different one. The code_challenge commits to the verifier. code_verifier in this URL would give the secret to the browser and its history, which defeats PKCE.',
        spec: `${SPEC}#step-4-authorization-code`,
        retry: 'reload',
    },
    {
        step: 6,
        name: 'validateCallback',
        phase: 'step-4-authorization-code',
        title: 'Validate the callback',
        hint: 'Return the code from the callback query, but only after state matches the transaction, the transaction has not expired and no error was returned.',
        why: 'A callback with a missing or wrong state, an expired transaction or an error is not the answer to your request. Accepting it lets an attacker feed your app their own authorization code, or replay an old callback.',
        spec: `${SPEC}#step-4-authorization-code`,
        retry: 'relaunch',
        caveat: 'The check only sees the returned code. It cannot tell whether state is verified.',
    },
    {
        step: 7,
        name: 'exchange',
        phase: 'step-5-access-token',
        title: 'Exchange the code for tokens',
        hint: 'POST grant_type=authorization_code, code, code_verifier, redirect_uri and client_id to token_endpoint with no client secret. Return the token response (Bearer, positive expires_in, scope).',
        why: 'The code is short-lived and only useful together with the verifier. Exchanging it from your server keeps the tokens out of the browser, and sending the verifier proves you are the app that started the request.',
        spec: `${SPEC}#step-5-access-token`,
        retry: 'relaunch',
    },
    {
        step: 8,
        name: 'verifyIdentity',
        phase: 'step-5-access-token',
        title: 'Verify the ID token',
        hint: 'Verify signature, issuer, audience and expiry, then return the Practitioner ID from the fhirUser claim.',
        why: 'The ID token says who signed in. A token with an unchecked signature, issuer or audience can be forged or issued for another app, so your app could show the wrong clinician.',
        spec: `${SPEC_SCOPES}#steps-for-using-an-id-token`,
        retry: 'relaunch',
        caveat: 'The check only compares the returned ID with the claim. It cannot tell whether the signature is verified.',
    },
    {
        step: 9,
        name: 'launchContext',
        phase: 'step-5-access-token',
        title: 'Read the launch context',
        hint: 'Return patient and encounter from the token response, and the practitioner from the previous step.',
        why: 'The EPJ decides which patient and encounter the app was launched for and returns them with the access token. Taking them from the URL or a form lets anyone with the link point the app at another patient.',
        spec: `${SPEC_SCOPES}#launch-context-arrives-with-your-access_token`,
        retry: 'relaunch',
    },
    {
        step: 10,
        name: 'loadChart',
        phase: 'step-6-fhir-api',
        title: 'Load the chart',
        hint: 'Read the Patient and the Encounter that matches the launch context, which must be in-progress. Return patientName, age, encounter, status and started.',
        why: 'The chart must come from the launch context, and the encounter must be the in-progress one. Otherwise the clinician sees a different patient or a finished consultation while believing it is the current one.',
        spec: `${SPEC}#step-6-fhir-api`,
        retry: 'relaunch',
    },
]

const BEFORE_YOU_BUILD = [
    'Why does SMART exist, and what problem does it solve for a clinician?',
    'For each of iss, launch, state, code_verifier, aud and code: what does it protect against, and where in the network tab do you see it?',
    'Which endpoints in .well-known/smart-configuration matter, and why do you only trust them on the issuer origin?',
    'Compare the scopes you requested with scope in the token response. What was granted, and what would be refused?',
    'Why do access tokens stay on the server and not in the browser?',
    'Which three client authentication types does SMART define, and which one fits a Norwegian EPJ vendor today?',
    'How does HelseID relate to, and differ from, the authorization server of the EPJ?',
]

const STEP_COUNT = DEFINITIONS.length

export class CheckError extends AppError {
    constructor(message: string) {
        super(502, message)
    }
}

export class StepError extends Error {
    override name = 'StepError'

    constructor(
        public readonly step: number,
        public readonly status: number,
        message: string,
        public readonly checklist: Checklist,
    ) {
        super(message)
    }
}

export class Attempt {
    readonly id = randomToken()
    readonly createdAt = Date.now()
    private readonly secrets = new Set<string>()
    private readonly records = new Map<number, ChecklistItem>()

    remember(...values: unknown[]): void {
        for (const value of values) {
            const isSecret = typeof value === 'string' && value.length >= MIN_SECRET_LENGTH

            if (isSecret && this.secrets.size < MAX_SECRETS) {
                this.secrets.add(value)
            }
        }
    }

    async run<T>(step: number, task: () => T | Promise<T>, check: (value: T) => void): Promise<T> {
        try {
            const value = await task()

            this.remember(...secretsFrom(step, value))
            check(value)
            this.records.set(step, { step, state: 'passed' })

            return value
        } catch (error) {
            throw this.fail(step, error)
        }
    }

    checklist(): Checklist {
        return DEFINITIONS.map(({ step }) => ({ ...(this.records.get(step) ?? { step, state: 'pending' }) }))
    }

    private fail(step: number, error: unknown): StepError {
        const unfinished = error instanceof UnfinishedError
        const message = unfinished ? '' : this.describe(error)

        for (const recorded of this.records.keys()) {
            if (recorded >= step) {
                this.records.delete(recorded)
            }
        }

        this.records.set(step, { step, state: 'failed', message })

        return new StepError(step, unfinished ? 501 : 502, message, this.checklist())
    }

    private describe(error: unknown): string {
        let text = 'The step threw a value that is not an Error.'

        if (error instanceof AppError) {
            text = String(error.message)
        } else if (error instanceof Error) {
            text = `${String(error.name)}: ${String(error.message)}`
        }

        const redacted = this.redact(text)

        return redacted.length > MAX_MESSAGE_LENGTH ? `${redacted.slice(0, MAX_MESSAGE_LENGTH)}...` : redacted
    }

    private redact(text: string): string {
        let result = text

        for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
            for (const form of new Set([secret, encodeURIComponent(secret)])) {
                result = result.split(form).join(REDACTED)
            }
        }

        return result
    }
}

export class Attempts {
    private readonly attempts = new Map<string, Attempt>()

    create(): Attempt {
        this.prune()

        if (this.attempts.size >= MAX_ATTEMPTS) {
            const oldest = this.attempts.keys().next()

            if (!oldest.done) {
                this.attempts.delete(oldest.value)
            }
        }

        const attempt = new Attempt()
        this.attempts.set(attempt.id, attempt)

        return attempt
    }

    get(id: string | undefined): Attempt | undefined {
        const attempt = id ? this.attempts.get(id) : undefined

        return attempt && Date.now() - attempt.createdAt <= ATTEMPT_TTL_MS ? attempt : undefined
    }

    prune(): void {
        const now = Date.now()

        for (const [id, attempt] of this.attempts) {
            if (now - attempt.createdAt > ATTEMPT_TTL_MS) {
                this.attempts.delete(id)
            }
        }
    }
}

function secretsFrom(step: number, value: unknown): unknown[] {
    if (typeof value === 'string') {
        return step === 6 ? [value] : []
    }

    if (typeof value !== 'object' || value === null) {
        return []
    }

    const fields = value as Record<string, unknown>
    const idToken = typeof fields.id_token === 'string' ? fields.id_token.split('.') : []

    return [fields.verifier, fields.state, fields.access_token, fields.id_token, fields.refresh_token, ...idToken]
}

function nextAction(definition: StepDefinition): string {
    if (definition.retry === 'reload') {
        return 'Fix src/steps.ts and save, then refresh this tab. The launch ID works for 5 minutes after you clicked Hackathon starter. After that, click Hackathon starter in the app picker again. You can keep the consultation open.'
    }

    return 'Fix src/steps.ts and save, then click Hackathon starter in the app picker again. You can keep the consultation open.'
}

function renderWhy(definition: StepDefinition): string {
    return `${escapeHtml(definition.why)} <a href="${definition.spec}">SMART spec</a>`
}

function renderRescue(): string {
    return `<p>Rescue: read and compare this step in the <a href="${SOLVED_STEPS}">solved steps.ts</a>. More options in <a href="${STUCK}">Stuck?</a></p>`
}

function renderItem(item: ChecklistItem, definition: StepDefinition): string {
    const label = `TODO ${definition.step} ${escapeHtml(definition.name)}: ${escapeHtml(definition.title)}`
    const caveat = definition.caveat ? `<p><small>${escapeHtml(definition.caveat)}</small></p>` : ''

    if (item.state === 'passed') {
        return `<li>✅ ${label}
        <details><summary>Why this step</summary><p>${renderWhy(definition)}</p></details>${caveat}</li>`
    }

    if (item.state === 'pending') {
        return `<li>⬜ ${label}</li>`
    }

    const problem = item.message
        ? `Check failed: ${escapeHtml(item.message)}`
        : 'Not implemented yet. Replace unfinished() in src/steps.ts.'

    return `<li>❌ <strong>${label}</strong>
        <p>${problem}</p>
        <p>Hint: ${escapeHtml(definition.hint)}</p>
        <p>Why: ${renderWhy(definition)}</p>
        <p>Next: ${escapeHtml(nextAction(definition))}</p>
        ${renderRescue()}
        ${caveat}</li>`
}

function renderBeforeYouBuild(): string {
    const prompts = BEFORE_YOU_BUILD.map((prompt) => `<li>${escapeHtml(prompt)}</li>`).join('')

    return `
        <h2>Before you build</h2>
        <p>Talk these through as a team, out loud. Open your browser's network tab, start a new launch from the EPJ and narrate each redirect to each other. Skipped Bronze? The <a href="${SOLUTIONS_GUIDE}">solutions guide</a> walks through the same steps.</p>
        <ol>${prompts}</ol>
        <p>The prompts help you explain the flow. They do not make your app certified or secure.</p>
        <p>When you can answer them, pick a <a href="${PROBLEM_CARDS}">problem card</a> or bring your own idea.</p>
    `
}

export function renderChecklist(checklist: Checklist): string {
    const items = new Map(checklist.map((item) => [item.step, item]))

    const phases = PHASES.map((phase) => {
        const rows =
            phase.id === 'step-1-register'
                ? '<li>✅ Configured: CLIENT_ID in .env. The hackathon pre-registers hackathon-public. This app does not verify the registration with the server.</li>'
                : DEFINITIONS.filter((definition) => definition.phase === phase.id)
                      .map((definition) =>
                          renderItem(
                              items.get(definition.step) ?? { step: definition.step, state: 'pending' },
                              definition,
                          ),
                      )
                      .join('')

        return `<h3><a href="${SPEC}#${phase.id}">${escapeHtml(phase.title)}</a></h3><ul>${rows}</ul>`
    }).join('')

    const passed = checklist.filter((item) => item.state === 'passed').length

    return `
        <h2>Progress: ${passed} of ${STEP_COUNT} steps OK</h2>
        <p>✅ means the returned value has the right shape. It is not a security certification. See <a href="${BREAK_IT}">Break it</a> for checks that provoke real rejections.</p>
        <p>Saving a file restarts the app and clears this progress and all sessions.</p>
        ${phases}
        ${passed === STEP_COUNT ? renderBeforeYouBuild() : ''}
    `
}
