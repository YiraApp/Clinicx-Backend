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
}

export const consentController = new ConsentController();
