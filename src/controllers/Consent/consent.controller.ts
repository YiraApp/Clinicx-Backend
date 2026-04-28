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
                data: templates
            });
        } catch (error: any) {
            console.error("[Consent Controller] Error fetching templates:", error.message);
            res.status(500).json({ error: "Failed to fetch templates" });
        }
    }
}

export const consentController = new ConsentController();
