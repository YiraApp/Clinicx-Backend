import { test } from "node:test";
import assert from "node:assert/strict";
import type { FhirBundle, HiType } from "../../services/Abdm/fhir/fhir-common.js";
import { BUILDERS } from "../../services/Abdm/fhir/health-records.js";
import { FIXTURES } from "../../services/Abdm/fhir/fhir-fixtures.js";
import { recordPdfOf } from "../../services/Abdm/fhir/record-pdf.js";
import type { HealthRecordBundle } from "../../services/Abdm/abdm-health-record.service.js";
import type { CareContextRow, Hip } from "../../services/Abdm/m2/m2-store.js";
import { AbdmM2Controller, type CareContextRecords } from "./abdm-m2.controller.js";

/**
 * GET /api/abdm/patients/:userId/care-contexts/:reference (each record's PDF described) and
 * GET .../care-contexts/:reference/records/:key/pdf (that PDF, as it goes in the bundle).
 * Made-up patient and records only.
 */

const HIP: Hip = { id: "IN3610000001", hospitalId: 12, name: "ClinicX Test Hospital" };
const PATIENT = "0f6c2b8e-1d2a-4c55-9d7e-0a1b2c3d4e5f";
const OTHER_PATIENT = "9a8b7c6d-0000-4000-8000-000000000001";
const REF = "VISIT-101";
const NOW = new Date("2026-10-26T12:00:00+05:30");

const bundleOf = <T extends HiType>(hiType: T, source: unknown = FIXTURES[hiType]): HealthRecordBundle => {
    const bundle = (BUILDERS[hiType] as (s: unknown, now: Date) => FhirBundle)(source, NOW);
    return { hiType, key: bundle.id, bundle };
};
const VISIT = [
    bundleOf("OPConsultation"),
    bundleOf("Prescription"),
    bundleOf("Invoice"),
    bundleOf("HealthDocumentRecord"),
];

const context = { referenceNumber: REF, kind: "visit", display: "Visit on 20 Oct 2026", recordDate: new Date("2026-10-20T04:30:00Z"), patientUserId: PATIENT } as CareContextRow;

const recordsWith = (over: Partial<CareContextRecords> = {}) => {
    const built: string[] = [];
    const records: CareContextRecords = {
        async hip(hospitalId) { return hospitalId === HIP.hospitalId ? HIP : null; },
        async patient(userId) { return [PATIENT, OTHER_PATIENT].includes(userId.toLowerCase()) ? { userId: userId.toLowerCase() } : null; },
        async careContext(hipId, reference) { return hipId === HIP.id && reference === REF ? context : null; },
        async bundles(reference) { built.push(reference); return VISIT; },
        ...over,
    };
    return { controller: new AbdmM2Controller(undefined, records), built };
};

const call = async (handler: "careContextView" | "careContextPdf", controller: AbdmM2Controller, params: Record<string, string>, hospital: number | null = HIP.hospitalId) => {
    const res: any = {
        statusCode: 200,
        body: null,
        sent: null as Buffer | null,
        headers: {} as Record<string, string>,
        setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; },
        status(code: number) { this.statusCode = code; return this; },
        json(body: unknown) { this.body = body; return this; },
        send(body: Buffer) { this.sent = body; return this; },
    };
    await controller[handler]({ params: { userId: PATIENT, reference: REF, ...params }, headers: hospital ? { "x-hospital-id": String(hospital) } : {} } as any, res);
    return res;
};

test("the record view gives each record its key and describes the PDF it carries", async () => {
    const { controller } = recordsWith();
    const res = await call("careContextView", controller, {});
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    const records = res.body.data.records;
    assert.deepEqual(records.map((r: any) => [r.hiType, r.key]), VISIT.map((r) => [r.hiType, r.key]));
    const [op, rx, invoice, documents] = records;
    assert.deepEqual(op.pdf, { title: "Consultation report (PDF)", bytes: recordPdfOf(VISIT[0]!.bundle)!.data.length, source: "generated" });
    assert.equal(rx.pdf.source, "signed-copy", "a prescription's own PDF is the one sent");
    assert.equal(invoice.pdf.source, "generated");
    assert.equal(documents.pdf, null, "a health document carries its uploads, not a PDF built of it");
    assert.ok(!JSON.stringify(res.body).includes(recordPdfOf(VISIT[0]!.bundle)!.data.toString("base64").slice(0, 200)), "the PDF itself is not in the view");
});

test("the PDF route answers the record's PDF byte for byte as it is in the bundle, never cached, with no patient detail in its name", async () => {
    const { controller } = recordsWith();
    for (const record of VISIT.slice(0, 3)) {
        const res = await call("careContextPdf", controller, { key: record.key });
        assert.equal(res.statusCode, 200, record.hiType);
        assert.equal(res.headers["content-type"], "application/pdf");
        assert.equal(res.headers["cache-control"], "no-store");
        assert.equal(res.headers["x-content-type-options"], "nosniff");
        assert.equal(res.headers["content-disposition"], `inline; filename="${record.hiType}.pdf"`);
        assert.deepEqual(res.sent, recordPdfOf(record.bundle)!.data);
        assert.equal(res.sent.subarray(0, 5).toString("latin1"), "%PDF-");
    }
});

test("no PDF for a record that carries none, or a key no longer in the care context", async () => {
    const { controller } = recordsWith();
    const none = await call("careContextPdf", controller, { key: VISIT[3]!.key });
    assert.equal(none.statusCode, 404);
    assert.match(none.body.message, /no PDF of its own/);
    assert.equal(none.sent, null);

    const gone = await call("careContextPdf", controller, { key: "4c0e7c1e-0000-5000-8000-000000000000" });
    assert.equal(gone.statusCode, 404);
    assert.match(gone.body.message, /changed since it was opened/);
});

test("another patient's care context, an unknown patient, or a hospital that is no facility builds nothing", async () => {
    const { controller, built } = recordsWith();
    const other = await call("careContextPdf", controller, { userId: OTHER_PATIENT, key: VISIT[0]!.key });
    assert.equal(other.statusCode, 404);
    const unknown = await call("careContextPdf", controller, { userId: "11111111-2222-4333-8444-555555555555", key: VISIT[0]!.key });
    assert.equal(unknown.statusCode, 404);
    const notFacility = await call("careContextPdf", controller, { key: VISIT[0]!.key }, 99);
    assert.equal(notFacility.statusCode, 409);
    const unknownContext = await call("careContextView", controller, { reference: "VISIT-999" });
    assert.equal(unknownContext.statusCode, 404);
    assert.deepEqual(built, [], "no record was built for any of them");
});

test("linking takes the reviewed records as a list of reference numbers, and refuses anything else before calling ABDM", async () => {
    const { controller } = recordsWith();
    for (const references of ["VISIT-101", [101], [""], { 0: "VISIT-101" }]) {
        const res: any = { statusCode: 200, body: null, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; } };
        await controller.link({ params: { userId: PATIENT }, headers: { "x-hospital-id": "12" }, body: { references } } as any, res);
        assert.equal(res.statusCode, 400, JSON.stringify(references));
        assert.match(res.body.message, /references must be a list/);
    }
});

test("a record that can't be built says what is missing, for the view and the PDF alike", async () => {
    const { FhirSourceError } = await import("../../services/Abdm/fhir/fhir-common.js");
    const { controller } = recordsWith({ async bundles() { throw new FhirSourceError("Report 7 has no conclusion."); } });
    for (const handler of ["careContextView", "careContextPdf"] as const) {
        const res = await call(handler, controller, { key: VISIT[0]!.key });
        assert.equal(res.statusCode, 422, handler);
        assert.equal(res.body.message, "Report 7 has no conclusion.");
        assert.equal(res.body.data.kind, "record");
    }
});
