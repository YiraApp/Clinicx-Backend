import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { HI_TYPES, NRCES, type FhirBundle, type HiType } from "./fhir-common.js";
import { BUILDERS } from "./health-records.js";
import { FIXTURES } from "./fhir-fixtures.js";
import { readFileSync } from "node:fs";
import { printable, recordPdfOf, renderRecordPdf } from "./record-pdf.js";
import { drawableLogo } from "../record-logo.js";
import { prescriptionPdfService } from "../../Prescriptions/prescription-pdf.service.js";
import { recordView } from "./record-view.js";

/**
 * Unstructured data: every record but a HealthDocumentRecord carries a PDF of itself, built from its
 * own bundle and placed where the NRCES profile carries documents. All data is the made-up fixtures.
 */

const NOW = new Date("2026-10-26T12:00:00+05:30");
const build = <T extends HiType>(hiType: T, source: unknown = FIXTURES[hiType]) => (BUILDERS[hiType] as (s: unknown, now: Date) => FhirBundle)(source, NOW);
const composition = (b: FhirBundle) => b.entry[0]!.resource as any;
const byUrl = (b: FhirBundle, url: string) => b.entry.find((e) => e.fullUrl === url)?.resource as any;
const tagged = (b: FhirBundle) => b.entry.map((e) => e.resource as any).filter((r) => (r.meta?.tag ?? []).some((t: any) => t.code === "record-pdf"));

const noSignedCopy = { ...FIXTURES.Prescription, prescription: { ...FIXTURES.Prescription.prescription, signedCopy: null } };
const imaging = { ...FIXTURES.DiagnosticReport, kind: "imaging" as const, entered: { ...FIXTURES.DiagnosticReport.entered!, results: [], specimen: null } };
const fileOnly = { ...FIXTURES.DiagnosticReport, entered: null };

/** Each record that gets a PDF: the resource it is, the section it is in, and how that resource is typed. */
const PLACEMENT: Array<{ name: string; hiType: HiType; source?: unknown; as: "DocumentReference" | "Binary"; section: { title?: string; code?: string; within?: string }; type?: string }> = [
    { name: "OPConsultation", hiType: "OPConsultation", as: "DocumentReference", section: { code: "371530004" }, type: "371530004" },
    { name: "Prescription without the clinic's PDF", hiType: "Prescription", source: noSignedCopy, as: "Binary", section: { code: "440545006" } },
    { name: "DiagnosticReport (lab)", hiType: "DiagnosticReport", as: "DocumentReference", section: { code: "721981007" }, type: "4241000179101" },
    { name: "DiagnosticReport (imaging)", hiType: "DiagnosticReport", source: imaging, as: "DocumentReference", section: { code: "721981007" }, type: "721981007" },
    { name: "DischargeSummary", hiType: "DischargeSummary", as: "DocumentReference", section: { code: "373942005" }, type: "373942005" },
    { name: "ImmunizationRecord", hiType: "ImmunizationRecord", as: "DocumentReference", section: { code: "41000179103" }, type: "41000179103" },
    { name: "WellnessRecord", hiType: "WellnessRecord", as: "DocumentReference", section: { title: "Document Reference" }, type: "419891008" },
    // InvoiceRecord's section is closed to all but the Invoice: the PDF is in a sub-section of it
    { name: "Invoice", hiType: "Invoice", as: "DocumentReference", section: { title: "Document Reference", within: "Invoice" }, type: "419891008" },
];

/** A PDF's text, read back from its (deflated) content streams: PDFKit writes each run as hex in a TJ array. */
const pdfText = (pdf: Buffer): string => {
    const raw = pdf.toString("latin1");
    const out: string[] = [];
    for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
        let content: string;
        try {
            content = inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1");
        } catch {
            continue;
        }
        for (const tj of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
            out.push([...tj[1]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1]!, "hex").toString("latin1")).join(""));
        }
    }
    return out.join("\n");
};

for (const p of PLACEMENT) {
    test(`${p.name}: carries a PDF of itself as a ${p.as} in the section NRCES carries documents in`, () => {
        const bundle = build(p.hiType, p.source);
        const own = tagged(bundle);
        assert.equal(own.length, 1, "exactly one PDF of the record");
        const pdf = own[0];
        assert.equal(pdf.resourceType, p.as);
        assert.deepEqual(pdf.meta.profile, [NRCES + p.as]);

        // In the section, by a reference that resolves and names its type
        const holding: Array<{ s: any; parent: any }> = [];
        const walk = (sections: any[] | undefined, parent: any) => {
            for (const s of sections ?? []) {
                if ((s.entry ?? []).some((e: any) => e.reference === `urn:uuid:${pdf.id}`)) holding.push({ s, parent });
                walk(s.section, s);
            }
        };
        walk(composition(bundle).section, null);
        assert.equal(holding.length, 1, "listed in one section");
        const { s, parent } = holding[0]!;
        if (p.section.code) assert.equal(s.code.coding[0].code, p.section.code);
        if (p.section.title) assert.equal(s.title, p.section.title);
        assert.equal(parent?.title ?? null, p.section.within ?? null, p.section.within ? `inside the ${p.section.within} section` : "a top-level section");
        const entry = s.entry.find((e: any) => e.reference === `urn:uuid:${pdf.id}`);
        assert.equal(entry.type, p.as);
        assert.equal(byUrl(bundle, entry.reference), pdf);

        // A non-empty application/pdf, base64 of the file itself
        const attachment = p.as === "Binary" ? { contentType: pdf.contentType, data: pdf.data } : pdf.content[0].attachment;
        assert.equal(attachment.contentType, "application/pdf");
        assert.match(attachment.data, /^[A-Za-z0-9+/]+={0,2}$/, "standard base64");
        const bytes = Buffer.from(attachment.data, "base64");
        assert.equal(bytes.toString("base64"), attachment.data, "round-trips");
        assert.ok(bytes.length > 1000, "non-empty");
        assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
        assert.match(bytes.subarray(-8).toString("latin1"), /%%EOF\s*$/);

        if (p.as === "DocumentReference") {
            assert.equal(pdf.status, "current");
            assert.equal(pdf.docStatus, "final");
            assert.equal(pdf.subject.reference, composition(bundle).subject.reference);
            assert.equal(pdf.type.coding[0].system, "http://snomed.info/sct");
            assert.equal(pdf.type.coding[0].code, p.type);
            assert.equal(attachment.language, "en-IN");
            assert.equal(attachment.title, `${composition(bundle).title} (PDF)`);
            assert.equal(attachment.creation, composition(bundle).date);
            assert.equal(attachment.size, bytes.length, "size is the file's");
            assert.equal(attachment.hash, createHash("sha1").update(bytes).digest("base64"), "hash is the file's SHA-1");
        }
        assert.deepEqual(recordPdfOf(bundle)?.data, bytes, "the PDF the desk previews is the one in the bundle");
        assert.equal(recordPdfOf(bundle)?.source, "generated");
    });
}

test("the PDF says what the bundle says: its letterhead, the patient, the doctor, the ABHA card and every section", () => {
    for (const p of PLACEMENT) {
        const bundle = build(p.hiType, p.source);
        const text = pdfText(recordPdfOf(bundle)!.data);
        // Read back from the bundle without its own PDF: the same lines, as the record view gives them
        const view = recordView({ hiType: p.hiType, bundle: { ...bundle, entry: bundle.entry.filter((e) => !tagged(bundle).includes(e.resource)) } });
        assert.ok(text.includes(printable(view.title)), `${p.name}: the title`);
        // The letterhead, as the clinic's prescription PDF heads its page
        assert.ok(text.includes("Ocimum Dental Clinic"), `${p.name}: the facility`);
        assert.ok(text.includes("12 Test Road, Hyderabad, Telangana - 500001"), `${p.name}: the facility's address`);
        assert.ok(text.includes("Web: ocimum.example.test"), `${p.name}: the facility's website`);
        assert.ok(text.includes("ABDM facility ID (HFR): IN3610001937"), `${p.name}: the HFR id`);
        assert.ok(text.includes("PATIENT INFORMATION") && text.includes("Asha <Test> & Rao"), `${p.name}: the patient's name, as text`);
        assert.ok(text.includes("Age: 36 Yrs") && text.includes("Gender: Female") && text.includes("DOB: 12 Apr 1990"), `${p.name}: age, gender and birth date`);
        assert.ok(text.includes("CONSULTING DOCTOR") && text.includes("Dr. Kiran Test"), `${p.name}: the doctor`);
        assert.ok(text.includes("Qual: BDS") && text.includes("Reg No: TSMC-12345"), `${p.name}: the doctor's qualification and registration`);
        // The ABHA card: the fixture's made-up ABHA number and address
        assert.ok(text.includes("AYUSHMAN BHARAT HEALTH ACCOUNT"), `${p.name}: the ABHA card`);
        assert.ok(text.includes("91-0000-0000-0000"), `${p.name}: the ABHA number`);
        assert.ok(text.includes("asha.test@sbx"), `${p.name}: the ABHA address`);
        assert.ok(text.indexOf("ABHA number") < text.indexOf("ABHA address"), `${p.name}: the number, then the address`);
        assert.ok(text.includes("RECORDED BY"), `${p.name}: who recorded it`);
        for (const s of view.sections) {
            assert.ok(text.includes(s.title.toUpperCase()), `${p.name}: section ${s.title}`);
            // Each line's subject (before its value), whether it is drawn as a list line, a table row or a box's title
            for (const item of s.items) {
                // ("Total Rs. 1,652": the label and the amount are cells of their own)
                const words = printable(item).split(/: | — | · /)[0]!.split(" ");
                const amountAt = words.findIndex((w) => /^(\d|Rs\.)/.test(w));
                const subject = (amountAt > 0 ? words.slice(0, amountAt) : words).slice(0, 3).join(" ");
                assert.ok(text.toLowerCase().includes(subject.toLowerCase()), `${p.name}: ${item}`);
            }
        }
    }
});

test("medicines, results, vaccines and bill lines are tables, with the values in their own columns", () => {
    const op = pdfText(recordPdfOf(build("OPConsultation"))!.data);
    for (const cell of ["MEDICINE & ROUTE", "DOSAGE & SCHEDULE", "Paracetamol 650 mg tablet", "Route: Oral", "650 mg, Twice daily, for 3 days", "Dental caries", "Blood pressure", "120/80 mmHg"]) {
        assert.ok(op.includes(cell), `consultation: ${cell}`);
    }
    // The prescription PDF's Rx tile heads the medicines; a note reads as its advice box
    assert.ok(op.includes("Rx") && op.includes("CLINICAL NOTE") && op.includes("Advised warm saline rinses."));
    const lab = pdfText(recordPdfOf(build("DiagnosticReport"))!.data);
    for (const cell of ["TEST / PARAMETER", "REFERENCE / FLAG", "Haemoglobin", "11.2 g/dL", "Low, 13 g/dL", "CONCLUSION", "Mild anaemia."]) assert.ok(lab.includes(cell), `lab report: ${cell}`);
    const vaccine = pdfText(recordPdfOf(build("ImmunizationRecord"))!.data);
    for (const cell of ["VACCINE", "GIVEN ON", "Tetanus toxoid vaccine", "20 Oct 2026"]) assert.ok(vaccine.includes(cell), `immunization: ${cell}`);
    const invoice = pdfText(recordPdfOf(build("Invoice"))!.data);
    // The rupee sign is spelt out for the PDF's fonts
    for (const cell of ["ITEM", "AMOUNT", "Consultation fee", "Rs. 500", "Items total", "Total", "Status: Paid"]) assert.ok(invoice.includes(cell), `invoice: ${cell}`);
});

test("the letterhead carries the clinic's logo; one PDFKit can't draw at once leaves it out rather than cutting the file short", () => {
    const stored = readFileSync("public/images/hospital_logo.png");
    const logo = drawableLogo(stored)!;
    const withLogo = (l: Buffer | null) => recordPdfOf(build("Invoice", { ...FIXTURES.Invoice, organization: { ...FIXTURES.Invoice.organization, logo: l } }))!.data;
    const drawn = withLogo(logo);
    assert.match(drawn.toString("latin1"), /\/Subtype \/Image/, "the logo is in the PDF");
    assert.deepEqual(withLogo(logo), drawn, "still the same bytes for the same record");
    assert.doesNotMatch(recordPdfOf(build("Invoice"))!.data.toString("latin1"), /\/Subtype \/Image/, "no logo, no image");
    // The logo as stored (a PNG with transparency), not made opaque: PDFKit would only finish it later
    const raw = withLogo(stored);
    assert.match(raw.subarray(-16).toString("latin1"), /%%EOF\s*$/, "a whole file");
    assert.deepEqual(raw, recordPdfOf(build("Invoice"))!.data, "the record without the logo");
    // The logo is the letterhead's, not the record's: the bundle does not carry it
    const bundle = JSON.stringify(build("Invoice", { ...FIXTURES.Invoice, organization: { ...FIXTURES.Invoice.organization, logo } }));
    assert.ok(!bundle.includes(logo.toString("base64").slice(0, 40)));
});

test("a long record breaks over pages: each page numbered, a table's header again on the next page", () => {
    const medications = Array.from({ length: 40 }, (_, i) => ({ id: `m-${i}`, name: `Test medicine ${i + 1} 500 mg tablet`, dosage: "500 mg", frequency: "Twice daily", duration: "5 days", route: "Oral" }));
    const text = pdfText(recordPdfOf(build("OPConsultation", { ...FIXTURES.OPConsultation, medications }))!.data);
    const pages = Number(text.match(/Page 1 of (\d+)/)?.[1]);
    assert.ok(pages >= 2, "more than a page");
    for (let i = 1; i <= pages; i++) assert.ok(text.includes(`Page ${i} of ${pages}`), `page ${i} numbered`);
    assert.ok(text.split("MEDICINE & ROUTE").length - 1 >= 2, "the medicines' header on each page they run over");
    assert.ok(text.includes("Test medicine 40 500 mg tablet") && text.includes("(continued)"));
});

test("a record nobody signed names the clinic's staff, not a doctor", () => {
    const staff = { id: "hospital-12", name: "Ocimum Dental Clinic staff" };
    const text = pdfText(recordPdfOf(build("WellnessRecord", { ...FIXTURES.WellnessRecord, practitioner: staff }))!.data);
    assert.ok(text.includes("Ocimum Dental Clinic staff"));
    assert.ok(!text.includes("Dr. Ocimum"), "no Dr. before the staff");
    assert.ok(!text.includes("CONSULTING DOCTOR"));
});

test("the clinic's own prescription PDF shows the ABHA card too", async () => {
    const input = {
        hospital: { name: "Ocimum Dental Clinic" },
        doctor: { name: "Kiran Test" },
        patient: { name: "Asha Test", abhaNumber: "91000000000000", abhaAddress: "asha.test@sbx" },
        prescription: { medications: [{ name: "Paracetamol 650 mg tablet" }] },
    };
    const text = pdfText(await prescriptionPdfService.generatePrescriptionPdf(input));
    assert.ok(text.includes("AYUSHMAN BHARAT HEALTH ACCOUNT") && text.includes("91-0000-0000-0000") && text.includes("asha.test@sbx"));
    const without = pdfText(await prescriptionPdfService.generatePrescriptionPdf({ ...input, patient: { name: "Asha Test" } }));
    assert.ok(!without.includes("AYUSHMAN BHARAT HEALTH ACCOUNT"), "no card for a patient without an ABHA");
});

test("the same record builds the same PDF, byte for byte, so what staff preview is what is sent", () => {
    for (const p of PLACEMENT) {
        assert.deepEqual(recordPdfOf(build(p.hiType, p.source))!.data, recordPdfOf(build(p.hiType, p.source))!.data, p.name);
    }
    // Built at another moment, the record (and its PDF) is the same
    const later = (BUILDERS.OPConsultation as (s: unknown, now: Date) => FhirBundle)(FIXTURES.OPConsultation, new Date("2026-11-11T09:00:00+05:30"));
    assert.deepEqual(recordPdfOf(later)!.data, recordPdfOf(build("OPConsultation"))!.data);
});

test("a prescription with the clinic's own PDF carries that, and no second one", () => {
    const bundle = build("Prescription");
    assert.equal(tagged(bundle).length, 0);
    assert.deepEqual(composition(bundle).section[0].entry.map((e: any) => e.type), ["MedicationRequest", "MedicationRequest", "Binary"]);
    const pdf = recordPdfOf(bundle)!;
    assert.equal(pdf.source, "signed-copy");
    assert.equal(pdf.data.toString(), "%PDF-1.4\n% fixture\n");
});

test("HealthDocumentRecord is unchanged: its uploads only, and no PDF of its own", () => {
    const bundle = build("HealthDocumentRecord");
    assert.deepEqual(bundle.entry.map((e) => e.resource.resourceType), ["Composition", "Patient", "Practitioner", "Organization", "Encounter", "DocumentReference"]);
    assert.equal(tagged(bundle).length, 0);
    assert.deepEqual(composition(bundle).section.map((s: any) => [s.title, s.entry.length]), [["Health Document", 1]]);
    assert.equal((bundle.entry[5]!.resource as any).content[0].attachment.title, "Old discharge card");
    assert.equal(recordPdfOf(bundle), null);
});

test("a report that is only its uploaded file is sent as that file, with no PDF built", () => {
    const bundle = build("DiagnosticReport", fileOnly);
    assert.equal(tagged(bundle).length, 0);
    assert.deepEqual(composition(bundle).section[0].entry.map((e: any) => e.type), ["DocumentReference"]);
    assert.equal(recordPdfOf(bundle), null);
});

test("a DiagnosticReport's section keeps to the two entries the profile allows", () => {
    for (const source of [FIXTURES.DiagnosticReport, imaging]) {
        const s = composition(build("DiagnosticReport", source)).section;
        assert.equal(s.length, 1);
        assert.deepEqual(s[0].entry.map((e: any) => e.type), ["DiagnosticReport", "DocumentReference"]);
    }
});

test("an Invoice's one section holds only the Invoice, as InvoiceRecord's closed slicing requires; the PDF is in a sub-section", () => {
    const s = composition(build("Invoice")).section;
    assert.equal(s.length, 1, "InvoiceRecord allows one section");
    assert.deepEqual(s[0].entry.map((e: any) => e.type), ["Invoice"]);
    assert.deepEqual(s[0].section.map((sub: any) => [sub.title, sub.entry.map((e: any) => e.type)]), [["Document Reference", ["DocumentReference"]]]);
});

test("every HI type but HealthDocumentRecord carries a PDF; the bundle stays one NRCES document whose references resolve", () => {
    for (const hiType of HI_TYPES) {
        const bundle = build(hiType);
        const ids = new Set(bundle.entry.map((e) => e.fullUrl));
        assert.equal(ids.size, bundle.entry.length, `${hiType}: each resource once`);
        const pdf = recordPdfOf(bundle);
        if (hiType === "HealthDocumentRecord") assert.equal(pdf, null);
        else assert.ok(pdf && pdf.data.length > 0, `${hiType} carries a PDF`);
    }
});

test("text the PDF's fonts can't print is replaced visibly, never dropped", () => {
    assert.equal(printable("₹1,652 · 10–20 — ok"), "Rs. 1,652 · 10–20 — ok");
    assert.equal(printable("आशा Rao"), "??? Rao");
    assert.equal(printable("10.⁠0 mg"), "10.0 mg");
    assert.match(renderRecordPdf("OPConsultation", build("OPConsultation")).subarray(0, 5).toString("latin1"), /^%PDF-/);
});

/**
 * Tier 1 of the NRCES check, by the ABDM Docs validator (docs.abdm.gov.in/mcp), which `npm run
 * fhir:validate` also runs. It needs the network, so it runs only with ABDM_FHIR_VALIDATE=1.
 */
test("the ABDM Docs validator finds nothing in any bundle", { skip: process.env.ABDM_FHIR_VALIDATE === "1" ? false : "set ABDM_FHIR_VALIDATE=1 to call the ABDM Docs validator" }, async () => {
    const DOCS_MCP = "https://docs.abdm.gov.in/mcp";
    let session: string | null = null;
    let id = 0;
    const rpc = async (method: string, params: unknown, notify = false): Promise<any> => {
        const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
        if (session) headers["mcp-session-id"] = session;
        const res = await fetch(DOCS_MCP, { method: "POST", headers, body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++id, method, params }) });
        session = res.headers.get("mcp-session-id") ?? session;
        if (notify) return null;
        const text = await res.text();
        const json = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).pop() ?? "{}");
        if (json.error) throw new Error(JSON.stringify(json.error));
        return json.result;
    };
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "clinicx-record-pdf-test", version: "1" } });
    await rpc("notifications/initialized", {}, true);
    const cases = [...HI_TYPES.map((hiType) => ({ name: hiType, hiType, source: FIXTURES[hiType] as unknown })), ...PLACEMENT, { name: "DiagnosticReport (file only)", hiType: "DiagnosticReport" as HiType, source: fileOnly }];
    for (const c of cases) {
        const result = await rpc("tools/call", { name: "validate", arguments: { kind: "fhir", bundle_json: JSON.stringify(build(c.hiType, c.source ?? FIXTURES[c.hiType])), record_type: c.hiType } });
        const report = JSON.parse(result.content.map((x: any) => x.text ?? "").join(""));
        assert.ok("findings" in report && (report.findings === null || report.findings.length === 0), `${c.name}: ${JSON.stringify(report.findings)}`);
    }
});
