import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { PatientRegistrationService } from "./patient-registration.service.js";
import { patientRegistrationRepository } from "../../repositories/Organizations/patient-registration.repository.js";
import { userRepository } from "../../repositories/Account/user.repository.js";
import { defaultOrganizationRepository } from "../../repositories/Organizations/default-organization.repository.js";
import { hospitalSettingsService } from "./hospital-settings.service.js";

// No database and no WhatsApp: the repositories and the send are stood in for.
const USER = "11111111-1111-1111-1111-111111111111";
let existing: Record<string, unknown> | null;
let saved: Array<Record<string, unknown>>;
let sent: Array<{ userId: string; tokenNumber?: string }>;
let service: PatientRegistrationService;

/** The background WhatsApp send runs after registerPatient returns. */
const backgroundWork = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
    existing = null;
    saved = [];
    sent = [];
    mock.method(defaultOrganizationRepository, "getActiveDefault", async () => ({ OrganizationId: 1, HospitalId: 19 }));
    mock.method(patientRegistrationRepository, "findByUserId", async () => existing);
    mock.method(patientRegistrationRepository, "save", async (registration: Record<string, unknown>) => {
        saved.push({ ...registration });
        return registration;
    });
    mock.method(userRepository, "updateUser", async () => undefined);
    mock.method(userRepository, "findById", async (id: string) => ({ Id: id, TokenNumber: "HOSP11-TEST-A" }));
    // A new registration also checks the hospital's settings for the Yira notification email: stood
    // in for too, or the test would wait on a database that is not there and never finish.
    mock.method(hospitalSettingsService, "getSettings", async () => ({ SendInfoMailToYira: false }));
    service = new PatientRegistrationService();
    mock.method(service, "sendPatientRegistrationWhatsApp", async (user: { Id: string }, tokenNumber?: string) => {
        sent.push({ userId: user.Id, tokenNumber });
    });
    mock.method(service, "sendPatientRegistrationYiraNotification", async () => undefined);
});

afterEach(() => mock.restoreAll());

const save = () => service.registerPatient({ userId: USER, organizationId: 1, hospitalId: 19, tokenNumber: "HOSP11-TEST-A" });

test("a newly registered patient gets the clinic_reg WhatsApp welcome, once", async () => {
    const result = await save();
    await backgroundWork();
    assert.equal(result.newRegistration, true);
    assert.deepEqual(sent, [{ userId: USER, tokenNumber: "HOSP11-TEST-A" }]);
    assert.equal(saved.length, 1, "the registration is saved");
});

test("updating an existing patient's details sends no WhatsApp message", async () => {
    existing = { UserId: USER, OrganizationId: 1, HospitalId: 19, TokenNumber: "HOSP11-TEST-A", Status: true, IsDeleted: false };
    const result = await save();
    await backgroundWork();
    assert.equal(result.newRegistration, false);
    assert.deepEqual(sent, [], "no welcome on Save Changes");
    assert.equal(saved.length, 1, "the details are still saved");
    assert.equal(result.message, "Patient details saved successfully.");
});

test("a patient registered elsewhere is new at this organization, so the welcome goes", async () => {
    // findByUserId looks at this organization only (and only live registrations): none here yet.
    existing = null;
    await service.registerPatient({ userId: USER, organizationId: 2, hospitalId: 30, tokenNumber: "HOSP30-TEST-B" });
    await backgroundWork();
    assert.equal(sent.length, 1);
});

// Token numbers here end in letters on purpose: one ending in digits takes registration's Redis
// sequence step, and the Redis client, which connects when imported, would hold the test open.
