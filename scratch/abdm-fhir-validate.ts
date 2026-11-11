/**
 * Validates one bundle of every ABDM HI type, built from the fixtures, against the NRCES profiles.
 *
 *   npm run fhir:validate              tier 1: the ABDM Docs validator (docs.abdm.gov.in/mcp)
 *   FHIR_VALIDATOR_JAR=path/to/validator_cli.jar npm run fhir:validate
 *                                      also tier 2: the HL7 validator against IG ndhm.in#6.5.0
 *
 * Exits 1 when any bundle has a finding (tier 1) or an error (tier 2).
 */
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HI_TYPES, type HiType } from "../src/services/Abdm/fhir/fhir-common.js";
import { BUILDERS } from "../src/services/Abdm/fhir/health-records.js";
import { FIXTURES } from "../src/services/Abdm/fhir/fhir-fixtures.js";

const DOCS_MCP = "https://docs.abdm.gov.in/mcp";

let session: string | null = null;
let nextId = 0;
const rpc = async (method: string, params: unknown, notify = false): Promise<any> => {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (session) headers["mcp-session-id"] = session;
    const res = await fetch(DOCS_MCP, {
        method: "POST",
        headers,
        body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++nextId, method, params }),
    });
    session = res.headers.get("mcp-session-id") ?? session;
    if (notify) return null;
    const text = await res.text();
    const json = text.trim().startsWith("{")
        ? JSON.parse(text)
        : JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).pop() ?? "{}");
    if (json.error) throw new Error(JSON.stringify(json.error));
    return json.result;
};

const main = async () => {
    const jar = process.env.FHIR_VALIDATOR_JAR;
    const dir = mkdtempSync(join(tmpdir(), "abdm-fhir-"));
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "clinicx-fhir-validate", version: "1" } });
    await rpc("notifications/initialized", {}, true);

    // Each HI type's fixture, and the variants whose PDF goes elsewhere or is not built
    const cases: Array<{ name: string; hiType: HiType; source: unknown }> = [
        ...HI_TYPES.map((hiType) => ({ name: hiType, hiType, source: FIXTURES[hiType] as unknown })),
        { name: "Prescription-generated-pdf", hiType: "Prescription", source: { ...FIXTURES.Prescription, prescription: { ...FIXTURES.Prescription.prescription, signedCopy: null } } },
        { name: "DiagnosticReport-imaging", hiType: "DiagnosticReport", source: { ...FIXTURES.DiagnosticReport, kind: "imaging", entered: { ...FIXTURES.DiagnosticReport.entered!, results: [], specimen: null } } },
        { name: "DiagnosticReport-file-only", hiType: "DiagnosticReport", source: { ...FIXTURES.DiagnosticReport, entered: null } },
    ];

    let failed = 0;
    for (const { name, hiType, source } of cases) {
        const bundle = (BUILDERS[hiType] as (s: unknown) => object)(source);
        const json = JSON.stringify(bundle);
        const file = join(dir, `${name}.json`);
        writeFileSync(file, json);

        const result = await rpc("tools/call", { name: "validate", arguments: { kind: "fhir", bundle_json: json, record_type: hiType } });
        const text = result.content.map((c: any) => c.text ?? "").join("");
        let report: any;
        try { report = JSON.parse(text); } catch { report = { raw: text }; }
        // A clean bundle answers "findings": null; an answer without the key is not a pass.
        const ok = "findings" in report && (report.findings === null || (Array.isArray(report.findings) && report.findings.length === 0));
        console.log(`${ok ? "PASS" : "FAIL"}  tier 1  ${name}${ok ? "" : `\n${JSON.stringify(report, null, 2)}`}`);
        if (!ok) failed++;

        if (jar) {
            try {
                const out = execFileSync("java", ["-jar", jar, file, "-version", "4.0.1", "-ig", "ndhm.in#6.5.0"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
                console.log(`PASS  tier 2  ${name}  ${out.split("\n").find((l) => /Success|errors/.test(l)) ?? ""}`);
            } catch (error: any) {
                failed++;
                const lines = String(error.stdout ?? "").split("\n").filter((l) => /^\s*(Error|Warning)/.test(l) || /errors/.test(l));
                console.log(`FAIL  tier 2  ${name}\n${lines.join("\n")}`);
            }
        }
    }
    console.log(`bundles written to ${dir}`);
    process.exit(failed ? 1 : 0);
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
