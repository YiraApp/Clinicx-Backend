import { PatientRegistration } from "../../models/Organizations/patient-registration.model.js";
import { patientRegistrationRepository } from "../../repositories/Organizations/patient-registration.repository.js";
import { PatientInsurance } from "../../models/Organizations/patient-insurance.model.js";
import { patientInsuranceRepository } from "../../repositories/Organizations/patient-insurance.repository.js";
import { addressRepository } from "../../repositories/Account/address.repository.js";
import { Address } from "../../models/Account/address.model.js";
import { userRepository } from "../../repositories/Account/user.repository.js";

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

        // 3. Handle User Addresses
        console.log("[PatientRegistrationService] patientFields:", patientFields);
        if (patientFields.PermanentAddress || patientFields.TemporaryAddress || patientFields.AddressLine1) {
            const user = await userRepository.findById(userId);
            if (user) {
                let permData = patientFields.PermanentAddress;
                console.log("[PatientRegistrationService] Found user, processing addresses. permData:", permData);
                if (!permData && patientFields.AddressLine1) {
                    permData = {
                        AddressLine1: patientFields.AddressLine1,
                        AddressLine2: patientFields.AddressLine2,
                        City: patientFields.City,
                        State: patientFields.State,
                        Pincode: patientFields.Pincode,
                        Landmark: patientFields.Landmark,
                        Country: patientFields.Country
                    };
                }

                if (permData && permData.AddressLine1) {
                    let address: Address | null = null;
                    if (user.PermanentAddressId) address = await addressRepository.findById(user.PermanentAddressId);
                    if (!address) address = new Address();

                    Object.assign(address, permData);
                    address.AddressType = true; // Permanent
                    const saved = await addressRepository.save(address);
                    user.PermanentAddressId = saved.Id;
                }

                if (patientFields.TemporaryAddress && patientFields.TemporaryAddress.AddressLine1) {
                    let address: Address | null = null;
                    if (user.TemporaryAddressId) address = await addressRepository.findById(user.TemporaryAddressId);
                    if (!address) address = new Address();

                    Object.assign(address, patientFields.TemporaryAddress);
                    address.AddressType = false; // Temporary
                    const saved = await addressRepository.save(address);
                    user.TemporaryAddressId = saved.Id;
                }

                await userRepository.save(user);
            }
        }

        return { message: "Patient details saved successfully." };
    }

    async getPatients(page: number, pageSize: number, filters: any): Promise<any> {
        return await patientRegistrationRepository.getPatients(page, pageSize, filters);
    }

    async sendRegistrationLink(data: any): Promise<any> {
        const { name, phone, countryCode, channel, email, organizationId, hospitalId } = data;
        const PATIENT_ROLE_ID = "4FC67429-28AE-4106-93EF-436228282ED0";

        // 1. Check if user already exists as a patient in this org/hospital
        const { userRepository } = await import("../../repositories/Account/user.repository.js");
        const identifier = email || phone;
        
        if (identifier) {
            const exists = await userRepository.checkUserRole(identifier, PATIENT_ROLE_ID, organizationId, hospitalId);
            if (exists) {
                throw new Error("A patient with this contact information is already registered in this organization/hospital.");
            }
        }

        // 2. Create registration link record
        const { UserRegistrationLink } = await import("../../models/Organizations/user-registration-link.model.js");
        const { userRegistrationLinkRepository } = await import("../../repositories/Organizations/user-registration-link.repository.js");
        
        const regLink = new UserRegistrationLink();
        regLink.Email = email ?? null;
        regLink.PhoneNumber = phone ?? null;
        regLink.CountryCode = countryCode ?? "91";
        regLink.OrganizationId = organizationId ? Number(organizationId) : null;
        regLink.HospitalId = hospitalId ? Number(hospitalId) : null;
        regLink.Type = channel === "email" ? "Email" : channel === "sms" ? "SMS" : "WhatsApp";
        regLink.IsUsed = false;
        regLink.ExpiryTime = new Date(Date.now() + 48 * 60 * 60 * 1000);
        regLink.Role = "Patient";
        regLink.UserId = null;
        regLink.CreatedBy = null;

        const savedLink = await userRegistrationLinkRepository.save(regLink);

        const baseUrl = process.env.FRONTEND_URL || process.env.CLIENT_URL || "http://localhost:5173";
        // Use token instead of raw details for security
        const link = `${baseUrl}/self-register?token=${savedLink.Token}&orgId=${organizationId || ""}&hospId=${hospitalId || ""}&name=${encodeURIComponent(name)}&phone=${phone}&countryCode=${regLink.CountryCode}`;

        if (channel === "email" && email) {
            try {
                const { mailService } = await import("../Mail/mail.service.js");
                await mailService.sendDynamicEmail("PATIENT_REGISTRATION_INVITE", email, {
                    PatientName: name,
                    RegistrationLink: link,
                });
            } catch (err) {
                console.error("Mail service error:", err);
            }
        } else {
            console.log(`[${regLink.Type} to ${regLink.CountryCode}${phone}]: Hello ${name}, please register here: ${link}`);
        }

        return { message: "Link sent successfully.", link };
    }

    async getOrgHospPatients(page: number, pageSize: number, filters: any): Promise<any> {
        const PATIENT_ROLE_ID = "4FC67429-28AE-4106-93EF-436228282ED0";
        const { userRepository } = await import("../../repositories/Account/user.repository.js");
        
        // Force the patient role ID filter
        const finalFilters = {
            ...filters,
            roleId: PATIENT_ROLE_ID
        };

        if (filters.hospitalId) {
            return await userRepository.getHospUsers(page, pageSize, finalFilters);
        } else {
            return await userRepository.getOrgUsers(page, pageSize, finalFilters);
        }
    }
}

export const patientRegistrationService = new PatientRegistrationService();
