import { AppDataSource } from "../../config/database.js";
import type { AbdmFacility, AbdmSettingName, FacilityInput, FacilityStore, SettingsStore } from "../../services/Abdm/abdm-facilities.service.js";

/** ABDM per tenant on SQL Server: the AbdmFacilities and AbdmSettings tables. */

const q = (sql: string, params: unknown[] = []): Promise<any[]> => AppDataSource.query(sql, params);

const facility = (r: any): AbdmFacility => ({
    hospitalId: Number(r.HospitalId),
    hipId: r.HipId || null,
    name: r.HipName || r.HipId || r.ScanShareHipId || "",
    scanShareHipId: r.ScanShareHipId || null,
    autoLink: Boolean(r.AutoLink),
});

export const abdmFacilityRepository: FacilityStore = {
    async list() {
        return (await q(`SELECT HospitalId, HipId, HipName, ScanShareHipId, AutoLink FROM AbdmFacilities WHERE IsActive = 1`)).map(facility);
    },

    async save(hospitalId: number, input: FacilityInput, userId: string | null) {
        await q(
            `MERGE AbdmFacilities AS t
             USING (SELECT @0 AS HospitalId) AS s ON t.HospitalId = s.HospitalId
             WHEN MATCHED THEN UPDATE SET HipId = @1, HipName = @2, ScanShareHipId = @3, AutoLink = @4, IsActive = @5, UpdatedAt = GETDATE(), UpdatedBy = @6
             WHEN NOT MATCHED THEN INSERT (HospitalId, HipId, HipName, ScanShareHipId, AutoLink, IsActive, UpdatedBy) VALUES (@0, @1, @2, @3, @4, @5, @6);`,
            [hospitalId, input.hipId ?? null, input.hipName ?? null, input.scanShareHipId ?? null, input.autoLink ? 1 : 0, input.isActive === false ? 0 : 1, userId],
        );
    },
};

export const abdmSettingsRepository: SettingsStore = {
    async get(name: AbdmSettingName) {
        const rows = await q(`SELECT Value FROM AbdmSettings WHERE Name = @0`, [name]);
        return rows[0]?.Value ?? null;
    },

    async set(name: AbdmSettingName, value: string) {
        await q(
            `MERGE AbdmSettings AS t USING (SELECT @0 AS Name) AS s ON t.Name = s.Name
             WHEN MATCHED THEN UPDATE SET Value = @1, UpdatedAt = GETDATE()
             WHEN NOT MATCHED THEN INSERT (Name, Value) VALUES (@0, @1);`,
            [name, value],
        );
    },
};
