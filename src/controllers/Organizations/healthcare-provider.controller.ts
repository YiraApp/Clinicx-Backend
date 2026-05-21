import type { Request, Response } from "express";
import { healthcareProviderService } from "../../services/Organizations/healthcare-provider.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

export class HealthcareProviderController {
    async onboard(req: Request, res: Response) {
        try {
            const result = await healthcareProviderService.onboardProvider(req.body);
            return res.json(ApiResponse.success(result, "Provider onboarded successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async getDoctors(req: Request, res: Response) {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const pageSize = parseInt(req.query.pageSize as string) || 10;
            const organizationId = req.query.organizationId ? Number(req.query.organizationId) : undefined;
            const hospitalId = req.query.hospitalId ? Number(req.query.hospitalId) : undefined;
            const search = req.query.search as string;
            const status = req.query.status as string;

            // Convert string status to boolean for the repository
            let statusBool: boolean | undefined = undefined;
            if (status === "active" || status === "true") statusBool = true;
            else if (status === "inactive" || status === "false") statusBool = false;


            const result = await healthcareProviderService.getDoctors(page, pageSize, {
                organizationId,
                hospitalId,
                search,
                status: statusBool
            });


            return res.json(ApiResponse.success(result, "Doctors fetched successfully."));
        } catch (error: any) {
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async getDoctorById(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            if (isNaN(id)) return res.status(400).json(ApiResponse.error("Invalid doctor ID"));

            const result = await healthcareProviderService.getDoctorById(id);
            if (!result) return res.status(404).json(ApiResponse.error("Doctor not found"));

            return res.json(ApiResponse.success(result, "Doctor details fetched successfully."));
        } catch (error: any) {
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async update(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            if (isNaN(id)) return res.status(400).json(ApiResponse.error("Invalid doctor ID"));

            const result = await healthcareProviderService.updateProvider(id, req.body);
            return res.json(ApiResponse.success(result, "Doctor profile updated successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async getSlots(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            const hospitalId = parseInt(req.query.hospitalId as string);
            const { startDate, endDate } = req.query;

            if (isNaN(id) || isNaN(hospitalId)) {
                return res.status(400).json(ApiResponse.error("Doctor ID and Hospital ID are required and must be valid numbers"));
            }

            const slots = await healthcareProviderService.getDoctorSlots(
                id, 
                hospitalId, 
                startDate as string, 
                endDate as string
            );
            return res.json(ApiResponse.success(slots, "Doctor slots fetched successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async generateSlots(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            const hospitalId = parseInt(req.body.hospitalId as string);
            const { startDate, endDate, slotDuration, overwrite } = req.body;

            if (isNaN(id) || isNaN(hospitalId) || !startDate || !endDate) {
                return res.status(400).json(ApiResponse.error("Missing or invalid parameters: id, hospitalId, startDate, endDate must be valid"));
            }

            const result = await healthcareProviderService.generateSlotsForDateRange(
                id, 
                hospitalId, 
                startDate, 
                endDate,
                slotDuration ? Number(slotDuration) : 15,
                overwrite === true || overwrite === 'true'
            );
            return res.json(ApiResponse.success(result, "Slots generated successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async generateManualSlots(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            const hospitalId = parseInt(req.body.hospitalId as string);
            const { date, slots, overwrite } = req.body;

            if (isNaN(id) || isNaN(hospitalId) || !date || !Array.isArray(slots)) {
                return res.status(400).json(ApiResponse.error("Missing or invalid parameters: id, hospitalId, date, and slots (array) are required"));
            }

            const result = await healthcareProviderService.generateManualSlots(
                id,
                hospitalId,
                date,
                slots,
                overwrite === true || overwrite === 'true'
            );
            return res.json(ApiResponse.success(result, "Manual slots generated successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async updateSchedule(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            if (isNaN(id)) return res.status(400).json(ApiResponse.error("Invalid doctor ID"));

            const result = await healthcareProviderService.updateWeeklySchedule(id, req.body);
            return res.json(ApiResponse.success(result, "Weekly schedule updated successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async updateSlotStatus(req: Request, res: Response) {
        try {
            const slotId = parseInt(req.params.slotId as string);
            if (isNaN(slotId)) return res.status(400).json(ApiResponse.error("Invalid slot ID"));

            const { status, isAvailable } = req.body;

            const result = await healthcareProviderService.updateSlotStatus(slotId, { status, isAvailable });
            return res.json(ApiResponse.success(result, "Slot status updated successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }
}



export const healthcareProviderController = new HealthcareProviderController();
