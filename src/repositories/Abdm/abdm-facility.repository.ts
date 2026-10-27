import { MssqlParameter } from "typeorm/index.js";
import { AppDataSource } from "../../config/database.js";
import type { AbdmFacility, AbdmSettingName, FacilityInput, FacilityStore, SettingsStore } from "../../services/Abdm/abdm-facilities.service.js";

/** ABDM per tenant on SQL Server: the AbdmFacilities and AbdmSettings tables. */

const q = (sql: string, params: unknown[] = []): Promise<any[]> => AppDataSource.query(sql, params);

const facility = (r: any): AbdmFacility => ({
    hospitalId: Number(r.HospitalId),
    hipId: r.HipId || null,
    name: r.HipName || r.HipId || r.HiuId || r.ScanShareHipId || "",
    scanShareHipId: r.ScanShareHipId || null,
    hiuId: r.HiuId || null,
    autoLink: Boolean(r.AutoLink),
});

export const abdmFacilityRepository: FacilityStore = {
    async list() {
        return (await q(`SELECT HospitalId, HipId, HipName, ScanShareHipId, HiuId, AutoLink FROM AbdmFacilities WHERE IsActive = 1`)).map(facility);
    },

    async save(hospitalId: number, input: FacilityInput, userId: string | null) {
        await q(
            `MERGE AbdmFacilities AS t
             USING (SELECT @0 AS HospitalId) AS s ON t.HospitalId = s.HospitalId
             WHEN MATCHED THEN UPDATE SET HipId = @1, HipName = @2, ScanShareHipId = @3, AutoLink = @4, IsActive = @5, UpdatedAt = GETDATE(), UpdatedBy = @6, HiuId = @7
             WHEN NOT MATCHED THEN INSERT (HospitalId, HipId, HipName, ScanShareHipId, AutoLink, IsActive, UpdatedBy, HiuId) VALUES (@0, @1, @2, @3, @4, @5, @6, @7);`,
            [hospitalId, input.hipId ?? null, input.hipName ?? null, input.scanShareHipId ?? null, input.autoLink ? 1 : 0, input.isActive === false ? 0 : 1, userId, input.hiuId ?? null],
        );
    },

    async openHiuRequests(hospitalId: number, hiuId: string) {
        // The time comes from JS (the driver runs with useUTC=false), as in the HIU repositories.
        const rows = await q(
            `SELECT COUNT(*) AS OpenRequests FROM AbdmHiuConsentRequests r
             WHERE r.HospitalId = @0 AND r.HiuId = @1 AND (
                (r.Status IN ('SENDING', 'REQUESTED') AND r.DataEraseAt > @2)
                OR (r.Status IN ('GRANTED', 'PARTLY_REVOKED') AND NOT EXISTS (SELECT 1 FROM AbdmHiuConsentArtefacts a WHERE a.ConsentRequestFk = r.Id))
                OR EXISTS (SELECT 1 FROM AbdmHiuConsentArtefacts a WHERE a.ConsentRequestFk = r.Id AND a.Status = 'GRANTED' AND (a.DataEraseAt IS NULL OR a.DataEraseAt > @2))
                OR EXISTS (SELECT 1 FROM AbdmHiuConsentArtefacts a INNER JOIN AbdmHiuDataRequests d ON d.ArtefactFk = a.Id
                           WHERE a.ConsentRequestFk = r.Id AND d.SessionStatus IN ('REQUESTED', 'RECEIVING')))`,
            [hospitalId, hiuId, new MssqlParameter(new Date(), "datetime2", 3)],
        );
        return Number(rows[0]?.OpenRequests ?? 0);
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
