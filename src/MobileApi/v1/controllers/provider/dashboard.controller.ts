import type { Request, Response } from "express";
import { mobileDashboardService } from "../../services/provider/mobile-dashboard.service.js";
import { ApiResponse } from "../../../../utils/response.utils.js";

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

        const result = await mobileDashboardService.getPatientClinicalData(
            resolvedPatientId,
            parsedOrgId,
            parsedHospitalId,
            parsedAppointmentId
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
        const { doctorId, orgId, hospitalId, searchTerm, gender, status } = req.body;

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

        const result = await mobileDashboardService.getPatientsList(
            doctorId,
            parsedOrgId,
            parsedHospitalId,
            { searchTerm, gender, status }
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
 * Retrieves the patient's overview information (contact, medical, insurance, and visit history).
 */
export const getPatientOverview = async (req: Request, res: Response) => {
    try {
        const { patientId, orgId, hospitalId } = req.body;

        if (!patientId || orgId === undefined || hospitalId === undefined) {
            return res.status(400).json({
                status: false,
                message: "Missing required fields: patientId, orgId, and hospitalId are all required in request body"
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

        const result = await mobileDashboardService.getPatientOverview(patientId, parsedOrgId, parsedHospitalId);

        return res.json(ApiResponse.success(result, "Overview details fetched successfully"));
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

        if (!patientId || orgId === undefined || hospitalId === undefined) {
            return res.status(400).json({
                status: false,
                message: "Missing required fields: patientId, orgId, and hospitalId are all required in request body"
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

        const result = await mobileDashboardService.getPatientProfile(patientId, parsedOrgId, parsedHospitalId);

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
        const { roleId, orgId, hospitalId, hospId } = req.body;

        if (!roleId) {
            return res.status(400).json({
                status: false,
                message: "Missing required field: roleId is required in request body"
            });
        }

        const resolvedOrgId = orgId !== undefined ? Number(orgId) : null;
        const resolvedHospitalId = (hospitalId !== undefined ? Number(hospitalId) : (hospId !== undefined ? Number(hospId) : null));

        const parsedOrgId = resolvedOrgId && !isNaN(resolvedOrgId) ? resolvedOrgId : null;
        const parsedHospitalId = resolvedHospitalId && !isNaN(resolvedHospitalId) ? resolvedHospitalId : null;

        const { sidebarService } = await import("../../../../services/Common/sidebar.service.js");
        const menu = await sidebarService.getMobileSidebarMenu(
            roleId as string,
            parsedOrgId,
            parsedHospitalId
        );

        const mappedData = menu.map((item) => ({
            title: item.MenuName,
            taskCode: item.TaskCode || "",
            taskId: item.TaskId || "",
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
