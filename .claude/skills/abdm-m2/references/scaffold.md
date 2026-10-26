# HIE-CM m2 build

Scaffolds an ABDM m2 integration one journey at a time. It covers care contexts, HIP initiated linking, discovery, and pushing encrypted records to a requester.

## How this skill runs

Every journey below is an OODA loop, not a recipe: observe the actual state (last response, last error), orient against the step matched below, decide the cheapest next action, act, and return to observe. A step is done only when its exit condition is observed against the sandbox, never because it "should have worked."

Loop limit: 8 passes per step. Hitting the limit is an escalation: state what was observed, what was tried, and which operation page to read, then ask one question.

Before building, read `references/test-matrix.md` in this skill. Its APIs are the ones the sheet lists for the group a case sits in, so a case may not call all of them. Build every journey that a case mandatory for your entity type needs, and build each mandatory case's Expected Result into the screen, not only its calls. The test run uses it to know what each case exercises.

## Before the first journey, when the codebase already exists

Skip this section only for a system that does not exist yet. Otherwise it runs first, and its exit condition is a written plan, not a call.

### In plain words

Most ABDM integrations are not new systems. They are a hospital management
system, a laboratory system or a clinic application that already has patients,
visits, records, a login, an HTTP client and a way of keeping secrets. Every
ABDM journey has to land somewhere inside that, and a journey built before the
codebase has been read lands in the wrong place: a second HTTP client beside the
first, an ABHA column on the wrong table, a callback route the reverse proxy
never forwards.

So the first loop is not a journey. It is a survey of the system as it is, and
its exit condition is a written plan that names, for every ABDM touchpoint, the
file it will live in. The journeys then build against that plan rather than
against the specification's idea of a fresh codebase.

### Before you start

- The repository, checked out, with permission to read all of it. A survey of
  half a codebase produces a plan for half a system.
- The answers to the deployment interview. The
  code says what the system is. Only the integrator can say what the
  deployment is, and the two together decide which journeys are built at all.
- The practices that hold across every call, which
  the plan has to leave room for.

### What happens

This is one loop with a limit of eight passes over the codebase. Each pass
reads live state only, which here means the files themselves, never a README's
description of them and never an assumption carried from a similar system.

**Observe.** Inventory the system from its manifests and its tree, not from its
documentation. Record file paths for each of these, or record that none exists:

| Find | Where it usually shows | Why ABDM needs it |
|---|---|---|
| Languages and runtime versions | package manifests, lock files, toolchain files | Every generated call has to be idiomatic here |
| Build, run and test commands | manifests, CI configuration, a Makefile | Each journey's exit condition becomes a test that runs the same way |
| The frontend and backend split, and how they talk | the top level tree, an API client in the frontend, route definitions in the backend | The counter screens go in the frontend; every ABDM call goes through the backend |
| The outbound HTTP client the backend already uses | the dependency list, a shared client module | ABDM calls reuse it, or a second one appears and the two drift |
| How secrets and configuration reach the process | environment loading, a vault client, a config file | The client id, the secret and the access token travel the same way |
| The patient model, and the identifier fields it already carries | the schema, the ORM models, the migrations | The ABHA number and address become columns beside the existing identifiers, not a new table |
| The visit, encounter or record model | the same places | A care context maps to one of these, and the plan has to say which |
| Where inbound HTTP is routed and authenticated, and whether the deployment has a public URL | the router, the middleware, the reverse proxy configuration, the deployment manifests | ABDM calls back, and a callback route that nothing forwards is silence nobody notices |
| Existing cryptography helpers | a security or crypto module, the dependency list | The RSA encryption of identifiers reuses them |
| Where errors are shown to a user, and where they are logged | the frontend's error surface, the logging setup | A refused call has to land on the screen the person is looking at, and never log a token |

**Orient.** Map each ABDM touchpoint onto that inventory. Where the map is
exact, write the file path. Where it is not, write two candidates and say what
would decide between them. The common ambiguities: two places that could hold
the patient identifier, an HTTP client in the frontend and none in the backend,
a monorepo with several services and no obvious owner for callbacks.

Then read the interview answers against the inventory. A government integrator
gets the demographic route; a facility with no public URL gets no callback
driven journey until it has one; a desk with a fingerprint reader gets the
biometric method. The route set is the intersection of what the deployment
allows and what the code can host.

**Decide.** Order the journeys. The token comes first because every other call
needs it: the gateway session token, or for M4 the bearer token the registry calls
carry. Then the journey whose exit condition can be observed with
the least new code, usually a profile read for a patient who already holds an
ABHA. Creation and linking come after, because each depends on state the earlier
ones produce. For each journey, name the files it will touch and the test that
proves its exit condition.

**Act.** Write the plan. It is a file in the repository, at the path the
integrator names or at the root as `abdm-integration-plan.md`, and it is the
only output of this loop. Then return to observe once, reading the plan against
the tree, to confirm every path in it exists or is marked as new.

If the limit is reached with questions still open, escalate: name what was
found, name the two candidates that could not be separated, point at this
atom, and ask one question.

### How you know it worked

The plan exists and answers every row of the inventory table with a file path,
or with the words none, add at, followed by a path. No row is blank and no row
says to be decided.

Every ABDM touchpoint in the plan names one file, or names two candidates and
the observation that would choose between them. Every journey in the plan names
the test that proves its exit condition and the command that runs it.

Open the plan beside the tree. Every path it names resolves, or is marked as
new. That is the observation that ends this loop, and the first journey does
not start until it has been made.

### When it goes wrong

- **The plan puts the HTTP client in the frontend.** The survey found the
  frontend's API client and stopped. Every ABDM call carries a secret, so it
  goes through the backend, and the plan has to say which backend module.
- **Two patient tables, and the plan picked one.** Orient produced one
  hypothesis where it needed two. Name both, and name the query that shows
  which one the visit model points at.
- **The plan has a callback route and the deployment has no public URL.** The
  inventory row on inbound routing was answered from the router rather than
  from the deployment. Mark every callback driven journey as blocked on a URL,
  and build the ones that are not.
- **The survey read the README and not the tree.** A README describes the
  system somebody meant to build. The plan is for the one that exists.
- **Eight passes and the plan is still incomplete.** Escalate with the rows
  that are answered, the rows that are not, this atom, and one question about
  the row that blocks the most journeys.

From `shared.concept.survey-an-existing-codebase`.

## Journeys

### Link token (`m2-abdm-link-token-hip`)

**Act: the calls in this journey, in order**

#### 1. Generate link token to link the health records (`m2_post_v3_token_generate_token`)

```bash
curl --request POST \
  --url https://dev.abdm.gov.in/api/hiecm/v3/token/generate-token \
  --header 'Authorization: Bearer <ACCESS_TOKEN_FROM_SESSIONS_CALL>' \
  --header 'REQUEST-ID: 18235d89-cb13-479d-ad71-7a57d5f669a8' \
  --header 'TIMESTAMP: 2022-10-06T15:10:00.587Z' \
  --header 'X-CM-ID: sbx' \
  --header 'X-HIP-ID: IN2810014366' \
  --header 'Content-Type: application/json' \
  --data '{
  "abhaNumber": 12345678901234,
  "abhaAddress": "<ABHA_ADDRESS>",
  "name": "first_name + middle_name + last_name",
  "gender": "M",
  "yearOfBirth": 9999
}'
```

**Exit condition (Observe until this is true)**

Each call you made in this journey answered by its callback, with `response.requestId` equal to the `REQUEST-ID` you sent on that call. The 202 on a call is receipt, not the outcome: the outcome is in the callback's body.

- `POST /api/hiecm/v3/token/generate-token` is answered by `POST /api/v3/hip/token/on-generate-token` on your bridge.

### HIP initiated linking (`m2-abdm-hip-initiated-linking-hip`)

**Act: the calls in this journey, in order**

#### 1. Perform HIP initiated linking (`m2_post_hip_v3_link_carecontext`)

```bash
curl --request POST \
  --url https://dev.abdm.gov.in/api/hiecm/hip/v3/link/carecontext \
  --header 'Authorization: Bearer <ACCESS_TOKEN_FROM_SESSIONS_CALL>' \
  --header 'REQUEST-ID: 18235d89-cb13-479d-ad71-7a57d5f669a8' \
  --header 'TIMESTAMP: 2022-10-06T15:10:00.587Z' \
  --header 'X-CM-ID: sbx' \
  --header 'X-HIP-ID: IN2810014366' \
  --header 'X-LINK-TOKEN: <TOKEN>' \
  --header 'Content-Type: application/json' \
  --data '{
  "abhaNumber": 12345678901234,
  "abhaAddress": "<ABHA_ADDRESS>",
  "patient": [
    {
      "referenceNumber": "TMH-PUID-001",
      "display": "String",
      "careContexts": [
        {
          "referenceNumber": "TMH-PUID-001",
          "display": "display 1"
        }
      ],
      "hiType": "DiagnosticReport",
      "count": 1
    }
  ]
}'
```

#### 2. Notify a change to a linked care context (`m2_post_hip_v3_link_context_notify`)

```bash
curl --request POST \
  --url https://dev.abdm.gov.in/api/hiecm/hip/v3/link/context/notify \
  --header 'Authorization: Bearer <ACCESS_TOKEN_FROM_SESSIONS_CALL>' \
  --header 'REQUEST-ID: 18235d89-cb13-479d-ad71-7a57d5f669a8' \
  --header 'TIMESTAMP: 2022-10-06T15:10:00.587Z' \
  --header 'X-CM-ID: sbx' \
  --header 'X-HIP-ID: IN2810014366' \
  --header 'Content-Type: application/json' \
  --data '{
  "notification": {
    "patient": {
      "id": "<ABHA_ADDRESS>"
    },
    "careContext": {
      "patientReference": "<ABHA_ADDRESS>",
      "careContextReference": "b009a970-8b04-4779-abd1-b50f113245bf"
    },
    "hiTypes": [
      "DiagnosticReport"
    ],
    "date": "2024-05-09T10:34:00.387Z",
    "hip": {
      "id": "ABDM_HIP"
    }
  }
}'
```

#### 3. Send SMS notification to patient that a care context is linked (`m2_post_hip_v3_link_patient_links_sms_notify2`)

```bash
curl --request POST \
  --url https://dev.abdm.gov.in/api/hiecm/hip/v3/link/patient/links/sms/notify2 \
  --header 'Authorization: Bearer <ACCESS_TOKEN_FROM_SESSIONS_CALL>' \
  --header 'REQUEST-ID: 18235d89-cb13-479d-ad71-7a57d5f669a8' \
  --header 'TIMESTAMP: 2022-10-06T15:10:00.587Z' \
  --header 'X-CM-ID: sbx' \
  --header 'Content-Type: application/json' \
  --data '{
  "notification": {
    "phoneNo": "986543***",
    "hip": {
      "id": "ABDM_HIP",
      "name": "ABC Hospital"
    }
  }
}'
```

**Exit condition (Observe until this is true)**

Each call you made in this journey answered by its callback, with `response.requestId` equal to the `REQUEST-ID` you sent on that call. The 202 on a call is receipt, not the outcome: the outcome is in the callback's body.

- `POST /api/hiecm/hip/v3/link/carecontext` is answered by `POST /api/v3/link/on_carecontext` on your bridge.
- `POST /api/hiecm/hip/v3/link/context/notify` is answered by `POST /api/v3/links/context/on-notify` on your bridge.
- `POST /api/hiecm/hip/v3/link/patient/links/sms/notify2` is answered by `POST /api/v3/patients/sms/on-notify` on your bridge.

### User initiated linking (`m2-abdm-user-initiated-linking-hip`)

**Act: the calls in this journey, in order**

#### 1. Answer the care context discovery (`m2_post_user_initiated_linking_v3_patient_care_context_on_8c9340`)

```bash
curl --request POST \
  --url https://dev.abdm.gov.in/api/hiecm/user-initiated-linking/v3/patient/care-context/on-discover \
  --header 'Authorization: Bearer <ACCESS_TOKEN_FROM_SESSIONS_CALL>' \
  --header 'REQUEST-ID: 18235d89-cb13-479d-ad71-7a57d5f669a8' \
  --header 'TIMESTAMP: 2022-10-06T15:10:00.587Z' \
  --header 'X-CM-ID: sbx' \
  --header 'X-HIU-ID: IN2810014366' \
  --header 'Content-Type: application/json' \
  --data '{
  "transactionId": "f901b782-bfdf-4224-9f8d-da2cadc20c0d",
  "patient": [
    {
      "referenceNumber": "<ABHA_ADDRESS>",
      "display": "12345",
      "careContexts": [
        {
          "referenceNumber": "abc123",
          "display": "12345"
        }
      ],
      "hiType": "Prescription",
      "count": 1
    }
  ],
  "matchedBy": [
    "MR"
  ],
  "response": {
    "requestId": "f29f0e59-8388-4698-9fe6-05db67aeac46"
  }
}'
```

#### 2. Link care context on init (`m2_post_user_initiated_linking_v3_link_care_context_on_init`)

```bash
curl --request POST \
  --url https://dev.abdm.gov.in/api/hiecm/user-initiated-linking/v3/link/care-context/on-init \
  --header 'Authorization: Bearer <ACCESS_TOKEN_FROM_SESSIONS_CALL>' \
  --header 'REQUEST-ID: 18235d89-cb13-479d-ad71-7a57d5f669a8' \
  --header 'TIMESTAMP: 2022-10-06T15:10:00.587Z' \
  --header 'X-CM-ID: sbx' \
  --header 'Content-Type: application/json' \
  --data '{
  "transactionId": "f901b782-bfdf-4224-9f8d-da2cadc20c0d",
  "link": {
    "referenceNumber": "d353b782-bfdf-4224-9f8d-da2cadc20c0d",
    "authenticationType": "DIRECT",
    "meta": {
      "communicationMedium": "MOBILE",
      "communicationHint": "OTP",
      "communicationExpiry": "2024-05-01T05:22:34.123Z"
    }
  },
  "response": {
    "requestId": "f29f0e59-8388-4698-9fe6-05db67aeac46"
  }
}'
```

#### 3. Link care context on confirm (`m2_post_user_initiated_linking_v3_link_care_context_on_confirm`)

```bash
curl --request POST \
  --url https://dev.abdm.gov.in/api/hiecm/user-initiated-linking/v3/link/care-context/on-confirm \
  --header 'Authorization: Bearer <ACCESS_TOKEN_FROM_SESSIONS_CALL>' \
  --header 'REQUEST-ID: 18235d89-cb13-479d-ad71-7a57d5f669a8' \
  --header 'TIMESTAMP: 2022-10-06T15:10:00.587Z' \
  --header 'X-CM-ID: sbx' \
  --header 'Content-Type: application/json' \
  --data '{
  "patient": [
    {
      "referenceNumber": "<ABHA_ADDRESS>",
      "display": "12345",
      "careContexts": [
        {
          "referenceNumber": "abc123",
          "display": "12345"
        }
      ],
      "hiType": "Prescription",
      "count": 1
    }
  ],
  "response": {
    "requestId": "f29f0e59-8388-4698-9fe6-05db67aeac46"
  }
}'
```

**Exit condition (Observe until this is true)**

A 202 on this reply, sent with `response.requestId` set to the `REQUEST-ID` of the `POST /api/v3/hip/link/care-context/confirm` request it answers. A reply without that id answers nothing.

### Consent and data flow (`m2-consent-management-data-flow-hip`)

**Act: the calls in this journey, in order**

#### 1. Acknowledge the consent notification (`m2_post_consent_v3_request_hip_on_notify`)

```bash
curl --request POST \
  --url https://dev.abdm.gov.in/api/hiecm/consent/v3/request/hip/on-notify \
  --header 'Authorization: Bearer <ACCESS_TOKEN_FROM_SESSIONS_CALL>' \
  --header 'REQUEST-ID: 18235d89-cb13-479d-ad71-7a57d5f669a8' \
  --header 'TIMESTAMP: 2022-10-06T15:10:00.587Z' \
  --header 'X-CM-ID: sbx' \
  --header 'Content-Type: application/json' \
  --data '{
  "acknowledgement": {
    "status": "OK",
    "consentId": "e3c74829-3f82-4f94-959e-e10f57bcd57b"
  },
  "response": {
    "requestId": "6f0b4665-a915-4c92-aa36-65afb4a2cd71"
  }
}'
```

#### 2. Submit the health information data request acknowledgement from HIP (`m2_post_data_flow_v3_health_information_hip_on_request`)

```bash
curl --request POST \
  --url https://dev.abdm.gov.in/api/hiecm/data-flow/v3/health-information/hip/on-request \
  --header 'Authorization: Bearer <ACCESS_TOKEN_FROM_SESSIONS_CALL>' \
  --header 'REQUEST-ID: 18235d89-cb13-479d-ad71-7a57d5f669a8' \
  --header 'TIMESTAMP: 2022-10-06T15:10:00.587Z' \
  --header 'X-CM-ID: sbx' \
  --header 'Content-Type: application/json' \
  --data '{
  "hiRequest": {
    "transactionId": "18235d89-cb13-479d-ad71-7a57d5f669a8",
    "sessionStatus": "ACKNOWLEDGED"
  },
  "response": {
    "requestId": "6f0b4665-a915-4c92-aa36-65afb4a2cd71"
  }
}'
```

#### 3. Submit the notifications corresponding to events during data flow (`m2_post_data_flow_v3_health_information_notify`)

```bash
curl --request POST \
  --url https://dev.abdm.gov.in/api/hiecm/data-flow/v3/health-information/notify \
  --header 'Authorization: Bearer <ACCESS_TOKEN_FROM_SESSIONS_CALL>' \
  --header 'REQUEST-ID: 18235d89-cb13-479d-ad71-7a57d5f669a8' \
  --header 'TIMESTAMP: 2022-10-06T15:10:00.587Z' \
  --header 'X-CM-ID: sbx' \
  --header 'Content-Type: application/json' \
  --data '{
  "notification": {
    "consentId": "18235d89-cb13-479d-ad71-7a57d5f669a8",
    "transactionId": "18235d89-cb13-479d-ad71-7a57d5f669a8",
    "doneAt": "2023-01-24T06:35:44.167Z",
    "notifier": {
      "type": "HIP",
      "id": "IN2810014366"
    },
    "statusNotification": {
      "sessionStatus": "TRANSFERRED",
      "hipId": "IN2810014366",
      "statusResponses": [
        {
          "careContextReference": "10004-20200001768-1",
          "hiStatus": "DELIVERED",
          "description": "Data sent successfully"
        }
      ]
    }
  }
}'
```

**Exit condition (Observe until this is true)**

A 202 response to `POST /api/hiecm/data-flow/v3/health-information/notify` in `m2-consent-management-data-flow-hip`, whose body the specification does not give: read what comes back.

### Callbacks (`m2-callbacks`)

**Act: the calls in this journey, in order**

#### 1. Receive the HIP token on generate token (`m2_post_v3_hip_token_on_generate_token`)

Inbound to your bridge at `/api/v3/hip/token/on-generate-token`. Acknowledge it and continue.

#### 2. Link on carecontext (`m2_post_v3_link_on_carecontext`)

Inbound to your bridge at `/api/v3/link/on_carecontext`. Acknowledge it and continue.

#### 3. Receive the links context on notify (`m2_post_v3_links_context_on_notify`)

Inbound to your bridge at `/api/v3/links/context/on-notify`. Acknowledge it and continue.

#### 4. Receive the patients SMS on notify (`m2_post_v3_patients_sms_on_notify`)

Inbound to your bridge at `/api/v3/patients/sms/on-notify`. Acknowledge it and continue.

#### 5. Discover care contexts associated with a patient (`m2_post_v3_hip_patient_care_context_discover`)

Inbound to your bridge at `/api/v3/hip/patient/care-context/discover`. Acknowledge it and continue.

#### 6. Initiate the linking of care contexts for a patient (`m2_post_v3_hip_link_care_context_init`)

Inbound to your bridge at `/api/v3/hip/link/care-context/init`. Acknowledge it and continue.

#### 7. Confirm the linking of care contexts for a patient (`m2_post_v3_hip_link_care_context_confirm`)

Inbound to your bridge at `/api/v3/hip/link/care-context/confirm`. Acknowledge it and continue.

#### 8. Receive the consent decision (`m2_post_v3_consent_request_hip_notify`)

```bash
curl --request POST \
  --url https://dev.abdm.gov.in/api/v3/consent/request/hip/notify \
  --header 'Authorization: Bearer <ACCESS_TOKEN_FROM_SESSIONS_CALL>' \
  --header 'REQUEST-ID: 18235d89-cb13-479d-ad71-7a57d5f669a8' \
  --header 'TIMESTAMP: 2022-10-06T15:10:00.587Z' \
  --header 'X-HIP-ID: IN2810014366' \
  --header 'Content-Type: application/json' \
  --data '{
  "notification": {
    "status": "GRANTED",
    "consentId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "consentDetail": {
      "schemaVersion": "v3",
      "consentId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "createdAt": "2024-05-01T05:10:20.123Z",
      "patient": {
        "id": "<ABHA_ADDRESS>"
      },
      "careContexts": [
        {
          "patientReference": "batman@tmh",
          "careContextReference": "Episode1"
        }
      ],
      "purpose": {
        "text": "Care Management",
        "code": "CAREMGT",
        "refUri": "www.abc.com"
      },
      "hip": {
        "id": "cowin_hip_01",
        "name": "Cowin",
        "type": "HIP"
      },
      "hiu": {
        "id": "cowin_hiu_01",
        "name": "Cowin",
        "type": "HIU"
      },
      "consentManager": {
        "id": "abdm"
      },
      "requester": {
        "name": "<ABHA_ADDRESS>",
        "identifier": {
          "value": "REG1",
          "type": "MH1001",
          "system": "https://www.sample.com"
        }
      },
      "hiTypes": [
        "Prescription"
      ],
      "permission": {
        "accessMode": "VIEW",
        "dateRange": {
          "from": "2021-09-28T12:30:08.573Z",
          "to": "2021-09-28T12:30:08.573Z"
        },
        "dataEraseAt": "2021-09-28T12:30:08.573Z",
        "frequency": {
          "unit": "HOUR",
          "value": 1,
          "repeats": 0
        }
      }
    },
    "signature": "e8nY601CYDsC0FKoDjSp+7GeQ2s2R8oZncLCz5ce+pEuDOr5bZV0aaHjwJg4b9S9V+twjt4hbojx3fl7egrt8+0c+lfPTi5/bBUAQXCABTfFmtFU7jn65HlTt8kgkiONx26ZBhJ0wX3xjYI72PPtzYIiT5Q08YtDoILA62KceioV7lwuKssw7wC4ECbBAvRuXT121TmtrPhf+0myJATSnaajS06S6OthrKfZLNTUFf3pFiJzqouSTrjNblOX6DT2+JuO3rom1Szz/03c0HQG+wWASv+PO3J6uRs0UI4JvKmM/4tP+Z+/HPKM15K5U5K+4pqf6czKrbIDpkT/kP8bGg==",
    "grantAcknowledgement": false
  }
}'
```

#### 9. Receive the health information data request to HIP (`m2_post_v3_hip_health_information_request`)

Inbound to your bridge at `/api/v3/hip/health-information/request`. Acknowledge it and continue.

#### 10. Push the encrypted records to the HIU's data push URL (`m2_post_health_information_transfer`)

Outbound from your bridge. POST each page of encrypted records to the `dataPushUrl` in the health information request of step 9. The call goes straight to the HIU, not through the gateway. The HIU answers 202 for each page.

**Exit condition (Observe until this is true)**

A 202 response to `POST /health-information/transfer` in `m2-callbacks`, whose body the specification does not give: read what comes back.

## Where the detail is

- Every operation, with its body fields and responses: /docs/hiecm/v3/api/m2
- Error codes: /docs/hiecm/v3/api/m2/errors
