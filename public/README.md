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

Edit `.env` and set `CLIENT_ID` to the shared hackathon client ([.env.example](./.env.example)).

```sh
PORT=3100
FHIR_BASE_URL=https://epj.ekstern.dev.nav.no/fhir
AUTH_ISSUER=https://epj.ekstern.dev.nav.no/oidc
CLIENT_ID=hackathon-public
REDIRECT_URI=http://localhost:3100/callback
SCOPES=openid fhirUser launch patient/Patient.r patient/Encounter.s
```

`hackathon-public` is already registered, so there is nothing to send the host.

## 3. Run the reference

```sh
npm run start:reference
```

## 4. Launch

Log in at https://epj.ekstern.dev.nav.no with your own test clinician, open a patient marked "Pågår nå" and pick **Hackathon starter** in the app picker.

## 5. Build your own

On `main`, implement the TODOs in [src/steps.ts](./src/steps.ts), then run `npm start`. This branch has them done: see [SOLUTIONS.md](./SOLUTIONS.md) for the walkthroughs, scopes per feature and break-it checks.

The reference implementation of each step is in [src/reference.ts](./src/reference.ts), and `npm run start:reference` runs it.

## 6. Registration

`hackathon-public` is registered for everyone with these values.

| Field | Value |
|---|---|
| Token endpoint auth | `none` |
| Launch URL | `http://localhost:3100/launch` |
| Redirect URL | `http://localhost:3100/callback` |

You can request any scope in `SCOPES` without asking the host: `openid fhirUser launch`, plus `patient/*.cruds` and `user/*.cruds` (for example `patient/Condition.s`). System scopes are not available. The launch URL, redirect URL and port are fixed: a different port or URI needs the host to register it.

[Exercises](./EXERCISES.md) · [Troubleshooting](../TROUBLESHOOTING.md)
