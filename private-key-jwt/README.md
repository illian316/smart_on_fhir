# SMART on FHIR EHR launch with a private key

A finished SMART on FHIR app for nav-epj. The app authenticates to the token endpoint with `private_key_jwt`: it signs a short-lived client assertion with your private key, which never leaves your machine. After launch it shows the patient's name and the logged-in clinician.

## Quickstart

```sh
npm ci
cp .env.example .env
npm run generate-key
npm start
```

Node 22 (`.nvmrc`). Then log in at https://epj.ekstern.dev.nav.no, open a patient marked "Pågår nå" and pick your app.

`npm run generate-key` writes the private key to `keys/private.jwk.json` (ignored by Git) and prints the public JWK Set. Give that to the host. It refuses to overwrite an existing key.

## Configure

Edit `.env`. [src/config.ts](./src/config.ts) validates it at startup and prints what is missing.

| Variable | Value |
|---|---|
| `PORT` | `3100` |
| `FHIR_BASE_URL` | `https://epj.ekstern.dev.nav.no/fhir` |
| `AUTH_ISSUER` | `https://epj.ekstern.dev.nav.no/oidc` |
| `CLIENT_ID` | Your own client ID, e.g. `yourname-key` |
| `REDIRECT_URI` | `http://localhost:3100/callback` |
| `SCOPES` | `openid fhirUser launch patient/Patient.r patient/Encounter.s` |
| `PRIVATE_JWK_PATH` | `keys/private.jwk.json` |

## Register

The host registers the app in nav-epj by hand. Send your `CLIENT_ID` and the public JWK Set, and wait for the go-ahead before launching. Changing scopes, port or redirect URI means registering again.

| Field | Value |
|---|---|
| Token endpoint auth | `private_key_jwt` |
| Launch URL | `http://localhost:3100/launch` |
| Redirect URL | `http://localhost:3100/callback` |
| Scopes | same as `SCOPES` |

## Where to add your app

- [src/smart.ts](./src/smart.ts): launch, PKCE and state, signed client assertion (`clientAssertion`), code exchange, ID token verification. Reuse as is.
- [src/app.ts](./src/app.ts): the `/` route fetches the launched patient and renders the name. Replace it with your own page.
- [src/fhir.ts](./src/fhir.ts): `fhirGet` sends the access token to the configured FHIR server. Add schemas and calls here.
- [src/generate-key.ts](./src/generate-key.ts): creates the RS384 key pair with `jose`.

The session is held in server memory and lasts at most as long as the access token. There is no refresh: after expiry, launch again from the EPJ. Request more scopes in `SCOPES` and in the registration before reading more resources.

## Test

```sh
npm test
npm run typecheck
```

`test/smoke.test.ts` generates a throwaway key in a temp directory and runs launch, callback and the patient page against an in-process mock server, checking the signed assertion. It does not read `.env`.

[Troubleshooting](../TROUBLESHOOTING.md)
