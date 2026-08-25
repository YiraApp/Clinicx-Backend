import { AppDataSource } from "../../config/database.js";
import { appointmentRepository } from "../../repositories/Appointments/appointment.repository.js";
import { healthcareProviderScheduleSlotRepository } from "../../repositories/Organizations/healthcare-provider-schedule-slot.repository.js";
import { patientQueueRepository } from "../../repositories/Appointments/patient-queue.repository.js";
import { Appointment } from "../../models/Appointments/appointment.model.js";
import { PatientQueue } from "../../models/Appointments/patient-queue.model.js";
import { PatientRegistration } from "../../models/Organizations/patient-registration.model.js";
import { PatientInsurance } from "../../models/Organizations/patient-insurance.model.js";
import { AppointmentStatus, QueueStatus } from "../../enums/appointments.js";
import { appointmentBillRepository } from "../../repositories/Payments/appointment-bill.repository.js";

import { defaultOrganizationRepository } from "../../repositories/Organizations/default-organization.repository.js";
import { zoomService } from "../Common/zoom.service.js";
import { mailService } from "../Mail/mail.service.js";

export class AppointmentService {
    async bookAppointmentFromPulse(data: {
        token?: string;
        patientName?: string;
        patientPhone?: string;
        patientEmail?: string;
        gender?: string;
        dob?: string;
        userId?: string;
        doctorId: string;
        hospitalId: number;
        orgId: number;
        slotId: number;
        appointmentDate: string;
        startTime: string;
        endTime: string;
        reason?: string;
        appointmentType?: string;
        isTeleConsultation?: boolean;
        createdBy?: string;
        reportUrl?: string;
        parsedSummary?: string;
        parentAppointmentId?: number | null;
        treatmentPlanIds?: string[];
        customTreatmentPlans?: { name: string; amount: number; description?: string }[];
        discountAmount?: number;
    }) {
        // 1. Mandatory Mobile Number check
        const rawPhone = data.patientPhone || "";
        const cleanPhone = rawPhone.replace(/[^\d]/g, "");

        if (!cleanPhone || cleanPhone.length < 10) {
            throw new Error("Patient mobile number is required to allocate or register the patient.");
        }

        if (!data.orgId || !data.hospitalId) {
            const activeDefault = await defaultOrganizationRepository.getActiveDefault();
            if (activeDefault) {
                if (!data.orgId) data.orgId = activeDefault.OrganizationId;
                if (!data.hospitalId) data.hospitalId = activeDefault.HospitalId;
            }
        }

        if (!data.orgId || !data.hospitalId) {
            throw new Error("OrganizationId and HospitalId could not be resolved.");
        }

        const { User } = await import("../../models/Account/user.model.js");
        const { UserRole } = await import("../../models/Account/userrole.model.js");
        const { Role } = await import("../../models/Account/role.model.js");
        const { v4: uuidv4 } = await import("uuid");

        const userRepo = AppDataSource.getRepository(User);
        const last10Digits = cleanPhone.slice(-10);

        // 2. Fetch all users registered under this phone number (Primary + Family Dependents)
        const existingFamilyUsers = await userRepo.createQueryBuilder("u")
            .where("u.IsDeleted = 0")
            .andWhere("(u.PhoneNumber = :phone OR u.PhoneNumber LIKE :last10)", {
                phone: cleanPhone,
                last10: `%${last10Digits}`
            })
            .orderBy("u.IsPrimary", "DESC")
            .addOrderBy("u.CreatedAt", "ASC")
            .getMany();

        let targetUser: InstanceType<typeof User> | null = null;
        let isNewRegistration = false;

        if (existingFamilyUsers.length === 0) {
            // Case A: NO user exists for this phone number -> Create Primary User
            isNewRegistration = true;
            targetUser = new User();
            targetUser.Id = uuidv4();
            targetUser.IsPrimary = true;
            targetUser.Relation = "Self";

            const nameParts = (data.patientName || "Pulse Patient").trim().split(" ");
            targetUser.FirstName = nameParts[0];
            targetUser.LastName = nameParts.slice(1).join(" ") || "";
            const providedEmail = (data.patientEmail || (data as any).email || "").trim();
            targetUser.Email = providedEmail.length > 0 ? providedEmail : "";
            targetUser.PhoneNumber = cleanPhone;
            targetUser.Status = true;
            targetUser.IsDeleted = false;
            await userRepo.save(targetUser);
        } else {
            // Case B: Primary User exists for this phone number!
            const parentId = (data as any).parentUserId || (data as any).ParentUserId;
            const primaryUser = (parentId ? existingFamilyUsers.find(u => u.Id.toLowerCase() === String(parentId).toLowerCase()) : null) || existingFamilyUsers.find(u => u.IsPrimary) || existingFamilyUsers[0]!;
            const reqName = (data.patientName || "").trim().toLowerCase();
            const reqEmail = (data.patientEmail || "").trim().toLowerCase();

            // Match by UserId
            if (data.userId) {
                targetUser = existingFamilyUsers.find(u => u.Id.toLowerCase() === data.userId!.toLowerCase()) || null;
                if (!targetUser) {
                    targetUser = await userRepo.findOne({ where: { Id: data.userId, IsDeleted: false } });
                }
            }

            // Match by Full Name
            if (!targetUser && reqName) {
                targetUser = existingFamilyUsers.find(u => {
                    const fullName = `${u.FirstName || ''} ${u.LastName || ''}`.trim().toLowerCase();
                    return fullName === reqName || u.FirstName?.toLowerCase() === reqName;
                }) || null;
            }

            // Match by Email
            if (!targetUser && reqEmail) {
                targetUser = existingFamilyUsers.find(u => u.Email?.toLowerCase() === reqEmail) || null;
            }

            // Match by Relation (e.g., Spouse, Child, Father, Mother, Brother, Sister)
            const reqRelation = ((data as any).relation || "").trim().toLowerCase();
            if (!targetUser && reqRelation && reqRelation !== "self") {
                targetUser = existingFamilyUsers.find(u => u.Relation?.toLowerCase() === reqRelation) || null;
            }

            // If no exact match among existing family members:
            if (!targetUser) {
                const primaryFullName = `${primaryUser.FirstName || ''} ${primaryUser.LastName || ''}`.trim().toLowerCase();
                if (!reqName || reqName === primaryFullName || primaryUser.FirstName?.toLowerCase() === reqName) {
                    targetUser = primaryUser;
                } else {
                    // Create a Dependent / Secondary User linked to the Primary User (Do NOT duplicate primary user!)
                    isNewRegistration = true;
                    targetUser = new User();
                    targetUser.Id = uuidv4();
                    targetUser.IsPrimary = false;
                    targetUser.ParentUserId = parentId || primaryUser.Id;
                    targetUser.Relation = (data as any).relation || "Dependent";

                    const nameParts = reqName.split(" ");
                    targetUser.FirstName = nameParts[0] ? nameParts[0].charAt(0).toUpperCase() + nameParts[0].slice(1) : "Family";
                    targetUser.LastName = nameParts.slice(1).join(" ") || "Member";
                    const depProvidedEmail = (data.patientEmail || (data as any).email || "").trim();
                    targetUser.Email = depProvidedEmail.length > 0 ? depProvidedEmail : "";
                    targetUser.PhoneNumber = cleanPhone;
                    targetUser.Status = true;
                    targetUser.IsDeleted = false;
                    await userRepo.save(targetUser);
                }
            }
        }

        // Update name/email if user exists and has placeholder info
        if (targetUser && data.patientName && (!targetUser.FirstName || targetUser.FirstName === "Pulse" || targetUser.FirstName === "Patient")) {
            const nameParts = data.patientName.trim().split(" ");
            targetUser.FirstName = nameParts[0];
            targetUser.LastName = nameParts.slice(1).join(" ") || "";
            const providedEmail = (data.patientEmail || (data as any).email || "").trim();
            if (providedEmail.length > 0) {
                targetUser.Email = providedEmail;
            } else if (targetUser.Email && targetUser.Email.includes("@yira.ai")) {
                targetUser.Email = "";
            }
            await userRepo.save(targetUser);
        }

        // Send Welcome Credentials Email for new registrations
        if (isNewRegistration && targetUser.Email && !targetUser.Email.endsWith("@yira.ai")) {
            mailService.sendDynamicEmail("WELCOME_EMAIL", targetUser.Email, {
                FirstName: targetUser.FirstName,
                LastName: targetUser.LastName || "",
                RoleMessage: "Welcome to Yira / ClinX! Your patient account has been created via Pulse Health Camp.",
                Email: targetUser.Email,
                Password: "Registered via Health Camp",
                Role: "Patient",
                OrganizationName: "Yira Hospitals",
                LoginURL: process.env.CLIENT_URL || "https://pulse.yira.ai/"
            }).catch((mailErr: any) => {
                console.error("[Mail] Welcome email error in bookAppointmentFromPulse:", mailErr);
            });
        }

        // 3. Ensure Organization & Hospital Assignment in UserRoles & PatientRegistrations
        const userRoleRepo = AppDataSource.getRepository(UserRole);
        const patientRegRepo = AppDataSource.getRepository(PatientRegistration);

        const existingRoleMapping = await userRoleRepo.findOne({
            where: { UserId: targetUser.Id, OrganizationId: data.orgId, HospitalId: data.hospitalId, IsDeleted: false }
        });

        if (!existingRoleMapping) {
            const roleRepo = AppDataSource.getRepository(Role);
            const patientRole = await roleRepo.findOne({ where: { RoleName: "Patient" } });
            const roleId = patientRole ? patientRole.Id : "00000000-0000-0000-0000-000000000000";

            const userRole = new UserRole();
            userRole.UserId = targetUser.Id;
            userRole.RoleId = roleId;
            userRole.OrganizationId = data.orgId;
            userRole.HospitalId = data.hospitalId;
            userRole.Status = true;
            userRole.IsDeleted = false;
            await userRoleRepo.save(userRole);
        }

        const existingPatientReg = await patientRegRepo.findOne({
            where: { UserId: targetUser.Id, OrganizationId: data.orgId, HospitalId: data.hospitalId }
        });

        if (!existingPatientReg) {
            const patientReg = new PatientRegistration();
            patientReg.UserId = targetUser.Id;
            patientReg.OrganizationId = data.orgId;
            patientReg.HospitalId = data.hospitalId;
            patientReg.Status = true;
            patientReg.IsDeleted = false;
            await patientRegRepo.save(patientReg);
        }

        // 4. Book Appointment for the resolved Patient (Primary or Dependent)
        const appointment = await this.bookAppointment({
            userId: targetUser.Id,
            doctorId: data.doctorId,
            hospitalId: data.hospitalId,
            orgId: data.orgId,
            slotId: data.slotId,
            appointmentDate: data.appointmentDate,
            startTime: data.startTime,
            endTime: data.endTime,
            reason: data.reason,
            appointmentType: data.appointmentType,
            isTeleConsultation: data.isTeleConsultation,
            createdBy: data.createdBy || "PulseWhatsApp",
            parentAppointmentId: data.parentAppointmentId || null,
            treatmentPlanIds: data.treatmentPlanIds || [],
            customTreatmentPlans: data.customTreatmentPlans || [],
            discountAmount: data.discountAmount || 0
        });

        // 5. If Report Blob URL is provided from Pulse, save into MedicalDocuments (Patient Records UI) & PostVisitDocuments tables
        const reportUrl = data.reportUrl || (data as any).ReportUrl || (data as any).report_url;
        if (reportUrl && appointment && appointment.Id) {
            try {
                // A. Save into MedicalDocuments table (Patient Records tab in ClinX)
                const { MedicalDocument } = await import("../../models/Appointments/medical-document.model.js");
                const { medicalDocumentRepository } = await import("../../repositories/Appointments/medical-document.repository.js");

                const medDoc = new MedicalDocument();
                medDoc.AppointmentId = appointment.Id;
                medDoc.PatientId = targetUser.Id;
                medDoc.DoctorId = appointment.DoctorId || data.doctorId;
                medDoc.OrganizationId = data.orgId;
                medDoc.HospitalId = data.hospitalId;
                medDoc.DocumentCategory = "Health Camp Report";
                medDoc.DocumentType = "Pulse Health Report";
                medDoc.FileName = `Pulse_Report_${data.token || appointment.Id}.pdf`;
                medDoc.OriginalFileName = `Pulse_Report_${data.token || appointment.Id}.pdf`;
                medDoc.BlobUrl = reportUrl;
                medDoc.MimeType = "application/pdf";
                medDoc.FileExtension = ".pdf";
                medDoc.UploadedSource = "PulseWhatsApp";
                medDoc.UploadedByUserId = targetUser.Id;
                medDoc.IsPatientUploaded = true;
                medDoc.Status = "ACTIVE";
                medDoc.IsDeleted = false;
                medDoc.CreatedAt = new Date();
                medDoc.CreatedBy = "PulseWhatsApp";

                await medicalDocumentRepository.save(medDoc);
                console.log(`[Pulse Integration] Successfully saved report Blob URL into MedicalDocuments for Appointment ID: ${appointment.Id}`);

                // B. Save into PostVisitDocuments table (Post Visit Consultation Bundle)
                const { postVisitDocumentRepository } = await import("../../repositories/Appointments/post-visit-document.repository.js");

                await postVisitDocumentRepository.create({
                    AppointmentId: appointment.Id,
                    PatientId: targetUser.Id,
                    DoctorId: appointment.DoctorId || data.doctorId,
                    OrganizationId: data.orgId,
                    HospitalId: data.hospitalId,
                    DocumentType: "Pulse Health Report",
                    FileName: `Pulse_Report_${data.token || appointment.Id}.pdf`,
                    BlobUrl: reportUrl,
                    Status: "ACTIVE",
                    IsDeleted: false,
                    CreatedAt: new Date(),
                    GeneratedAt: new Date(),
                    CreatedBy: "PulseWhatsApp"
                });
                console.log(`[Pulse Integration] Successfully saved report Blob URL into PostVisitDocuments for Appointment ID: ${appointment.Id}`);
            } catch (docErr) {
                console.error("[Pulse Integration] Error saving report URL into ClinX document tables:", docErr);
            }
        }

        // 6. If Parsed Medical Summary is provided from Pulse and is valid (not empty or generic salutation/placeholder), save into ClinicalNotes
        const rawSummary = data.parsedSummary || (data as any).ParsedSummary || (data as any).parsed_summary;
        const isValidSummary = (summary?: string): boolean => {
            if (!summary || typeof summary !== "string") return false;
            let clean = summary.trim();
            if (!clean || clean.length < 5) return false;

            // Strip leading 'Summary:', 'Patient:', 'Notes:' prefixes
            clean = clean.replace(/^(summary|patient|note|notes)\s*:\s*/i, "").trim();
            // Strip leading salutations ('Mr.', 'Mrs.', 'Ms.', 'Dr.')
            clean = clean.replace(/^(mr\.|mr|mrs\.|mrs|ms\.|ms|dr\.|dr)\s*/i, "").trim();

            if (!clean || clean.length < 8) return false;

            const lower = clean.toLowerCase();
            if (
                lower === "no parsed summary available." ||
                lower === "medical records processed successfully. key health metrics reviewed." ||
                lower === "status" ||
                lower === "status is" ||
                lower === "normal" ||
                lower === "report"
            ) {
                return false;
            }

            return true;
        };

        if (isValidSummary(rawSummary) && appointment && appointment.Id) {
            try {
                const { clinicalNoteRepository } = await import("../../repositories/Appointments/clinical-note.repository.js");
                await clinicalNoteRepository.create({
                    AppointmentId: appointment.Id,
                    PatientId: targetUser.Id,
                    DoctorId: appointment.DoctorId || data.doctorId,
                    OrganizationId: data.orgId,
                    HospitalId: data.hospitalId,
                    Notes: rawSummary.trim(),
                    CreatedBy: "Pulse AI Parser",
                    CreatedAt: new Date()
                });
                console.log(`[Pulse Integration] Successfully saved parsed summary into ClinicalNotes for Appointment ID: ${appointment.Id}`);
            } catch (noteErr) {
                console.error("[Pulse Integration] Error saving parsed summary into ClinicalNotes table:", noteErr);
            }
        }

        return {
            patient: {
                userId: targetUser.Id,
                fullName: `${targetUser.FirstName} ${targetUser.LastName}`.trim(),
                phoneNumber: targetUser.PhoneNumber,
                email: targetUser.Email,
                relation: targetUser.Relation || (targetUser.IsPrimary ? "Self" : "Dependent"),
                isPrimary: targetUser.IsPrimary ?? false,
                organizationId: data.orgId,
                hospitalId: data.hospitalId,
                isNewRegistration,
                isHospitalMapped: true
            },
            appointment,
            dynamicLink: (appointment as any)?.dynamicLink || null,
            videoCallUrl: (appointment as any)?.videoCallUrl || appointment?.MeetingUrl || null,
            redirectionUrlId: (appointment as any)?.redirectionUrlId || null
        };
    }

    async bookAppointment(data: {
        userId: string;
        doctorId: string;
        hospitalId?: number;
        orgId?: number;
        slotId: number;
        appointmentDate: string;
        startTime: string;
        endTime: string;
        reason?: string;
        appointmentType?: string;
        createdBy?: string;
        isTeleConsultation?: boolean;
        status?: string;
        parentAppointmentId?: number | null;
        treatmentPlanIds?: string[];
        customTreatmentPlans?: { name: string; amount: number; description?: string }[];
        discountAmount?: number;
    }): Promise<Appointment> {

        if (!data.orgId || !data.hospitalId) {
            const activeDefault = await defaultOrganizationRepository.getActiveDefault();
            if (activeDefault) {
                if (!data.orgId) data.orgId = activeDefault.OrganizationId;
                if (!data.hospitalId) data.hospitalId = activeDefault.HospitalId;
            }
        }

        if (!data.orgId || !data.hospitalId) {
            throw new Error("OrganizationId and HospitalId could not be resolved.");
        }

        const orgId = data.orgId;
        const hospitalId = data.hospitalId;

        const newAppointment = await AppDataSource.transaction(async (manager) => {
            // 1. Check if slot exists and is available
            const slot = await healthcareProviderScheduleSlotRepository.findById(data.slotId);
            if (!slot) throw new Error("Slot not found.");
            if (slot.IsBooked) throw new Error("Slot is already booked.");
            if (!slot.IsAvailable) throw new Error("Slot is blocked.");

            // 2. Generate Meeting URL if teleconsultation
            let meetingUrl: string | undefined = undefined;
            const isTele = data.isTeleConsultation || data.appointmentType === "Teleconsult" || data.appointmentType === "TeleConsultation";
            if (isTele) {
                const appointmentDate = new Date(data.appointmentDate);
                const zoomMeeting = await zoomService.createMeeting(
                    `Consultation: ${data.reason || 'General'}`,
                    appointmentDate
                );
                meetingUrl = zoomMeeting.join_url;
            }

            // 3. Generate Appointment Number
            const appointmentDate = new Date(data.appointmentDate);
            const appointmentNumber = await appointmentRepository.getNextAppointmentNumber(
                hospitalId,
                appointmentDate
            );

            // 4. Create Appointment
            const appointment = await appointmentRepository.create({
                UserId: data.userId,
                DoctorId: data.doctorId,
                HospitalId: hospitalId,
                OrgId: orgId,
                SlotId: data.slotId,
                AppointmentDate: appointmentDate,
                StartTime: data.startTime,
                EndTime: data.endTime,
                Reason: data.reason,
                AppointmentType: data.appointmentType || "Consultation",
                Status: data.status || "Scheduled",
                IsTeleConsultation: isTele,
                ParentAppointmentId: data.parentAppointmentId || null,

                MeetingUrl: meetingUrl,
                CreatedBy: data.createdBy,
                AppointmentNumber: appointmentNumber
            });

            // 5. Link Treatment Plans
            if (data.treatmentPlanIds && data.treatmentPlanIds.length > 0) {
                const { AppointmentTreatmentPlan } = await import("../../models/Payments/appointment-treatment-plan.model.js");
                const { v4: uuidv4 } = await import("uuid");
                for (const planId of data.treatmentPlanIds) {
                    const link = manager.create(AppointmentTreatmentPlan, {
                        AppointmentTreatmentPlanId: uuidv4(),
                        AppointmentId: appointment.Id,
                        TreatmentPlanId: planId,
                        CreatedAt: new Date()
                    });
                    await manager.save(link);
                }
            }

            // 5.5. Create & Link Custom Treatment Plans
            if (data.customTreatmentPlans && data.customTreatmentPlans.length > 0) {
                const { TreatmentPlan } = await import("../../models/Payments/treatment-plan.model.js");
                const { AppointmentTreatmentPlan } = await import("../../models/Payments/appointment-treatment-plan.model.js");
                const { v4: uuidv4 } = await import("uuid");
                for (const customPlan of data.customTreatmentPlans) {
                    if (!customPlan.name) continue;
                    const newPlan = manager.create(TreatmentPlan, {
                        TreatmentPlanId: uuidv4(),
                        Name: customPlan.name,
                        Description: customPlan.description || null,
                        Amount: Number(customPlan.amount || 0),
                        Status: "Active",
                        OrgId: data.orgId,
                        HospitalId: data.hospitalId,
                        IsDeleted: false,
                        CreatedAt: new Date()
                    });
                    await manager.save(newPlan);

                    const link = manager.create(AppointmentTreatmentPlan, {
                        AppointmentTreatmentPlanId: uuidv4(),
                        AppointmentId: appointment.Id,
                        TreatmentPlanId: newPlan.TreatmentPlanId,
                        CreatedAt: new Date()
                    });
                    await manager.save(link);
                }
            }

            // 6. Mark Slot as Booked
            await manager.update("HealthcareProviderScheduleSlots", data.slotId, {
                IsBooked: true,
                Status: "Booked",
                UpdatedAt: new Date()
            });

            // 7. Create/consolidate complete Appointment Bill immediately
            const { HealthcareProvider } = await import("../../models/Organizations/healthcare-provider.model.js");
            const provider = await manager.findOne(HealthcareProvider, {
                where: { UserId: data.doctorId }
            });
            const consultationFee = data.appointmentType === "Without Consultation" ? 0 : (provider?.ConsultationFee || 0);

            // If it's a follow-up, locate the root parent appointment in the chain
            let rootParentId: number | null = null;
            if (appointment.ParentAppointmentId) {
                const { Appointment: ApptModel } = await import("../../models/Appointments/appointment.model.js");
                 let currentId = appointment.ParentAppointmentId;
                 const visitedAppts = new Set<number>();
                 while (currentId) {
                     if (visitedAppts.has(currentId)) {
                         break;
                     }
                     visitedAppts.add(currentId);
                     const parentAppt = await manager.findOne(ApptModel, { where: { Id: currentId } });
                     if (parentAppt) {
                         rootParentId = parentAppt.Id;
                         currentId = parentAppt.ParentAppointmentId || 0;
                     } else {
                         break;
                     }
                 }
            }

            let billAppended = false;
            if (rootParentId) {
                const parentBill = await appointmentBillRepository.findByAppointmentId(rootParentId);
                if (parentBill) {
                    await appointmentBillRepository.appendChildItemsToBill(parentBill.AppointmentBillId, appointment.Id, {
                        consultationFee,
                        treatmentPlanIds: data.treatmentPlanIds || [],
                        customTreatmentPlans: data.customTreatmentPlans || [],
                        discountAmount: data.discountAmount || 0
                    });
                    billAppended = true;
                }
            }

            if (!billAppended) {
                await appointmentBillRepository.createBillForAppointment(appointment.Id, {
                    patientId: data.userId,
                    providerId: data.doctorId,
                    hospitalId: hospitalId,
                    consultationFee,
                    treatmentPlanIds: data.treatmentPlanIds || [],
                    customTreatmentPlans: data.customTreatmentPlans || [],
                    discountAmount: data.discountAmount || 0
                });
            }

            return appointment;
        });

        // Generate meeting redirection dynamically for teleconsultation / video call appointments
        let redirectionUrlId: string | null = null;
        let dynamicLink: string | null = null;

        try {
            const { meetingRedirectionService } = await import("./meeting-redirection.service.js");
            if (newAppointment.IsTeleConsultation || newAppointment.MeetingUrl) {
                const redirection = await meetingRedirectionService.getOrCreateRedirection({
                    AppointmentId: newAppointment.Id,
                    PatientId: newAppointment.UserId,
                    DoctorId: newAppointment.DoctorId,
                    HospitalId: newAppointment.HospitalId,
                    OrganizationId: newAppointment.OrgId,
                    MeetingUrl: newAppointment.MeetingUrl || "",
                    AppointmentDate: newAppointment.AppointmentDate,
                    StartTime: newAppointment.StartTime
                });
                if (redirection && redirection.UrlId) {
                    redirectionUrlId = redirection.UrlId;
                    const baseUrl = (process.env.FRONTEND_URL || process.env.CLIENT_URL || "http://localhost:5173").replace(/\/+$/, "");
                    dynamicLink = `${baseUrl}/redirections?urlid=${redirection.UrlId}`;
                }
            }
        } catch (redirErr) {
            console.error("[AppointmentService] Error creating meeting redirection:", redirErr);
        }

        (newAppointment as any).dynamicLink = dynamicLink;
        (newAppointment as any).videoCallUrl = dynamicLink || newAppointment.MeetingUrl || null;
        (newAppointment as any).redirectionUrlId = redirectionUrlId;

        // Async task: send WhatsApp confirmation with dynamic video call link
        try {
            const enrichedAppointment = await appointmentRepository.findById(newAppointment.Id);
            if (enrichedAppointment && enrichedAppointment.User?.PhoneNumber) {
                const appt = enrichedAppointment;
                const { meetingRedirectionService } = await import("./meeting-redirection.service.js");
                const { whatsappService } = await import("../Common/whatsapp.service.js");

                const redirection = await meetingRedirectionService.getOrCreateRedirection({
                    AppointmentId: appt.Id,
                    PatientId: appt.UserId,
                    DoctorId: appt.DoctorId,
                    HospitalId: appt.HospitalId,
                    OrganizationId: appt.OrgId,
                    MeetingUrl: appt.MeetingUrl || "",
                    AppointmentDate: appt.AppointmentDate,
                    StartTime: appt.StartTime
                });

                // Format details for WhatsApp
                const patientName = `${appt.User?.FirstName || ""} ${appt.User?.LastName || ""}`.trim();
                const doctorName = appt.Doctor 
                    ? `${appt.Doctor.FirstName || ""} ${appt.Doctor.LastName || ""}`.trim()
                    : "N/A";
                const hospitalName = appt.Hospital?.Name || "our clinic";

                const dateStr = new Date(appt.AppointmentDate).toLocaleDateString("en-IN", {
                    day: "2-digit", month: "short", year: "numeric"
                });
                const timeStr = appt.StartTime ? appt.StartTime.slice(0, 5) : "";

                const countryCode = appt.User.CountryCode || "91";
                const normalizedPhone = `${countryCode.replace(/\D/g, "")}${appt.User.PhoneNumber.replace(/\D/g, "")}`;

                // Select template based on consultation type
                const templateName = appt.IsTeleConsultation ? "video_call_template" : "appointment_conformation";

                const components: any[] = [
                    {
                        type: "header",
                        parameters: [
                            { type: "text", text: hospitalName }
                        ]
                    }
                ];

                const bodyParameters = [
                    { type: "text", text: patientName },
                    { type: "text", text: doctorName },
                    { type: "text", text: hospitalName },
                    { type: "text", text: dateStr },
                    { type: "text", text: timeStr }
                ];

                components.push({
                    type: "body",
                    parameters: bodyParameters
                });

                if (appt.IsTeleConsultation) {
                    components.push({
                        type: "button",
                        sub_type: "url",
                        index: "0",
                        parameters: [
                            { type: "text", text: redirection.UrlId }
                        ]
                    });
                }

                await whatsappService.sendTemplateMessage(normalizedPhone, templateName, "en", components);
                console.log(`[AppointmentService] WhatsApp appointment notification sent to ${normalizedPhone} using template ${templateName}`);
            }
        } catch (err) {
            console.error("[AppointmentService] Error generating redirection or sending WhatsApp notification:", err);
        }

        return newAppointment;
    }

    async attachMedicalAndInsurance(appointments: Appointment[]) {
        const userIds = [...new Set(appointments.map(a => a.UserId).filter(Boolean))];
        const appointmentIds = appointments.map(a => a.Id).filter(Boolean);
        const medicalMap = new Map<string, PatientRegistration>();
        const insuranceMap = new Map<string, PatientInsurance>();
        const plansMap = new Map<number, any[]>();

        if (userIds.length > 0) {
            const registrations = await AppDataSource.getRepository(PatientRegistration)
                .createQueryBuilder("pr")
                .where("pr.UserId IN (:...userIds)", { userIds })
                .andWhere("pr.IsDeleted = :deleted", { deleted: false })
                .getMany();
            registrations.forEach(reg => medicalMap.set(reg.UserId.toUpperCase(), reg));

            const insurances = await AppDataSource.getRepository(PatientInsurance)
                .createQueryBuilder("ins")
                .where("ins.UserId IN (:...userIds)", { userIds })
                .andWhere("ins.IsDeleted = :deleted", { deleted: false })
                .getMany();
            insurances.forEach(ins => insuranceMap.set(ins.UserId.toUpperCase(), ins));
        }

        if (appointmentIds.length > 0) {
            try {
                const { AppointmentTreatmentPlan } = await import("../../models/Payments/appointment-treatment-plan.model.js");
                const links = await AppDataSource.getRepository(AppointmentTreatmentPlan)
                    .createQueryBuilder("atp")
                    .leftJoinAndSelect("atp.TreatmentPlan", "tp")
                    .where("atp.AppointmentId IN (:...appointmentIds)", { appointmentIds })
                    .getMany();

                links.forEach(link => {
                    if (link.TreatmentPlan) {
                        const arr = plansMap.get(link.AppointmentId) || [];
                        arr.push(link.TreatmentPlan);
                        plansMap.set(link.AppointmentId, arr);
                    }
                });
            } catch (error) {
                console.error("Error attaching treatment plans:", error);
            }
        }

        return appointments.map(apt => {
            const reg = medicalMap.get(apt.UserId?.toUpperCase());
            const ins = insuranceMap.get(apt.UserId?.toUpperCase());
            return {
                ...apt,
                allergies: reg?.Allergies || null,
                medicalHistory: reg?.MedicalHistory || null,
                insuranceProvider: ins?.InsuranceProvider || null,
                insuranceNumber: ins?.InsuranceNumber || null,
                treatmentPlans: plansMap.get(apt.Id) || []
            };
        });
    }

    async getDoctorAppointments(doctorId: string, dateStr: string, orgId?: number, hospitalId?: number) {
        return await appointmentRepository.getDoctorAppointments(doctorId, dateStr, orgId, hospitalId);
    }

    async getHospitalAppointments(hospitalId: number, dateStr: string) {
        return await appointmentRepository.getHospitalAppointments(hospitalId, dateStr);
    }

    async getPatientAppointments(userId: string) {
        const appointments = await appointmentRepository.getPatientAppointments(userId);
        const enrichedAppointments = [];
        const { HealthcareProvider } = await import("../../models/Organizations/healthcare-provider.model.js");

        for (const appt of appointments) {
            let specialty = "General Medicine";
            if (appt.DoctorId) {
                const provider = await AppDataSource.getRepository(HealthcareProvider).findOne({
                    where: { UserId: appt.DoctorId, IsDeleted: false }
                });
                if (provider) {
                    specialty = provider.Specialty || "General Medicine";
                }
            }
            enrichedAppointments.push({
                ...appt,
                specialty
            });
        }

        return await this.attachMedicalAndInsurance(enrichedAppointments);
    }

    async getPatientHospitalSummary(userId: string) {
        const hospitals = await appointmentRepository.getPatientHospitalSummary(userId);
        
        const allUserAppointments = await AppDataSource.getRepository(Appointment).find({
            where: { UserId: userId },
            select: ["Id", "Status"]
        });

        const stats = {
            total: allUserAppointments.length,
            confirmed: 0,
            pending: 0,
            completed: 0
        };

        for (const apt of allUserAppointments) {
            const s = apt.Status?.toLowerCase() || "";
            if (s === "confirmed" || s === "scheduled") stats.confirmed++;
            else if (s === "pending" || s === "paymentpending") stats.pending++;
            else if (s === "completed") stats.completed++;
        }

        return {
            hospitals,
            stats
        };
    }

    async getPatientAppointmentsByHospital(userId: string, hospitalId: number) {
        const appointments = await appointmentRepository.getPatientAppointmentsByHospital(userId, hospitalId);
        const enrichedAppointments = [];
        const { HealthcareProvider } = await import("../../models/Organizations/healthcare-provider.model.js");

        for (const appt of appointments) {
            let specialty = "General Medicine";
            if (appt.DoctorId) {
                const provider = await AppDataSource.getRepository(HealthcareProvider).findOne({
                    where: { UserId: appt.DoctorId, IsDeleted: false }
                });
                if (provider) {
                    specialty = provider.Specialty || "General Medicine";
                }
            }
            enrichedAppointments.push({
                ...appt,
                specialty
            });
        }

        return await this.attachMedicalAndInsurance(enrichedAppointments);
    }

    async getAppointments(filters: { orgId?: number, hospitalId?: number, userId?: string, doctorId?: string, date?: string, status?: string, startDate?: string, endDate?: string, page?: number, pageSize?: number }) {
        const { data: appointments, total } = await appointmentRepository.getAppointments(filters);
        const enriched = await this.attachMedicalAndInsurance(appointments);
        const summary = {
            totalAppointments: appointments.length,
            totalScheduled: 0,
            totalConfirmed: 0,
            totalPaymentPending: 0,
            totalCompleted: 0
        };
        for (const apt of appointments) {
            const s = apt.Status?.toLowerCase() || "";
            if (s === "scheduled") summary.totalScheduled++;
            else if (s === "confirmed") summary.totalConfirmed++;
            else if (s === "paymentpending") summary.totalPaymentPending++;
            else if (s === "completed") summary.totalCompleted++;
        }
        return { data: enriched, summary, total, page: filters.page || 1, pageSize: filters.pageSize || 50 };
    }

    async cancelAppointment(appointmentId: number, slotId: number) {
        return await AppDataSource.transaction(async (manager) => {
            await manager.update("Appointments", appointmentId, {
                Status: "Cancelled",
                UpdatedAt: new Date()
            });

            await manager.update("HealthcareProviderScheduleSlots", slotId, {
                IsBooked: false,
                Status: "Available",
                UpdatedAt: new Date()
            });
        });
    }

    async updateAppointmentStatus(appointmentId: number, status: string) {
        return await AppDataSource.transaction(async (manager) => {
            // Update appointment status
            await manager.update(Appointment, appointmentId, { Status: status, UpdatedAt: new Date() });

            const statusLower = status.toLowerCase();

            // If status is "Arrived", add to queue if not already there
            if (statusLower === AppointmentStatus.Arrived.toLowerCase()) {
                const existingQueue = await manager.findOne(PatientQueue, { where: { AppointmentId: appointmentId } });
                if (!existingQueue) {
                    const appointment = await manager.findOne(Appointment, { 
                        where: { Id: appointmentId },
                        relations: ["Hospital"]
                    });
                    
                    if (appointment) {
                        const nextNumber = await patientQueueRepository.getNextQueueNumber(appointment.HospitalId, new Date());
                        const newQueueEntry = manager.create(PatientQueue, {
                            AppointmentId: appointmentId,
                            DoctorId: appointment.DoctorId,
                            QueueNumber: nextNumber,
                            Status: QueueStatus.Waiting,
                            AddedAt: new Date()
                        });
                        await manager.save(newQueueEntry);
                    }
                }
            }

            // If status is "In Progress", update queue status to "WithDoctor"
            if (statusLower === AppointmentStatus.InProgress.toLowerCase()) {
                const queueEntry = await manager.findOne(PatientQueue, { where: { AppointmentId: appointmentId } });
                if (queueEntry) {
                    await manager.update(PatientQueue, queueEntry.Id, { 
                        Status: QueueStatus.WithDoctor,
                        CalledAt: new Date()
                    });
                }
            }

            // If status is "Completed", update queue status
            if (statusLower === AppointmentStatus.Completed.toLowerCase()) {
                const queueEntry = await manager.findOne(PatientQueue, { where: { AppointmentId: appointmentId } });
                if (queueEntry) {
                    await manager.update(PatientQueue, queueEntry.Id, { 
                        Status: QueueStatus.Completed,
                        CompletedAt: new Date()
                    });
                }
            }

            // If status is "Cancelled", update queue status and free up schedule slot
            if (statusLower === AppointmentStatus.Cancelled.toLowerCase()) {
                const appointment = await manager.findOne(Appointment, { where: { Id: appointmentId } });
                if (appointment && appointment.SlotId) {
                    await manager.update("HealthcareProviderScheduleSlots", appointment.SlotId, {
                        IsBooked: false,
                        Status: "Available",
                        UpdatedAt: new Date()
                    });
                }
                const queueEntry = await manager.findOne(PatientQueue, { where: { AppointmentId: appointmentId } });
                if (queueEntry) {
                    await manager.update(PatientQueue, queueEntry.Id, { 
                        Status: QueueStatus.Skipped
                    });
                }
            }
        });
    }

    async rescheduleAppointment(appointmentId: number, data: { newSlotId: number; newDoctorId: string; newDate: string; startTime: string; endTime: string }) {
        return await AppDataSource.transaction(async (manager) => {
            const appointment = await manager.findOne(Appointment, { where: { Id: appointmentId } });
            if (!appointment) throw new Error("Appointment not found.");

            // 1. Release old slot (if slot exists and is changed)
            if (appointment.SlotId && appointment.SlotId !== data.newSlotId) {
                await manager.update("HealthcareProviderScheduleSlots", appointment.SlotId, {
                    IsBooked: false,
                    Status: "Available",
                    UpdatedAt: new Date()
                });
            }

            // 2. Book new slot
            await manager.update("HealthcareProviderScheduleSlots", data.newSlotId, {
                IsBooked: true,
                Status: "Booked",
                UpdatedAt: new Date()
            });

            // 3. Update appointment details
            await manager.update(Appointment, appointmentId, {
                SlotId: data.newSlotId,
                DoctorId: data.newDoctorId,
                AppointmentDate: new Date(data.newDate),
                StartTime: data.startTime,
                EndTime: data.endTime,
                UpdatedAt: new Date()
            });

            // 4. Update queue if queue exists
            const queueEntry = await manager.findOne(PatientQueue, { where: { AppointmentId: appointmentId } });
            if (queueEntry) {
                await manager.update(PatientQueue, queueEntry.Id, {
                    DoctorId: data.newDoctorId
                });
            }

            return await manager.findOne(Appointment, { where: { Id: appointmentId } });
        });
    }

    async createInstantMeeting(topic: string = "Instant Consultation") {
        return await zoomService.createMeeting(topic);
    }
}

export const appointmentService = new AppointmentService();

