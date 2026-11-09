# Ideas for your SMART app

Bronze, Silver and Gold ideas from the [published track](https://hl7norway.github.io/Norwegian-FHIR-Hackathon-2026/currentbuild/smart-track.html).
Worked solutions for all of them are in [SOLUTIONS.md](./SOLUTIONS.md).
Borrow helpers from [src/extensions.ts](./src/extensions.ts) or write your own FHIR calls.
Bronze and Silver build on this `public/` app. Gold ideas point at the finished templates in the other folders.

## Bronze: it launched

Show the patient's name, age and the ongoing consultation. Follow the ten steps in `src/steps.ts`:

1. Receive `iss` and `launch`, and check the trusted FHIR issuer.
2. Discover the authorization and token endpoints.
3. Generate the PKCE verifier and challenge.
4. Store state and the launch transaction on the server.
5. Redirect to authorization with your scopes.
6. Check state when the callback returns.
7. Exchange the code server-side with your registered client authentication.
8. Verify the ID token before reading its claims.
9. Read patient and encounter from the token response, and the clinician from the `fhirUser` claim.
10. Fetch the FHIR resources and render the page.

Then walk a teammate through the redirects in the browser's network tab. Keep tokens, secrets and keys on the server.

## Scopes

`r` reads by ID, `s` searches, `c` creates. Add scopes to `SCOPES`; `patient/` and `user/` scopes need no registration (see [README](./README.md#6-registration)).

| Feature | FHIR request | Extra scopes |
|---|---|---|
| Name, age, consultation | `GET Patient/{patient}`, `GET Encounter?patient={patient}` | none |
| Care team | `GET PractitionerRole?practitioner={id}` | `patient/PractitionerRole.s patient/Organization.r` |
| Diagnoses | `GET Condition?subject={patient}&encounter={encounter}` | `patient/Condition.s` |
| Measurements | `GET Observation?subject={patient}&code=http://loinc.org\|8310-5` | `patient/Observation.s` |
| Write a measurement | `POST Observation` | `patient/Observation.c` (add `.r` to read back) |
| Write a note | `POST DocumentReference` | `patient/DocumentReference.c` (add `.r` to read back) |

Select the encounter that matches the launch context. An empty Bundle means no data, a 403 means a missing scope.

## Silver: useful and honest

### Clinical mini-app

```http
GET Condition?subject={patient}&encounter={encounter}
GET Observation?subject={patient}&code=http://loinc.org|8310-5
```

```ts
const { conditions, measurements, trendReady } = await clinicalSummary(config, tokens, context)
```

Show a summary, trend or flag with the code system and unit next to each value. Draw a trend from three or more readings in one unit.

### Scope detective

```sh
SCOPES=openid fhirUser launch patient/Patient.r patient/Encounter.s
```

Launch with fewer scopes, compare them with `scope` in the token response, and show one allowed read and one refused read with its `OperationOutcome`.

### Confidential client

```http
POST <token endpoint>
Authorization: Basic base64(client_id:client_secret)
```

Compare your token request (TODO 7) with `exchange` in [../client-secret/src/smart.ts](../client-secret/src/smart.ts). Only the client authentication differs. A wrong secret returns `401 invalid_client`.

## Gold

### Write-back

```ts
const created = await createResource(config, tokens, temperature(context, 37.4))
const note = await createResource(config, tokens, journalNote(context, 'Patient reports improvement.'))
```

Call `createResource` from a POST handler triggered by a user action. Validate input, bind a CSRF token to the session, check the Origin header and take patient and encounter from the launch session. Expect `201` with an ID and `Location`, then read it back. Measurements appear in the Målinger tab and the note in the journal editor.

### Asymmetric authentication

```ts
const assertion = await clientAssertion(config, discovery.token_endpoint)
```

Read `clientAssertion` in [../private-key-jwt/src/smart.ts](../private-key-jwt/src/smart.ts) and compare it with the token request of `public/`. Run that template with your own key to see the signed assertion work.

### Backend Services

```http
GET /Patient?identifier=urn:oid:2.16.578.1.12.4.1.4.1|20856210112
Authorization: Bearer <system token>
```

Run the finished [../backend-services/](../backend-services/) template, which has its own registration with the host. The token has no patient and no refresh token.

### Break it

Provoke one rejection at a time and compare the status and error with what you expect.

| Rejecter | Provoke | Expect |
|---|---|---|
| Your app | Callback with wrong `state`, or a replayed callback | Refused before any token request |
| Your app | ID token whose audience is not your client ID | `verifyIdentity` throws |
| Authorization server | Send the same code to the token endpoint twice | `invalid_grant` |
| Authorization server | Wrong `code_verifier` | `invalid_grant` |
| Authorization server | Wrong, expired or replayed assertion (in `../private-key-jwt/`) | `401 invalid_client` |
| FHIR server | Resource outside your granted scopes | `403` with an `OperationOutcome` |
| FHIR server | Access token whose audience is not the FHIR base | Rejected |

Audiences differ per token: authorize `aud` is the FHIR base, the ID token `aud` is your client ID, the assertion `aud` is the token endpoint.

## Keep a working launch

Commit a working launch before trying a new idea. To see another client authentication method, compare with `src/smart.ts` in the finished `client-secret/` and `private-key-jwt/` templates.
