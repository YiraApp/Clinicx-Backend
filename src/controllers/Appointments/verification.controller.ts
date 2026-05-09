import { Request, Response } from "express";
import { verificationService } from "../../services/Appointments/verification.service.js";

export class VerificationController {
    async uploadDocument(req: Request, res: Response): Promise<void> {
        try {
            const appointmentId = parseInt(req.params.appointmentId as string);
            const { type } = req.body;
            const file = req.file;
            const userId = (req as any).user?.Id;

            if (isNaN(appointmentId) || !type || !file) {
                res.status(400).json({ status: "error", message: "AppointmentId, type, and file are required." });
                return;
            }

            const doc = await verificationService.uploadDocument(appointmentId, type, file, userId);
            
            res.status(200).json({
                status: "success",
                message: `${type} uploaded successfully`,
                data: doc
            });
        } catch (error: any) {
            console.error("[Verification Controller] Error uploading document:", error.message);
            res.status(500).json({ status: "error", message: "Failed to upload document" });
        }
    }

    async getStatus(req: Request, res: Response): Promise<void> {
        try {
            const appointmentId = parseInt(req.params.appointmentId as string);
            if (isNaN(appointmentId)) {
                res.status(400).json({ status: "error", message: "Valid AppointmentId is required." });
                return;
            }

            const data = await verificationService.getVerificationStatus(appointmentId);
            res.status(200).json({
                status: "success",
                data: data
            });
        } catch (error: any) {
            console.error("[Verification Controller] Error fetching status:", error.message);
            res.status(500).json({ status: "error", message: "Failed to fetch verification status" });
        }
    }

    async updateStatus(req: Request, res: Response): Promise<void> {
        try {
            const appointmentId = parseInt(req.params.appointmentId as string);
            const updateData = req.body;
            const userId = (req as any).user?.Id;

            if (isNaN(appointmentId)) {
                res.status(400).json({ status: "error", message: "Valid AppointmentId is required." });
                return;
            }

            await verificationService.updateMasterStatus(appointmentId, {
                ...updateData,
                UpdatedBy: userId,
                VerifiedBy: userId,
                VerifiedAt: new Date()
            });

            res.status(200).json({
                status: "success",
                message: "Verification status updated successfully"
            });
        } catch (error: any) {
            console.error("[Verification Controller] Error updating status:", error.message);
            res.status(500).json({ status: "error", message: "Failed to update status" });
        }
    }
    async completeCheckin(req: Request, res: Response): Promise<void> {
        try {
            const appointmentId = parseInt(req.params.appointmentId as string);
            const data = req.body;
            const userId = (req as any).user?.Id;

            if (isNaN(appointmentId)) {
                res.status(400).json({ status: "error", message: "Valid AppointmentId is required." });
                return;
            }

            await verificationService.completeCheckin(appointmentId, {
                ...data,
                verifiedBy: userId
            });

            res.status(200).json({
                status: "success",
                message: "Patient checked in successfully and added to queue"
            });
        } catch (error: any) {
            console.error("[Verification Controller] Error completing checkin:", error.message);
            res.status(500).json({ status: "error", message: error.message || "Failed to complete checkin" });
        }
    }
}

export const verificationController = new VerificationController();
