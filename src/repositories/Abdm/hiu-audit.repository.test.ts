import { test } from "node:test";
import assert from "node:assert/strict";
import { HiuAuditRepository, toAuditRow } from "./hiu-audit.repository.js";
import { HIU_AUDIT_EVENTS, HIU_AUDIT_OUTCOMES, notifyAuditEvent } from "../../services/Abdm/hiu/hiu-audit.js";

const AT = new Date("2026-10-26T10:00:00.000Z");
const STAFF = "3956f98d-d835-4204-8d5b-72870e57ff76";

test("an event becomes a row cut to its columns", () => {
    const row = toAuditRow({
        hospitalId: 4,
        staffUserId: STAFF,
        event: HIU_AUDIT_EVENTS.RECORD_VIEWED,
        consentRequestId: "c".repeat(80),
        artefactId: "a-1",
        outcome: HIU_AUDIT_OUTCOMES.OK,
        detail: "d".repeat(900),
    }, AT);
    assert.equal(row.At, AT);
    assert.equal(row.HospitalId, 4);
    assert.equal(row.StaffUserId, STAFF);
    assert.equal(row.Event, "RECORD_VIEWED");
    assert.equal(row.ConsentRequestId!.length, 64);
    assert.equal(row.ArtefactId, "a-1");
    assert.equal(row.TransactionId, null);
    assert.equal(row.RequestId, null);
    assert.equal(row.Outcome, "OK");
    assert.equal(row.Detail!.length, 500);
});

test("a staff id that is not a GUID is dropped rather than failing the insert", () => {
    assert.equal(toAuditRow({ hospitalId: null, staffUserId: "system", event: "X", outcome: "OK" }, AT).StaffUserId, null);
    assert.equal(toAuditRow({ hospitalId: null, event: "X", outcome: "OK" }, AT).HospitalId, null);
});

test("record() writes through the injected insert", async () => {
    const rows: unknown[] = [];
    const audit = new HiuAuditRepository({ insert: async (row) => { rows.push(row); }, clock: () => AT });
    await audit.record({ hospitalId: 1, event: HIU_AUDIT_EVENTS.CONSENT_INIT, requestId: "r-1", outcome: HIU_AUDIT_OUTCOMES.OK });
    assert.equal(rows.length, 1);
    assert.equal((rows[0] as any).RequestId, "r-1");
});

test("record() never throws, and its one log line carries no detail", async () => {
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    try {
        const audit = new HiuAuditRepository({ insert: async () => { throw Object.assign(new Error("Violation of something with secret-detail"), { code: "EREQUEST" }); } });
        await audit.record({ hospitalId: 1, event: HIU_AUDIT_EVENTS.PAGE_RECEIVED, outcome: "OK", detail: "secret-detail", transactionId: "t-1" });
    } finally {
        console.error = realError;
    }
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /audit write failed for PAGE_RECEIVED: EREQUEST/);
    assert.ok(!logged[0]!.includes("secret-detail"));
});

test("every plan event name exists, and notify events follow the status", () => {
    for (const name of ["CONSENT_INIT", "ON_INIT", "ON_NOTIFY_SENT", "FETCH", "ON_FETCH", "HI_REQUEST", "ON_REQUEST", "PAGE_RECEIVED", "DECRYPT_FAIL", "DATA_NOTIFY_SENT", "RECORD_VIEWED", "RECORD_PURGED"]) {
        assert.equal((HIU_AUDIT_EVENTS as Record<string, string>)[name], name);
    }
    assert.equal(notifyAuditEvent("GRANTED"), HIU_AUDIT_EVENTS.NOTIFY_GRANTED);
    assert.equal(notifyAuditEvent("revoked"), HIU_AUDIT_EVENTS.NOTIFY_REVOKED);
});
