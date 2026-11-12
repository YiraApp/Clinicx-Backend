import { test } from "node:test";
import assert from "node:assert/strict";
import { FhirSourceError } from "../../services/Abdm/fhir/fhir-common.js";
import { RecordPdfError, type PreviewRequest, type RecordPdfOut } from "../../services/Abdm/record-pdf-preview.service.js";
import type { StoredPdf } from "../../repositories/Abdm/abdm-record-pdf.repository.js";
import { RecordPdfController } from "./record-pdf.controller.js";
import { medicalRecordColumns } from "../../services/Appointments/medical-record-mapping.js";

/** POST .../record-pdf/preview, GET .../record-pdf/:type/:id and its stored versions. Made-up ids only. */

const PATIENT = "0f6c2b8e-1d2a-4c55-9d7e-0a1b2c3d4e5f";
const PDF = Buffer.from("%PDF-1.4\n% made up\n%%EOF\n");

const out = (over: Partial<RecordPdfOut> = {}): RecordPdfOut => ({
    reference: "OP-101", hiType: "OPConsultation", recordKey: "appointment-101",
    pdf: { title: "Consultation report (PDF)", data: PDF, source: "generated" }, draft: false, ...over,
});

const call = async (controller: RecordPdfController, handler: "preview" | "saved" | "versions" | "version", req: { params?: Record<string, string>; body?: unknown }) => {
    const res: any = {
        statusCode: 200, body: null, sent: null as Buffer | null, headers: {} as Record<string, string>,
        setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; },
        status(code: number) { this.statusCode = code; return this; },
        json(body: unknown) { this.body = body; return this; },
        send(body: Buffer) { this.sent = body; return this; },
    };
    await controller[handler]({ params: { userId: PATIENT, ...(req.params ?? {}) }, body: req.body, headers: { "x-hospital-id": "12" }, userId: "staff-1" } as any, res);
    return res;
};

const controllerWith = (records: Record<string, unknown> = {}, archive: Record<string, unknown> = {}) => {
    const asked: PreviewRequest[] = [];
    const controller = new RecordPdfController(
        {
            preview: async (req: PreviewRequest) => { asked.push(req); return out(); },
            saved: async () => out({ draft: true }),
            locate: async () => ({ reference: "WR-9", hiType: "WellnessRecord", recordKey: "wellness-record-9" }),
            ...records,
        } as any,
        { versions: async () => [], version: async () => null, ...archive } as any,
    );
    return { controller, asked };
};

test("a preview answers the PDF, never cached, typed by HI type (no patient detail), for the URL's patient and the header's hospital", async () => {
    const { controller, asked } = controllerWith();
    const res = await call(controller, "preview", { body: { type: "consultation", draft: { chiefComplaint: "Swelling", patientId: "someone-else" }, appointmentId: "101", recordId: "" } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.sent, PDF);
    assert.equal(res.headers["content-type"], "application/pdf");
    assert.equal(res.headers["content-disposition"], 'inline; filename="OPConsultation.pdf"');
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-record-status"], "final");
    assert.equal(asked[0]!.patientId, PATIENT);
    assert.equal(asked[0]!.hospitalId, 12);
    assert.equal(asked[0]!.appointmentId, 101);
    assert.equal(asked[0]!.recordId, null);
    assert.equal(asked[0]!.staffUserId, "staff-1");
});

test("a preview refuses an unknown type or missing fields, and says why a draft can't be built", async () => {
    const { controller } = controllerWith();
    assert.equal((await call(controller, "preview", { body: { type: "health-document", draft: {} } })).statusCode, 400);
    assert.equal((await call(controller, "preview", { body: { type: "wellness" } })).statusCode, 400);

    const reason = controllerWith({ preview: async () => { throw new RecordPdfError(422, "Record at least one measurement."); } });
    const res = await call(reason.controller, "preview", { body: { type: "wellness", draft: {} } });
    assert.equal(res.statusCode, 422);
    assert.deepEqual(res.body, { status: false, message: "Record at least one measurement.", data: { kind: "record" } });

    const fhir = controllerWith({ preview: async () => { throw new FhirSourceError("A Final report needs a conclusion."); } });
    assert.equal((await call(fhir.controller, "preview", { body: { type: "diagnostic-report", draft: {} } })).statusCode, 422);

    const missing = controllerWith({ preview: async () => { throw new Error("Appointment 404 not found."); } });
    assert.equal((await call(missing.controller, "preview", { body: { type: "consultation", draft: {} } })).statusCode, 404);
});

test("a saved record's PDF says whether it is shared yet; versions list what is stored, and one version answers its bytes", async () => {
    const stored: StoredPdf = {
        id: "3", hospitalId: 12, patientUserId: PATIENT, reference: "WR-9", hiType: "WellnessRecord", recordKey: "k", source: "generated",
        sha1: "a".repeat(40), bytes: PDF.length, blobUrl: "https://example.blob.core.windows.net/abdm-record-pdfs/x.pdf", createdAt: new Date("2026-10-21T10:00:00Z"),
    };
    const { controller } = controllerWith({}, {
        versions: async (hospitalId: number, loc: any) => { assert.equal(hospitalId, 12); assert.equal(loc.reference, "WR-9"); return [stored]; },
        version: async (_h: number, _l: any, id: string) => (id === "3" ? PDF : null),
    });
    const saved = await call(controller, "saved", { params: { type: "wellness", id: "9" } });
    assert.equal(saved.headers["x-record-status"], "draft");
    assert.equal(saved.headers["access-control-expose-headers"], "X-Record-Status", "the browser may read it");

    const list = await call(controller, "versions", { params: { type: "wellness", id: "9" } });
    assert.deepEqual(list.body.data, [{ id: "3", createdAt: "2026-10-21T10:00:00.000Z", bytes: PDF.length, source: "generated" }]);
    assert.ok(!JSON.stringify(list.body).includes("blob.core.windows.net"), "the stored file's address stays on the server");

    assert.deepEqual((await call(controller, "version", { params: { type: "wellness", id: "9", versionId: "3" } })).sent, PDF);
    assert.equal((await call(controller, "version", { params: { type: "wellness", id: "9", versionId: "4" } })).statusCode, 404);
    assert.equal((await call(controller, "saved", { params: { type: "nonsense", id: "9" } })).statusCode, 404);
});

test("the medical record form maps as POST /api/medical-records always has", () => {
    const cols = medicalRecordColumns({ patientId: "p", appointmentId: "101", type: "Consultation", chiefComplaint: "Swelling", examination: "Tender", treatmentPlan: "Rinse", hospitalId: 12 });
    assert.equal(cols.AppointmentId, 101);
    assert.equal(cols.PhysicalExamination, "Tender");
    assert.equal(cols.Treatment, "Rinse");
    assert.equal(cols.Status, "Completed");
    assert.equal(medicalRecordColumns({ status: "Updated" }).Status, "Updated");
});
