import type { Request, Response } from "express";
import { mobileAppointmentService } from "../../services/provider/mobile-appointment.service.js";
import { ApiResponse } from "../../../../utils/response.utils.js";
import { healthcareProviderScheduleSlotRepository } from "../../../../repositories/Organizations/healthcare-provider-schedule-slot.repository.js";
import { healthcareProviderService } from "../../../../services/Organizations/healthcare-provider.service.js";
import { healthcareProviderRepository } from "../../../../repositories/Organizations/healthcare-provider.repository.js";

/**
 * Retrieves provider appointment dashboard stats and filtered appointment list.
 */
export const getAppointmentDashboard = async (req: Request, res: Response) => {
    try {
        console.log("getAppointmentDashboard called with body:", req.body);
        const { doctorId, hospitalId, orgId, date, dateFrom, dateTo, status, search } = req.body;

        if (!doctorId || hospitalId === undefined || orgId === undefined) {
            console.log("getAppointmentDashboard Validation Failed: missing doctorId, hospitalId, or orgId");
            return res.status(400).json({
                status: false,
                message: "Missing required fields: doctorId, hospitalId, and orgId are required in request body"
            });
        }

        const parsedHospitalId = Number(hospitalId);
        const parsedOrgId = Number(orgId);

        if (isNaN(parsedHospitalId) || isNaN(parsedOrgId)) {
            console.log("getAppointmentDashboard Validation Failed: hospitalId/orgId NaN", { parsedHospitalId, parsedOrgId });
            return res.status(400).json({
                status: false,
                message: "Invalid parameters: hospitalId and orgId must be valid numbers"
            });
        }

        const result = await mobileAppointmentService.getAppointmentDashboard(
            doctorId,
            parsedHospitalId,
            parsedOrgId,
            { date, dateFrom, dateTo, status, search }
        );

        return res.json(ApiResponse.success(result, "Appointment dashboard data retrieved successfully."));
    } catch (error: any) {
        console.error("getAppointmentDashboard Error:", error);
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to retrieve appointment dashboard data"
        });
    }
};

/**
 * Creates a new appointment for a patient in mobile context.
 */
export const bookAppointment = async (req: Request, res: Response) => {
    try {
        const {
            doctorId,
            hospitalId,
            orgId,
            patientName,
            patientPhone,
            gender,
            dob,
            appointmentDate,
            startTime,
            reason,
            appointmentType,
            isTeleConsultation,
            parentAppointmentId,
            treatmentPlanIds,
            customTreatmentPlans,
            discountAmount
        } = req.body;

        if (!doctorId || hospitalId === undefined || orgId === undefined || !patientPhone) {
            return res.status(400).json({
                status: false,
                message: "Missing required fields: doctorId, hospitalId, orgId, and patientPhone are required"
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

        const result = await mobileAppointmentService.bookAppointment({
            doctorId,
            hospitalId: parsedHospitalId,
            orgId: parsedOrgId,
            patientName,
            patientPhone,
            gender,
            dob,
            appointmentDate: appointmentDate || new Date().toISOString().split("T")[0],
            startTime: startTime || "10:00:00",
            reason,
            appointmentType,
            isTeleConsultation,
            parentAppointmentId: parentAppointmentId ? Number(parentAppointmentId) : null,
            treatmentPlanIds: Array.isArray(treatmentPlanIds) ? treatmentPlanIds : [],
            customTreatmentPlans: Array.isArray(customTreatmentPlans) ? customTreatmentPlans : [],
            discountAmount: discountAmount ? Number(discountAmount) : 0
        });

        return res.json(ApiResponse.success(result, "Appointment booked successfully."));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to book appointment"
        });
    }
};

/**
 * Updates the status of an existing appointment.
 */
export const updateAppointmentStatus = async (req: Request, res: Response) => {
    try {
        const { appointmentId, status } = req.body;
        if (!appointmentId || !status) {
            return res.status(400).json({
                status: false,
                message: "appointmentId and status are required"
            });
        }

        const result = await mobileAppointmentService.updateAppointmentStatus(appointmentId, status);
        return res.json(ApiResponse.success(result, "Appointment status updated successfully."));
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to update appointment status"
        });
    }
};

/**
 * Retrieves available doctor schedule slots for a given date.
 */
export const getMobileDoctorSlots = async (req: Request, res: Response) => {
    try {
        const { doctorId, hospitalId, date } = req.body;
        const dateStr = date || new Date().toISOString().split("T")[0];

        const hospIdNum = Number(hospitalId) || 1;
        const provider = await healthcareProviderRepository.findByUserIdAndHospital(doctorId, hospIdNum);
        const providerIdNum = provider ? provider.Id : (Number(doctorId) || 1);

        const [y, m, d] = dateStr.split("-").map(Number);
        const targetDate = new Date(y, m - 1, d);

        const slots = await healthcareProviderScheduleSlotRepository.getSlots(providerIdNum, hospIdNum, targetDate, targetDate);

        let formattedSlots: Array<{ id: string; startTime: string; endTime: string; label: string; isAvailable: boolean; isBooked: boolean; isBlocked: boolean; patientName?: string; appointmentType?: string; appointmentId?: string; reason?: string }> = [];

        if (slots && slots.length > 0) {
            formattedSlots = slots.map(s => {
                let patientName = undefined;
                let appointmentType = undefined;
                let appointmentId = undefined;
                let reason = undefined;
                
                if (s.IsBooked && s.Appointments && s.Appointments.length > 0) {
                    const activeAppt = s.Appointments.find(appt => 
                        appt.Status && !["cancelled", "canceled", "no show", "noshow", "rescheduled"].includes(appt.Status.toLowerCase())
                    );
                    if (activeAppt) {
                        appointmentId = String(activeAppt.Id);
                        if (activeAppt.User) {
                            const u = activeAppt.User;
                            patientName = [u.FirstName, u.LastName].filter(Boolean).join(" ") || u.Email || "Patient";
                        }
                        appointmentType = activeAppt.AppointmentType || 'Regular Check-up';
                        reason = activeAppt.Reason || undefined;
                    }
                }

                return {
                    id: String(s.Id),
                    startTime: s.StartTime,
                    endTime: s.EndTime,
                    label: `${s.StartTime} - ${s.EndTime}`,
                    isAvailable: s.IsAvailable && !s.IsBooked,
                    isBooked: s.IsBooked,
                    isBlocked: !s.IsAvailable && !s.IsBooked,
                    patientName: patientName,
                    appointmentType: appointmentType,
                    appointmentId: appointmentId,
                    reason: reason
                };
            });
        }

        return res.json(ApiResponse.success({ date: dateStr, slots: formattedSlots }, "Doctor slots fetched successfully."));
    } catch (error: any) {
        console.error("getMobileDoctorSlots error:", error);
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to fetch doctor slots"
        });
    }
};

/**
 * Deploy manual doctor slots for a given date.
 */
export const deployMobileDoctorSlots = async (req: Request, res: Response) => {
    try {
        const { doctorId, hospitalId, date, slots } = req.body;
        if (!doctorId || !hospitalId || !date || !Array.isArray(slots)) {
            return res.status(400).json({
                status: false,
                message: "doctorId, hospitalId, date, and slots array are required"
            });
        }

        const hospIdNum = Number(hospitalId) || 1;
        const provider = await healthcareProviderRepository.findByUserIdAndHospital(doctorId, hospIdNum);
        const providerIdNum = provider ? provider.Id : (Number(doctorId) || 1);

        const result = await healthcareProviderService.generateManualSlots(
            providerIdNum,
            hospIdNum,
            date,
            slots,
            true // overwrite
        );

        return res.json(ApiResponse.success(result, "Doctor slots deployed successfully."));
    } catch (error: any) {
        console.error("deployMobileDoctorSlots error:", error);
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to deploy doctor slots"
        });
    }
};

/**
 * Block or unblock a doctor slot.
 */
export const blockMobileDoctorSlot = async (req: Request, res: Response) => {
    try {
        const { slotId, block } = req.body;
        if (!slotId) {
            return res.status(400).json({
                status: false,
                message: "slotId is required"
            });
        }

        const shouldBlock = block !== undefined ? Boolean(block) : true;
        const result = await healthcareProviderScheduleSlotRepository.updateSlotStatus(
            Number(slotId),
            { isAvailable: !shouldBlock }
        );

        if (!result) {
            return res.status(404).json({
                status: false,
                message: "Slot not found"
            });
        }

        return res.json(ApiResponse.success(result, shouldBlock ? "Slot blocked successfully." : "Slot unblocked successfully."));
    } catch (error: any) {
        console.error("blockMobileDoctorSlot error:", error);
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to update slot status"
        });
    }
};

/**
 * Retrieves treatment plans for the organization and hospital.
 */
export const getTreatmentPlans = async (req: Request, res: Response) => {
    try {
        const orgId = req.query.orgId || req.body.orgId;
        const hospitalId = req.query.hospitalId || req.body.hospitalId;
        const search = req.query.search || req.body.search || "";

        const parsedOrgId = orgId ? Number(orgId) : 1;
        const parsedHospId = hospitalId ? Number(hospitalId) : undefined;

        const { treatmentPlanService } = await import("../../../../services/Payments/treatment-plan.service.js");
        const plans = await treatmentPlanService.getPlans(
            parsedOrgId,
            parsedHospId,
            String(search)
        );

        return res.json(ApiResponse.success(plans, "Treatment plans retrieved successfully."));
    } catch (error: any) {
        console.error("getTreatmentPlans Error:", error);
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to retrieve treatment plans"
        });
    }
};

/**
 * Retrieves previous appointments for a patient (to support linking appointments).
 */
export const getPatientAppointments = async (req: Request, res: Response) => {
    try {
        const { patientPhone, userId, orgId } = req.body;
        const { Appointment } = await import("../../../../models/Appointments/appointment.model.js");
        const { AppDataSource } = await import("../../../../config/database.js");

        const apptRepo = AppDataSource.getRepository(Appointment);
        const qb = apptRepo.createQueryBuilder("a")
            .leftJoinAndSelect("a.User", "u")
            .leftJoinAndSelect("a.Doctor", "d")
            .where("a.Status != :cancelledStatus", { cancelledStatus: "Cancelled" })
            .orderBy("a.AppointmentDate", "DESC")
            .addOrderBy("a.StartTime", "DESC")
            .take(25);

        if (userId) {
            qb.andWhere("a.UserId = :userId", { userId });
        } else if (patientPhone) {
            const cleanPhone = String(patientPhone).replace(/\D/g, "");
            const last10 = cleanPhone.slice(-10);
            qb.andWhere("(u.PhoneNumber = :cleanPhone OR u.PhoneNumber LIKE :last10)", { cleanPhone, last10: `%${last10}` });
        }

        if (orgId) {
            qb.andWhere("a.OrgId = :orgId", { orgId: Number(orgId) });
        }

        const appts = await qb.getMany();
        const formatted = appts.map(a => ({
            id: a.Id,
            appointmentDate: a.AppointmentDate,
            startTime: a.StartTime,
            appointmentType: a.AppointmentType,
            status: a.Status,
            reason: a.Reason,
            doctorName: a.Doctor ? `Dr. ${a.Doctor.FirstName || ''} ${a.Doctor.LastName || ''}`.trim() : "Doctor",
            patientName: a.User ? `${a.User.FirstName || ''} ${a.User.LastName || ''}`.trim() : "Patient"
        }));

        return res.json(ApiResponse.success(formatted, "Patient appointments fetched successfully."));
    } catch (error: any) {
        console.error("getPatientAppointments Error:", error);
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to fetch patient appointments"
        });
    }
};
