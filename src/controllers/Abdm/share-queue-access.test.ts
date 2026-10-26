import { test } from "node:test";
import assert from "node:assert/strict";
import { AbhaJourneyError } from "../../services/Abdm/abha-enrolment.service.js";
import { shareQueueHospital, type ShareQueueAccess } from "./share-queue-access.js";

const STAFF = "11111111-1111-1111-1111-111111111111";
const HOSPITAL = 7;
const OTHER_HOSPITAL = 8;

/** Staff who work at [worksAt] only; records every check it is asked. */
const access = (worksAt: number[]) => {
    const asked: Array<[string, number]> = [];
    const store: ShareQueueAccess = {
        async staffWorksAt(userId, hospitalId) {
            asked.push([userId, hospitalId]);
            return worksAt.includes(hospitalId);
        },
    };
    return { store, asked };
};

const refusal = (status: number) => (error: unknown) =>
    error instanceof AbhaJourneyError && error.status === status;

test("the queue needs x-hospital-id: there is no default hospital to fall back to", async () => {
    const { store, asked } = access([HOSPITAL]);
    await assert.rejects(shareQueueHospital(null, STAFF, store), refusal(400));
    assert.deepEqual(asked, []);
});

test("staff without a role at the hospital are refused its queue", async () => {
    const { store, asked } = access([OTHER_HOSPITAL]);
    await assert.rejects(shareQueueHospital(HOSPITAL, STAFF, store), refusal(403));
    assert.deepEqual(asked, [[STAFF, HOSPITAL]]);
});

test("staff with a role at the hospital get its queue", async () => {
    const { store, asked } = access([HOSPITAL]);
    assert.equal(await shareQueueHospital(HOSPITAL, STAFF, store), HOSPITAL);
    assert.deepEqual(asked, [[STAFF, HOSPITAL]]);
});
