/**
 * Checks every request body M2 sends against its operation's schema with ABDM's validator
 * (docs.abdm.gov.in/mcp, validate kind=request). The bodies are produced by the real M2 services
 * with fictitious data and a gateway that records instead of sending: nothing reaches ABDM.
 *
 *   npx tsx scratch/abdm-m2-validate-requests.ts
 */
import { CareContextCatalog } from "../src/services/Abdm/m2/care-contexts.js";
import { HipLinkingService } from "../src/services/Abdm/m2/hip-linking.js";
import { PatientLinkingService } from "../src/services/Abdm/m2/patient-linking.js";
import { DataFlowService } from "../src/services/Abdm/m2/data-flow.js";
import { generateKeyMaterial } from "../src/services/Abdm/hie-crypto.js";
import { fixtureParties } from "../src/services/Abdm/fhir/fhir-fixtures.js";

process.env.ABDM_M2_HIP_ID = "IN3610000001";
process.env.ABDM_M2_HIP_HOSPITAL_ID = "12";
process.env.ABDM_M2_HIP_NAME = "Test Clinic";
const PATIENT = "0f6c2b8e-1d2a-4c55-9d7e-0a1b2c3d4e5f";

const OPERATIONS: Record<string, string> = {
    "/api/hiecm/v3/token/generate-token": "m2_post_v3_token_generate_token",
    "/api/hiecm/hip/v3/link/carecontext": "m2_post_hip_v3_link_carecontext",
    "/api/hiecm/hip/v3/link/context/notify": "m2_post_hip_v3_link_context_notify",
    "/api/hiecm/hip/v3/link/patient/links/sms/notify2": "m2_post_hip_v3_link_patient_links_sms_notify2",
    "/api/hiecm/user-initiated-linking/v3/patient/care-context/on-discover": "m2_post_user_initiated_linking_v3_patient_care_context_on_8c9340",
    "/api/hiecm/user-initiated-linking/v3/link/care-context/on-init": "m2_post_user_initiated_linking_v3_link_care_context_on_init",
    "/api/hiecm/user-initiated-linking/v3/link/care-context/on-confirm": "m2_post_user_initiated_linking_v3_link_care_context_on_confirm",
    "/api/hiecm/consent/v3/request/hip/on-notify": "m2_post_consent_v3_request_hip_on_notify",
    "/api/hiecm/data-flow/v3/health-information/hip/on-request": "m2_post_data_flow_v3_health_information_hip_on_request",
    "/api/hiecm/data-flow/v3/health-information/notify": "m2_post_data_flow_v3_health_information_notify",
};

// An in-memory store holding one patient, like the one the tests use.
const memory = () => {
    const contexts: any[] = [];
    let id = 1;
    const consents: any[] = [], requests: any[] = [], transfers: any[] = [], tokens: any[] = [];
    const patient = { userId: PATIENT, name: "Asha Rao", gender: "Female", birthDate: "1990-04-12", phone: "+919800000000", abhaNumber: "91-1234-5678-9012", abhaAddress: "asha.test@sbx" };
    return {
        contexts,
        patient: async () => patient,
        patientsAt: async () => [patient],
        patientsWithAbhaAt: async () => [PATIENT],
        appointmentIds: async () => [101],
        upsertCareContexts: async (seeds: any[]) => { for (const s of seeds) if (!contexts.some((c) => c.referenceNumber === s.referenceNumber)) contexts.push({ ...s, id: id++, linkStatus: "not-linked", notifiedHiTypes: [], linkedAbhaAddress: null }); },
        careContexts: async () => contexts.map((c) => ({ ...c })),
        careContextsByRefs: async (_h: string, refs: string[]) => contexts.filter((c) => refs.includes(c.referenceNumber)).map((c) => ({ ...c })),
        careContextsByLinkRequest: async (r: string) => contexts.filter((c) => c.linkRequestId === r).map((c) => ({ ...c })),
        setLinkState: async (ids: number[], patch: any) => { for (const c of contexts) if (ids.includes(c.id)) Object.assign(c, patch); },
        linkToken: async () => tokens[0] ?? null,
        saveLinkToken: async (t: any) => { tokens.push(t); },
        dropLinkTokens: async () => { tokens.length = 0; },
        createLinkRequest: async (r: any) => { requests.push(r); },
        linkRequest: async (ref: string) => requests.find((r) => r.linkRefNumber === ref) ?? null,
        updateLinkRequest: async (ref: string, p: any) => { Object.assign(requests.find((r) => r.linkRefNumber === ref), p); },
        saveConsent: async (c: any) => { consents.push(c); },
        consent: async (cid: string) => consents.find((c) => c.consentId === cid) ?? null,
        createTransfer: async (t: any) => { transfers.push(t); return "created" as const; },
        updateTransfer: async () => {},
    };
};

const main = async () => {
    const store: any = memory();
    const sent: Array<{ path: string; body: unknown }> = [];
    const gateway: any = { call: async (c: any) => { sent.push({ path: c.path, body: c.body }); return {}; }, getAccessToken: async () => "t" };
    const records: any = {
        visit: async () => ({
            parties: fixtureParties,
            appointment: { id: 101, start: new Date("2026-10-20T10:00:00+05:30"), end: null, teleconsultation: false },
            registration: { allergies: null, medicalHistory: null },
            medicalRecords: [{ Id: "mr-1", Type: "Consultation", Date: new Date("2026-10-20T10:00:00+05:30"), ChiefComplaint: "Toothache" }],
            prescriptions: [{ row: { Id: "rx-1", Date: new Date("2026-10-20T10:10:00+05:30") }, medications: [{ id: "m-1", name: "Paracetamol" }], diagnoses: [], pdf: null }],
            notes: [], documents: [], bills: [], immunizations: [], certificates: new Map(),
        }),
        standaloneRecordIds: async () => ({ dischargeSummaryIds: [], immunizationIds: [], vitalsRecordIds: [] }),
    };
    const catalog = new CareContextCatalog(store, records);
    const linking = new HipLinkingService(store, catalog, gateway);
    const patientLinking = new PatientLinkingService(store, catalog, { sendOTP: async () => {} }, gateway, () => new Date(), () => "246810");
    const { BUILDERS } = await import("../src/services/Abdm/fhir/health-records.js");
    const { FIXTURES } = await import("../src/services/Abdm/fhir/fhir-fixtures.js");
    const flow = new DataFlowService(store, catalog, { forAppointment: async () => [{ hiType: "OPConsultation", key: "k", bundle: BUILDERS.OPConsultation(FIXTURES.OPConsultation) }] } as any, gateway, () => new Date(), async () => ({ ok: true, status: 202 }));

    // HIP-initiated: token, link, notify, SMS
    await linking.link(PATIENT);
    const tokenRequest = store.contexts[0].linkRequestId;
    await linking.onLinkToken(tokenRequest, { abhaAddress: "asha.test@sbx", linkToken: "e30.eyJleHAiOjE5MDAwMDAwMDB9.s" });
    await linking.onLinkResult(store.contexts[0].linkRequestId, { status: "Successfully Linked care context", abhaAddress: "asha.test@sbx" });
    store.contexts[0].notifiedHiTypes = ["OPConsultation"];
    await linking.notifyChanges(PATIENT);
    await linking.smsNotify(PATIENT);
    // User-initiated: discover, init, confirm
    for (const c of store.contexts) c.linkStatus = "not-linked";
    await patientLinking.onDiscover("6f0b4665-a915-4c92-aa36-65afb4a2cd71", {}, { transactionId: "f901b782-bfdf-4224-9f8d-da2cadc20c0d", patient: { id: "asha.test@sbx", name: "Asha Rao", gender: "F", yearOfBirth: 1990 } });
    await patientLinking.onLinkInit("6f0b4665-a915-4c92-aa36-65afb4a2cd72", { transactionId: "f901b782-bfdf-4224-9f8d-da2cadc20c0d", abhaAddress: "asha.test@sbx", patient: [{ referenceNumber: PATIENT, careContexts: [{ referenceNumber: "OP-101" }], hiType: "OPConsultation", count: 1 }] });
    const linkRef = (sent.at(-1)!.body as any).link.referenceNumber;
    await patientLinking.onLinkConfirm("6f0b4665-a915-4c92-aa36-65afb4a2cd73", { confirmation: { linkRefNumber: linkRef, token: 246810 } });
    // Consent and data flow
    const hiu = generateKeyMaterial();
    await flow.onConsentNotify("6f0b4665-a915-4c92-aa36-65afb4a2cd74", { notification: { status: "GRANTED", consentId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", consentDetail: { consentId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", patient: { id: "asha.test@sbx" }, hiTypes: ["OPConsultation"], careContexts: [{ patientReference: PATIENT, careContextReference: "OP-101" }], permission: { dateRange: { from: "2026-01-01T00:00:00Z", to: "2026-12-31T00:00:00Z" }, dataEraseAt: "2027-12-31T00:00:00Z" } } } });
    await flow.onHealthInformationRequest("6f0b4665-a915-4c92-aa36-65afb4a2cd75", { transactionId: "18235d89-cb13-479d-ad71-7a57d5f669a8", hiRequest: { consent: { id: "3fa85f64-5717-4562-b3fc-2c963f66afa6" }, dateRange: { from: "2026-01-01T00:00:00Z", to: "2026-12-31T00:00:00Z" }, dataPushUrl: "https://hiu.example.test/push", keyMaterial: { cryptoAlg: "ECDH", curve: "Curve25519", dhPublicKey: { expiry: "2026-12-31T00:00:00Z", parameters: "Curve25519/32byte random key", keyValue: hiu.publicKey }, nonce: hiu.nonce } } });

    // Validate each distinct operation's body with ABDM's validator
    let session: string | null = null, rid = 0;
    const rpc = async (method: string, params: unknown, notify = false): Promise<any> => {
        const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
        if (session) headers["mcp-session-id"] = session;
        const res = await fetch("https://docs.abdm.gov.in/mcp", { method: "POST", headers, body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++rid, method, params }) });
        session = res.headers.get("mcp-session-id") ?? session;
        if (notify) return null;
        const text = await res.text();
        return (text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).pop()!)).result;
    };
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "clinicx-m2", version: "1" } });
    await rpc("notifications/initialized", {}, true);

    const seen = new Set<string>();
    let failed = 0;
    for (const { path, body } of sent) {
        const op = OPERATIONS[path];
        if (!op || seen.has(op)) continue;
        seen.add(op);
        const r = await rpc("tools/call", { name: "validate", arguments: { kind: "request", operation_id: op, body: JSON.stringify(body) } });
        const text = r.content.map((c: any) => c.text ?? "").join("");
        let report: any;
        try { report = JSON.parse(text); } catch { report = { raw: text }; }
        // The request validator answers { valid, errors }; anything else is not a pass.
        const ok = report.valid === true && Array.isArray(report.errors) && report.errors.length === 0;
        if (!ok) failed++;
        console.log(`${ok ? "PASS" : "FAIL"}  ${op}${ok ? "" : "\n" + JSON.stringify(report.errors ?? report, null, 1).slice(0, 1500)}`);
    }

    // The validator must be able to say no: a link request without abhaAddress or hiType.
    const broken = await rpc("tools/call", { name: "validate", arguments: { kind: "request", operation_id: "m2_post_hip_v3_link_carecontext", body: JSON.stringify({ patient: [{ referenceNumber: "x", careContexts: [] }] }) } });
    const brokenReport = JSON.parse(broken.content.map((c: any) => c.text ?? "").join(""));
    console.log(`${brokenReport.valid === false ? "PASS" : "FAIL"}  a broken body is refused (${(brokenReport.errors ?? []).length} errors)`);
    if (brokenReport.valid !== false) failed++;
    const missing = Object.values(OPERATIONS).filter((op) => !seen.has(op));
    if (missing.length) console.log("NOT EXERCISED:", missing.join(", "));
    process.exit(failed || missing.length ? 1 : 0);
};

main().catch((e) => { console.error(e); process.exit(1); });
