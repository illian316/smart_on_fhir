# Public EHR-launch starter

Token endpoint authentication `none`: PKCE is the proof, no secret or key.

## 1. Install

```sh
npm ci
```

Node 22 (`.nvmrc`).

## 2. Configure

```sh
cp .env.example .env
```

Edit `.env` and set `CLIENT_ID` to the shared hackathon client ([.env.example](./.env.example)). After a configuration error, run `npm start` again.

```sh
PORT=3100
FHIR_BASE_URL=https://epj.ekstern.dev.nav.no/fhir
AUTH_ISSUER=https://epj.ekstern.dev.nav.no/oidc
CLIENT_ID=hackathon-public
REDIRECT_URI=http://localhost:3100/callback
SCOPES=openid fhirUser launch patient/Patient.r patient/Encounter.s
```

`hackathon-public` is already registered, so there is nothing to send the host.

## 3. Start

```sh
npm start
```

`npm start` reads the `.env` file from step 2, so create it first. It restarts the app when you save a file or `.env`. A restart clears in-memory sessions and progress.

## 4. Launch

Log in at https://epj.ekstern.dev.nav.no with your own test clinician, open a patient marked "Pågår nå" and pick **Hackathon starter** in the app picker.

The page lists ten steps grouped by the [SMART App Launch](https://build.fhir.org/ig/HL7/smart-app-launch/en/app-launch.html) phases. Each step shows ✅, ❌ or ⬜ with a hint and the next action. The first launch fails at TODO 1.

## 5. Build your own

Implement the next TODO in [src/steps.ts](./src/steps.ts), then retry:

- TODO 1 to 5 failed: refresh the tab within 5 minutes of the launch.
- Later, or TODO 6 to 10: pick **Hackathon starter** in the app picker again. You do not need to close the consultation.

```ts
pkce() {
    return unfinished(3, 'Generate a random PKCE verifier and its base64url SHA-256 challenge')
},
```

Notes:

- ✅ means the output has the right shape. It is not a security certification: the checks do not prove randomness, state handling or ID token signature verification. See [Break it](./EXERCISES.md#break-it).
- Errors you throw are shown on the page. Known secret values of 8 or more characters (codes, verifiers, state, tokens) are redacted. Other text in an error is not guaranteed to be, so keep secrets out of error messages.
- Progress belongs to the browser that started the launch.
- Worked answers are on the `solutions` branch of the upstream repo. [Stuck?](#stuck) shows how to use them.

## Stuck?

Each ❌ step on the checklist has a hint, a short explanation of why the step exists and a link to the SMART spec.

To see a working answer, open [`steps.ts` on the `solutions` branch](https://github.com/navikt/smart-on-fhir-templates/blob/solutions/public/src/steps.ts) and find the function for your step, for example `pkce()`. It can call helpers that your `src/` does not have, so compare it with your code instead of pasting it in.

To run the finished app, clone the `solutions` branch into a folder next to your repo. Your own code is not touched. Stop your own app first, since both use port 3100, then run this in `public/`:

```sh
git clone --branch solutions https://github.com/navikt/smart-on-fhir-templates ../../smart-solved
cp .env ../../smart-solved/public/.env
cd ../../smart-solved/public
npm ci
npm start
```

If the finished app shows no checklist, the discussion questions are under [Before you build](#before-you-build).

## Skip Bronze and pacing

You can switch to the finished app at any point and build your own idea on top of it. Set it up as in [Stuck?](#stuck) and go through [Before you build](#before-you-build). The [solutions guide](https://github.com/navikt/smart-on-fhir-templates/blob/solutions/public/SOLUTIONS.md) explains each step.

## Before you build

Use these questions to check that the team understands the launch. Open the browser's network tab, start a new launch from the EPJ and follow each redirect. The checklist shows the same questions once all ten steps pass.

1. Why does SMART exist, and what problem does it solve for a clinician?
2. For each of iss, launch, state, code_verifier, aud and code: what does it protect against, and where in the network tab do you see it?
3. Which endpoints in .well-known/smart-configuration matter, and why do you only trust them on the issuer origin?
4. Compare the scopes you requested with scope in the token response. What was granted, and what would be refused?
5. Why do access tokens stay on the server and not in the browser?
6. Which three client authentication types does SMART define, and which one fits a Norwegian EPJ vendor today?
7. How does HelseID relate to, and differ from, the authorization server of the EPJ?

The questions help you explain the flow. They do not make your app certified or secure. When you can answer them, pick a [problem card](./EXERCISES.md#problem-cards) or bring your own idea.

## 6. Registration

`hackathon-public` is registered for everyone with these values.

| Field | Value |
|---|---|
| Token endpoint auth | `none` |
| Launch URL | `http://localhost:3100/launch` |
| Redirect URL | `http://localhost:3100/callback` |

You can request any scope in `SCOPES` without asking the host: `openid fhirUser launch`, plus `patient/*.cruds` and `user/*.cruds` (for example `patient/Condition.s`). System scopes are not available. The launch URL, redirect URL and port are fixed: a different port or URI needs the host to register it.

[Exercises](./EXERCISES.md) · [Troubleshooting](../TROUBLESHOOTING.md)
