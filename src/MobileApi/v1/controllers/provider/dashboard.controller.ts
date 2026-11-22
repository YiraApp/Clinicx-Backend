import type { Request, Response } from "express";
import { mobileDashboardService } from "../../services/provider/mobile-dashboard.service.js";
import { ApiResponse } from "../../../../utils/response.utils.js";
import { AppDataSource } from "../../../../config/database.js";
import { User } from "../../../../models/Account/user.model.js";
import { requireTokenActor, actingProfileId, tokenActorId } from "../../../../utils/request-actor.js";
import { requireDoctorView } from "../../../../utils/work-access.js";
import { assertContactChange } from "../../../../utils/contact-change.js";
import { isFamilyLinked } from "../../../../middlewares/request-identity.js";
import { patientAccessConsentService } from "../../services/consent/patient-access-consent.service.js";

/**
 * Retrieves the provider dashboard statistics, todays schedule, recent patients,
 * and graph data for the mobile clinic application.
 */
export const getProviderDashboard = async (req: Request, res: Response) => {
    try {
        const { doctorId, hospitalId, orgId } = req.body;

        if (!doctorId || hospitalId === undefined || orgId === undefined) {
            return res.status(400).json({
                status: false,
                message: "Missing required fields: doctorId, hospitalId, and orgId are all required in request body"
            });
        }

        const parsedHospitalId = Number(hospitalId);
        const parsedOrgId = Number(orgId);

        if (isNaN(parsedHospitalId) || isNaN(parsedOrgId)) {
            return res.status(400).json({
                status: false,
                message: "Invalid parameters: hospitalId and orgId must be valid numbers"
            });
        }

        if (!(await requireDoctorView(req, res, doctorId, parsedHospitalId))) return;
        const result = await mobileDashboardService.getProviderDashboard(doctorId, parsedHospitalId, parsedOrgId);
        return res.json(ApiResponse.success(result, "Dashboard details fetched successfully."));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to retrieve provider dashboard data"
        });
    }
};

/**
 * Retrieves clinical notes for a patient filtered by patientUserId, orgId, hospitalId, and appointmentId.
 */
export const getClinicalData = async (req: Request, res: Response) => {
    try {
        const { userId, patientUserId, patientId, orgId, hospitalId, appointmentId } = req.body;

        const resolvedPatientId = patientId || patientUserId || userId;

        if (!resolvedPatientId || orgId === undefined || hospitalId === undefined) {
            return res.status(400).json({
                status: false,
                message: "Missing required fields: patientId/patientUserId/userId, orgId, and hospitalId are all required in request body"
            });
        }

        const parsedOrgId = Number(orgId);
        const parsedHospitalId = Number(hospitalId);
        const parsedAppointmentId = appointmentId !== undefined ? Number(appointmentId) : undefined;

        if (isNaN(parsedOrgId) || isNaN(parsedHospitalId) || (parsedAppointmentId !== undefined && isNaN(parsedAppointmentId))) {
            return res.status(400).json({
                status: false,
                message: "Invalid parameters: orgId and hospitalId must be valid numbers, and appointmentId must be a number if provided"
            });
        }

        const view = await resolvePatientView(req, String(resolvedPatientId), parsedHospitalId);
        if (view.denied) {
            return res.status(403).json(
                ApiResponse.error("The patient hasn't given you access to their records.", {
                    code: "CONSENT_REQUIRED",
                    consentStatus: view.consentStatus,
                })
            );
        }
        const result = await mobileDashboardService.getPatientClinicalData(
            resolvedPatientId,
            parsedOrgId,
            parsedHospitalId,
            parsedAppointmentId,
            view.scopeDoctorId
        );

        return res.json(ApiResponse.success(result, "Patient clinical data retrieved successfully"));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to retrieve patient clinical data"
        });
    }
};

/**
 * Retrieves the list of patients registered for a specific organization and hospital.
 */
export const getPatientsList = async (req: Request, res: Response) => {
    try {
        const { doctorId, orgId, hospitalId, searchTerm, gender, status, page, pageSize } = req.body;

        if (!doctorId || orgId === undefined || hospitalId === undefined) {
            return res.status(400).json({
                status: false,
                message: "Missing required fields: doctorId, orgId, and hospitalId are all required in request body"
            });
        }

        const parsedOrgId = Number(orgId);
        const parsedHospitalId = Number(hospitalId);

        if (isNaN(parsedOrgId) || isNaN(parsedHospitalId)) {
            return res.status(400).json({
                status: false,
                message: "Invalid parameters: orgId and hospitalId must be valid numbers"
            });
        }

        if (!(await requireDoctorView(req, res, doctorId, parsedHospitalId))) return;
        const result = await mobileDashboardService.getPatientsList(
            doctorId,
            parsedOrgId,
            parsedHospitalId,
            { searchTerm, gender, status, page, pageSize }
        );

        return res.json(ApiResponse.success(result, "Active patient matching log criteria updated."));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to retrieve patients list"
        });
    }
};

// removed getPatientNotes function

/**
 * Retrieves the filter dropdown options for patients (status and gender filters).
 */
export const getPatientsFilters = async (req: Request, res: Response) => {
    try {
        const filter_dropdown_options = {
            status_filters: [
                { id: "01", value: "All" },
                { id: "02", value: "Active" }
            ],
            gender_filters: [
                { id: "01", value: "All" },
                { id: "02", value: "Male" },
                { id: "03", value: "Female" },
                { id: "04", value: "Others" }
            ]
        };

        return res.json(ApiResponse.success({ filter_dropdown_options }, "Filter options retrieved successfully"));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to retrieve filter options"
        });
    }
};

/**
 * What a caller may see of a patient. The patient and their family see everything. A doctor sees the
 * whole history (every doctor, every hospital) only with the patient's consent; without it only his
 * own consultations (scopeDoctorId). Other staff at a hospital the patient visits see that hospital.
 * Anyone else is denied: before this, any signed-in account could read any patient's overview.
 */
async function resolvePatientView(req: Request, patientId: string, hospitalId?: number): Promise<{
    denied: boolean;
    isSelfOrFamily: boolean;
    scopeDoctorId?: string;
    consentStatus?: string;
    recordAccess: { scope: "all" | "doctor" | "hospital"; hasConsent: boolean; treated?: boolean; status?: string };
}> {
    const user = (req as any).user || {};
    const callerIds = [user.userId, user.id, user.tokenUserId]
        .map((id: unknown) => String(id || "").trim())
        .filter((id: string, i: number, all: string[]) => id && all.indexOf(id) === i);
    const requesterId = callerIds[0] || "";
    const pid = patientId.trim();
    let isSelfOrFamily = callerIds.some((id) => id.toLowerCase() === pid.toLowerCase());
    for (const id of callerIds) {
        if (isSelfOrFamily) break;
        isSelfOrFamily = await isFamilyLinked(id, pid).catch(() => false);
    }
    if (isSelfOrFamily) return { denied: false, isSelfOrFamily, recordAccess: { scope: "all", hasConsent: true } };
    if (!requesterId) return { denied: true, isSelfOrFamily, recordAccess: { scope: "doctor", hasConsent: false } };

    const consent = await patientAccessConsentService.checkAccess(pid, requesterId);
    if (consent?.hasAccess) {
        return { denied: false, isSelfOrFamily, recordAccess: { scope: "all", hasConsent: true, status: consent.status } };
    }
    const hospitalAccess = hospitalId
        ? await patientAccessConsentService.checkHospitalRecordAccess(pid, requesterId, { hospitalId })
        : { allowed: false };
    const providerRows = await AppDataSource.query(
        "SELECT TOP 1 Id FROM HealthcareProviders WHERE UserId = @0 AND IsDeleted = 0",
        [requesterId]
    ).catch(() => []);
    const isDoctor = Array.isArray(providerRows) && providerRows.length > 0;
    if (isDoctor && (hospitalAccess.allowed || consent?.treated)) {
        return {
            denied: false,
            isSelfOrFamily,
            scopeDoctorId: requesterId,
            recordAccess: { scope: "doctor", hasConsent: false, treated: !!consent?.treated, status: consent?.status },
        };
    }
    if (hospitalAccess.allowed) {
        return { denied: false, isSelfOrFamily, recordAccess: { scope: "hospital", hasConsent: false, status: consent?.status } };
    }
    return { denied: true, isSelfOrFamily, consentStatus: consent?.status ?? "NO_REQUEST", recordAccess: { scope: "doctor", hasConsent: false } };
}

/**
 * Retrieves the patient's overview information (contact, medical, insurance, and visit history).
 */
export const getPatientOverview = async (req: Request, res: Response) => {
    try {
        const { patientId, orgId, hospitalId } = req.body;

        if (!patientId) {
            return res.status(400).json({
                status: false,
                message: "Missing required field: patientId is required in request body"
            });
        }

        let parsedOrgId = orgId !== undefined && orgId !== null && !isNaN(Number(orgId)) ? Number(orgId) : undefined;
        let parsedHospitalId = hospitalId !== undefined && hospitalId !== null && !isNaN(Number(hospitalId)) && Number(hospitalId) > 0 ? Number(hospitalId) : undefined;

        // If hospitalId was not provided, fallback to the authenticated doctor/provider's hospital
        if (!parsedHospitalId && (req as any).user?.userId) {
            try {
                const docUserId = (req as any).user.userId;
                const { AppDataSource } = await import("../../../../config/database.js");
                const rows = await AppDataSource.query("SELECT HospitalId FROM HealthcareProviders WHERE UserId = @0 AND IsDeleted = 0", [docUserId]);
                if (rows && rows.length > 0 && rows[0].HospitalId) {
                    parsedHospitalId = Number(rows[0].HospitalId);
                }
            } catch (err) {
                // Ignore fallback error
            }
        }

        const view = await resolvePatientView(req, String(patientId), parsedHospitalId);
        if (view.denied) {
            return res.status(403).json(
                ApiResponse.error("The patient hasn't given you access to their records.", {
                    code: "CONSENT_REQUIRED",
                    consentStatus: view.consentStatus,
                })
            );
        }
        if (view.recordAccess.scope === "all" && view.recordAccess.hasConsent && !view.isSelfOrFamily) {
            // Shared with this doctor: the whole history, at every hospital
            parsedOrgId = undefined;
            parsedHospitalId = undefined;
        }
        const scopeDoctorId = view.scopeDoctorId;
        const recordAccess = view.recordAccess;

        const result = await mobileDashboardService.getPatientOverview(patientId, parsedOrgId, parsedHospitalId, scopeDoctorId);

        return res.json(ApiResponse.success({ ...result, record_access: recordAccess }, "Overview details fetched successfully"));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to retrieve patient overview details"
        });
    }
};

/**
 * Retrieves the patient's detailed profile (info, contact, vitals, medical, and insurance).
 */
export const getPatientProfile = async (req: Request, res: Response) => {
    try {
        const { patientId, orgId, hospitalId } = req.body;

        if (!patientId) {
            return res.status(400).json({
                status: false,
                message: "Missing required field: patientId is required in request body"
            });
        }

        const parsedOrgId = orgId !== undefined && orgId !== null && !isNaN(Number(orgId)) ? Number(orgId) : undefined;
        const parsedHospitalId = hospitalId !== undefined && hospitalId !== null && !isNaN(Number(hospitalId)) ? Number(hospitalId) : undefined;

        const view = await resolvePatientView(req, String(patientId), parsedHospitalId);
        if (view.denied) {
            return res.status(403).json(
                ApiResponse.error("The patient hasn't given you access to their records.", {
                    code: "CONSENT_REQUIRED",
                    consentStatus: view.consentStatus,
                })
            );
        }

        const result = await mobileDashboardService.getPatientProfile(patientId, parsedOrgId, parsedHospitalId, view.scopeDoctorId);

        return res.json(ApiResponse.success(result, "Patient profile data retrieved successfully"));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to retrieve patient profile details"
        });
    }
};

/**
 * Retrieves the sidebar menu for the user based on role, organization, and hospital.
 */
export const getSidebarMenu = async (req: Request, res: Response) => {
    try {
        const { roleId, latestRoleId, orgId, latestOrgId, hospitalId, latestHospitalId, hospId } = req.body || {};

        const resolvedRoleId = roleId || latestRoleId || (req as any).user?.roleId || (req as any).user?.latestRoleId;

        if (!resolvedRoleId) {
            return res.status(400).json({
                status: false,
                message: "Missing required field: roleId is required in request body"
            });
        }

        const resolvedOrgId = orgId !== undefined ? Number(orgId) : (latestOrgId !== undefined ? Number(latestOrgId) : null);
        const resolvedHospitalId = (hospitalId !== undefined 
            ? Number(hospitalId) 
            : (latestHospitalId !== undefined 
                ? Number(latestHospitalId) 
                : (hospId !== undefined ? Number(hospId) : null)));

        const parsedOrgId = resolvedOrgId && !isNaN(resolvedOrgId) ? resolvedOrgId : null;
        const parsedHospitalId = resolvedHospitalId && !isNaN(resolvedHospitalId) ? resolvedHospitalId : null;

        const { sidebarService } = await import("../../../../services/Common/sidebar.service.js");
        const menu = await sidebarService.getMobileSidebarMenu(
            resolvedRoleId as string,
            parsedOrgId,
            parsedHospitalId
        );

        const mappedData = menu.map((item) => ({
            title: item.MenuName,
            taskCode: item.TaskCode || "",
            taskId: item.TaskId || 0,
            ImagePath: item.ImagePath || "",
            icon: item.Icon || "",
            useImage: item.UseImage ? 1 : 0
        }));

        return res.json({
            status: true,
            message: "SideMenu Details fetched successfully",
            data: mappedData
        });
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to retrieve sidebar menu"
        });
    }
};

/**
 * Retrieves the comprehensive profile of the authenticated healthcare provider / doctor.
 */
export const getProviderProfile = async (req: Request, res: Response) => {
    try {
        const { doctorId, userId, hospitalId, orgId } = req.body;
        const targetUserId = doctorId || userId || (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id || (req as any).userId;

        if (!targetUserId) {
            return res.status(400).json({
                status: false,
                message: "Doctor/User ID is required"
            });
        }

        const result = await mobileDashboardService.getProviderProfile(
            targetUserId,
            hospitalId ? Number(hospitalId) : undefined,
            orgId ? Number(orgId) : undefined
        );
        return res.json(ApiResponse.success(result, "Provider profile data retrieved successfully"));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to retrieve provider profile details"
        });
    }
};

/** The profile being edited, when it is the signed-in person's own or their family's. Answers otherwise. */
async function requireEditableProfile(req: Request, res: Response, targetUserId: string): Promise<User | null> {
    const signedIn = requireTokenActor(req, res);
    if (!signedIn) return null;
    const open = actingProfileId(req) || signedIn;
    const mine = (await isFamilyLinked(signedIn, targetUserId)) || (await isFamilyLinked(open, targetUserId));
    const target = mine ? await AppDataSource.getRepository(User).findOne({ where: { Id: targetUserId, IsDeleted: false } }) : null;
    if (!target) res.status(403).json({ status: false, message: "You can only edit your own profile or your family's." });
    return target;
}

/**
 * Updates doctor personal and professional profile details.
 */
export const updateProviderProfile = async (req: Request, res: Response) => {
    try {
        const { doctorId, userId, patientId } = req.body;
        const targetUserId = userId || patientId || doctorId || (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id || (req as any).userId;

        if (!targetUserId) {
            return res.status(400).json({
                status: false,
                message: "Doctor/User ID is required"
            });
        }

        const target = await requireEditableProfile(req, res, String(targetUserId));
        if (!target) return;
        await assertContactChange(tokenActorId(req), target, { phone: req.body.phoneNumber, email: req.body.email });
        const result = await mobileDashboardService.updateProviderProfile(targetUserId, req.body);
        return res.json(ApiResponse.success(result, "Doctor profile updated successfully"));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to update doctor profile"
        });
    }
};

/**
 * Uploads doctor profile photo.
 */
export const uploadProviderProfilePhoto = async (req: Request, res: Response) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({
                status: false,
                message: "No photo file uploaded"
            });
        }

        const { doctorId, userId, patientId } = req.body;
        const targetUserId = userId || patientId || doctorId || (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id || (req as any).userId;

        if (!targetUserId) {
            return res.status(400).json({
                status: false,
                message: "Doctor/User ID is required"
            });
        }

        if (!(await requireEditableProfile(req, res, String(targetUserId)))) return;
        const result = await mobileDashboardService.uploadProviderPhoto(targetUserId, file);
        return res.json(ApiResponse.success(result, "Doctor profile photo uploaded successfully"));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to upload profile photo"
        });
    }
};

/**
 * Toggles a patient's favorite status for a doctor.
 */
export const toggleFavoritePatient = async (req: Request, res: Response) => {
    try {
        const { doctorId, patientId, isFavorite } = req.body;
        const currentDocId = doctorId || (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id || (req as any).userId || "default";

        if (!patientId) {
            return res.status(400).json({
                status: false,
                message: "Missing patientId"
            });
        }

        if (!(await requireDoctorView(req, res, currentDocId, Number(req.body.hospitalId) || undefined))) return;
        const result = await mobileDashboardService.toggleFavoritePatient(currentDocId, patientId, isFavorite);
        return res.json(ApiResponse.success(result, "Favorite status updated successfully"));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to toggle favorite status"
        });
    }
};

/**
 * Retrieves all favorite patients for a doctor.
 */
export const getFavoritePatientsList = async (req: Request, res: Response) => {
    try {
        const { doctorId, orgId, hospitalId } = req.body;
        const currentDocId = doctorId || (req as any).user?.userId || (req as any).user?.Id || (req as any).user?.id || (req as any).userId || "default";
        const parsedOrgId = Number(orgId || 1);
        const parsedHospitalId = Number(hospitalId || 1);

        if (!(await requireDoctorView(req, res, currentDocId, parsedHospitalId))) return;
        const result = await mobileDashboardService.getFavoritePatients(currentDocId, parsedOrgId, parsedHospitalId);
        return res.json(ApiResponse.success(result, "Favorite patients retrieved successfully"));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to retrieve favorite patients"
        });
    }
};


/**
 * Deactivates (soft-deletes) a user account by setting Status = false and IsDeleted = true.
 */
export const deactivateUserAccount = async (req: Request, res: Response) => {
    try {
        const { userId } = req.body;
        // Deleting an account needs a signed-in token; a claimed userId + deviceId is not enough.
        const requesterId = requireTokenActor(req, res);
        if (!requesterId) return;
        const targetUserId = String(userId || requesterId || "").trim();

        if (!targetUserId) {
            return res.status(400).json({
                status: false,
                message: "User ID is required"
            });
        }
        // Only your own account, or a dependent under it (never someone else's, and never a linked
        // family member's own account): before this check any signed-in user could delete any account.
        if (targetUserId.toUpperCase() !== requesterId.toUpperCase()) {
            const users = AppDataSource.getRepository(User);
            const [requester, target] = await Promise.all([
                users.findOne({ where: { Id: requesterId, IsDeleted: false }, select: { Id: true, ParentUserId: true } }),
                users.findOne({ where: { Id: targetUserId, IsDeleted: false }, select: { Id: true, ParentUserId: true } }),
            ]);
            const holder = (requester?.ParentUserId || requester?.Id || "").toUpperCase();
            const isOwnDependent = !!target?.ParentUserId && !!holder
                && target.ParentUserId.toUpperCase() === holder && target.Id.toUpperCase() !== holder;
            if (!isOwnDependent) {
                return res.status(403).json({ status: false, message: "You can only delete your own account or a family member you added." });
            }
        }

        const result = await mobileDashboardService.deactivateAccount(targetUserId);
        return res.json(ApiResponse.success(result, "Account deleted successfully"));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to delete account"
        });
    }
};
