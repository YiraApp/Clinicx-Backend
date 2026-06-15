import { v4 as uuidv4 } from "uuid";
import { PatientRegistration } from "../../models/Organizations/patient-registration.model.js";
import { patientRegistrationRepository } from "../../repositories/Organizations/patient-registration.repository.js";
import { PatientInsurance } from "../../models/Organizations/patient-insurance.model.js";
import { patientInsuranceRepository } from "../../repositories/Organizations/patient-insurance.repository.js";
import { addressRepository } from "../../repositories/Account/address.repository.js";
import { Address } from "../../models/Account/address.model.js";
import { userRepository } from "../../repositories/Account/user.repository.js";

export class PatientRegistrationService {
    async registerPatient(data: any): Promise<any> {
        const { userId, organizationId, hospitalId, token, ...patientFields } = data;

        if (!userId) throw new Error("UserId is required for patient registration.");

        // If registration was initiated via a token, validate and deactivate it
        if (token) {
            const { userRegistrationLinkRepository } = await import("../../repositories/Organizations/user-registration-link.repository.js");
            const regLink = await userRegistrationLinkRepository.findByToken(token);
            if (!regLink) {
                throw new Error("Registration link not found or has already been used.");
            }
            if (regLink.ExpiryTime && new Date(regLink.ExpiryTime) < new Date()) {
                throw new Error("Registration link has expired. Please request a new one.");
            }
            await userRegistrationLinkRepository.markAsUsed(regLink.Id);
        }

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
        regLink.Token = uuidv4().toUpperCase();
        regLink.Email = email ?? null;
        regLink.PhoneNumber = phone ?? null;
        regLink.CountryCode = countryCode ?? "91";
        regLink.PatientName = name ?? null;
        regLink.OrganizationId = organizationId ? Number(organizationId) : null;
        regLink.HospitalId = hospitalId ? Number(hospitalId) : null;
        regLink.Type = channel === "email" ? "Email" : channel === "sms" ? "SMS" : "WhatsApp";
        regLink.IsUsed = false;
        regLink.ExpiryTime = new Date(Date.now() + 48 * 60 * 60 * 1000);
        regLink.Role = "Patient";
        regLink.UserId = null;
        regLink.CreatedBy = null;

        const savedLink = await userRegistrationLinkRepository.save(regLink);

        const baseUrl = (process.env.FRONTEND_URL || process.env.CLIENT_URL || "http://localhost:5173").replace(/\/+$/, "");
        // Use only the token in the link — all metadata is fetched securely from the backend
        const link = `${baseUrl}/self-register?token=${savedLink.Token}`;

        // Resolve organization/hospital name for WhatsApp template {{2}} parameter
        let orgDisplayName = "our clinic";
        try {
            if (hospitalId) {
                const { hospitalRepository } = await import("../../repositories/Organizations/hospital.repository.js");
                const hospital = await hospitalRepository.findById(Number(hospitalId));
                if (hospital?.Name) orgDisplayName = hospital.Name;
            } else if (organizationId) {
                const { organizationRepository } = await import("../../repositories/Organizations/organization.repository.js");
                const org = await organizationRepository.findById(Number(organizationId));
                if (org?.Name) orgDisplayName = org.Name;
            }
        } catch (err) {
            console.error("[SendRegistrationLink] Failed to resolve org/hospital name:", err);
        }

        // 3. Send via the selected channel
        if (channel === "email" && email) {
            try {
                const { mailService } = await import("../Mail/mail.service.js");
                await mailService.sendDynamicEmail("PATIENT_REGISTRATION_INVITE", email, {
                    PatientName: name,
                    RegistrationLink: link,
                });
            } catch (err) {
                console.error("[SendRegistrationLink] Mail service error:", err);
            }
        } else if (channel === "whatsapp" && phone) {
            // Send via WhatsApp Graph API using the "self_registration" template
            try {
                const { whatsappService } = await import("../Common/whatsapp.service.js");
                const normalizedPhone = `${countryCode || "91"}${phone.replace(/\D/g, "")}`;

                // Template: self_registration
                // Header: Expected 1 localizable_param (e.g. Org Name / Clinic Name)
                // Body: Hello {{1}}, Your patient registration for {{2}} is awaiting completion...
                // Button[0]: URL button with registration link
                const components = [
                    {
                        type: "header",
                        parameters: [
                            { type: "text", text: orgDisplayName }            // Dynamic header parameter (e.g., Clinic Name)
                        ]
                    },
                    {
                        type: "body",
                        parameters: [
                            { type: "text", text: name || "Patient" },       // {{1}} - Patient name
                            { type: "text", text: orgDisplayName },           // {{2}} - Organization/Hospital name
                        ]
                    },
                    {
                        type: "button",
                        sub_type: "url",
                        index: 0,
                        parameters: [
                            { type: "text", text: savedLink.Token }           // Only the token — WhatsApp appends to template's URL prefix
                        ]
                    }
                ];

                await whatsappService.sendTemplateMessage(normalizedPhone, "self_registration", "en", components);
                console.log(`[SendRegistrationLink] WhatsApp template sent to ${normalizedPhone}`);
            } catch (err) {
                console.error("[SendRegistrationLink] WhatsApp service error:", err);
                throw err;
            }
        } else if (channel === "sms" && phone) {
            // Send via SMS
            try {
                const { smsService } = await import("../Common/sms.service.js");
                const normalizedPhone = `${countryCode || "91"}${phone.replace(/\D/g, "")}`;
                const message = `Hello ${name || "Patient"}, your patient registration for ${orgDisplayName} is awaiting completion. Please use this secure link to complete your registration: ${link} - Thank you`;
                await smsService.sendSMS(normalizedPhone, message);
                console.log(`[SendRegistrationLink] SMS sent to ${normalizedPhone}`);
            } catch (err) {
                console.error("[SendRegistrationLink] SMS service error:", err);
            }
        } else {
            console.log(`[SendRegistrationLink] [${regLink.Type} to ${regLink.CountryCode}${phone}]: Hello ${name}, please register here: ${link}`);
        }

        return { message: "Link sent successfully.", link };
    }

    /**
     * Looks up a registration link by token and returns the associated metadata.
     * Used by the public /self-register page to pre-fill the form.
     */
    async getRegistrationLinkByToken(token: string): Promise<any> {
        const { userRegistrationLinkRepository } = await import("../../repositories/Organizations/user-registration-link.repository.js");

        const regLink = await userRegistrationLinkRepository.findAnyByToken(token);
        if (!regLink) {
            throw new Error("Registration link not found. Please verify your link.");
        }

        if (regLink.IsUsed) {
            throw new Error("ALREADY_USED");
        }

        if (regLink.ExpiryTime && new Date(regLink.ExpiryTime) < new Date()) {
            throw new Error("Registration link has expired. Please request a new one.");
        }

        // Resolve organization and hospital names for display
        let organizationName: string | null = null;
        let hospitalName: string | null = null;

        if (regLink.OrganizationId) {
            const { organizationRepository } = await import("../../repositories/Organizations/organization.repository.js");
            const org = await organizationRepository.findById(regLink.OrganizationId);
            organizationName = org?.Name ?? null;
        }

        if (regLink.HospitalId) {
            const { hospitalRepository } = await import("../../repositories/Organizations/hospital.repository.js");
            const hospital = await hospitalRepository.findById(regLink.HospitalId);
            hospitalName = hospital?.Name ?? null;
        }

        // Parse name into firstName / lastName
        const nameParts = (regLink.PatientName || "").trim().split(" ");
        const firstName = nameParts[0] || "";
        const lastName = nameParts.slice(1).join(" ") || "";

        return {
            token: regLink.Token,
            firstName,
            lastName,
            name: regLink.PatientName,
            phone: regLink.PhoneNumber,
            countryCode: regLink.CountryCode,
            email: regLink.Email,
            organizationId: regLink.OrganizationId,
            hospitalId: regLink.HospitalId,
            organizationName,
            hospitalName,
            role: regLink.Role,
        };
    }

    async getOrgHospPatients(page: number, pageSize: number, filters: any): Promise<any> {
        const PATIENT_ROLE_ID = "4FC67429-28AE-4106-93EF-436228282ED0";
        const { userRepository } = await import("../../repositories/Account/user.repository.js");
        const { AppDataSource } = await import("../../config/database.js");
        const { PatientInsurance } = await import("../../models/Organizations/patient-insurance.model.js");
        const { PatientRegistration } = await import("../../models/Organizations/patient-registration.model.js");

        // Force the patient role ID filter
        const finalFilters = {
            ...filters,
            roleId: PATIENT_ROLE_ID
        };

        let result: any;
        if (filters.hospitalId) {
            result = await userRepository.getHospUsers(page, pageSize, finalFilters);
        } else {
            result = await userRepository.getOrgUsers(page, pageSize, finalFilters);
        }

        // Extract patient user IDs from result
        const patients: any[] = result?.data?.data || result?.patients || [];
        if (patients.length === 0) return result;

        const userIds = patients.map((p: any) => p.userId || p.id).filter(Boolean);

        // Batch-load insurance records for all patients
        const insuranceRepo = AppDataSource.getRepository(PatientInsurance);
        const insurances = await insuranceRepo.createQueryBuilder("i")
            .where("i.UserId IN (:...userIds)", { userIds })
            .andWhere("i.IsDeleted = :deleted", { deleted: false })
            .getMany();

        const insuranceMap = new Map<string, PatientInsurance>();
        insurances.forEach(ins => insuranceMap.set(ins.UserId.toUpperCase(), ins));

        // Batch-load patient registration records
        const regRepo = AppDataSource.getRepository(PatientRegistration);
        const registrations = await regRepo.createQueryBuilder("r")
            .where("r.UserId IN (:...userIds)", { userIds })
            .andWhere("r.IsDeleted = :deleted", { deleted: false })
            .getMany();

        const regMap = new Map<string, PatientRegistration>();
        registrations.forEach(reg => regMap.set(reg.UserId.toUpperCase(), reg));

        // Merge insurance + registration into each patient
        const enriched = patients.map((p: any) => {
            const uid = (p.userId || p.id || "").toUpperCase();
            const ins = insuranceMap.get(uid);
            const reg = regMap.get(uid);
            return {
                ...p,
                insuranceProvider: ins?.InsuranceProvider || null,
                insuranceNumber: ins?.InsuranceNumber || null,
                insuranceStatus: ins?.Status ?? null,
                allergies: reg?.Allergies || p.allergies || null,
                medicalHistory: reg?.MedicalHistory || p.medicalHistory || null,
            };
        });

        // Rebuild result with enriched patients
        if (result?.data?.data) {
            return { ...result, data: { ...result.data, data: enriched } };
        }
        return { ...result, patients: enriched };
    }

    async quickCheck(filters: { mobile?: string, email?: string, name?: string, hospitalId?: number, organizationId?: number, globalSearch?: boolean }): Promise<any[]> {
        const { mobile, email, name, hospitalId, organizationId, globalSearch } = filters;
        if (!mobile && !email && !name) {
            throw new Error("At least one search parameter (mobile, email, or name) must be provided.");
        }

        const { AppDataSource } = await import("../../config/database.js");
        const { User } = await import("../../models/Account/user.model.js");
        const { PatientRegistration } = await import("../../models/Organizations/patient-registration.model.js");
        const userRepo = AppDataSource.getRepository(User);
        const regRepo = AppDataSource.getRepository(PatientRegistration);

        const PATIENT_ROLE_ID = "4FC67429-28AE-4106-93EF-436228282ED0";

        // 1. Find primary user(s) matching the search — patient role only
        const query = userRepo.createQueryBuilder("u")
            .innerJoin("u.UserRoles", "ur")
            .where("u.IsDeleted = 0")
            .andWhere("ur.RoleId = :patientRoleId", { patientRoleId: PATIENT_ROLE_ID })
            .andWhere("ur.Status = 1")
            .andWhere("ur.IsDeleted = 0");

        const orConditions = [];
        const params: any = {};

        if (mobile) {
            orConditions.push("u.PhoneNumber LIKE :mobile");
            params.mobile = `%${mobile}%`;
        }
        if (email) {
            orConditions.push("u.Email LIKE :email");
            params.email = `%${email}%`;
        }
        if (name) {
            orConditions.push("(u.FirstName LIKE :name OR u.LastName LIKE :name OR (COALESCE(u.FirstName, '') + ' ' + COALESCE(u.LastName, '')) LIKE :name)");
            params.name = `%${name}%`;
        }

        if (orConditions.length > 0) {
            query.andWhere(`(${orConditions.join(' OR ')})`, params);
        }

        const matches = await query.getMany();
        if (matches.length === 0) return [];

        // 2. Get all unique phone numbers from matches to find family members
        const phoneNumbers = [...new Set(matches.map(m => m.PhoneNumber).filter(Boolean))];
        if (phoneNumbers.length === 0) return [];

        // 3. Fetch ALL users with those phone numbers (family group) — patient role only
        const allFamilyMembers = await userRepo.createQueryBuilder("u")
            .innerJoin("u.UserRoles", "ur2")
            .where("u.IsDeleted = 0")
            .andWhere("u.PhoneNumber IN (:...phoneNumbers)", { phoneNumbers })
            .andWhere("ur2.RoleId = :patientRoleId2", { patientRoleId2: PATIENT_ROLE_ID })
            .andWhere("ur2.Status = 1")
            .andWhere("ur2.IsDeleted = 0")
            .getMany();

        // 4. Check hospital/org registration for each user
        let registeredUserIds = new Set<string>();
        if (hospitalId || organizationId) {
            const regQuery = regRepo.createQueryBuilder("pr")
                .select("pr.UserId")
                .where("pr.IsDeleted = 0");
            if (hospitalId) {
                regQuery.andWhere("pr.HospitalId = :hospitalId", { hospitalId });
            } else if (organizationId) {
                regQuery.andWhere("pr.OrganizationId = :organizationId", { organizationId });
            }
            const regs = await regQuery.getMany();
            registeredUserIds = new Set(regs.map(r => r.UserId.toUpperCase()));
        }

        // 5. Group by PhoneNumber
        const groupsMap = new Map<string, { primary: any, relations: any[] }>();

        allFamilyMembers.forEach(u => {
            const phone = u.PhoneNumber;
            if (!groupsMap.has(phone)) {
                groupsMap.set(phone, { primary: null, relations: [] });
            }

            const group = groupsMap.get(phone)!;
            const isRegisteredAtHospital = registeredUserIds.size === 0 || registeredUserIds.has(u.Id.toUpperCase());

            const userData = {
                id: u.Id,
                name: `${u.FirstName || ""} ${u.LastName || ""}`.trim(),
                firstName: u.FirstName,
                lastName: u.LastName,
                email: u.Email,
                phone: u.PhoneNumber,
                gender: u.Gender,
                dateOfBirth: u.DateOfBirth,
                relation: u.Relation,
                isPrimary: u.IsPrimary,
                status: u.Status,
                bloodGroup: u.BloodGroup,
                // Key flag: is this person registered at the current hospital?
                isRegisteredAtHospital,
                // Action hint for frontend
                action: isRegisteredAtHospital ? "book" : "register_and_book"
            };

            if (u.IsPrimary || u.Relation === "Self" || !u.Relation) {
                // If no primary set yet, first match becomes primary
                if (!group.primary) {
                    group.primary = userData;
                } else {
                    group.relations.push(userData);
                }
            } else {
                group.relations.push(userData);
            }
        });

        return Array.from(groupsMap.values()).map(g => ({
            primary: g.primary || g.relations[0],
            relations: g.primary ? g.relations : g.relations.slice(1)
        }));
    }
}

export const patientRegistrationService = new PatientRegistrationService();
