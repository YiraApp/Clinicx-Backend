// "Scan prescription" runs on the server with its own Gemini key; the app sends only the file.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prescriptionScanService as svc, scanMimeType } from "../src/services/Prescriptions/prescription-scan.service.js";

const realFetch = globalThis.fetch;
const pdf = Buffer.from("%PDF-1.4 sample");
afterEach(() => { globalThis.fetch = realFetch; process.env.GEMINI_API_KEY = "test-key"; });
process.env.GEMINI_API_KEY = "test-key";

test("recognises files by their bytes, not the declared type", () => {
    assert.equal(scanMimeType(pdf, "application/octet-stream"), "application/pdf");
    assert.equal(scanMimeType(Buffer.from([0xff, 0xd8, 0xff, 0x00]), ""), "image/jpeg");
    assert.equal(scanMimeType(Buffer.from("hello"), "text/plain", "a.txt"), null);
});

test("sends the key in a header and returns the parsed prescription", async () => {
    let sent: any = null;
    globalThis.fetch = (async (url: string, init: any) => {
        sent = { url, key: init.headers["x-goog-api-key"], body: JSON.parse(init.body) };
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"doctorName":"Dr A","medications":[{"name":"Tab X"}],"confidence":90}' }] } }] }), { status: 200 });
    }) as any;
    const r = await svc.scan({ buffer: pdf, mimetype: "application/pdf" });
    assert.equal(r.doctorName, "Dr A");
    assert.equal(r.medications.length, 1);
    assert.equal(sent.key, "test-key");
    assert.ok(!String(sent.url).includes("key="), "key must not be in the URL");
    assert.equal(sent.body.contents[0].parts[1].inlineData.mimeType, "application/pdf");
});

test("clear errors: no key, no file, wrong type, busy, unreadable reply", async () => {
    process.env.GEMINI_API_KEY = "";
    await assert.rejects(svc.scan({ buffer: pdf }), { code: "NOT_CONFIGURED" });
    process.env.GEMINI_API_KEY = "test-key";
    await assert.rejects(svc.scan(undefined), { code: "NO_FILE" });
    await assert.rejects(svc.scan({ buffer: Buffer.from("hello"), mimetype: "text/plain" }), { code: "UNSUPPORTED_TYPE" });
    globalThis.fetch = (async () => new Response("{}", { status: 429 })) as any;
    await assert.rejects(svc.scan({ buffer: pdf }), { code: "RATE_LIMITED" });
    globalThis.fetch = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }), { status: 200 })) as any;
    await assert.rejects(svc.scan({ buffer: pdf }), { code: "PARSE_ERROR" });
});
