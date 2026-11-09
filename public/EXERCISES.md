# Ideas for your SMART app

Bronze, Silver and Gold ideas from the [published track](https://hl7norway.github.io/Norwegian-FHIR-Hackathon-2026/currentbuild/smart-track.html).
Borrow helpers from [src/extensions.ts](./src/extensions.ts) or write your own FHIR calls.
Pick a [problem card](#problem-cards) or bring your own idea.
Bronze and Silver build on this `public/` app. Gold ideas point at the finished templates in the other folders.

## Bronze: it launched

Show the patient's name, age and the ongoing consultation. The ten steps in `src/steps.ts` follow the [SMART App Launch](https://build.fhir.org/ig/HL7/smart-app-launch/en/app-launch.html) phases:

[Step 2: launch from the EHR](https://build.fhir.org/ig/HL7/smart-app-launch/en/app-launch.html#step-2-launch-ehr)

1. Receive `iss` and `launch`, and check the trusted FHIR issuer.

[Step 3: discovery](https://build.fhir.org/ig/HL7/smart-app-launch/en/app-launch.html#step-3-discovery)

2. Discover the authorization and token endpoints.

[Step 4: authorization code](https://build.fhir.org/ig/HL7/smart-app-launch/en/app-launch.html#step-4-authorization-code)

3. Generate the PKCE verifier and challenge.
4. Store state and the launch transaction on the server.
5. Redirect to authorization with your scopes.
6. Check state when the callback returns.

[Step 5: access token](https://build.fhir.org/ig/HL7/smart-app-launch/en/app-launch.html#step-5-access-token)

7. Exchange the code server-side with your registered client authentication.
8. Verify the ID token before reading its claims.
9. Read patient and encounter from the token response, and the clinician from the `fhirUser` claim.

[Step 6: FHIR API](https://build.fhir.org/ig/HL7/smart-app-launch/en/app-launch.html#step-6-fhir-api)

10. Fetch the FHIR resources and render the page.

The page checks the shape of each step's output, not its security. Use [Break it](#break-it) to test the rest.

When all ten steps pass, the checklist shows the [Before you build](./README.md#before-you-build) questions. Open the browser's network tab and follow each redirect while you answer them. Keep tokens, secrets and keys on the server.

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

Call `createResource` from a POST handler triggered by a user action. Validate input, bind a CSRF token to the session, check the Origin header and take patient and encounter from the launch session. Expect `201` with an ID and `Location`, then read it back. Measurements appear in the Målinger tab and the note in the journal editor. [Write-back shapes](#write-back-shapes) lists what the EPJ accepts.

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

## Write-back shapes

The EPJ accepts two write shapes and rejects anything else with `400` and an `OperationOutcome` that names the field. Both need the encounter from your launch, so only an app launched from a consultation can write. `createResource` and the builders in [src/extensions.ts](./src/extensions.ts) send the temperature and note shapes below.

**Observation** (scope `patient/Observation.c`), one measurement per resource:

```json
{
  "resourceType": "Observation",
  "status": "final",
  "code": { "coding": [{ "system": "http://loinc.org", "code": "29463-7", "display": "Body weight" }] },
  "subject": { "reference": "Patient/<launch patient>" },
  "encounter": { "reference": "Encounter/<launch encounter>" },
  "effectiveDateTime": "2026-03-01T09:30:00Z",
  "valueQuantity": { "value": 81.5, "unit": "kg", "system": "http://unitsofmeasure.org", "code": "kg" }
}
```

- Exactly one LOINC coding. `effectiveDateTime` needs a time and a `Z` offset. The value has at most 8 integer digits, 4 decimals and no comparator.
- Send systolic and diastolic blood pressure as two Observations. `component`, `note`, `interpretation`, `referenceRange`, `category`, `identifier` and extensions are rejected. `performer` is optional, at most one `Practitioner/<id>`.

**DocumentReference** (scope `patient/DocumentReference.c`), a journal note:

```json
{
  "resourceType": "DocumentReference",
  "status": "current",
  "type": { "coding": [{ "system": "urn:oid:2.16.578.1.12.4.1.1.9602", "code": "J01-2" }] },
  "subject": { "reference": "Patient/<launch patient>" },
  "context": { "encounter": [{ "reference": "Encounter/<launch encounter>" }] },
  "description": "Plain text for the journal.",
  "content": [{ "attachment": { "contentType": "application/pdf" } }]
}
```

- `description` becomes the note text. It is narrative, not a structured assessment, and nothing computes from it.
- `content` is exactly one attachment with only `contentType`. `data`, `url`, `title` and other attachment fields are rejected, as are `author`, `date` and `category`.

What to expect back:

| Case | Response |
|---|---|
| Success | `201` with a `Location` header |
| Invalid shape | `400` with an `OperationOutcome` naming the field |
| Unknown encounter, or one that belongs to another patient or organisation | `400` |
| Missing scope | `403` with `WWW-Authenticate` |
| Patient that does not match your patient-bound scope | `404` |

The server assigns the ID, so posting twice stores two records. Disable the button while a request is in flight and show the `Location` result.

## Problem cards

Each card is a starting hypothesis about a clinical need, not a requirement or a clinical recommendation. Check the idea with the other team members before you build it. The data is synthetic.

Every patient below belongs to one card only. Before you build, ask the host to reserve one patient from your card for your team. Several teams can pick the same card, and each gets a different patient. Not every card has a patient at every organisation, so choose the reserved patient's organisation when you log in. Everyone on the team logs in as their own test clinician, and several of you can have a consultation open with the same patient at once.

The reservation keeps teams out of each other's way, but the EPJ does not enforce it: everyone at an organisation can see and change the records of all its patients. If every patient on a card is taken, pick another card or bring your own idea.

Request `patient/Observation.s` to read measurements, plus `patient/Observation.c` or `patient/DocumentReference.c` for the writes in [Write-back shapes](#write-back-shapes). Patients not marked as ongoing need a consultation started in the EPJ before you can launch, and the app only gets context from that launch. The listed codes each have at least three readings per patient. Write an Observation with the same code and UCUM unit as the seeded readings, and compare values in a trend only when the units match. Use only the codes listed here: do not invent codes for risk, scores or conclusions.

### Kidney function trend

A GP wants to see whether kidney function is falling before renewing a prescription. Open question: what change over what time span is worth a warning, and who decides that?

| Organisation | Patient | Personident | LOINC codes (UCUM unit) |
|---|---|---|---|
| Skogtun | Sigrun Moen | 09894810030 | 62238-1 eGFR (`mL/min/{1.73_m2}`), 14682-9 creatinine (`umol/L`) |
| Havnegata | Per Tveit | 12924510194 | 62238-1 (`mL/min/{1.73_m2}`), 14682-9 (`umol/L`) |
| Bjerkely | Gunnar Foss | 23895710156 | 62238-1 (`mL/min/{1.73_m2}`) |

Write: a journal note that cites the values you read, or a new eGFR or creatinine Observation.

### Mental health score follow-up

A clinician follows PHQ-9 or GAD-7 scores between visits. Open question: which change between two scores should prompt a conversation, and how does the app avoid sounding like a diagnosis?

| Organisation | Patient | Personident | LOINC codes (UCUM unit) |
|---|---|---|---|
| Skogtun | Olav Haug | 70837710381 | 69737-5 GAD-7 (`{score}`) |
| Havnegata | Hilde Nes | 65866910027 | 44261-6 PHQ-9 (`{score}`) |
| Bjerkely | Linn Holm | 66820350082 | 44261-6 (`{score}`) |

Write: a journal note, or a new score as an Observation with the seeded code.

### Consultation prep

Before a consultation the clinician wants a one-screen overview of recent measurements. Open question: which three or four values matter for this patient, and how old can a value be before the overview should hide it?

| Organisation | Patient | Personident | LOINC codes (UCUM unit) |
|---|---|---|---|
| Skogtun | Bjarne Berge (ongoing) | 20856210112 | 8480-6 and 8462-4 blood pressure (`mm[Hg]`), 29463-7 weight (`kg`) |
| Havnegata | Else Strand (ongoing) | 04845310039 | 4548-4 HbA1c (`%`), 62238-1 eGFR (`mL/min/{1.73_m2}`) |
| Solbakken | Helge Bratt (ongoing) | 16834910156 | 8480-6, 8462-4 (`mm[Hg]`) |

Write: a journal note that summarises what you showed.

## Keep a working launch

Commit a working launch before trying a new idea. To see another client authentication method, compare with `src/smart.ts` in the finished `client-secret/` and `private-key-jwt/` templates.
