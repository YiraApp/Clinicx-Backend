import { Request, Response } from "express";
import { PrescriptionScanError, prescriptionScanService } from "../../../../services/Prescriptions/prescription-scan.service.js";
import { ApiResponse } from "../../../../utils/response.utils.js";

/** POST /v1/api/auth/prescriptions/scan (multipart "file"): the app's "Scan prescription". */
export async function scanPrescription(req: Request, res: Response) {
    try {
        const result = await prescriptionScanService.scan(req.file as Express.Multer.File | undefined);
        return res.json(ApiResponse.success(result, "Prescription read."));
    } catch (error: any) {
        if (error instanceof PrescriptionScanError) {
            return res.status(error.httpStatus).json(ApiResponse.error(error.message, { code: error.code }));
        }
        console.error("[PrescriptionScan] Error:", error);
        return res.status(500).json(ApiResponse.error("Something went wrong while analyzing. Please try again."));
    }
}
