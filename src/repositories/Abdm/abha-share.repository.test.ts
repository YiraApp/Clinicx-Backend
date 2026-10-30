import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { AppDataSource } from "../../config/database.js";
import { AbhaShareRepository } from "./abha-share.repository.js";

const realGetRepository = AppDataSource.getRepository;
afterEach(() => { (AppDataSource as any).getRepository = realGetRepository; });

test("a new share stores the time it is given, never the column's GETDATE() default", async () => {
    let saved: any;
    (AppDataSource as any).getRepository = () => ({
        create: (columns: any) => columns,
        save: async (columns: any) => { saved = columns; return { ...columns, Id: 9 }; },
    });
    const createdAt = new Date("2026-10-30T08:46:37Z");

    const id = await new AbhaShareRepository().createShare({
        requestId: "req-1",
        hipId: "Yira-HIP",
        counterId: "OPD1",
        abhaNumber: null,
        abhaAddress: "asha.kumari@sbx",
        patientName: null,
        userId: null,
        hospitalId: 19,
        tokenNumber: null,
        expiresAt: null,
        status: "RECEIVED",
        matchType: null,
        error: null,
        createdAt,
    });

    assert.equal(id, 9);
    assert.equal(saved.CreatedAt, createdAt);
});
