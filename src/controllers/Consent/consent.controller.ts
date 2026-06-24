import { Request, Response } from "express";
import { consentService } from "../../services/Consent/consent.service.js";

export class ConsentController {
    /**
     * POST /api/consent/templates
     */
    async createTemplate(req: Request, res: Response): Promise<void> {
        try {
            const file = req.file as Express.Multer.File;
            const { Name, HospitalId, OrganizationId, HospitalName, OrgName, Description, CreatedBy, Fields } = req.body;

            if (!file) {
                res.status(400).json({ error: "PDF file is required." });
                return;
            }

            if (!Name || !HospitalId || !OrganizationId || !HospitalName || !OrgName) {
                res.status(400).json({ error: "Name, HospitalId, OrganizationId, HospitalName, and OrgName are required." });
                return;
            }


            const template = await consentService.createTemplate(
                file,
                {
                    Name,
                    HospitalId: parseInt(HospitalId),
                    OrganizationId: parseInt(OrganizationId),
                    HospitalName,
                    OrgName,
                    Description,
                    CreatedBy

                },
                Fields
            );

            res.status(201).json({
                message: "Consent template created successfully",
                data: template
            });
        } catch (error: any) {
            console.error("[Consent Controller] Error:", error.message);
            res.status(500).json({ error: "Failed to create consent template", detail: error.message });
        }
    }

    /**
     * GET /api/consent/templates
     */
    async getTemplates(req: Request, res: Response): Promise<void> {
        try {
            const hospitalId = req.query.hospitalId ? parseInt(req.query.hospitalId as string) : undefined;
            const organizationId = req.query.organizationId ? parseInt(req.query.organizationId as string) : undefined;

            const templates = await consentService.getTemplates(hospitalId, organizationId);

            res.status(200).json({
                status: "success",
                message: "Templates fetched successfully",
                data: templates
            });
        } catch (error: any) {
            console.error("[Consent Controller] Error fetching templates:", error.message);
            res.status(500).json({ status: "error", message: "Failed to fetch templates" });
        }
    }

    /**
     * GET /api/consent/templates/:id
     */
    async getTemplateById(req: Request, res: Response): Promise<void> {
        try {
            const templateId = parseInt(req.params.id as string);
            const template = await consentService.getTemplateById(templateId);

            res.status(200).json({
                status: "success",
                message: "Template details fetched successfully",
                data: template
            });
        } catch (error: any) {
            console.error("[Consent Controller] Error fetching template details:", error.message);
            res.status(500).json({ status: "error", message: "Failed to fetch template details" });
        }
    }

    /**
     * PUT /api/consent/templates/:id
     */
    async updateTemplate(req: Request, res: Response): Promise<void> {
        try {
            const templateId = parseInt(req.params.id as string);
            if (isNaN(templateId)) {
                res.status(400).json({ error: "Valid Template ID is required." });
                return;
            }

            const file = req.file as Express.Multer.File | undefined;
            const { Name, HospitalName, OrgName, Description, Status, IsDeleted, UpdatedBy, Fields } = req.body;

            const updatedTemplate = await consentService.updateTemplate(
                templateId,
                file,
                {
                    Name,
                    HospitalName,
                    OrgName,
                    Description,
                    Status: Status !== undefined ? Status === 'true' || Status === true : undefined,
                    IsDeleted: IsDeleted !== undefined ? IsDeleted === 'true' || IsDeleted === true : undefined,
                    UpdatedBy
                },
                Fields
            );

            if (!updatedTemplate) {
                res.status(404).json({ error: "Template not found." });
                return;
            }

            res.status(200).json({
                message: "Consent template updated successfully",
                data: updatedTemplate
            });
        } catch (error: any) {
            console.error("[Consent Controller] Error updating template:", error.message);
            res.status(500).json({ error: "Failed to update consent template", detail: error.message });
        }
    }

    /**
     * DELETE /api/consent/templates/:id
     */
    async deleteTemplate(req: Request, res: Response): Promise<void> {
        try {
            const templateId = parseInt(req.params.id as string);
            if (isNaN(templateId)) {
                res.status(400).json({ error: "Valid Template ID is required." });
                return;
            }

            await consentService.deleteTemplate(templateId);

            res.status(200).json({
                message: "Consent template deleted successfully"
            });
        } catch (error: any) {
            console.error("[Consent Controller] Error deleting template:", error.message);
            res.status(500).json({ error: "Failed to delete consent template", detail: error.message });
        }
    }

    /**
     * POST /api/consent/send
     */
    async sendConsent(req: Request, res: Response): Promise<void> {
        try {
            const { appointmentId, templateIds, createdBy, channel } = req.body;

            console.log("[Consent Controller] Incoming send request:", { appointmentId, templateIds, channel });

            if (appointmentId === undefined || appointmentId === null) {
                res.status(400).json({ error: "appointmentId is required." });
                return;
            }

            if (!templateIds || !Array.isArray(templateIds)) {
                res.status(400).json({ error: "templateIds must be a valid array." });
                return;
            }

            if (templateIds.length === 0) {
                res.status(400).json({ error: "Please select at least one consent template." });
                return;
            }

            const request = await consentService.sendConsent({
                appointmentId: parseInt(appointmentId),
                templateIds: templateIds.map((id: any) => parseInt(id)),
                createdBy,
                channel
            });

            res.status(200).json({
                message: "Consent request sent successfully",
                data: request
            });
        } catch (error: any) {
            console.error("[Consent Controller] Error sending consent:", error.message);
            res.status(500).json({ error: "Failed to send consent request", detail: error.message });
        }
    }

    /**
     * GET /api/consent/status/daily
     */
    async getDailyConsentStatus(req: Request, res: Response): Promise<void> {
        try {
            const date = req.query.date as string;
            const hospitalId = parseInt(req.query.hospitalId as string);

            if (!date || isNaN(hospitalId)) {
                res.status(400).json({ error: "Date (YYYY-MM-DD) and hospitalId are required." });
                return;
            }

            const consents = await consentService.getDailyConsentStatus(date, hospitalId);
            res.status(200).json({ 
                status: "success",
                message: "Daily consent status fetched successfully",
                data: consents 
            });
        } catch (error: any) {
            console.error("[Consent Controller] Error fetching daily consent status:", error.message);
            res.status(500).json({ status: "error", message: "Failed to fetch daily consent status" });
        }
    }

    /**
     * GET /api/consent/appointment/:appointmentId
     */
    async getAppointmentConsentStatus(req: Request, res: Response): Promise<void> {
        try {
            const appointmentId = parseInt(req.params.appointmentId as string);
            const consents = await consentService.getAppointmentConsentStatus(appointmentId);

            res.status(200).json({
                status: "success",
                message: "Appointment consent status fetched successfully",
                data: consents
            });
        } catch (error: any) {
            console.error("[Consent Controller] Error fetching appointment consent status:", error.message);
            res.status(500).json({ status: "error", message: "Failed to fetch appointment consent status" });
        }
    }

    /**
     * GET /api/consent/request/:link
     */
    async getConsentRequestByLink(req: Request, res: Response) {
        try {
            const link = req.params.link as string;
            const requests = await consentService.getConsentRequestByLink(link);

            if (!requests || requests.length === 0) {
                return res.status(404).json({ error: "Consent request not found." });
            }

            // Check for expiration
            const first = requests[0];
            if (first.ExpiresAt && new Date() > new Date(first.ExpiresAt)) {
                return res.status(410).json({
                    error: "This consent link has expired.",
                    detail: "Links are valid for 24 hours. Please request a new link from the front desk."
                });
            }
            const response = {
                Patient: first.Patient,
                Hospital: first.Hospital,
                RequestLink: first.RequestLink,
                CreatedAt: first.CreatedAt,
                Requests: requests.map(r => ({
                    Id: r.Id,
                    TemplateId: r.TemplateId,
                    Template: r.Template,
                    Status: r.Status,
                    SignedPdfUrl: r.SignedPdfUrl,
                    SignatureImageUrl: r.SignatureImageUrl,
                    SignedAt: r.SignedAt
                }))
            };

            return res.json(response);
        } catch (error: any) {
            console.error("[Consent Controller] Get Error:", error.message);
            return res.status(500).json({ error: "Internal server error." });
        }
    }

    /**
     * GET /api/consent/data/:link
     * Returns consent request data with pre-computed field values for auto-fill.
     */
    async getConsentData(req: Request, res: Response) {
        try {
            const link = req.params.link as string;
            const data = await consentService.getConsentData(link);

            if (!data) {
                return res.status(404).json({ error: "Consent request not found." });
            }

            // Check for expiration
            if (data.ExpiresAt && new Date() > new Date(data.ExpiresAt)) {
                return res.status(410).json({
                    error: "This consent link has expired.",
                    detail: "Links are valid for 24 hours. Please request a new link from the front desk."
                });
            }

            return res.json(data);
        } catch (error: any) {
            console.error("[Consent Controller] Get consent data error:", error.message);
            return res.status(500).json({ error: "Internal server error." });
        }
    }

    /**
     * POST /api/consent/submit/:link
     */
    async submitConsentSignature(req: Request, res: Response): Promise<void> {
        try {
            const link = req.params.link as string;
            const { signatureData, ipAddress } = req.body;

            if (!signatureData) {
                res.status(400).json({ error: "Signature data is required." });
                return;
            }

            const updatedRequest = await consentService.submitConsentSignature(link, signatureData, ipAddress || req.ip);

            let nextLink = null;
            if (updatedRequest.AppointmentId) {
                const { consentRequestRepository } = await import("../../repositories/Consent/consent-request.repository.js");
                const nextPending = await consentRequestRepository.findOne({
                    where: { AppointmentId: updatedRequest.AppointmentId, Status: "Pending" }
                });
                if (nextPending) {
                    nextLink = nextPending.RequestLink;
                }
            }

            res.status(200).json({
                message: "Consent signed successfully",
                data: updatedRequest,
                nextLink: nextLink
            });
        } catch (error: any) {
            console.error("[Consent Controller] Error submitting signature:", error.message);
            res.status(500).json({ error: "Failed to submit signature", detail: error.message });
        }
    }
}

export const consentController = new ConsentController();
