import type { Request, Response } from "express";
import { ApiResponse } from "../../utils/response.utils.js";
import { abdmHealthRecordService, type HealthRecordBundle } from "../../services/Abdm/abdm-health-record.service.js";

/**
 * What a care context would share with ABDM: each HI type with its bundle's size, or the bundles
 * themselves with ?bundles=true. Staff only, like every ABDM route.
 */

const describe = (records: HealthRecordBundle[], withBundles: boolean) => ({
    hiTypes: [...new Set(records.map((r) => r.hiType))],
    records: records.map((r) => ({
        hiType: r.hiType,
        key: r.key,
        resources: r.bundle.entry.length,
        bytes: Buffer.byteLength(JSON.stringify(r.bundle)),
        ...(withBundles ? { bundle: r.bundle } : {}),
    })),
});

const id = (req: Request): number => {
    const n = Number(req.params.id);
    if (!Number.isInteger(n) || n < 1) throw new Error("A numeric id is required.");
    return n;
};

const send = async <K>(req: Request, res: Response, load: (id: K) => Promise<HealthRecordBundle[]>, key: (req: Request) => K) => {
    try {
        const records = await load(key(req));
        return res.json(ApiResponse.success(describe(records, req.query.bundles === "true")));
    } catch (error: any) {
        const status = /not found/i.test(error?.message ?? "") ? 404 : 400;
        return res.status(status).json(ApiResponse.error(error?.message ?? "The health records could not be built."));
    }
};

export class AbdmHealthRecordController {
    appointment(req: Request, res: Response) {
        return send(req, res, (n: number) => abdmHealthRecordService.forAppointment(n), id);
    }

    dischargeSummary(req: Request, res: Response) {
        return send(req, res, (n: number) => abdmHealthRecordService.forDischargeSummary(n), id);
    }

    immunization(req: Request, res: Response) {
        return send(req, res, (n: number) => abdmHealthRecordService.forImmunization(n), id);
    }

    vitals(req: Request, res: Response) {
        return send(req, res, (recordId: string) => abdmHealthRecordService.forVitalsRecord(recordId), (r) => String(r.params.id));
    }
}

export const abdmHealthRecordController = new AbdmHealthRecordController();
