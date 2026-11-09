# SMART on FHIR EHR launch with a client secret

A finished SMART on FHIR app for nav-epj. The app authenticates to the token endpoint with `client_secret_basic`, and the secret stays on the Node server. After launch it shows the patient's name and the logged-in clinician.

## Quickstart

```sh
npm ci
cp .env.example .env
npm start
```

Node 22 (`.nvmrc`). Then log in at https://epj.ekstern.dev.nav.no, open a patient marked "Pågår nå" and pick your app.

## Configure

Edit `.env`. [src/config.ts](./src/config.ts) validates it at startup and prints what is missing.

| Variable | Value |
|---|---|
| `PORT` | `3100` |
| `FHIR_BASE_URL` | `https://epj.ekstern.dev.nav.no/fhir` |
| `AUTH_ISSUER` | `https://epj.ekstern.dev.nav.no/oidc` |
| `CLIENT_ID` | Your own client ID, e.g. `yourname-secret` |
| `REDIRECT_URI` | `http://localhost:3100/callback` |
| `SCOPES` | `openid fhirUser launch patient/Patient.r patient/Encounter.s` |
| `CLIENT_SECRET` | A secret you pick |

## Register

The host registers the app in nav-epj by hand. Send your `CLIENT_ID` and `CLIENT_SECRET`, and wait for the go-ahead before launching. Changing scopes, port or redirect URI means registering again.

| Field | Value |
|---|---|
| Token endpoint auth | `client_secret_basic` |
| Launch URL | `http://localhost:3100/launch` |
| Redirect URL | `http://localhost:3100/callback` |
| Scopes | same as `SCOPES` |

## Where to add your app

- [src/smart.ts](./src/smart.ts): launch, PKCE and state, code exchange with Basic credentials, ID token verification. Reuse as is.
- [src/app.ts](./src/app.ts): the `/` route fetches the launched patient and renders the name. Replace it with your own page.
- [src/fhir.ts](./src/fhir.ts): `fhirGet` sends the access token to the configured FHIR server. Add schemas and calls here.

The session is held in server memory and lasts at most as long as the access token. There is no refresh: after expiry, launch again from the EPJ. Request more scopes in `SCOPES` and in the registration before reading more resources.

## Test

```sh
npm test
npm run typecheck
```

`test/smoke.test.ts` runs launch, callback and the patient page against an in-process mock server. It does not read `.env`.

[Troubleshooting](../TROUBLESHOOTING.md)
