import { Request, Response } from "express";
import { dietFoodService } from "../../services/Diet/diet-food.service.js";
import { dietTemplateService } from "../../services/Diet/diet-template.service.js";
import { patientDietPlanService } from "../../services/Diet/patient-diet-plan.service.js";

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
            res.status(400).json({ error: error.message || "Failed to create food item." });
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
            res.status(400).json({ error: error.message || "Failed to update food item." });
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
            res.status(400).json({ error: error.message || "Failed to delete food item." });
        }
    }

    // ----------------------------------------------------
    // TEMPLATE APIS
    // ----------------------------------------------------

    async listTemplates(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            const doctorId = getDoctorId(req);
            const { condition, dietType, search } = req.query;

            const templates = await dietTemplateService.listTemplates({
                organizationId,
                doctorId,
                condition: condition as string,
                dietType: dietType as string,
                search: search as string
            });

            res.json(templates);
        } catch (error: any) {
            console.error("Error in listTemplates:", error);
            res.status(500).json({ error: error.message || "Failed to list templates." });
        }
    }

    async getTemplateById(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            const id = parseInt(String(req.params.id), 10);
            const template = await dietTemplateService.getTemplateById(id, organizationId);

            if (!template) {
                return res.status(404).json({ error: "Template not found." });
            }

            res.json(template);
        } catch (error: any) {
            res.status(500).json({ error: error.message || "Failed to get template." });
        }
    }

    async createTemplate(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            if (!organizationId) {
                return res.status(400).json({ error: "OrganizationId is required." });
            }
            const doctorId = getDoctorId(req);

            const result = await dietTemplateService.createTemplate({
                ...req.body,
                organizationId,
                doctorId
            });

            res.status(201).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message || "Failed to create template." });
        }
    }

    async updateTemplate(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            if (!organizationId) {
                return res.status(400).json({ error: "OrganizationId is required." });
            }

            const id = parseInt(String(req.params.id), 10);
            const updated = await dietTemplateService.updateTemplate(id, req.body, organizationId);
            res.json(updated);
        } catch (error: any) {
            res.status(400).json({ error: error.message || "Failed to update template." });
        }
    }

    async deleteTemplate(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            if (!organizationId) {
                return res.status(400).json({ error: "OrganizationId is required." });
            }

            const id = parseInt(String(req.params.id), 10);
            const result = await dietTemplateService.deleteTemplate(id, organizationId);
            res.json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message || "Failed to delete template." });
        }
    }

    async duplicateTemplate(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            if (!organizationId) {
                return res.status(400).json({ error: "OrganizationId is required." });
            }
            const doctorId = getDoctorId(req);
            if (!doctorId) {
                return res.status(400).json({ error: "DoctorId is required to duplicate template." });
            }

            const id = parseInt(String(req.params.id), 10);
            const duplicated = await dietTemplateService.duplicateTemplate(
                id,
                organizationId,
                doctorId,
                req.body.name
            );

            res.status(201).json(duplicated);
        } catch (error: any) {
            res.status(400).json({ error: error.message || "Failed to duplicate template." });
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
            console.error("Error in assignPlan:", error);
            res.status(400).json({ error: error.message || "Failed to assign diet plan." });
        }
    }

    async getPatientPlans(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            const rawPatientId = req.params.patientId || req.query.patientId;

            if (!rawPatientId) {
                return res.status(400).json({ error: "PatientId is required." });
            }

            const patientId = String(rawPatientId);
            const plans = await patientDietPlanService.getPatientPlans(patientId, organizationId);
            res.json(plans);
        } catch (error: any) {
            res.status(500).json({ error: error.message || "Failed to get patient plans." });
        }
    }

    async getPlanDetails(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            const id = parseInt(String(req.params.id), 10);
            const plan = await patientDietPlanService.getPlanDetails(id, organizationId);

            if (!plan) {
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
            res.status(400).json({ error: error.message || "Failed to update diet plan." });
        }
    }

    async updatePlanStatus(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            if (!organizationId) {
                return res.status(400).json({ error: "OrganizationId is required." });
            }

            const id = parseInt(String(req.params.id), 10);
            const { status } = req.body;
            if (!status) {
                return res.status(400).json({ error: "Status is required." });
            }

            const result = await patientDietPlanService.updatePlanStatus(id, status, organizationId);
            res.json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message || "Failed to update plan status." });
        }
    }
}

export const dietController = new DietController();
