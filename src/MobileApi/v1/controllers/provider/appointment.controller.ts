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
            isTeleConsultation
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
            isTeleConsultation
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

        let slots = await healthcareProviderScheduleSlotRepository.getSlots(providerIdNum, hospIdNum, targetDate, targetDate);

        if (!slots || slots.length === 0) {
            try {
                await healthcareProviderService.generateSlotsForDateRange(
                    providerIdNum,
                    hospIdNum,
                    dateStr,
                    dateStr,
                    30,
                    0,
                    false
                );
                slots = await healthcareProviderScheduleSlotRepository.getSlots(providerIdNum, hospIdNum, targetDate, targetDate);
            } catch (genErr) {
                console.log("Auto-generate slots fallback:", genErr);
            }
        }

        let formattedSlots: Array<{ id: string; startTime: string; endTime: string; label: string; isAvailable: boolean; isBooked: boolean; patientName?: string; appointmentType?: string }> = [];

        if (slots && slots.length > 0) {
            formattedSlots = slots.map(s => {
                let patientName = undefined;
                let appointmentType = undefined;
                
                if (s.IsBooked && s.Appointments && s.Appointments.length > 0) {
                    const activeAppt = s.Appointments.find(appt => 
                        appt.Status && !["cancelled", "canceled", "no show", "noshow", "rescheduled"].includes(appt.Status.toLowerCase())
                    );
                    if (activeAppt) {
                        if (activeAppt.User) {
                            patientName = `${activeAppt.User.FirstName || ''} ${activeAppt.User.LastName || ''}`.trim() || activeAppt.User.Email || undefined;
                        }
                        appointmentType = activeAppt.AppointmentType || 'Regular Check-up';
                    }
                }

                return {
                    id: String(s.Id),
                    startTime: s.StartTime,
                    endTime: s.EndTime,
                    label: `${s.StartTime} - ${s.EndTime}`,
                    isAvailable: s.IsAvailable && !s.IsBooked,
                    isBooked: s.IsBooked,
                    patientName: patientName,
                    appointmentType: appointmentType
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
