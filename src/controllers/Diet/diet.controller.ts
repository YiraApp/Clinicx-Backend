import { Request, Response } from "express";
import { dietFoodService } from "../../services/Diet/diet-food.service.js";
import { dietTemplateService } from "../../services/Diet/diet-template.service.js";
import { patientDietPlanService } from "../../services/Diet/patient-diet-plan.service.js";
import { patientAccessConsentService } from "../../MobileApi/v1/services/consent/patient-access-consent.service.js";
import { DietFoodImagesService } from "../../services/Diet/diet-food-images.service.js";
import { DietValidationError } from "../../services/Diet/diet-validation.js";
import { dietPlanDocumentService } from "../../services/Diet/diet-plan-document.service.js";
import { sendPdf } from "../../utils/send-pdf.js";
import { editLockMessage } from "../../utils/edit-window.js";
import { AppDataSource } from "../../config/database.js";
import { isFamilyLinked } from "../../middlewares/request-identity.js";
import { isDoctor, workingAccountId } from "../../utils/work-access.js";
import { staffHospitalIds } from "../../utils/staff-access.js";
import { isSystemAdmin } from "../../utils/hospital-admin-access.js";
import { sameUserId } from "../../utils/request-actor.js";

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

/** The signed-in user. Ownership checks use only this, never ids sent in the request. */
function getAuthUserId(req: Request): string | undefined {
    const user = (req as any).user;
    const id = user?.userId || user?.Id || user?.id;
    return id ? String(id) : undefined;
}

/** What the caller is to this patient. */
interface PlanAccess {
    /** The account working in this request, proven by its token. */
    me: string | null;
    family: boolean;
    consented: boolean;
    doctor: boolean;
    /** Works with this patient: treats them, has their consent, or works at a hospital they visit. */
    related: boolean;
    /** Works as a doctor or other hospital staff at all. */
    staff: boolean;
}

async function planAccess(req: Request, patientId: string): Promise<PlanAccess> {
    const open = getAuthUserId(req);
    const family = !!open && (await isFamilyLinked(open, patientId));
    const me = await workingAccountId(req);
    if (!me) return { me, family, consented: false, doctor: false, related: family, staff: false };

    const doctor = await isDoctor(me);
    const hospitals = await staffHospitalIds(me);
    const systemAdmin = !doctor && (await isSystemAdmin(me));
    const consent = await patientAccessConsentService.checkAccess(patientId, me);
    const consented = consent?.hasAccess === true;
    let related = family || consented || !!consent?.treated || systemAdmin;
    for (const hospitalId of hospitals) {
        if (related) break;
        related = (await patientAccessConsentService.checkHospitalRecordAccess(patientId, me, { hospitalId })).allowed;
    }
    return { me, family, consented, doctor, related, staff: doctor || systemAdmin || hospitals.length > 0 };
}

/** A doctor manages the plans they assigned; other staff, their organisation's plans for patients they work with. */
async function canManagePlan(access: PlanAccess, plan: any): Promise<boolean> {
    if (!access.me || plan.CreatedByPatient) return false;
    if (sameUserId(plan.AssignedByDoctorId, access.me)) return true;
    return !access.doctor && access.related && (await dietPlanDocumentService.canStaffOpen(access.me, plan));
}

/** The patient, family, and a doctor with consent see every plan listed; anyone else only what they manage. */
async function canSeePlan(access: PlanAccess, plan: any): Promise<boolean> {
    return access.family || access.consented || (await canManagePlan(access, plan));
}

/** Who prescribes: a doctor or staff member who works with this patient. Answers and returns null otherwise. */
async function requirePrescriber(req: Request, res: Response): Promise<string | null> {
    const patientId = String(req.body?.patientId ?? "").trim();
    if (!patientId) {
        res.status(400).json({ error: "PatientId is required." });
        return null;
    }
    const access = await planAccess(req, patientId);
    if (access.me && access.staff && access.related) return access.me;
    res.status(403).json({ error: "You can only prescribe diet plans for your own patients." });
    return null;
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

    /** "Ask AI" about one food: what it is, who it suits, what to watch, better swaps. */
    async askAboutFood(req: Request, res: Response) {
        try {
            const { foodAiService, FoodAiError } = await import("../../services/Diet/food-ai.service.js");
            try {
                const question = foodAiService.parse(req.body);
                return res.json({ success: true, data: await foodAiService.ask(question) });
            } catch (e: any) {
                if (e instanceof FoodAiError) return res.status(e.status).json({ success: false, message: e.message });
                throw e;
            }
        } catch (error: any) {
            console.error("[Diet] askAboutFood:", error?.message || error);
            return res.status(500).json({ success: false, message: "Could not get an answer right now. Please try again." });
        }
    }

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
            const doctorId = await requirePrescriber(req, res);
            if (!doctorId) return;

            const plan = await patientDietPlanService.assignPlan({
                ...req.body,
                organizationId,
                doctorId
            });

            // Keep a PDF of the plan in the patient's documents.
            const document = plan ? await dietPlanDocumentService.saveToDocumentsQuietly(plan.Id) : null;
            res.status(201).json(document ? { ...plan, PdfUrl: document.url, DocumentId: document.documentId } : plan);
        } catch (error: any) {
            sendError(res, error, "Failed to assign diet plan.", "assignPlan");
        }
    }

    /**
     * POST /plans/preview: the PDF the plan in the body would get (same body as POST /plans), drawn
     * without saving anything, so the doctor can check it and go back to edit.
     */
    async previewPlanPdf(req: Request, res: Response) {
        try {
            const organizationId = getOrganizationId(req);
            if (!organizationId) return res.status(400).json({ error: "OrganizationId is required." });
            const doctorId = await requirePrescriber(req, res);
            if (!doctorId) return;
            const draft = await patientDietPlanService.draftPlan({ ...req.body, organizationId, doctorId });
            const buffer = await dietPlanDocumentService.previewPdf(draft as any);
            res.setHeader("Cache-Control", "no-store");
            sendPdf(res, buffer, "Diet Plan - preview.pdf", false);
        } catch (error: any) {
            sendError(res, error, "Couldn't create the preview.", "previewPlanPdf");
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
            if (fullHistory) return res.json(plans);

            const access = await planAccess(req, patientId);
            const visible: typeof plans = [];
            for (const plan of plans) {
                if (await canSeePlan(access, plan)) visible.push(plan);
            }
            if (!access.family && !access.consented && !visible.length && !(access.staff && access.related)) {
                return res.status(403).json({ error: "You can only see diet plans of your own patients." });
            }
            res.json(visible);
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
            if (!plan || plan.CreatedByPatient || !(await canSeePlan(await planAccess(req, String(plan.PatientId)), plan))) {
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
            if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid plan id." });
            const current = await patientDietPlanService.getPlanDetails(id);
            if (!current) return res.status(404).json({ error: "Diet plan not found." });
            if (!(await canManagePlan(await planAccess(req, String(current.PatientId)), current))) {
                return res.status(403).json({ error: "Only the doctor who prescribed this plan, or their hospital's staff, can change it." });
            }
            // A doctor's change is allowed only within an hour of prescribing.
            const locked = await editLockMessage("dietPlan", id);
            if (locked) return res.status(403).json({ error: locked });
            const updated = await patientDietPlanService.updatePlan(id, req.body, organizationId);
            // The PDF in the patient's documents follows the plan.
            const document = updated ? await dietPlanDocumentService.saveToDocumentsQuietly(id) : null;
            res.json(document ? { ...updated, PdfUrl: document.url, DocumentId: document.documentId } : updated);
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

            // Pausing or stopping is the patient's choice: doctors prescribe (a new plan replaces the active one).
            const [owner] = await AppDataSource.query(`SELECT PatientId FROM PatientDietPlans WHERE Id = @0`, [id]);
            const requester = (getAuthUserId(req) || "").toLowerCase();
            if (!owner || String(owner.PatientId).toLowerCase() !== requester) {
                return res.status(403).json({ error: "Doctors can't pause or stop a diet plan. Prescribe a new plan instead; it replaces the current one." });
            }

            const result = await patientDietPlanService.updatePlanStatus(id, req.body?.status, organizationId);
            res.json(result);
        } catch (error: any) {
            sendError(res, error, "Failed to update plan status.", "updatePlanStatus");
        }
    }
    /** GET /plans/:id/pdf: the plan as a PDF, built from what is saved now. For the clinic's staff and the patient. */
    async openPlanPdf(req: Request, res: Response) {
        try {
            const id = parseInt(String(req.params.id), 10);
            if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid plan id." });
            const userId = getAuthUserId(req);
            const plan = await patientDietPlanService.getPlanDetails(id);
            const isPatient = !!plan && !!userId && String(plan.PatientId).toLowerCase() === userId.toLowerCase();
            // A doctor the patient gave access to their full records sees every plan in the list
            // (self-made ones and other organisations' too), so may open each plan's PDF as well.
            const allowed = !!plan && (isPatient
                || (await canManagePlan(await planAccess(req, String(plan.PatientId)), plan))
                || (await this.canSeeFullHistory(req, String(plan.PatientId))));
            if (!plan || !allowed) {
                return res.status(404).json({ error: "Diet plan not found." });
            }
            const pdf = await dietPlanDocumentService.buildPdf(id);
            if (!pdf) return res.status(404).json({ error: "Diet plan not found." });
            sendPdf(res, pdf.buffer, pdf.fileName, req.query.download === "1");
        } catch (error: any) {
            sendError(res, error, "Couldn't create the diet plan PDF.", "openPlanPdf");
        }
    }

    /** POST /plans/:id/pdf: builds the plan's PDF again and saves it to the patient's documents. */
    async savePlanPdf(req: Request, res: Response) {
        try {
            const id = parseInt(String(req.params.id), 10);
            if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid plan id." });
            const plan = await patientDietPlanService.getPlanDetails(id);
            if (!plan || !(await canManagePlan(await planAccess(req, String(plan.PatientId)), plan))) {
                return res.status(404).json({ error: "Diet plan not found." });
            }
            const document = await dietPlanDocumentService.saveToDocuments(id);
            if (!document) return res.status(404).json({ error: "Diet plan not found." });
            res.json({ success: true, message: "Diet plan PDF saved to the patient's documents.", url: document.url, documentId: document.documentId, fileName: document.fileName });
        } catch (error: any) {
            sendError(res, error, "Couldn't save the diet plan PDF to the patient's documents.", "savePlanPdf");
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
