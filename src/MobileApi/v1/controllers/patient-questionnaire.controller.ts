import type { Request, Response } from "express";
import { isFamilyLinked } from "../../../middlewares/request-identity.js";
import { questionnairePatientService as service } from "../../../services/Questionnaires/questionnaire-patient.service.js";
import { questionnaireAdminService as adminService } from "../../../services/Questionnaires/questionnaire-admin.service.js";
import { isHospitalStaff } from "../../../utils/hospital-admin-access.js";
import { QuestionnaireError } from "../../../services/Questionnaires/questionnaire-shared.js";
import { ApiResponse } from "../../../utils/response.utils.js";

const requesterOf = (req: Request) => String((req as any).user?.userId || (req as any).user?.id || "").trim();

/**
 * The patient a request is about: the signed-in profile, or a family member
 * named in ?patientId / body.patientId.
 */
async function patientOf(req: Request): Promise<{ patientId: string; requesterId: string }> {
    const requesterId = requesterOf(req);
    if (!requesterId) throw new QuestionnaireError("Please sign in again.", 401);
    const asked = String(req.query.patientId || req.body?.patientId || "").trim();
    if (!asked || asked.toLowerCase() === requesterId.toLowerCase()) return { patientId: requesterId, requesterId };
    if (await isFamilyLinked(requesterId, asked)) return { patientId: asked, requesterId };
    throw new QuestionnaireError("You can only open questionnaires for yourself and your family.", 403);
}

function fail(res: Response, error: any) {
    if (error instanceof QuestionnaireError) return res.status(error.status).json(ApiResponse.error(error.message));
    console.error("[PatientQuestionnaire]", error?.message || error);
    return res.status(500).json(ApiResponse.error("Something went wrong. Please try again."));
}

const idOf = (value: unknown) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new QuestionnaireError("Questionnaire not found.", 404);
    return n;
};

export const patientQuestionnaireController = {
    async list(req: Request, res: Response) {
        try {
            const { patientId } = await patientOf(req);
            const items = await service.list(patientId);
            return res.json(ApiResponse.success({ items, dueCount: items.filter((q) => q.state === "due").length }, "Questionnaires fetched."));
        } catch (error) {
            return fail(res, error);
        }
    },

    async get(req: Request, res: Response) {
        try {
            const { patientId } = await patientOf(req);
            return res.json(ApiResponse.success(await service.getForm(patientId, idOf(req.params.id)), "Questionnaire fetched."));
        } catch (error) {
            return fail(res, error);
        }
    },

    async submit(req: Request, res: Response) {
        try {
            const { patientId, requesterId } = await patientOf(req);
            const submission = await service.submit(patientId, requesterId, idOf(req.params.id), req.body?.answers);
            return res.status(201).json(ApiResponse.success(submission, "Thank you. Your answers were sent."));
        } catch (error) {
            return fail(res, error);
        }
    },

    async getSubmission(req: Request, res: Response) {
        try {
            const { patientId } = await patientOf(req);
            return res.json(ApiResponse.success(await service.getSubmission(patientId, idOf(req.params.id)), "Submission fetched."));
        } catch (error) {
            return fail(res, error);
        }
    },

    /** For doctors: behind requirePatientRecordAccess, so hospital staff see their hospital's submissions. */
    async forDoctor(req: Request, res: Response) {
        try {
            const patientId = String(req.params.patientId || "").trim();
            if (!patientId) throw new QuestionnaireError("Patient is required.");
            let hospitalId = Number(req.query.hospitalId) || undefined;
            const appointmentId = Number(req.query.appointmentId) || undefined;
            if (!hospitalId && appointmentId) {
                const { AppDataSource } = await import("../../../config/database.js");
                const [appt] = await AppDataSource.query(`SELECT HospitalId FROM Appointments WHERE Id = @0`, [appointmentId]);
                hospitalId = appt?.HospitalId || undefined;
            }
            // With a hospital or appointment, staff were let in for that hospital only, so that's all they get.
            // Without one, the middleware required the patient's consent (or family), which covers every hospital.
            const groups = await service.forDoctor(patientId, hospitalId);
            return res.json(ApiResponse.success(groups, "Questionnaires fetched."));
        } catch (error) {
            return fail(res, error);
        }
    },

    /** The hospital's published questionnaires for one patient, so a doctor can pick one to send. */
    async sendableForDoctor(req: Request, res: Response) {
        try {
            const { hospitalId, patientId } = await staffContext(req);
            return res.json(ApiResponse.success(await adminService.forPatient(hospitalId, patientId), "Questionnaires fetched."));
        } catch (error) {
            return fail(res, error);
        }
    },

    /** A doctor (or other staff) sends one questionnaire to this patient. */
    async sendFromDoctor(req: Request, res: Response) {
        try {
            const { hospitalId, patientId, staffId } = await staffContext(req);
            const result = await adminService.sendToPatient(hospitalId, staffId, idOf(req.params.id), patientId, { dueInDays: req.body?.dueInDays });
            return res.status(201).json(ApiResponse.success(result, "Questionnaire sent."));
        } catch (error) {
            return fail(res, error);
        }
    },
};

/** The patient, the hospital the caller works at, and a check that they are staff there. */
async function staffContext(req: Request): Promise<{ hospitalId: number; patientId: string; staffId: string }> {
    const staffId = requesterOf(req);
    if (!staffId) throw new QuestionnaireError("Please sign in again.", 401);
    const patientId = String(req.params.patientId || "").trim();
    if (!patientId) throw new QuestionnaireError("Patient is required.");
    const hospitalId = Number(req.query.hospitalId ?? req.body?.hospitalId);
    if (!Number.isInteger(hospitalId) || hospitalId <= 0) throw new QuestionnaireError("Hospital is required.");
    if (!(await isHospitalStaff(staffId, hospitalId))) {
        throw new QuestionnaireError("Only this hospital's staff can send questionnaires to its patients.", 403);
    }
    return { hospitalId, patientId, staffId };
}
