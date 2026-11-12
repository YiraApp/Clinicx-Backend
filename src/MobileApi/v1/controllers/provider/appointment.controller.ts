import type { Request, Response } from "express";
import { mobileAppointmentService } from "../../services/provider/mobile-appointment.service.js";
import { ApiResponse } from "../../../../utils/response.utils.js";
import { healthcareProviderScheduleSlotRepository } from "../../../../repositories/Organizations/healthcare-provider-schedule-slot.repository.js";
import { healthcareProviderService } from "../../../../services/Organizations/healthcare-provider.service.js";
import { healthcareProviderRepository } from "../../../../repositories/Organizations/healthcare-provider.repository.js";
import { familyLinkService } from "../../../../services/Family/family-link.service.js";
import { requireTokenActor, actingProfileId, sameUserId } from "../../../../utils/request-actor.js";
import { isFamilyLinked, isSameFamily } from "../../../../middlewares/request-identity.js";
import { canManageHospital } from "../../../../utils/staff-access.js";

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
            patientUserId,
            parentUserId,
            relation,
            isPrimary,
            patientName,
            patientPhone,
            patientEmail,
            email,
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
            discountAmount,
            includeConsultationFee,
            consultationFee,
            shareRecords,
            grantRecordAccess
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
            // The patient the app picked; without these the patient was guessed from phone + name,
            // which made duplicate accounts or booked a family member with the same first name
            patientUserId: patientUserId ? String(patientUserId).trim() : undefined,
            parentUserId: parentUserId ? String(parentUserId).trim() : undefined,
            relation: relation ? String(relation).trim() : undefined,
            isPrimary: typeof isPrimary === "boolean" ? isPrimary : undefined,
            patientName,
            patientPhone,
            email: (patientEmail || email || "").trim() || undefined,
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
            discountAmount: discountAmount ? Number(discountAmount) : 0,
            includeConsultationFee: includeConsultationFee !== undefined ? Boolean(includeConsultationFee) : true,
            consultationFee: consultationFee !== undefined ? Number(consultationFee) : undefined,
            shareRecords: shareRecords !== undefined ? Boolean(shareRecords) : (grantRecordAccess !== undefined ? Boolean(grantRecordAccess) : true)
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
        const { appointmentId, patientId, doctorId, status } = req.body;
        if ((!appointmentId && !patientId) || !status) {
            return res.status(400).json({
                status: false,
                message: "appointmentId or patientId, and status are required"
            });
        }

        const requester = (req as any).user;
        const requesterId = String(requester?.userId || requester?.Id || requester?.id || "").trim();
        if (!requesterId) {
            return res.status(401).json({ status: false, message: "Sign in again to change this appointment." });
        }
        const effectiveDoctorId = doctorId;
        const result = await mobileAppointmentService.updateAppointmentStatus({
            appointmentId: appointmentId ? String(appointmentId) : undefined,
            patientId: patientId ? String(patientId) : undefined,
            doctorId: effectiveDoctorId ? String(effectiveDoctorId) : undefined,
            status: String(status),
            // Only the appointment's doctor, its patient's family, or its hospital's staff may change it
            requesterId
        });
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
                            patientName = `${activeAppt.User.FirstName || ''} ${activeAppt.User.LastName || ''}`.trim() || activeAppt.User.Email || undefined;
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
                    patientName: patientName || undefined,
                    appointmentType: appointmentType || undefined,
                    appointmentId: appointmentId || undefined,
                    reason: reason || undefined
                };
            });
        }

        const breaks: Array<{ id: string; fromTime: string; toTime: string; label: string }> = [];
        if (slots && slots.length > 1) {
            const timeToMins = (t: string) => {
                const [h, m] = t.split(':').map(Number);
                return h * 60 + m;
            };

            const sortedSlots = [...slots].sort((a, b) => timeToMins(a.StartTime) - timeToMins(b.StartTime));
            let breakIdx = 1;
            for (let i = 0; i < sortedSlots.length - 1; i++) {
                const currentEndMins = timeToMins(sortedSlots[i].EndTime);
                const nextStartMins = timeToMins(sortedSlots[i + 1].StartTime);
                const gap = nextStartMins - currentEndMins;
                if (gap >= 15) {
                    breaks.push({
                        id: `break_${breakIdx}`,
                        fromTime: sortedSlots[i].EndTime,
                        toTime: sortedSlots[i + 1].StartTime,
                        label: `Break ${breakIdx}`
                    });
                    breakIdx++;
                }
            }
        }

        const consultationFee = (provider?.ConsultationFee !== undefined && provider?.ConsultationFee !== null)
            ? Number(provider.ConsultationFee)
            : 0;

        return res.json(ApiResponse.success({ date: dateStr, slots: formattedSlots, breaks, consultationFee }, "Doctor slots fetched successfully."));
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
        const { doctorId, hospitalId, date, slots, breakTimes, breaks } = req.body;
        if (!doctorId || !hospitalId || !date || !Array.isArray(slots)) {
            return res.status(400).json({
                status: false,
                message: "doctorId, hospitalId, date, and slots array are required"
            });
        }

        const hospIdNum = Number(hospitalId) || 1;
        const provider = await healthcareProviderRepository.findByUserIdAndHospital(doctorId, hospIdNum);
        const providerIdNum = provider ? provider.Id : (Number(doctorId) || 1);

        const effectiveBreaks = Array.isArray(breakTimes) ? breakTimes : (Array.isArray(breaks) ? breaks : []);

        const result = await healthcareProviderService.generateManualSlots(
            providerIdNum,
            hospIdNum,
            date,
            slots,
            true, // overwrite
            effectiveBreaks
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
        // The app lists plans to attach to a booking: Active ones only
        const plans = await treatmentPlanService.getPlans(
            parsedOrgId,
            parsedHospId,
            String(search),
            true
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
        const { userId, hospitalId } = req.body;
        const { Appointment } = await import("../../../../models/Appointments/appointment.model.js");
        const { User } = await import("../../../../models/Account/user.model.js");
        const { AppDataSource } = await import("../../../../config/database.js");
        const { isFamilyLinked } = await import("../../../../middlewares/request-identity.js");

        // Whose appointments: the profile asked for, which must be the caller or
        // their family. (A phone number in the body used to replace this, which
        // let anyone list appointments for any phone.)
        const requesterId = String((req as any).user?.userId || (req as any).user?.id || "").trim();
        const targetId = String(userId || requesterId || "").trim();
        if (!targetId) {
            return res.status(400).json(ApiResponse.error("User ID is required"));
        }
        if (requesterId && targetId.toLowerCase() !== requesterId.toLowerCase() && !(await isFamilyLinked(requesterId, targetId))) {
            return res.status(403).json(ApiResponse.error("You can only see appointments for yourself and your family."));
        }

        // The main account also sees its family members' appointments, each
        // marked with who it is for. A family member's own profile sees only theirs.
        const userRepo = AppDataSource.getRepository(User);
        const target = await userRepo.findOne({ where: { Id: targetId } as any });
        const patientIds = new Set<string>([targetId]);
        const onlySelf = req.body?.onlySelf === true || req.body?.includeFamily === false || req.query?.onlySelf === "true" || req.query?.includeFamily === "false";
        if (target && !target.ParentUserId && target.IsPrimary && !onlySelf) {
            const last10 = String(target.PhoneNumber || "").replace(/\D/g, "").slice(-10);
            // Family members by parent account and by phone number, looked up together.
            const [children, samePhone] = await Promise.all([
                userRepo.find({ where: { ParentUserId: target.Id, IsDeleted: false } as any, select: ["Id"] as any }),
                last10.length === 10
                    ? userRepo
                        .createQueryBuilder("u")
                        .select("u.Id", "Id")
                        .where("RIGHT(u.PhoneNumber, 10) = :last10", { last10 })
                        .andWhere("u.IsDeleted = 0")
                        .getRawMany()
                    : Promise.resolve([] as any[]),
            ]);
            children.forEach((c: any) => patientIds.add(c.Id));
            samePhone.forEach((r: any) => patientIds.add(r.Id));
        }

        const apptRepo = AppDataSource.getRepository(Appointment);
        const qb = apptRepo.createQueryBuilder("a")
            .leftJoinAndSelect("a.User", "u")
            .leftJoinAndSelect("a.Doctor", "d")
            .leftJoinAndSelect("a.Hospital", "h")
            .leftJoinAndSelect("a.Organization", "o")
            .where("a.UserId IN (:...patientIds)", { patientIds: [...patientIds] })
            .orderBy("a.AppointmentDate", "DESC")
            .addOrderBy("a.StartTime", "DESC")
            // Every join is to one row (patient, doctor, hospital, organization), so a plain limit
            // returns the same 100 appointments in one query; take() made TypeORM page the ids
            // in a separate DISTINCT query first.
            .limit(100);

        if (hospitalId && Number(hospitalId) > 0) {
            qb.andWhere("a.HospitalId = :hospitalId", { hospitalId: Number(hospitalId) });
        }

        const appts = await qb.getMany();

        // Enrich appointments with healthcare provider details (specialty, qualification, experience, fee)
        const { HealthcareProvider } = await import("../../../../models/Organizations/healthcare-provider.model.js");
        const hpRepo = AppDataSource.getRepository(HealthcareProvider);
        const doctorIds = Array.from(new Set(appts.map(a => a.DoctorId).filter(Boolean)));
        let providersMap: Record<string, any> = {};
        if (doctorIds.length > 0) {
            try {
                const providers = await hpRepo.createQueryBuilder("hp")
                    .leftJoinAndSelect("hp.User", "u")
                    .leftJoinAndSelect("hp.Hospital", "hosp")
                    .where("hp.UserId IN (:...doctorIds)", { doctorIds })
                    .andWhere("hp.IsDeleted = 0")
                    .getMany();
                for (const p of providers) {
                    if (p.HospitalId) {
                        providersMap[`${p.UserId}_${p.HospitalId}`] = p;
                    }
                    if (!providersMap[p.UserId]) {
                        providersMap[p.UserId] = p;
                    }
                }
            } catch (hpErr) {
                console.error("Error fetching healthcare providers for appointments:", hpErr);
            }
        }

        const formatted = appts.map(a => {
            const docIdStr = a.DoctorId ?? a.Doctor?.Id;
            const hospIdNum = a.HospitalId ?? a.Hospital?.Id;
            const provider = (docIdStr && hospIdNum ? providersMap[`${docIdStr}_${hospIdNum}`] : null) || (docIdStr ? providersMap[docIdStr] : null);

            return {
                id: a.Id,
                appointmentDate: a.AppointmentDate,
                startTime: a.StartTime,
                endTime: a.EndTime,
                duration: a.Duration ? `${a.Duration} mins` : "15 mins",
                appointmentType: a.AppointmentType,
                isTeleConsultation: a.IsTeleConsultation === true ||
                                    (a.AppointmentType && a.AppointmentType.toLowerCase().includes("video")) ||
                                    (a.AppointmentType && a.AppointmentType.toLowerCase().includes("tele")) ||
                                    (!!a.MeetingUrl),
                meetingUrl: a.MeetingUrl || "",
                status: a.Status,
                reason: a.Reason,
                hospitalId: a.HospitalId ?? a.Hospital?.Id ?? provider?.HospitalId ?? null,
                hospitalName: a.Hospital?.Name || provider?.Hospital?.Name || "Healthcare Facility",
                organizationId: a.OrgId ?? a.Organization?.Id ?? null,
                organizationName: a.Organization?.Name || "Organization",
                doctorId: a.DoctorId ?? a.Doctor?.Id ?? null,
                slotId: a.SlotId ?? null,
                patientUserId: a.UserId ?? a.User?.Id ?? null,
                doctorName: a.Doctor ? `Dr. ${a.Doctor.FirstName || ''} ${a.Doctor.LastName || ''}`.trim() : (provider?.User ? `Dr. ${provider.User.FirstName || ''} ${provider.User.LastName || ''}`.trim() : "Doctor"),
                specialty: provider?.Specialty || "General Physician",
                qualification: provider?.Qualification || "MBBS",
                experience: provider?.Experience || "",
                consultationFee: provider?.ConsultationFee !== undefined && provider?.ConsultationFee !== null ? Number(provider.ConsultationFee) : 0,
                doctorPhoto: a.Doctor?.ImagePath || provider?.User?.ImagePath || null,
                patientName: a.User ? `${a.User.FirstName || ''} ${a.User.LastName || ''}`.trim() : "Patient",
                relation: (a.User?.Relation && a.User?.Relation.toLowerCase() !== "self") ? a.User.Relation : (a.User?.IsPrimary ? "Self" : "Dependent"),
                isPrimary: a.User?.IsPrimary ?? true
            };
        });

        return res.json(ApiResponse.success(formatted, "Patient appointments fetched successfully."));
    } catch (error: any) {
        console.error("getPatientAppointments Error:", error);
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to fetch patient appointments"
        });
    }
};

/**
 * Retrieves all matching patient accounts (primary & dependent family members) for a given phone or search.
 */
export const getPatientAccountsByPhone = async (req: Request, res: Response) => {
    try {
        const phone = req.body.phone || req.body.patientPhone || req.query.phone || req.query.patientPhone || "";
        const search = req.body.search || req.query.search || req.body.nameSearch || "";
        const orgId = req.body.orgId || req.query.orgId;
        const hospitalId = req.body.hospitalId || req.query.hospitalId;

        // Staff look up any patient to book for them. A patient may only list the accounts
        // on their own family's number, and may not search other users by name.
        const caller = (req as any).user || {};
        const callerIds = [caller.userId, caller.tokenUserId].filter(Boolean).map(String);
        if (!(await familyLinkService.isStaffAccount(callerIds))) {
            const asked = String(phone).replace(/\D/g, "").slice(-10);
            if (asked.length < 10 || !(await familyLinkService.ownFamilyPhones(callerIds)).has(asked)) {
                return res.status(403).json({
                    status: false,
                    message: "You can only look up accounts on your own number.",
                    data: { code: "PATIENT_LOOKUP_NOT_ALLOWED" }
                });
            }
        }

        const result = await mobileAppointmentService.findPatientAccountsByPhone(
            String(phone),
            orgId ? Number(orgId) : undefined,
            hospitalId ? Number(hospitalId) : undefined,
            String(search)
        );

        return res.json(ApiResponse.success(result, "Patient accounts retrieved successfully."));
    } catch (error: any) {
        console.error("getPatientAccountsByPhone Error:", error);
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to retrieve matching patient accounts"
        });
    }
};

/**
 * Creates or links a dependent family member under a primary phone account.
 * Enforces maximum of 6 dependents per primary account.
 */
export const addDependentPatient = async (req: Request, res: Response) => {
    try {
        const { primaryPhone, phone, parentUserId, name, relation, gender, dob, email, orgId, hospitalId } = req.body;
        const targetPhone = primaryPhone || phone;
        if (!targetPhone) {
            return res.status(400).json({
                status: false,
                message: "Primary phone number is required to add a family member"
            });
        }
        if (!name || name.trim().length < 2) {
            return res.status(400).json({
                status: false,
                message: "Valid family member name is required (min 2 characters)"
            });
        }

        // Staff add family members for any patient they book for. A patient may add them only
        // under their own family's number and account; before this, anyone could add a dependent
        // under any number or parent account.
        const actor = requireTokenActor(req, res);
        if (!actor) return;
        if (!(await familyLinkService.isStaffAccount([actor]))) {
            const profile = actingProfileId(req);
            const ownPhones = await familyLinkService.ownFamilyPhones([actor, ...(profile ? [profile] : [])]);
            const asked = String(targetPhone).replace(/\D/g, "").slice(-10);
            const parentOk = !parentUserId || (await isSameFamily(actor, String(parentUserId)));
            if (asked.length < 10 || !ownPhones.has(asked) || !parentOk) {
                return res.status(403).json({
                    status: false,
                    message: "You can only add family members to your own account.",
                    data: { code: "NOT_YOUR_FAMILY" }
                });
            }
        }

        // People linked from their own Yira account count toward the family limit too.
        if (await familyLinkService.familyLimitReached(parentUserId ? String(parentUserId) : undefined, String(targetPhone))) {
            return res.status(400).json({
                status: false,
                message: "Maximum limit of 6 family relations reached for this primary account.",
                data: { code: "FAMILY_LIMIT_REACHED" }
            });
        }

        const result = await mobileAppointmentService.createOrLinkDependent({
            primaryPhone: String(targetPhone),
            parentUserId: parentUserId ? String(parentUserId) : undefined,
            name: String(name),
            relation: String(relation || "Dependent"),
            gender: gender ? String(gender) : undefined,
            dob: dob ? String(dob) : undefined,
            email: email ? String(email) : undefined,
            orgId: orgId ? Number(orgId) : undefined,
            hospitalId: hospitalId ? Number(hospitalId) : undefined
        });

        return res.json(ApiResponse.success(result, "Family member added successfully."));
    } catch (error: any) {
        console.error("addDependentPatient Error:", error);
        return res.status(400).json({
            status: false,
            message: error.message || "Failed to add family member"
        });
    }
};

/**
 * Retrieves all doctors for a specific hospital so patients can view and book appointments with any doctor in that hospital.
 */
export const getHospitalDoctors = async (req: Request, res: Response) => {
    try {
        const query = req.query || {};
        const body = req.body || {};
        const rawHospId = query.hospitalId || body.hospitalId || query.hospital_id || body.hospital_id;
        const hospitalId = Number(rawHospId);
        const rawOrgId = query.organizationId || body.organizationId || query.orgId || body.orgId;
        const organizationId = rawOrgId ? Number(rawOrgId) : undefined;
        const search = String(query.search || body.search || "").trim();

        if (!hospitalId || isNaN(hospitalId)) {
            return res.status(400).json({
                status: false,
                message: "Valid hospitalId is required"
            });
        }

        const result = await healthcareProviderService.getDoctors(1, 100, {
            hospitalId,
            organizationId,
            search: search || undefined,
            status: true
        });

        const rawList = Array.isArray(result) ? result : (result.data?.data || result.data || []);
        const doctorsList = rawList
            .filter((d: any) => {
                const firstName = (d.User?.FirstName || d.firstName || "").toString().toLowerCase().trim();
                const lastName = (d.User?.LastName || d.lastName || "").toString().toLowerCase().trim();
                const fullName = `${firstName} ${lastName}`.trim();
                const rawName = (d.name || "").toString().toLowerCase().trim();
                const email = (d.User?.Email || d.email || "").toString().toLowerCase().trim();
                const specialty = (d.Specialty || d.specialty || "").toString().toLowerCase().trim();

                // Exclude any test, sample, demo, fake, or dummy doctors
                if (
                    firstName.includes("test") ||
                    lastName.includes("test") ||
                    fullName.includes("test") ||
                    rawName.includes("test") ||
                    email.includes("test") ||
                    specialty.includes("test") ||
                    firstName.includes("dummy") ||
                    lastName.includes("dummy") ||
                    rawName.includes("dummy") ||
                    fullName.includes("demo") ||
                    rawName.includes("demo") ||
                    fullName.includes("sample") ||
                    rawName.includes("sample") ||
                    fullName.includes("fake")
                ) {
                    return false;
                }
                return true;
            })
            .map((d: any) => {
                const firstName = d.User?.FirstName || d.firstName || "";
                const lastName = d.User?.LastName || d.lastName || "";
                const fullName = firstName || lastName ? `Dr. ${firstName} ${lastName}`.trim() : (d.name || "Doctor");
                const doctorGuid = d.UserId || d.userId || d.Id || d.id;
                return {
                    doctorId: doctorGuid,
                    id: doctorGuid,
                    providerId: d.Id || d.id,
                    userId: d.UserId || d.userId,
                    name: fullName,
                    firstName: firstName,
                    lastName: lastName,
                    specialty: d.Specialty || d.specialty || "General Physician",
                    subSpecialty: d.SubSpecialty || d.subSpecialty || null,
                    department: d.Department || d.department || "General",
                    qualification: d.Qualification || d.qualification || "MBBS",
                    experience: d.Experience || d.experience || "",
                    registrationNumber: d.RegistrationNumber || d.registrationNumber || null,
                    bio: d.Bio || d.bio || null,
                    hospitalId: hospitalId,
                    hospitalName: d.Hospital?.Name || null,
                    consultationFee: d.ConsultationFee !== undefined && d.ConsultationFee !== null ? Number(d.ConsultationFee) : 0,
                    imagePath: d.User?.ImagePath || d.imagePath || null,
                    email: d.User?.Email || d.email || null,
                    phoneNumber: d.User?.PhoneNumber || d.phoneNumber || null,
                    isLinked: true
                };
            });

        return res.json(ApiResponse.success(doctorsList, "Hospital doctors fetched successfully"));
    } catch (error: any) {
        console.error("getHospitalDoctors error:", error);
        return res.status(500).json({
            status: false,
            message: error.message || "Failed to fetch doctors for hospital"
        });
    }
};


export const rescheduleAppointment = async (req: Request, res: Response) => {
    try {
        const appointmentId = req.body.appointmentId || req.body.id || req.params.id;
        if (!appointmentId) {
            return res.status(400).json({ status: false, message: "appointmentId is required" });
        }
        // Only the patient (or their family), the appointment's doctor, or staff at its hospital.
        // Before this, anyone signed in could move anyone's appointment.
        const actor = requireTokenActor(req, res);
        if (!actor) return;
        const { AppDataSource } = await import("../../../../config/database.js");
        const { Appointment } = await import("../../../../models/Appointments/appointment.model.js");
        const appointment = await AppDataSource.getRepository(Appointment).findOne({
            where: { Id: parseInt(String(appointmentId), 10) } as any,
            select: { Id: true, UserId: true, DoctorId: true, HospitalId: true } as any,
        });
        if (!appointment) {
            return res.status(404).json({ status: false, message: "Appointment not found" });
        }
        const allowed = (appointment.UserId && await isFamilyLinked(actor, String(appointment.UserId)))
            || sameUserId(actor, appointment.DoctorId ? String(appointment.DoctorId) : null)
            || (appointment.HospitalId && await canManageHospital(actor, Number(appointment.HospitalId)));
        if (!allowed) {
            return res.status(403).json({ status: false, message: "You can only reschedule your own or your family's appointments." });
        }
        const { appointmentService } = await import("../../../../services/Appointments/appointment.service.js");
        const result = await appointmentService.rescheduleAppointment(parseInt(String(appointmentId), 10), req.body);
        return res.json(ApiResponse.success(result, "Appointment rescheduled successfully."));
    } catch (error: any) {
        return res.status(400).json({ status: false, message: error.message || "Failed to reschedule appointment" });
    }
};
