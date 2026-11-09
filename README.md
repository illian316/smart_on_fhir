# SMART on FHIR templates for nav-epj

Small TypeScript examples of SMART on FHIR apps that launch in nav-epj. Three are finished and minimal, one is the hackathon exercise. Each folder is a standalone npm project: copy it out and make it your own.

| Folder | Flow | Client authentication | Use it to |
|---|---|---|---|
| [public/](./public/) | EHR launch | `none` (PKCE only) | Do the hackathon: implement the auth steps yourself, then follow the [exercises](./public/EXERCISES.md) |
| [client-secret/](./client-secret/) | EHR launch | `client_secret_basic` | Start an app that holds a secret on its server |
| [private-key-jwt/](./private-key-jwt/) | EHR launch | `private_key_jwt` | Start an app that signs its token request with a key pair |
| [backend-services/](./backend-services/) | `client_credentials` | `private_key_jwt` | Start a system-to-system app without a clinician or patient |

## Get started

1. Click **Use this template** > **Create a new repository**, then clone it.
2. Pick a folder and follow its README:

   ```sh
   cd client-secret
   npm ci
   cp .env.example .env
   npm start
   ```

   In `public/`, run `npm run start:reference` first to see a working launch.

3. Get your own test clinician login from the host. The host registers each app in nav-epj by hand, except the shared hackathon client in `public/`. The folder README lists what to send.

`.env` and `keys/` are in `.gitignore`, so secrets stay out of your repo.

## How the folders compare

`client-secret/` and `private-key-jwt/` share one structure: `src/smart.ts` holds launch, PKCE, state, token exchange and ID token verification, `src/app.ts` the routes, `src/fhir.ts` the FHIR calls. They differ only in how the token request authenticates (`exchange` and `clientAssertion` in `src/smart.ts`) and in config. `backend-services/` has no launch: `src/smart.ts` requests and caches a system token. `public/` implements the same launch flow as ten TODOs in `src/steps.ts`, with the answers in `src/reference.ts`.

## More

- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md): errors and test patients
- [Published track](https://hl7norway.github.io/Norwegian-FHIR-Hackathon-2026/currentbuild/smart-track.html)
