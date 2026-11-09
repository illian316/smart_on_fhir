# SMART Backend Services

A finished system-to-system app for nav-epj. It authenticates with `client_credentials` and a signed `private_key_jwt` assertion, then searches Patient by identifier with a system-scoped token. There is no EHR launch, clinician or patient context.

## Quickstart

```sh
npm ci
cp .env.example .env
npm run generate-key
npm start
```

Node 22 (`.nvmrc`). Then open http://localhost:3100.

`npm run generate-key` writes the private key to `keys/private.jwk.json` (ignored by Git) and prints the public JWK Set. Give that to the host. It refuses to overwrite an existing key.

## Configure

Edit `.env`. [src/config.ts](./src/config.ts) validates it at startup and prints what is missing.

| Variable | Value |
|---|---|
| `PORT` | `3100` |
| `FHIR_BASE_URL` | `https://epj.ekstern.dev.nav.no/fhir` |
| `AUTH_ISSUER` | `https://epj.ekstern.dev.nav.no/oidc` |
| `CLIENT_ID` | Your own client ID, e.g. `yourname-backend` |
| `SCOPES` | `system/Patient.rs` (system scopes only) |
| `PRIVATE_JWK_PATH` | `keys/private.jwk.json` |
| `PATIENT_IDENTIFIER` | `urn:oid:2.16.578.1.12.4.1.4.1\|20856210112` |

## Register

The host registers the app in nav-epj by hand. Send your `CLIENT_ID` and the public JWK Set, and wait for the go-ahead before running. There is no launch or redirect URL. Changing scopes means registering again.

| Field | Value |
|---|---|
| Token endpoint auth | `private_key_jwt` with your public JWK |
| Grant type | `client_credentials` |
| Scopes | same as `SCOPES` |

## Where to add your app

- [src/smart.ts](./src/smart.ts): discovery, signed client assertion and the token request. `tokenProvider` caches the token until 30 seconds before it expires. Reuse as is.
- [src/fhir.ts](./src/fhir.ts): `searchPatients` does the one `Patient?identifier=` search. Add searches and schemas here, and the matching `system/` scopes.
- [src/app.ts](./src/app.ts): the `/` route renders the result. Replace it with your own routes.
- [src/generate-key.ts](./src/generate-key.ts): creates the RS384 key pair with `jose`.

## Test

```sh
npm test
npm run typecheck
```

`test/smoke.test.ts` generates a throwaway key in a temp directory and runs token request and search against an in-process mock server, checking the signed assertion and token reuse. It does not read `.env`.

[Troubleshooting](../TROUBLESHOOTING.md)
