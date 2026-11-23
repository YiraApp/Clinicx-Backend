import { test } from "node:test";
import assert from "node:assert/strict";
import {
    HospitalPatientRemovalService,
    PatientRemovalError,
    maskPhone,
    planRemoval,
    type HospitalPatientStore,
    type PatientHospitalLinks,
    type RemovalPlan,
    type RemovedLink,
} from "./hospital-patient-removal.service.js";
import { USER_ROLES_SOFT_DELETE_KEY } from "../Common/migration.service.js";
import { hospitalIdOf } from "../../controllers/Organizations/hospital-patient-removal.controller.js";

const DESK = "22222222-2222-2222-2222-222222222222";
const OTHER_DESK = "44444444-4444-4444-4444-444444444444";
const PATIENT = "33333333-3333-3333-3333-333333333333";
const AT = new Date("2026-11-23T07:00:00.000Z");

/** A stub database: Front Desk at hospital 19 (org 1); hospital 20 is org 18, where OTHER_DESK works. */
const fakeStore = (overrides: Partial<HospitalPatientStore> & { links?: PatientHospitalLinks | null; removal?: RemovedLink | null; abha?: { abhaNumber: string | null; abhaAddresses: string[] } | null } = {}) => {
    const calls = { applied: [] as { plan: RemovalPlan; actor: string; at: Date }[], restored: [] as { link: RemovedLink; actor: string }[], unlinked: [] as string[], listed: [] as unknown[] };
    const store: HospitalPatientStore = {
        async isFrontDeskAt(userId, hospitalId) {
            return (userId === DESK && hospitalId === 19) || (userId === OTHER_DESK && hospitalId === 20);
        },
        async hospitalOrganization(hospitalId) {
            return hospitalId === 19 ? 1 : hospitalId === 20 ? 18 : undefined;
        },
        async patientLinks() {
            return overrides.links === undefined
                ? { organizationId: 1, roleIdsHere: [501], otherHospitalIds: [], registrations: [{ id: 71, hospitalId: 19 }] }
                : overrides.links;
        },
        async applyRemoval(plan, actor, at) { calls.applied.push({ plan, actor, at }); },
        async latestRemoval() {
            return overrides.removal === undefined
                ? { userRoleId: 501, userId: PATIENT, roleId: "P", organizationId: 1, hospitalId: 19, removedAt: AT, removedBy: DESK }
                : overrides.removal;
        },
        async restore(link, actor) { calls.restored.push({ link, actor }); },
        async listRemoved(query) {
            calls.listed.push(query);
            return {
                total: 1,
                rows: [{
                    userId: PATIENT, firstName: "Asha", lastName: "K", gender: "Female", dateOfBirth: "1990-01-01",
                    phone: "+91 98765 43210", tokenNumber: "OCM123-2026-0098", removedAt: AT, removedById: DESK, removedByName: "Desk User",
                }],
            };
        },
        async abhaOf() {
            return overrides.abha === undefined ? { abhaNumber: "91-1234-5678-9012", abhaAddresses: ["asha@sbx"] } : overrides.abha;
        },
        async unlinkAbha(userId) { calls.unlinked.push(userId); },
        ...overrides,
    };
    return { store, calls, service: new HospitalPatientRemovalService(store, () => AT) };
};

const refused = async (work: Promise<unknown>, status: number, pattern?: RegExp) => {
    await assert.rejects(work, (error: unknown) => {
        assert.ok(error instanceof PatientRemovalError, `a PatientRemovalError, got ${error}`);
        assert.equal(error.status, status);
        if (pattern) assert.match(error.message, pattern);
        return true;
    });
};

test("Front Desk removes their hospital's patient: the Patient row and the organization's registration are marked, with who and when", async () => {
    const { service, calls } = fakeStore();
    const result = await service.remove(DESK, PATIENT, 19);
    assert.deepEqual(calls.applied, [{ plan: { roleIds: [501], deleteRegistrationIds: [71], moveRegistrations: [] }, actor: DESK, at: AT }]);
    assert.deepEqual(result, { userId: PATIENT, hospitalId: 19, removedAt: AT, removedBy: DESK });
});

test("only Front Desk at that hospital may remove: another hospital's desk, a missing sign-in and a bad hospital are refused", async () => {
    const { service, calls } = fakeStore();
    await refused(service.remove(OTHER_DESK, PATIENT, 19), 403, /Front Desk/);
    await refused(service.remove(PATIENT, PATIENT, 19), 403);
    await refused(service.remove(undefined, PATIENT, 19), 403);
    await refused(service.remove(DESK, PATIENT, Number.NaN), 400);
    await refused(service.remove(DESK, "not-a-guid", 19), 400);
    assert.equal(calls.applied.length, 0, "nothing is marked");
});

test("a patient with no live link at the hospital, or no account, is not found; Front Desk cannot remove themself", async () => {
    await refused(fakeStore({ links: { organizationId: 1, roleIdsHere: [], otherHospitalIds: [20], registrations: [] } }).service.remove(DESK, PATIENT, 19), 404, /not registered/);
    await refused(fakeStore({ links: null }).service.remove(DESK, PATIENT, 19), 404);
    await refused(fakeStore().service.remove(DESK, DESK.toLowerCase(), 19), 400, /own account/);
});

test("planRemoval keeps the registration of a patient who stays at another hospital of the organization, moved off this one", () => {
    const plan = planRemoval(19, {
        organizationId: 1,
        roleIdsHere: [501, 502],
        otherHospitalIds: [21, 19],
        registrations: [{ id: 71, hospitalId: 19 }, { id: 72, hospitalId: 21 }, { id: 73, hospitalId: null }],
    });
    assert.deepEqual(plan, { roleIds: [501, 502], deleteRegistrationIds: [], moveRegistrations: [{ id: 71, hospitalId: 21 }] });
});

test("planRemoval marks every registration in the organization when the patient is at no other hospital of it", () => {
    const plan = planRemoval(19, { organizationId: 1, roleIdsHere: [501], otherHospitalIds: [], registrations: [{ id: 71, hospitalId: 19 }, { id: 72, hospitalId: null }] });
    assert.deepEqual(plan, { roleIds: [501], deleteRegistrationIds: [71, 72], moveRegistrations: [] });
});

test("restore brings back the latest removal, and refuses a patient already back at the hospital or never removed", async () => {
    const ok = fakeStore({ links: { organizationId: 1, roleIdsHere: [], otherHospitalIds: [], registrations: [] } });
    const result = await ok.service.restore(DESK, PATIENT, 19);
    assert.equal(ok.calls.restored.length, 1);
    assert.equal(ok.calls.restored[0]!.link.userRoleId, 501);
    assert.equal(ok.calls.restored[0]!.actor, DESK);
    assert.deepEqual(result, { userId: PATIENT, hospitalId: 19, restoredAt: AT, restoredBy: DESK });

    await refused(fakeStore().service.restore(DESK, PATIENT, 19), 409, /already registered/);
    await refused(fakeStore({ links: { organizationId: 1, roleIdsHere: [], otherHospitalIds: [], registrations: [] }, removal: null }).service.restore(DESK, PATIENT, 19), 404);
    await refused(fakeStore({ links: { organizationId: 1, roleIdsHere: [], otherHospitalIds: [], registrations: [] } }).service.restore(OTHER_DESK, PATIENT, 19), 403);
});

test("the Deleted patients list masks phone numbers, names who removed each patient, and caps the page size", async () => {
    const { service, calls } = fakeStore();
    const list = await service.listRemoved(DESK, 19, 0, 500, "  asha  ");
    assert.deepEqual(calls.listed, [{ hospitalId: 19, page: 1, pageSize: 100, search: "asha" }]);
    assert.equal(list.patients[0]!.phone, "******3210");
    assert.equal(list.patients[0]!.name, "Asha K");
    assert.deepEqual(list.patients[0]!.removedBy, { id: DESK, name: "Desk User" });
    assert.equal(list.totalPages, 1);
    await refused(service.listRemoved(OTHER_DESK, 19), 403);
});

test("unlinking ABHA needs a patient of the hospital who has an ABHA, and returns only its last 4 digits", async () => {
    const ok = fakeStore();
    assert.deepEqual(await ok.service.unlinkAbha(DESK, PATIENT, 19), { userId: PATIENT, abhaNumberLast4: "9012" });
    assert.deepEqual(ok.calls.unlinked, [PATIENT]);

    const addressOnly = fakeStore({ abha: { abhaNumber: null, abhaAddresses: ["asha@sbx"] } });
    assert.deepEqual(await addressOnly.service.unlinkAbha(DESK, PATIENT, 19), { userId: PATIENT, abhaNumberLast4: null });

    await refused(fakeStore({ abha: { abhaNumber: null, abhaAddresses: [] } }).service.unlinkAbha(DESK, PATIENT, 19), 400, /No ABHA/);
    await refused(fakeStore({ links: { organizationId: 1, roleIdsHere: [], otherHospitalIds: [], registrations: [] } }).service.unlinkAbha(DESK, PATIENT, 19), 404);
    await refused(fakeStore().service.unlinkAbha(OTHER_DESK, PATIENT, 19), 403);
});

test("maskPhone keeps the last 4 digits only", () => {
    assert.equal(maskPhone("9876543210"), "******3210");
    assert.equal(maskPhone("12"), null);
    assert.equal(maskPhone(null), null);
});

test("the controller takes the hospital from the body, else the query, else the X-Hospital-Id header", () => {
    assert.equal(hospitalIdOf({ body: { hospitalId: 19 }, query: { hospitalId: "20" }, headers: {} } as any), 19);
    assert.equal(hospitalIdOf({ body: undefined, query: { hospitalId: "20" }, headers: {} } as any), 20);
    assert.equal(hospitalIdOf({ body: {}, query: {}, headers: { "x-hospital-id": "21" } } as any), 21);
    assert.ok(Number.isNaN(hospitalIdOf({ body: {}, query: {}, headers: {} } as any)));
});

test("the UserRoles key migration builds the live-rows unique index before it drops the old key", () => {
    const [create, drop] = USER_ROLES_SOFT_DELETE_KEY;
    assert.match(create, /CREATE UNIQUE NONCLUSTERED INDEX UX_UserRoles_Active ON dbo\.UserRoles \(UserId, RoleId, OrganizationId, HospitalId\) WHERE IsDeleted = 0/);
    assert.match(create, /NOT EXISTS/, "idempotent");
    assert.match(drop, /DROP CONSTRAINT UQ_UserRoles/);
    assert.match(drop, /EXISTS \(SELECT 1 FROM sys\.indexes WHERE name = 'UX_UserRoles_Active'/, "the old key goes only once the new index is there");
});
