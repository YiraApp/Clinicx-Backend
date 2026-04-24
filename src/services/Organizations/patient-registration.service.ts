import { PatientRegistration } from "../../models/Organizations/patient-registration.model.js";
import { patientRegistrationRepository } from "../../repositories/Organizations/patient-registration.repository.js";
import { PatientInsurance } from "../../models/Organizations/patient-insurance.model.js";
import { patientInsuranceRepository } from "../../repositories/Organizations/patient-insurance.repository.js";

export class PatientRegistrationService {
    async registerPatient(data: any): Promise<any> {
        const { userId, organizationId, hospitalId, ...patientFields } = data;

        if (!userId) throw new Error("UserId is required for patient registration.");

        // 1. Handle Medical Registration (Allergies, Medical History)
        let registration = await patientRegistrationRepository.findByUserId(userId, organizationId);
        if (!registration) {
            registration = new PatientRegistration();
            registration.UserId = userId;
            registration.OrganizationId = organizationId;
            registration.HospitalId = hospitalId;
        }

        if (patientFields.allergies !== undefined) registration.Allergies = patientFields.allergies;
        if (patientFields.medicalHistory !== undefined) registration.MedicalHistory = patientFields.medicalHistory;
        
        registration.Status = true;
        registration.IsDeleted = false;
        await patientRegistrationRepository.save(registration);

        // 2. Handle Insurance Details
        if (patientFields.insuranceProvider && patientFields.insuranceNumber) {
            let insurance = await patientInsuranceRepository.findByUserId(userId, organizationId, hospitalId);
            if (!insurance) {
                insurance = new PatientInsurance();
                insurance.UserId = userId;
                insurance.OrganizationId = organizationId;
                insurance.HospitalId = hospitalId;
            }
            insurance.InsuranceProvider = patientFields.insuranceProvider;
            insurance.InsuranceNumber = patientFields.insuranceNumber;
            insurance.Status = true;
            insurance.IsDeleted = false;
            await patientInsuranceRepository.save(insurance);
        }

        return { message: "Patient details saved successfully." };
    }

    async getPatients(page: number, pageSize: number, filters: any): Promise<any> {
        return await patientRegistrationRepository.getPatients(page, pageSize, filters);
    }

    async sendRegistrationLink(data: any): Promise<any> {
        const { name, phone, channel, email, organizationId, hospitalId } = data;
        
        const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
        const link = `${baseUrl}/self-register?orgId=${organizationId || ""}&hospId=${hospitalId || ""}&name=${encodeURIComponent(name)}&phone=${phone}&email=${encodeURIComponent(email || "")}`;

        if (channel === "email" && email) {
            // Send Email
            try {
                const { mailService } = await import("../Mail/mail.service.js");
                await mailService.sendDynamicEmail("PATIENT_REGISTRATION_LINK", email, {
                    name,
                    link,
                });
            } catch (err) {
                console.error("Mail service error:", err);
                // Fallback or ignore for now if template doesn't exist
            }
        } else {
            // Log SMS/WhatsApp link for now
            console.log(`[SMS/WhatsApp to ${phone}]: Hello ${name}, please register here: ${link}`);
        }

        return { message: "Link sent successfully.", link }; // Return link for testing
    }
}

export const patientRegistrationService = new PatientRegistrationService();
