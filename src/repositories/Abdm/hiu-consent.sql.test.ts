import { test } from "node:test";
import assert from "node:assert/strict";
import {
    ARTEFACT_RECORD_COUNT,
    CLAIM_STATUS_CHECK,
    END_ARTEFACT,
    findPatientIn,
    LIST_WAITING_REQUESTS,
    PATIENT_ROLE_ID,
    SELECT_REQUEST,
    statusCheckParams,
    toRequestRow,
    waitingRequestsParams,
} from "./hiu-consent.sql.js";

test("the waiting-request read binds raised-before, raised-after, checked-before and the limit to the clauses that use them", () => {
    const [raisedAfter, raisedBefore, checkedBefore] = [new Date("2026-11-03T00:00:00Z"), new Date("2026-11-10T09:00:00Z"), new Date("2026-11-10T09:45:00Z")];
    assert.deepEqual(waitingRequestsParams({ raisedAfter, raisedBefore, checkedBefore, limit: 100 }, (date) => date), [raisedBefore, raisedAfter, checkedBefore, 100]);
    assert.ok(LIST_WAITING_REQUESTS.startsWith(SELECT_REQUEST));
    assert.match(LIST_WAITING_REQUESTS, /r\.Status = 'REQUESTED' AND r\.ConsentRequestId IS NOT NULL AND r\.HiuId IS NOT NULL/);
    assert.match(LIST_WAITING_REQUESTS, /r\.CreatedAt <= @0 AND r\.CreatedAt >= @1 AND COALESCE\(r\.UpdatedAt, r\.CreatedAt\) <= @2/);
    assert.match(LIST_WAITING_REQUESTS, /ORDER BY COALESCE\(r\.UpdatedAt, r\.CreatedAt\), r\.Id\s+OFFSET 0 ROWS FETCH NEXT @3 ROWS ONLY$/);
    assert.ok(!/GETDATE/i.test(LIST_WAITING_REQUESTS), "times come from JS, never the database clock");
});

test("claiming a status check is one guarded UPDATE: only a REQUESTED request unchanged since checked-before", () => {
    const [at, checkedBefore] = [new Date("2026-11-10T10:00:00Z"), new Date("2026-11-10T09:45:00Z")];
    assert.deepEqual(statusCheckParams({ id: 7, requestId: "r-1", at, checkedBefore }, (date) => date), [7, "r-1", at, checkedBefore]);
    assert.match(CLAIM_STATUS_CHECK, /^UPDATE AbdmHiuConsentRequests\s+SET StatusRequestId = @1, UpdatedAt = @2\s+OUTPUT inserted\.Id/);
    assert.match(CLAIM_STATUS_CHECK, /WHERE Id = @0 AND Status = 'REQUESTED' AND COALESCE\(UpdatedAt, CreatedAt\) <= @3$/);
    assert.ok(!/GETDATE/i.test(CLAIM_STATUS_CHECK));
});

test("ending an artefact is one short transaction, artefact row first, that deletes no records", () => {
    assert.match(END_ARTEFACT, /^SET XACT_ABORT ON;\s+BEGIN TRANSACTION;/);
    // Only a GRANTED artefact is ended, and the batch says whether this call ended it.
    assert.match(END_ARTEFACT, /DECLARE @changed INT = @@ROWCOUNT;/);
    assert.match(END_ARTEFACT, /COMMIT TRANSACTION;\s+SELECT @changed AS Changed;$/);
    const artefact = END_ARTEFACT.indexOf("UPDATE AbdmHiuConsentArtefacts SET Status = @1, StatusAt = @2, CareContexts = NULL, UpdatedAt = @2 WHERE Id = @0 AND Status = 'GRANTED';");
    const keys = END_ARTEFACT.indexOf("UPDATE AbdmHiuDataRequests SET PrivateKey = NULL WHERE ArtefactFk = @0;");
    assert.ok(artefact > 0 && artefact < keys, "the artefact row (the one a page store locks) first");
    // Deleting megabytes in here is what ran past the timeout and rolled the revocation back.
    assert.ok(!/DELETE|AbdmHiuRecords/i.test(END_ARTEFACT));
});

type Sent = { sql: string; parameters: unknown[] };

const queryWith = (answer: any[]) => {
    const sent: Sent[] = [];
    const query = async (sql: string, parameters: unknown[] = []) => {
        sent.push({ sql, parameters });
        return answer;
    };
    return { query, sent };
};

const USER = "11111111-1111-1111-1111-111111111111";

test("a patient is found in the patient list's scope: registered at, or holding the Patient role at, this hospital", async () => {
    const { query, sent } = queryWith([{ Id: USER, FirstName: "Asha", LastName: "Kumari", AbhaAddress: "asha@sbx", AbhaNumber: "91-1111-2222-3333" }]);
    assert.deepEqual(await findPatientIn(query, USER, 19), { userId: USER, name: "Asha Kumari", abhaAddress: "asha@sbx", abhaNumber: "91-1111-2222-3333" });
    const { sql, parameters } = sent[0];
    assert.deepEqual(parameters, [USER, 19, PATIENT_ROLE_ID]);
    // As PatientRegistrationRepository.getPatients: a live registration, an active Patient role in its organization ...
    assert.match(sql, /INNER JOIN PatientRegistrations pr ON pr\.UserId = u\.Id AND pr\.IsDeleted = 0/);
    assert.match(sql, /INNER JOIN UserRoles ur ON ur\.UserId = u\.Id AND ur\.IsDeleted = 0 AND ur\.Status = 1\s+AND ur\.RoleId = @2 AND ur\.OrganizationId = pr\.OrganizationId/);
    // ... and the registration or the role at this hospital (a role-only patient of this hospital is no longer refused).
    assert.match(sql, /WHERE u\.Id = @0 AND u\.IsDeleted = 0 AND \(pr\.HospitalId = @1 OR ur\.HospitalId = @1\)/);
    assert.equal(PATIENT_ROLE_ID, "4FC67429-28AE-4106-93EF-436228282ED0");
});

test("no matching patient (not a patient, another hospital, deleted) is null", async () => {
    const { query } = queryWith([]);
    assert.equal(await findPatientIn(query, USER, 19), null);
});

test("a request row carries its patient's current ABHA number from Users, for the summary to mask", () => {
    assert.match(SELECT_REQUEST, /u\.AbhaNumber AS PatientAbhaNumber/);
    assert.match(SELECT_REQUEST, /LEFT JOIN Users u ON u\.Id = r\.PatientUserId/);
    const row = toRequestRow({ Id: 3, InitRequestId: "init-3", HospitalId: 19, StaffUserId: "s", PatientUserId: USER, PatientAbhaNumber: "91-1111-2222-3333", HiTypes: "[\"Prescription\"]", Status: "FAILED" });
    assert.equal(row.patientAbhaNumber, "91-1111-2222-3333");
    assert.equal(row.initRequestId, "init-3");
    assert.deepEqual(row.hiTypes, ["Prescription"]);
    assert.equal(toRequestRow({ Id: 4, PatientUserId: USER }).patientAbhaNumber, null);
});

test("an artefact's record count is the records view's: one transfer's entries, never a repeat's or a marker row", () => {
    // The records view (hiu-data.repository listRecords) shows one transfer: the count on the card must match it.
    assert.match(ARTEFACT_RECORD_COUNT, /WHERE rec\.ArtefactFk = a\.Id AND rec\.EntryIndex >= 0/);
    assert.match(ARTEFACT_RECORD_COUNT, /rec\.DataRequestFk = \(SELECT TOP 1 dr\.Id FROM AbdmHiuDataRequests dr\s+WHERE dr\.ArtefactFk = a\.Id/);
    assert.match(ARTEFACT_RECORD_COUNT, /EXISTS \(SELECT 1 FROM AbdmHiuRecords x WHERE x\.DataRequestFk = dr\.Id AND x\.EntryIndex >= 0\)/);
    assert.match(ARTEFACT_RECORD_COUNT, /ORDER BY CASE WHEN dr\.SessionStatus = 'RECEIVED' THEN 0 ELSE 1 END, dr\.Id DESC\)\)$/);
});
