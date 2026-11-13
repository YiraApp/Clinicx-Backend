// "Analyse" on a saved document goes to MedSense when it is set up, and reads with Gemini now if not.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mobileMedicalDocumentController as ctl } from "../src/MobileApi/v1/controllers/provider/medical-document.controller.js";
import { medicalReportAiService as ai } from "../src/services/Appointments/medical-report-ai.service.js";
import { medSenseService as ms } from "../src/services/Appointments/medsense.service.js";

const calls: string[] = [];
const report = { buffer: Buffer.from("%PDF-1.4"), mimeType: "application/pdf", fileName: "cbc.pdf", pageCount: 1 };
function res() {
    const r: any = { statusCode: 200, body: null };
    r.status = (c: number) => { r.statusCode = c; return r; };
    r.json = (b: any) => { r.body = b; return r; };
    return r;
}
const req = (force = false) => ({ params: { id: "7" }, body: { force }, query: {}, user: { userId: "u1" } }) as any;

beforeEach(() => {
    calls.length = 0;
    (ai as any).loadStoredReport = async () => ({ report, category: "Lab Report" });
    (ai as any).asPdf = async (p: any) => p.buffer;
    (ai as any).analyzeBuffer = async () => { calls.push("gemini"); return { overallStatus: "normal" }; };
    (ai as any).saveAnalysis = async () => { calls.push("save"); };
    (ms as any).submit = async () => { calls.push("medsense"); return "job1"; };
});

test("sends to MedSense and replies ANALYSIS_PENDING when MedSense handles it", async () => {
    (ms as any).handles = () => true;
    const r = res();
    await ctl.analyzeDocument(req(), r);
    assert.deepEqual(calls, ["medsense"]);
    assert.equal(r.statusCode, 409);
    assert.equal(r.body.data.code, "ANALYSIS_PENDING");
});

test("reads with Gemini when MedSense is not set up", async () => {
    (ms as any).handles = () => false;
    const r = res();
    await ctl.analyzeDocument(req(), r);
    assert.deepEqual(calls, ["gemini", "save"]);
    assert.equal(r.statusCode, 200);
});

test("falls back to Gemini when the MedSense submit fails", async () => {
    (ms as any).handles = () => true;
    (ms as any).submit = async () => { throw new Error("MedSense 500"); };
    const r = res();
    await ctl.analyzeDocument(req(), r);
    assert.deepEqual(calls, ["gemini", "save"]);
    assert.equal(r.statusCode, 200);
});

test("returns the saved analysis without calling either", async () => {
    (ai as any).loadStoredReport = async () => ({ cached: { overallStatus: "attention" } });
    const r = res();
    await ctl.analyzeDocument(req(), r);
    assert.deepEqual(calls, []);
    assert.equal(r.body.data.overallStatus, "attention");
});
