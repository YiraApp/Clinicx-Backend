// Who may open a diet plan's PDF: the patient, staff of the plan's organisation, and a doctor the
// patient gave access to their full records (their list shows self-made and other organisations' plans).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { dietController as ctl } from "../src/controllers/Diet/diet.controller.js";
import { patientDietPlanService as plans } from "../src/services/Diet/patient-diet-plan.service.js";
import { dietPlanDocumentService as docs } from "../src/services/Diet/diet-plan-document.service.js";
import { patientAccessConsentService as consent } from "../src/MobileApi/v1/services/consent/patient-access-consent.service.js";

const PATIENT = "AAAAAAAA-0000-0000-0000-000000000001";
const DOCTOR = "bbbbbbbb-0000-0000-0000-000000000002";
let plan: any;
let staff = false;
let hasConsent = false;

function res() {
    const r: any = { statusCode: 200, body: null, headers: {} as Record<string, string>, sent: null };
    r.status = (c: number) => { r.statusCode = c; return r; };
    r.json = (b: any) => { r.body = b; return r; };
    r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
    r.end = (b: any) => { r.sent = b; return r; };
    return r;
}
const req = (userId: string) => ({ params: { id: "7" }, query: {}, body: {}, headers: {}, user: { userId } }) as any;

beforeEach(() => {
    plan = { Id: 7, PatientId: PATIENT, AssignedByDoctorId: PATIENT, CreatedByPatient: true, OrganizationId: 4 };
    staff = false;
    hasConsent = false;
    (plans as any).getPlanDetails = async (id: number) => (id === 7 ? plan : null);
    (docs as any).canStaffOpen = async () => staff;
    (docs as any).buildPdf = async () => ({ buffer: Buffer.from("%PDF-1.4"), fileName: "Diet Plan.pdf" });
    (consent as any).checkAccess = async () => ({ hasAccess: hasConsent });
});

test("a doctor with the patient's full-records consent opens a plan the patient made", async () => {
    hasConsent = true;
    const r = res();
    await ctl.openPlanPdf(req(DOCTOR), r);
    assert.equal(r.headers["Content-Type"], "application/pdf");
    assert.ok(r.sent);
});

test("a doctor without consent or a role at the plan's organisation gets 404", async () => {
    const r = res();
    await ctl.openPlanPdf(req(DOCTOR), r);
    assert.equal(r.statusCode, 404);
    assert.equal(r.sent, null);
});

test("staff of the plan's organisation open it without consent", async () => {
    plan.CreatedByPatient = false;
    staff = true;
    const r = res();
    await ctl.openPlanPdf(req(DOCTOR), r);
    assert.equal(r.headers["Content-Type"], "application/pdf");
});

test("the patient opens their own plan (ids compared without case)", async () => {
    const r = res();
    await ctl.openPlanPdf(req(PATIENT.toLowerCase()), r);
    assert.equal(r.headers["Content-Type"], "application/pdf");
});

test("an unknown plan is 404 even with consent", async () => {
    hasConsent = true;
    const r = res();
    await ctl.openPlanPdf({ ...req(DOCTOR), params: { id: "8" } }, r);
    assert.equal(r.statusCode, 404);
});
