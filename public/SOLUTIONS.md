# Solutions

This branch has working Bronze, Silver and Gold solutions on top of the `public/` starter. The code carries comments that explain why each check is there. Run it with `npm start` (no `--reference`).

Everything in this file marked **automated** runs in `npm test` against the in-process fixture in [test/fixture.ts](./test/fixture.ts), not against the real host. Anything marked **manual** needs the EPJ and has not been run here.

## Run

```sh
npm ci
cp .env.example .env   # set CLIENT_ID as in the README
npm start
```

Launch from the EPJ as described in the [README](./README.md#4-launch). Open the app at the host in `REDIRECT_URI` (`http://localhost:3100`). The write forms check the `Origin` header against that address, so `127.0.0.1` or another port is refused.

## Scopes per feature

All of these are `patient/` scopes, so you can request them without asking the host. Change `SCOPES` in `.env`, restart and launch again.

| Feature | Route | `SCOPES` |
|---|---|---|
| Bronze | `/app` | `openid fhirUser launch patient/Patient.r patient/Encounter.s` (the default) |
| Silver clinical app | `/clinical` | default plus `patient/Condition.s patient/Observation.s` |
| Silver scope detective | `/scopes` | default only, see below |
| Gold write-back | `/write` | default plus `patient/Observation.cr patient/DocumentReference.cr` |

To try everything at once:

```sh
SCOPES=openid fhirUser launch patient/Patient.r patient/Encounter.s patient/Condition.s patient/Observation.crs patient/DocumentReference.cr
```

A page that needs a scope you did not request explains which one is missing and makes no upstream call.

## Bronze

[src/steps.ts](./src/steps.ts) implements the ten steps. The ones that are easy to get wrong:

- PKCE: a random verifier and its base64url SHA-256 challenge. The verifier never leaves the server until the token request.
- State: random per launch and compared with a constant-time check. The launch transaction is kept on the server and the cookie only holds an ID.
- Issuer pinning: `iss` must equal `FHIR_BASE_URL`, and the discovery document is checked against `AUTH_ISSUER`, so a forged `iss` cannot point the app at another server.
- ID token: signature, issuer and audience are verified before any claim is read.
- Encounter binding: the encounter from the token response must belong to the launched patient and be in progress.

**Automated:** [test/steps.test.ts](./test/steps.test.ts) drives `buildApp(config)` with the default steps through launch, callback and the chart, and through each rejection above.

## Silver

### Clinical mini-app (`/clinical`)

Shows diagnoses with their code and system, and body temperatures with the LOINC code, unit and date. A trend is drawn only from three or more readings that share one unit. Readings in different units are refused instead of converted or mixed.

**Automated:** [test/clinical-app.test.ts](./test/clinical-app.test.ts).

### Scope detective (`/scopes`)

Lists the requested scopes next to the scopes in the token response, then runs two reads:

- an allowed one: `Patient/{id}`
- a refused one: the first of `Condition` or `Observation` that the token cannot search

For a refused read the page shows the HTTP status and the `OperationOutcome` severity and code, and nothing else. The upstream body can contain details you should not print.

With the default scopes the first read is allowed and the second is refused. If you add `patient/Condition.s patient/Observation.s` nothing is refused, and the page says so instead of inventing a failure. To get a refusal again, relaunch with:

```sh
SCOPES=openid fhirUser launch patient/Patient.r patient/Encounter.s
```

**Automated:** [test/scope-detective.test.ts](./test/scope-detective.test.ts). **Manual:** a real 403 from the EPJ, which has not been run here.

### Confidential client comparison

`public/` sends no secret: PKCE is the proof. A confidential client adds one header to the same token request, `Authorization: Basic ...`. Compare `exchange` in [../client-secret/src/smart.ts](../client-secret/src/smart.ts) with `tokenRequest` in [src/reference.ts](./src/reference.ts).

The credentials are form-URL-encoded first, then joined and base64-encoded:

```text
id = form-urlencode(client_id)
secret = form-urlencode(client_secret)
Authorization: Basic base64(id + ":" + secret)
```

With the secret `p&ss w/+rd=é` the header carries `base64("<client_id>:p%26ss+w%2F%2Brd%3D%C3%A9")`. Plain base64 of the raw secret works for simple secrets and breaks on characters like `&`, `+` and spaces. A wrong secret gives `401 invalid_client`.

**Automated:** `Confidential client comparison` in [test/auth-errors.test.ts](./test/auth-errors.test.ts) builds that header from the real token request, checks the encoding and checks that a wrong secret gets 401.

```sh
node --import tsx --test --test-name-pattern="Confidential client comparison" test/auth-errors.test.ts
```

## Gold

### Write-back (`/write`)

[src/write-back.ts](./src/write-back.ts) adds two HTML forms: a temperature (`POST /write/temperature`) and a journal note (`POST /write/note`). `GET /write` only shows the forms. Nothing is written until the user submits one.

Checks on every POST, in this order:

1. A launch session exists (401 otherwise).
2. `Origin` equals the origin of `REDIRECT_URI` (403 otherwise). A missing or `null` Origin is refused, and the `Host` header is never trusted.
3. The hidden `csrf` field matches the random token of this session, compared in constant time (403 otherwise).
4. The fields validate: a temperature between 25 and 45 °C with at most two decimals, a note of 1 to 2000 characters, no repeated or unknown fields (400 otherwise). A `patient` or `encounter` field is rejected, so context only comes from the session.
5. The token has the create and read scopes for the resource (403 otherwise).

Then `createResource` requires `201`, a server ID and a matching `Location`. The app reads the resource back with the user's token and checks the type, the ID, the patient and the encounter against the launch session. Only then does it show the ID and the read-back. If the read-back fails after a successful create, the page says the resource exists and tells the user not to submit again. If the create itself ends in an unknown outcome (disconnect, timeout, 5xx, an empty or unreadable 201), the page says the resource may already have been saved and to check the EPJ before submitting again. A 4xx from the server is reported as a rejection. The app never retries a write.

Two caveats:

- The result is rendered by the POST response, so refreshing the page submits again.
- Scope checks understand SMART v2 letters (`cruds`) in `patient/` and `user/` scopes.

**Automated:** [test/write-forms.test.ts](./test/write-forms.test.ts) covers successful writes and read-back, a missing, wrong and cross-session CSRF token, a missing, wrong and `Host`-derived Origin, no session, invalid input, forged context, missing scopes, unexpected create responses and mismatching read-backs. Each rejection test asserts that nothing reached the fixture's create endpoints.

```sh
node --import tsx --test test/write-forms.test.ts
```

**Manual:** the real EPJ. Measurements should show in the Målinger tab and the note in the journal editor.

### Asymmetric authentication and Backend Services

These stay in the finished siblings. Do not copy them into `public/`.

- Compare `clientAssertion` in [../private-key-jwt/src/smart.ts](../private-key-jwt/src/smart.ts) with `tokenRequest` in `public/`. The assertion is signed with your private key, has `iss` and `sub` set to the client ID, `aud` set to the token endpoint, a short `exp` and a fresh `jti`.
- To run it against the host: `npm ci`, `cp .env.example .env`, `npm run generate-key`, send the printed public JWK Set to the host, wait for the go-ahead, then `npm start`. See [../private-key-jwt/README.md](../private-key-jwt/README.md).
- Backend Services is [../backend-services/](../backend-services/), registered separately and using `system/Patient.rs`. See its README. Its [smoke test](../backend-services/test/smoke.test.ts) runs the token request and a search against a mock server.

**Automated:** the `Asymmetric client authentication` test in `test/auth-errors.test.ts` shows that each token request carries a fresh signed assertion, and the sibling smoke tests run their own flows. **Manual:** a launch with your own registered key.

## Break it

One rejection per row of [EXERCISES.md](./EXERCISES.md#break-it). Run the automated ones with `npm test`. The manual ones need the EPJ, and their outcomes are what to expect from the code, not results recorded from the real host.

| Row | How | Where it is checked |
|---|---|---|
| Wrong or replayed state | Open `/callback?state=wrong&code=x`, or visit a valid callback URL twice. The app refuses before any token request. | Automated: `bad state, missing cookie and declined authorization never reach the token endpoint` in `test/steps.test.ts`. |
| ID token audience mismatch | The fixture issues an ID token for another client. No session is created. | Automated: `an ID token for another client creates no session` in `test/steps.test.ts`. |
| Duplicate code | Send the same code to the token endpoint twice. The second gives `400 invalid_grant`. | Automated against the mock token server: `reject code replay, wrong PKCE and a changed redirect URI` in `test/auth-errors.test.ts`. Manual against the real host. |
| Wrong verifier | Change the verifier before the exchange. | Same test as above. Manual against the real host. |
| Invalid, replayed or expired assertion | In `../private-key-jwt/src/smart.ts`, change `clientAssertion` one way at a time: a fixed `jti`, a past `exp`, the wrong `aud`, or a different key. | Manual only, against a registered sibling. Its smoke test checks the header, lifetime and `jti` of a valid assertion, not these failures. |
| Insufficient FHIR scope | Launch with the default scopes and open `/clinical`, or `/scopes` for the refused read. Expect 403 and `forbidden`. | Automated: `test/scope-detective.test.ts` and `test/clinical-app.test.ts`. Manual: a real 403 from the host. |
| Access token for the wrong audience | The app cannot choose the audience of the token it receives. | Not provokable from this app. The nearest automated check is `expired access tokens are not accepted` in `test/auth-errors.test.ts`, which gets a 401 from the fixture. |

Audiences differ per token: authorize `aud` is the FHIR base, the ID token `aud` is your client ID, the assertion `aud` is the token endpoint.
