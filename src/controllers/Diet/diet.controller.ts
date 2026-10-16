import { Request, Response } from "express";
import { dietFoodService } from "../../services/Diet/diet-food.service.js";
import { dietTemplateService } from "../../services/Diet/diet-template.service.js";
import { patientDietPlanService } from "../../services/Diet/patient-diet-plan.service.js";
import { patientAccessConsentService } from "../../MobileApi/v1/services/consent/patient-access-consent.service.js";
import { DietFoodImagesService } from "../../services/Diet/diet-food-images.service.js";
import { DietValidationError } from "../../services/Diet/diet-validation.js";

function getOrganizationId(req: Request): number | undefined {
    const orgId = req.headers["x-org-id"] 
        || req.headers["x-organization-id"] 
        || req.query.organizationId 
        || req.query.orgId 
        || req.body?.organizationId 
        || (req as any).user?.OrganizationId 
        || (req as any).user?.organizationId;
    return orgId ? parseInt(String(orgId), 10) : undefined;
}

function getDoctorId(req: Request): string | undefined {
    return (req as any).user?.userId 
        || (req as any).user?.Id 
        || req.body?.doctorId 
        || (req.query.doctorId as string);
}

/** The signed-in user. Ownership checks use only this, never ids sent in the request. */
function getAuthUserId(req: Request): string | undefined {
    const user = (req as any).user;
    const id = user?.userId || user?.Id || user?.id;
    return id ? String(id) : undefined;
}

function sendError(res: Response, error: any, fallback: string, context: string) {
    if (error instanceof DietValidationError) {
        return res.status(400).json({ error: error.message });
    }
    console.error(`Error in ${context}:`, error);
    return res.status(500).json({ error: fallback });
}

export class DietController {
    // ----------------------------------------------------
    // MASTER FOOD APIS
    // ----------------------------------------------------

    async searchFoods(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            const { search, category, slot, foodType, page, limit } = req.query;

            const result = await dietFoodService.searchFoods({
                search: search as string,
                category: category as string,
                slot: slot as string,
                foodType: foodType as string,
                organizationId,
                page: page ? parseInt(String(page), 10) : 1,
                limit: limit ? parseInt(String(limit), 10) : 50
            });

            res.json(result);
        } catch (error: any) {
            console.error("Error in searchFoods:", error);
            res.status(500).json({ error: error.message || "Failed to search food items." });
        }
    }

    async getCategories(req: Request, res: Response) {
        try {
            const categories = await dietFoodService.getCategories();
            res.json(categories);
        } catch (error: any) {
            res.status(500).json({ error: error.message || "Failed to fetch categories." });
        }
    }

    async getSlotRecommendations(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            const { dietType } = req.query;
            const recommendations = await dietFoodService.getSlotRecommendations({
                organizationId,
                dietType: dietType as string
            });
            res.json(recommendations);
        } catch (error: any) {
            console.error("Error in getSlotRecommendations:", error);
            res.status(500).json({ error: error.message || "Failed to fetch recommendations." });
        }
    }

    async createCustomFood(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            if (!organizationId) {
                return res.status(400).json({ error: "OrganizationId is required." });
            }

            const food = await dietFoodService.createCustomFood(req.body, organizationId);
            res.status(201).json(food);
        } catch (error: any) {
            sendError(res, error, "Failed to create food item.", "createCustomFood");
        }
    }

    async updateCustomFood(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            if (!organizationId) {
                return res.status(400).json({ error: "OrganizationId is required." });
            }

            const id = parseInt(String(req.params.id), 10);
            const updated = await dietFoodService.updateCustomFood(id, req.body, organizationId);
            res.json(updated);
        } catch (error: any) {
            sendError(res, error, "Failed to update food item.", "updateCustomFood");
        }
    }

    async deleteCustomFood(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            if (!organizationId) {
                return res.status(400).json({ error: "OrganizationId is required." });
            }

            const id = parseInt(String(req.params.id), 10);
            const result = await dietFoodService.deleteCustomFood(id, organizationId);
            res.json(result);
        } catch (error: any) {
            sendError(res, error, "Failed to delete food item.", "deleteCustomFood");
        }
    }

    // ----------------------------------------------------
    // TEMPLATE APIS
    // ----------------------------------------------------

    async listTemplates(req: Request, res: Response) {
        try {
            const { condition, dietType, search, scope } = req.query;
            const templates = await dietTemplateService.listTemplates({
                organizationId: getOrganizationId(req),
                doctorId: getAuthUserId(req),
                condition: condition as string,
                dietType: dietType as string,
                search: search as string,
                scope: scope as string,
            });
            res.json(templates);
        } catch (error: any) {
            sendError(res, error, "Failed to list templates.", "listTemplates");
        }
    }

    async getTemplateById(req: Request, res: Response) {
        try {
            const id = parseInt(String(req.params.id), 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid template id." });

            const template = await dietTemplateService.getTemplateById(id, getOrganizationId(req), getAuthUserId(req));
            if (!template) {
                return res.status(404).json({ error: "Template not found." });
            }
            res.json(template);
        } catch (error: any) {
            sendError(res, error, "Failed to get template.", "getTemplateById");
        }
    }

    async createTemplate(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            if (!organizationId) {
                return res.status(400).json({ error: "OrganizationId is required." });
            }

            const result = await dietTemplateService.createTemplate({
                ...req.body,
                organizationId,
                doctorId: getAuthUserId(req)
            });
            res.status(201).json(result);
        } catch (error: any) {
            sendError(res, error, "Failed to create template.", "createTemplate");
        }
    }

    async updateTemplate(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            if (!organizationId) {
                return res.status(400).json({ error: "OrganizationId is required." });
            }

            const id = parseInt(String(req.params.id), 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid template id." });

            const updated = await dietTemplateService.updateTemplate(id, req.body, organizationId, getAuthUserId(req));
            res.json(updated);
        } catch (error: any) {
            sendError(res, error, "Failed to update template.", "updateTemplate");
        }
    }

    async deleteTemplate(req: Request, res: Response) {
        try {
            const id = parseInt(String(req.params.id), 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid template id." });

            const result = await dietTemplateService.deleteTemplate(id, getAuthUserId(req));
            res.json(result);
        } catch (error: any) {
            sendError(res, error, "Failed to delete template.", "deleteTemplate");
        }
    }

    async duplicateTemplate(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            if (!organizationId) {
                return res.status(400).json({ error: "OrganizationId is required." });
            }
            const doctorId = getAuthUserId(req);
            if (!doctorId) {
                return res.status(401).json({ error: "Sign in as a doctor to copy templates." });
            }

            const id = parseInt(String(req.params.id), 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid template id." });

            const duplicated = await dietTemplateService.duplicateTemplate(id, organizationId, doctorId, req.body?.name);
            res.status(201).json(duplicated);
        } catch (error: any) {
            sendError(res, error, "Failed to copy template.", "duplicateTemplate");
        }
    }

    // ----------------------------------------------------
    // PATIENT DIET PLAN APIS (Doctor / Clinic)
    // ----------------------------------------------------

    async assignPlan(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            if (!organizationId) {
                return res.status(400).json({ error: "OrganizationId is required." });
            }
            const doctorId = getDoctorId(req);
            if (!doctorId) {
                return res.status(400).json({ error: "DoctorId is required." });
            }

            const plan = await patientDietPlanService.assignPlan({
                ...req.body,
                organizationId,
                doctorId
            });

            res.status(201).json(plan);
        } catch (error: any) {
            sendError(res, error, "Failed to assign diet plan.", "assignPlan");
        }
    }

    /** The patient themself, or a doctor holding an active access consent. */
    private async canSeeFullHistory(req: Request, patientId: string): Promise<boolean> {
        const user = (req as any).user;
        const requesterId = String(user?.userId || user?.id || "").trim();
        if (!requesterId) return false;
        if (requesterId.toLowerCase() === patientId.toLowerCase()) return true;
        const access = await patientAccessConsentService.checkAccess(patientId, requesterId);
        return access?.hasAccess === true;
    }

    async getPatientPlans(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            const rawPatientId = req.params.patientId || req.query.patientId;

            if (!rawPatientId) {
                return res.status(400).json({ error: "PatientId is required." });
            }

            const patientId = String(rawPatientId);
            const fullHistory = req.query.scope === "all";
            if (fullHistory && !(await this.canSeeFullHistory(req, patientId))) {
                return res.status(403).json({ error: "The patient hasn't given you access to their full records.", code: "CONSENT_REQUIRED" });
            }
            const plans = await patientDietPlanService.getPatientPlans(patientId, organizationId, { fullHistory });
            res.json(plans);
        } catch (error: any) {
            res.status(500).json({ error: error.message || "Failed to get patient plans." });
        }
    }

    async getPlanDetails(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            const id = parseInt(String(req.params.id), 10);
            if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid plan id." });
            // With the patient's consent a doctor may open any of their plans,
            // including ones from other organizations or made by the patient.
            if (req.query.scope === "all") {
                const plan = await patientDietPlanService.getPlanDetails(id);
                if (!plan) return res.status(404).json({ error: "Diet plan not found." });
                if (!(await this.canSeeFullHistory(req, String(plan.PatientId)))) {
                    return res.status(403).json({ error: "The patient hasn't given you access to their full records.", code: "CONSENT_REQUIRED" });
                }
                return res.json(plan);
            }

            const plan = await patientDietPlanService.getPlanDetails(id, organizationId);

            // Plans a patient made for themselves are private to them.
            if (!plan || plan.CreatedByPatient) {
                return res.status(404).json({ error: "Diet plan not found." });
            }

            res.json(plan);
        } catch (error: any) {
            res.status(500).json({ error: error.message || "Failed to get plan details." });
        }
    }

    async updatePlan(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            if (!organizationId) {
                return res.status(400).json({ error: "OrganizationId is required." });
            }

            const id = parseInt(String(req.params.id), 10);
            const updated = await patientDietPlanService.updatePlan(id, req.body, organizationId);
            res.json(updated);
        } catch (error: any) {
            sendError(res, error, "Failed to update diet plan.", "updatePlan");
        }
    }

    async updatePlanStatus(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            const id = parseInt(String(req.params.id), 10);
            if (!id || isNaN(id)) {
                return res.status(400).json({ error: "Invalid diet plan id." });
            }

            const result = await patientDietPlanService.updatePlanStatus(id, req.body?.status, organizationId);
            res.json(result);
        } catch (error: any) {
            sendError(res, error, "Failed to update plan status.", "updatePlanStatus");
        }
    }
    // ----------------------------------------------------
    // FOOD IMAGE POPULATION (Admin only)
    // ----------------------------------------------------

    async populateFoodImages(_req: Request, res: Response) {
        try {
            res.json({ message: "Food image population started. Check server logs for progress." });
            DietFoodImagesService.populateAllFoodImages().catch(err => {
                console.error("[DietController] populateFoodImages background error:", err);
            });
        } catch (error: any) {
            res.status(500).json({ error: error.message || "Failed to start image population." });
        }
    }
}

export const dietController = new DietController();
