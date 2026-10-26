# ABDM integration plan: Clinicx as HIP (M1 → M2)

Progress: 2 of 16 steps done (13%). Last updated 2026-10-26.

**Where it stands:** the HIP is set (`IN3610001937`, hospital 12); step 1 is blocked only on which deployment ABDM calls back on. Step 2 is built and tested. Check readiness any time with `GET /api/abdm/bridge` (staff sign-in).

Never write a secret here: no token, client secret, OTP, password or patient identifier.

## Scope

- **Goal:** Clinicx (an existing HIMS) shares the records each hospital creates through ABDM HIE-CM as a Health Information Provider (HIP).
- **Role:** HIP only. HIU (requesting records) and PHR are out of scope.
- **Modules:** M1 (ABHA, in progress on `ABHABang-26-10`), then M2 (skill `abdm-m2`, installed at `.claude/skills/abdm-m2`).
- **M2 journeys** (all 13 NHA M2 cases are mandatory for a private entity): link token, HIP-initiated linking with SMS deep link, user-initiated linking (discover/init/confirm), consent notification and encrypted data transfer.
- **Out of scope for now:** inpatient care contexts. No admission model exists yet (see Inventory).

## Inventory (survey of the code as it is, 2026-10-26)

| Find | Where it is | ABDM consequence |
|---|---|---|
| Runtime, build, test | Node + TypeScript, Express 5, TypeORM on SQL Server (`package.json`); `npm run dev`, `npm run build`, `npm test` (node:test, `src/**/*.test.ts`) | Every exit condition below becomes a `*.test.ts` run by `npm test` |
| Frontend/backend split | React frontend in `../Clinicx-Frontend` calls `/api/*`; ABHA screens in `src/components/abha/` there | Counter screens in the frontend; every ABDM call goes through this backend |
| Outbound HTTP client | `src/services/Abdm/abdm-gateway.service.ts` (fetch, REQUEST-ID, TIMESTAMP, session-token cache) | Reuse it. `call()` is hard-wired to the ABHA host; M2 needs the gateway host `abdmConfig.gatewayBaseUrl` plus `X-CM-ID`/`X-HIP-ID`/`X-LINK-TOKEN` |
| Secrets and configuration | `src/config/abdm.config.ts` reads `.env` locally and Azure App Settings when deployed | No `ABDM_*` keys are in the local `.env` today, so the sandbox can't be called locally. Add `ABDM_BRIDGE_URL` (new) |
| Patient model | `Users` (`src/models/Account/user.model.ts`) holds `AbhaNumber`, `AbhaAddress`, `AbhaLinkedAt`; per-hospital membership in `PatientRegistrations` (`src/models/Organizations/patient-registration.model.ts`) | Two candidates for the patient `referenceNumber`: `Users.Id` or `PatientRegistrations.Id`. Decided by: whether one person seen at two hospitals must appear as two patients to ABDM (each hospital is its own HIP) |
| Visit / encounter model | `Appointments` (has `HospitalId`, `AppointmentDate`, `DoctorId`); `Visits` (1:1 with appointment, no `HospitalId`) | OPD care context = **Appointment**: prescriptions, clinical notes, medical records and documents all key on `AppointmentId` |
| Inpatient admission | none. No admission/IPD/discharge model in `src/models` | IP care contexts are blocked until an admission model exists |
| Record formats | Structured: `PatientPrescriptions` + `PrescriptionMedications` (`ConceptId`) + `PrescriptionDiagnoses` (`DiagnosisConceptId`); `PatientMedicalRecords` (complaint/symptom/exam/diagnosis/treatment with SNOMED concept ids, vitals); `ClinicalNotes` (free text). Files: `MedicalDocuments` (blob, `DocumentCategory`), `PostVisitDocuments`, prescription PDFs. SNOMED service in `src/snomed/` | FHIR mapping: Prescription → `Prescription`; medical record + notes + vitals → `OPConsultation`; uploaded reports → `DiagnosticReport`/`HealthDocumentRecord` (attachment). No FHIR builder exists yet; add at `src/services/Abdm/fhir/` |
| Facility ID (HFR / HIP ID) | `.env`: `ABDM_M2_HIP_ID=IN3610001937` (Ocimum dentistry) + `ABDM_M2_HIP_HOSPITAL_ID=12` (Ocimum Dental Clinic), read by `abdmConfig.m2HipId`/`m2HipHospitalId`. Scan and Share keeps `ABDM_HIP_ID=Yira-HIP` | Every M2 call sends it as `X-HIP-ID`. A per-hospital `Hospitals.HfrId` column waits until a second hospital needs M2. Azure App Settings need the same two keys |
| Inbound routing and auth | `src/app.ts` mounts `/api` → `src/routes/index.ts`. The global `loggingMiddleware` enforces the app's JWT on everything outside its `publicRoutes`; `abdmRouter` adds `staffJwtMiddleware` | ABDM callbacks (`/api/v3/...`) would get **401** today. They need their own router, added to `publicRoutes`, authenticated by verifying ABDM's gateway token instead |
| Public URL | Azure Web Apps `Clinicx-api-dev` and `clinicx-api-qa` (`.github/workflows/`) | Bridge URL must be one of these. Callbacks only work against a deployed build, never localhost |
| Crypto helpers | `src/services/Abdm/abdm-crypto.service.ts`: RSA for M1 identifiers only | M2 needs its own path: X25519 (Curve25519) ECDH, HKDF, AES-GCM, with the requester's key and nonce. Don't reuse the M1 path. New file `src/services/Abdm/abdm-hie-crypto.service.ts` |
| Errors and logs | `loggingMiddleware` writes request/response bodies to `APILogs`; `src/utils/log-mask.utils.ts` masks only `/api/abdm*` | Extend masking to `/api/v3/*` callbacks: they carry demographics, consent artefacts and `keyMaterial` |

## Design rules (from the skill, applied here)

- **One exchange per REQUEST-ID.** Every outbound call and its callback is one row keyed by request id (`response.requestId` on the callback). `202 Accepted` is receipt, never completion.
- **Callbacks answer fast.** Log the whole body (masked) on arrival, persist it, return 202, process after.
- **Link tokens are reused.** Store one per patient per HIP with its expiry (about 6 months). Reuse it while valid and request a new one only when it has expired. Store it at rest like a credential and never log it.
- **Care-context display names carry no clinical detail.** Example: `OPD visit, 26 Oct 2026, <hospital name>`. Never a complaint, diagnosis or doctor note.
- **Consent is enforced at transfer time.** Refuse expired or revoked artefacts; send only care contexts and HI types the artefact names, and only records dated within its range.
- **Never log credentials or link tokens**, or anything before encryption.

## Steps

| # | Step | Status | Exit condition | Evidence |
|---|---|---|---|---|
| 0 | Survey and plan | done | This file exists; every inventory row answered | This file, 2026-10-26; `npm test` 42/42 pass |
| 1 | M2 prerequisites: valid HFR ID as the HIP, linked to the client ID; bridge URL on our deployment | blocked | `GET /api/abdm/bridge` returns `ready: true` | 2026-10-26, sandbox via `GET /api/abdm/bridge` (REQUEST-ID `318fab34-404e-4283-9d87-648aade52aa2`): session OK, client `SBX_002352` has `hip` and `bridge` roles. HIP resolved 2026-10-26: `Yira-HIP` fails the service lookup (ABDM-1002) that ABDM's sandbox procedure (`shared.sandbox.sandbox-to-hip-or-hiu-id`) gives as the HIP-ID check, so M2 uses `IN3610001937` → hospital 12; lookup REQUEST-ID `7366f551-2c46-49ef-853d-80477c1d7c9a` returned `isHip: true`, active. **Still blocked on:** the bridge URL is an ngrok tunnel and `ABDM_BRIDGE_URL` is unset. Which deployment receives callbacks? Repoint only once step 3's callback routes are deployed there |
| 2 | Gateway service calls the HIE-CM host with `X-CM-ID`/`X-HIP-ID`/`X-LINK-TOKEN` | done | Unit test: an M2 call goes to `gatewayBaseUrl` with those headers | 2026-10-26: `AbdmCall.host: "gateway"` in `abdm-gateway.service.ts`; tests in `abdm-gateway.test.ts`; `parseAbdmError` now reads the gateway's array-wrapped refusals (observed in the sandbox). `npm test` 51/51 |
| 3 | Callback surface: public `/api/v3/*` router, gateway-token check, masked body log, exchange store, 202 | pending | Test: an unauthenticated app request is refused, a valid callback is stored and answered 202 | |
| 4 | Link token: generate, receive `on-generate-token`, store and reuse | pending | Sandbox: callback `response.requestId` equals the sent REQUEST-ID; a second link for the same patient reuses the token | |
| 5 | FHIR bundles: `OPConsultation`, `Prescription`, documents | pending | Bundles pass the Docs MCP FHIR validator for a sample appointment | |
| 6 | Care contexts: one per appointment, reference + clinical-free display | pending | Test: display contains no field from the clinical tables | |
| 7 | HIP-initiated linking `link/carecontext`, automatic when records are saved | pending | Sandbox: `on_carecontext` callback success; record visible in PHR app (HIP_INTI_LINK_505) | |
| 8 | SMS deep link `links/sms/notify2` | pending | Sandbox: `sms/on-notify` success; SMS received (HIP_INIT_NOTIFY_HIECM) | |
| 9 | Context notify on record update `link/context/notify` | pending | Sandbox: `links/context/on-notify` success | |
| 10 | Discovery `on-discover`: verified-identifier match, then mobile with fuzzy name/gender/year match, unlinked contexts only | pending | Sandbox: PHR search shows this hospital's records (USER_INIT_LINK_603/604) | |
| 11 | Link init/confirm with our OTP over the existing SMS service | pending | Sandbox: records under "Linked Facilities" in PHR (USER_INIT_LINK_605/607) | |
| 12 | Consent notify `hip/notify` → store artefact → `on-notify` | pending | Sandbox: `on-notify` accepted; revoked artefact marked revoked | |
| 13 | Health-information request → `on-request` → encrypt → push → `notify` | pending | PHR app decrypts and displays records (HIP_INIT_SHARE_CARECONTEXT) | |
| 14 | Frontend: ABDM status per appointment (linked / pending / failed) for staff | pending | Screen shows each case's Expected Result | |
| 15 | NHA M2 functional test cases (`references/test.md`), run log linked here | pending | All 13 mandatory cases pass | |
