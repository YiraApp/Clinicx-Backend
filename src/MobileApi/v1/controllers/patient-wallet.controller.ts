import { Request, Response } from "express";
import { patientWalletService, WalletValidationError, type WalletFile } from "../services/patient-wallet.service.js";
import { isFamilyLinked } from "../../../middlewares/request-identity.js";
import { ApiResponse } from "../../../utils/response.utils.js";

const requesterOf = (req: Request) => String((req as any).user?.userId || (req as any).user?.id || "").trim();

const ALLOWED_FILES = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/i;

/**
 * Bills and policies are private: only the patient and their family accounts
 * may read or change them. Doctors never see them, consent or not.
 */
async function resolvePatient(req: Request, rawPatientId: any) {
    const requesterId = requesterOf(req);
    const patientId = String(rawPatientId || requesterId || "").trim();
    if (!requesterId) return { patientId, requesterId, error: 401, message: "Please sign in again." };
    if (patientId.toLowerCase() === requesterId.toLowerCase()) return { patientId, requesterId };
    if (await isFamilyLinked(requesterId, patientId)) return { patientId, requesterId };
    return { patientId, requesterId, error: 403, message: "You can only see bills and policies for yourself and your family." };
}

/** Stores the photo or PDF sent with a bill or policy, if there is one. */
async function storeFile(req: Request, patientId: string, folder: string): Promise<WalletFile | undefined> {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) return undefined;
    if (!ALLOWED_FILES.test(file.mimetype || "")) throw new WalletValidationError("Attach a photo (JPG, PNG) or a PDF.");
    const { blobService } = await import("../../../services/Common/blob.service.js");
    const [uploaded] = await blobService.uploadFiles([file], patientId, folder);
    return { url: uploaded.fileUrl, name: file.originalname || uploaded.fileName };
}

const idOf = (req: Request) => {
    const match = /^m-(\d+)$/.exec(String(req.params.id || "")) || /^(\d+)$/.exec(String(req.params.id || ""));
    return match ? Number(match[1]) : NaN;
};

function fail(res: Response, error: any, what: string) {
    if (error instanceof WalletValidationError) return res.status(400).json(ApiResponse.error(error.message));
    console.error(`❌ ${what}:`, error?.message || error);
    return res.status(500).json(ApiResponse.error(`Could not ${what.toLowerCase()}. Please try again.`));
}

export class PatientWalletController {
    /** GET /patient/billing?patientId= */
    async getBilling(req: Request, res: Response) {
        try {
            const t = await resolvePatient(req, req.query.patientId);
            if (t.error) return res.status(t.error).json(ApiResponse.error(t.message!));
            res.set("Cache-Control", "no-store");
            return res.json(ApiResponse.success(await patientWalletService.getBilling(t.patientId), "Bills fetched"));
        } catch (e) {
            return fail(res, e, "Load bills");
        }
    }

    /** POST /patient/billing (multipart, optional "file") */
    async addBill(req: Request, res: Response) {
        try {
            const t = await resolvePatient(req, req.body.patientId);
            if (t.error) return res.status(t.error).json(ApiResponse.error(t.message!));
            const file = await storeFile(req, t.patientId, "bills");
            return res.status(201).json(ApiResponse.success(await patientWalletService.addBill(t.patientId, t.requesterId, req.body, file), "Bill added"));
        } catch (e) {
            return fail(res, e, "Add the bill");
        }
    }

    /** PUT /patient/billing/:id (only bills the patient added) */
    async updateBill(req: Request, res: Response) {
        try {
            const t = await resolvePatient(req, req.body.patientId);
            if (t.error) return res.status(t.error).json(ApiResponse.error(t.message!));
            const id = idOf(req);
            if (!Number.isFinite(id)) return res.status(400).json(ApiResponse.error("Only bills you added can be edited."));
            const file = await storeFile(req, t.patientId, "bills");
            const bill = await patientWalletService.updateBill(t.patientId, id, req.body, file);
            if (!bill) return res.status(404).json(ApiResponse.error("Bill not found."));
            return res.json(ApiResponse.success(bill, "Bill updated"));
        } catch (e) {
            return fail(res, e, "Update the bill");
        }
    }

    /** DELETE /patient/billing/:id?patientId= */
    async deleteBill(req: Request, res: Response) {
        try {
            const t = await resolvePatient(req, req.query.patientId);
            if (t.error) return res.status(t.error).json(ApiResponse.error(t.message!));
            const id = idOf(req);
            if (!Number.isFinite(id)) return res.status(400).json(ApiResponse.error("Only bills you added can be deleted."));
            const done = await patientWalletService.deleteBill(t.patientId, id);
            if (!done) return res.status(404).json(ApiResponse.error("Bill not found."));
            return res.json(ApiResponse.success(null, "Bill deleted"));
        } catch (e) {
            return fail(res, e, "Delete the bill");
        }
    }

    /** GET /patient/policies?patientId= */
    async getPolicies(req: Request, res: Response) {
        try {
            const t = await resolvePatient(req, req.query.patientId);
            if (t.error) return res.status(t.error).json(ApiResponse.error(t.message!));
            res.set("Cache-Control", "no-store");
            return res.json(ApiResponse.success(await patientWalletService.getPolicies(t.patientId), "Policies fetched"));
        } catch (e) {
            return fail(res, e, "Load policies");
        }
    }

    /** POST /patient/policies (multipart, optional "file") */
    async addPolicy(req: Request, res: Response) {
        try {
            const t = await resolvePatient(req, req.body.patientId);
            if (t.error) return res.status(t.error).json(ApiResponse.error(t.message!));
            const file = await storeFile(req, t.patientId, "policies");
            return res.status(201).json(ApiResponse.success(await patientWalletService.addPolicy(t.patientId, t.requesterId, req.body, file), "Policy added"));
        } catch (e) {
            return fail(res, e, "Add the policy");
        }
    }

    /** PUT /patient/policies/:id */
    async updatePolicy(req: Request, res: Response) {
        try {
            const t = await resolvePatient(req, req.body.patientId);
            if (t.error) return res.status(t.error).json(ApiResponse.error(t.message!));
            const id = idOf(req);
            if (!Number.isFinite(id)) return res.status(400).json(ApiResponse.error("Policies added by a hospital can't be edited here."));
            const file = await storeFile(req, t.patientId, "policies");
            const policy = await patientWalletService.updatePolicy(t.patientId, id, req.body, file);
            if (!policy) return res.status(404).json(ApiResponse.error("Policy not found."));
            return res.json(ApiResponse.success(policy, "Policy updated"));
        } catch (e) {
            return fail(res, e, "Update the policy");
        }
    }

    /** DELETE /patient/policies/:id?patientId= */
    async deletePolicy(req: Request, res: Response) {
        try {
            const t = await resolvePatient(req, req.query.patientId);
            if (t.error) return res.status(t.error).json(ApiResponse.error(t.message!));
            const id = idOf(req);
            if (!Number.isFinite(id)) return res.status(400).json(ApiResponse.error("Policies added by a hospital can't be deleted here."));
            const done = await patientWalletService.deletePolicy(t.patientId, id);
            if (!done) return res.status(404).json(ApiResponse.error("Policy not found."));
            return res.json(ApiResponse.success(null, "Policy deleted"));
        } catch (e) {
            return fail(res, e, "Delete the policy");
        }
    }
}

export const patientWalletController = new PatientWalletController();
