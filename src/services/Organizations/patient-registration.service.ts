import { v4 as uuidv4 } from "uuid";
import { PatientRegistration } from "../../models/Organizations/patient-registration.model.js";
import { patientRegistrationRepository } from "../../repositories/Organizations/patient-registration.repository.js";
import { PatientInsurance } from "../../models/Organizations/patient-insurance.model.js";
import { patientInsuranceRepository } from "../../repositories/Organizations/patient-insurance.repository.js";
import { addressRepository } from "../../repositories/Account/address.repository.js";
import { Address } from "../../models/Account/address.model.js";
import { userRepository } from "../../repositories/Account/user.repository.js";
import { defaultOrganizationRepository } from "../../repositories/Organizations/default-organization.repository.js";

export class PatientRegistrationService {

    async sendPatientRegistrationWhatsApp(user: any, tokenNumber?: string): Promise<void> {
        try {
            const { whatsappService } = await import("../Common/whatsapp.service.js");
            const patientName = `${user.FirstName || ""} ${user.LastName || ""}`.trim() || "Patient";
            const patientMobile = user.PhoneNumber || "";
            const memberRef = tokenNumber || user.TokenNumber || "N/A";

            if (!patientMobile) {
                console.warn("[WhatsApp clinic_reg] Skipping: No phone number for user:", user?.Id);
                return;
            }

            let normalizedPhone = patientMobile.replace(/\D/g, "");
            if (normalizedPhone.length === 10) {
                normalizedPhone = `91${normalizedPhone}`;
            }

            const components = [
                {
                    type: "body",
                    parameters: [
                        { type: "text", text: patientName },
                        { type: "text", text: patientMobile },
                        { type: "text", text: memberRef }
                    ]
                }
            ];

            console.log(`[WhatsApp clinic_reg] Sending template 'clinic_reg' to ${normalizedPhone} with params:`, {
                1: patientName,
                2: patientMobile,
                3: memberRef
            });

            await whatsappService.sendTemplateMessage(normalizedPhone, "clinic_reg", "en", components);
            console.log(`[WhatsApp clinic_reg] Successfully sent template 'clinic_reg' to ${normalizedPhone}`);
        } catch (err: any) {
            console.error(`[WhatsApp clinic_reg] Error sending registration WhatsApp message:`, err?.message || err);
        }
    }


    async getNextTokenNumber(hospitalId?: number): Promise<{ tokenNumber: string; hospitalId: number; hospitalCode: string; currentMaxSequence: number; nextSequence: number }> {
        const { hospitalRepository } = await import("../../repositories/Organizations/hospital.repository.js");
        const { defaultOrganizationRepository } = await import("../../repositories/Organizations/default-organization.repository.js");
        const { AppDataSource } = await import("../../config/database.js");
        const { User } = await import("../../models/Account/user.model.js");

        let targetHospId = hospitalId;
        if (!targetHospId) {
            const activeDefault = await defaultOrganizationRepository.getActiveDefault();
            targetHospId = activeDefault?.HospitalId || 19;
        }

        const hospital = await hospitalRepository.findById(targetHospId);
        
        let prefix = "HOSP";
        if (hospital) {
            if (hospital.HospitalCode && hospital.HospitalCode.trim()) {
                prefix = hospital.HospitalCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
            } else if (hospital.Name && hospital.Name.trim()) {
                prefix = hospital.Name.trim().split(" ")[0].toUpperCase().replace(/[^A-Z0-9]/g, "");
            }
        }
        if (!prefix || prefix.length < 2) {
            prefix = `HOSP${targetHospId}`;
        }

        const year = new Date().getFullYear();
        const tokenPattern = `${prefix}-${year}-%`;

        // 1. Query PatientRegistration table across the hospital and year prefix
        const regRepo = AppDataSource.getRepository(PatientRegistration);
        const regTokens = await regRepo.createQueryBuilder("pr")
            .select("pr.TokenNumber", "token")
            .where("pr.TokenNumber LIKE :tokenPattern", { tokenPattern })
            .getRawMany();

        // 2. Query Users table to ensure global uniqueness across all registered users
        const userRepo = AppDataSource.getRepository(User);
        const userTokens = await userRepo.createQueryBuilder("u")
            .select("u.TokenNumber", "token")
            .where("u.TokenNumber LIKE :tokenPattern", { tokenPattern })
            .getRawMany();

        // 3. Extract and compute the true maximum sequence number in the database
        let maxSeq = 0;
        const allTokens = [...regTokens, ...userTokens];
        for (const row of allTokens) {
            if (row.token) {
                const parts = String(row.token).trim().split("-");
                const seqStr = parts[parts.length - 1];
                const num = parseInt(seqStr, 10);
                if (!isNaN(num) && num > maxSeq) {
                    maxSeq = num;
                }
            }
        }

        const nextSeq = maxSeq + 1;
        const tokenNumber = `${prefix}-${year}-${String(nextSeq).padStart(4, "0")}`;

        console.log(`[TokenSequence] Hospital: ${prefix} (ID ${targetHospId}) | Year: ${year} | Current Max Sequence: ${maxSeq} | Assigned Next Token: ${tokenNumber}`);

        return {
            tokenNumber,
            hospitalId: targetHospId,
            hospitalCode: prefix,
            currentMaxSequence: maxSeq,
            nextSequence: nextSeq
        };
    }

    async registerPatient(data: any): Promise<any> {
        const { userId, organizationId, hospitalId, token, ...patientFields } = data;

        if (!userId) throw new Error("UserId is required for patient registration.");

        // If registration was initiated via a registration link token (GUID), validate and deactivate it
        const isGuid = typeof token === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token.trim());
        if (token && isGuid) {
            const { userRegistrationLinkRepository } = await import("../../repositories/Organizations/user-registration-link.repository.js");
            const regLink = await userRegistrationLinkRepository.findByToken(token.trim());
            if (!regLink) {
                throw new Error("Registration link not found or has already been used.");
            }
            if (regLink.ExpiryTime && new Date(regLink.ExpiryTime) < new Date()) {
                throw new Error("Registration link has expired. Please request a new one.");
            }
            await userRegistrationLinkRepository.markAsUsed(regLink.Id);
        }

        // 1. Handle Medical Registration (Allergies, Medical History)
        const activeDefault = await defaultOrganizationRepository.getActiveDefault();
        const effectiveOrgId = organizationId || activeDefault?.OrganizationId || 1;
        const effectiveHospitalId = hospitalId || activeDefault?.HospitalId || 19;

        let registration = await patientRegistrationRepository.findByUserId(userId, effectiveOrgId);
        if (!registration) {
            registration = new PatientRegistration();
            registration.UserId = userId;
            registration.OrganizationId = effectiveOrgId;
            registration.HospitalId = effectiveHospitalId;
        } else if (!registration.HospitalId) {
            registration.HospitalId = effectiveHospitalId;
        }

        if (patientFields.allergies !== undefined) registration.Allergies = patientFields.allergies;
        if (patientFields.medicalHistory !== undefined) registration.MedicalHistory = patientFields.medicalHistory;
        if (patientFields.tokenNumber || (!isGuid && token ? token : undefined)) {
            registration.TokenNumber = patientFields.tokenNumber || (!isGuid && token ? token : undefined);
        } else if (!registration.TokenNumber) {
            const nextTokenData = await this.getNextTokenNumber(effectiveHospitalId);
            registration.TokenNumber = nextTokenData.tokenNumber;
        }

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

        // Send clinic_reg WhatsApp template in background
        (async () => {
            try {
                const u = await userRepository.findById(userId);
                if (u) {
                    await this.sendPatientRegistrationWhatsApp(u, registration.TokenNumber || u.TokenNumber || undefined);
                }
            } catch (err) {
                console.error("[WhatsApp clinic_reg] Background trigger error:", err);
            }
        })();

        return { message: "Patient details saved successfully.", tokenNumber: registration.TokenNumber };
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
        const { mobile, email, name, hospitalId, organizationId } = filters;
        if (!mobile && !email && !name) {
            throw new Error("At least one search parameter (mobile, email, or name) must be provided.");
        }

        const { AppDataSource } = await import("../../config/database.js");
        const { User } = await import("../../models/Account/user.model.js");
        const { PatientRegistration } = await import("../../models/Organizations/patient-registration.model.js");
        const { UserRole } = await import("../../models/Account/userrole.model.js");

        const userRepo = AppDataSource.getRepository(User);
        const regRepo = AppDataSource.getRepository(PatientRegistration);
        const userRoleRepo = AppDataSource.getRepository(UserRole);

        const PATIENT_ROLE_ID = "4FC67429-28AE-4106-93EF-436228282ED0";

        // 1. Find matched users by Phone/Email/Name directly from Users table
        const query = userRepo.createQueryBuilder("u")
            .where("u.IsDeleted = 0")
            .andWhere("u.Status = :statusActive", { statusActive: true });

        const orConditions: string[] = [];
        const params: any = { statusActive: true };

        if (mobile) {
            const cleanMobile = mobile.replace(/\D/g, '').slice(-10);
            orConditions.push("(u.PhoneNumber = :mobile OR RIGHT(REPLACE(u.PhoneNumber, ' ', ''), 10) = :cleanMobile)");
            params.mobile = mobile;
            params.cleanMobile = cleanMobile;
        }
        if (email) {
            orConditions.push("u.Email = :email");
            params.email = email;
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

        // 2. Identify phone numbers and parent IDs to pull the entire family group
        const phoneNumbers = [...new Set(matches.map(m => m.PhoneNumber).filter(Boolean))];
        const parentIds = new Set<string>();
        matches.forEach(m => {
            if (m.ParentUserId) {
                parentIds.add(m.ParentUserId.toUpperCase());
            } else {
                parentIds.add(m.Id.toUpperCase());
            }
        });

        // 3. Fetch ALL users in these family groups (Primary + all family members)
        const familyQuery = userRepo.createQueryBuilder("u")
            .where("u.IsDeleted = 0")
            .andWhere("u.Status = :statusActive", { statusActive: true });

        const familyConditions: string[] = [];
        const familyParams: any = { statusActive: true };

        if (phoneNumbers.length > 0) {
            familyConditions.push("u.PhoneNumber IN (:...phoneNumbers)");
            familyParams.phoneNumbers = phoneNumbers;
        }
        if (parentIds.size > 0) {
            const parentIdsArr = Array.from(parentIds);
            familyConditions.push("u.ParentUserId IN (:...parentIdsArr)");
            familyConditions.push("u.Id IN (:...parentIdsArr)");
            familyParams.parentIdsArr = parentIdsArr;
        }

        if (familyConditions.length > 0) {
            familyQuery.andWhere(`(${familyConditions.join(' OR ')})`, familyParams);
        }

        const rawFamilyMembers = await familyQuery.getMany();

        // Deduplicate raw family members by ID
        const uniqueMembersMap = new Map<string, typeof rawFamilyMembers[0]>();
        rawFamilyMembers.forEach(u => {
            if (u.Id && !uniqueMembersMap.has(u.Id.toUpperCase())) {
                uniqueMembersMap.set(u.Id.toUpperCase(), u);
            }
        });
        const allFamilyMembers = Array.from(uniqueMembersMap.values());

        // 4. Check hospital/org patient registration strictly for the requested hospital/org
        let effectiveHospId = hospitalId ? Number(hospitalId) : undefined;
        let effectiveOrgId = organizationId ? Number(organizationId) : undefined;

        const registeredUserIds = new Set<string>();
        const existingTokensMap = new Map<string, string>();
        let hasCheckedRegistration = false;

        if (effectiveHospId || effectiveOrgId) {
            hasCheckedRegistration = true;

            const urQuery = userRoleRepo.createQueryBuilder("ur")
                .select(["ur.UserRoleId", "ur.UserId", "ur.RoleId", "ur.HospitalId"])
                .where("ur.IsDeleted = 0")
                .andWhere("ur.Status = 1")
                .andWhere("ur.RoleId = :patientRoleId", { patientRoleId: PATIENT_ROLE_ID });

            if (effectiveHospId) {
                urQuery.andWhere("ur.HospitalId = :hospitalId", { hospitalId: effectiveHospId });
            } else if (effectiveOrgId) {
                urQuery.andWhere("ur.OrganizationId = :organizationId", { organizationId: effectiveOrgId });
            }
            const urs = await urQuery.getMany();
            urs.forEach(r => {
                if (r.UserId) registeredUserIds.add(r.UserId.toUpperCase());
            });

            // Also check PatientRegistration table
            const prQuery = regRepo.createQueryBuilder("pr")
                .select(["pr.Id", "pr.UserId", "pr.TokenNumber", "pr.HospitalId"])
                .where("pr.IsDeleted = 0");

            if (effectiveHospId) {
                prQuery.andWhere("pr.HospitalId = :hospitalId", { hospitalId: effectiveHospId });
            } else if (effectiveOrgId) {
                prQuery.andWhere("pr.OrganizationId = :organizationId", { organizationId: effectiveOrgId });
            }
            const prRows = await prQuery.getMany();
            prRows.forEach(pr => {
                if (pr.UserId) {
                    registeredUserIds.add(pr.UserId.toUpperCase());
                    if (pr.TokenNumber) existingTokensMap.set(pr.UserId.toUpperCase(), pr.TokenNumber);
                }
            });
        }

        // 5. Group by primary user
        const userPhoneMap = new Map<string, string>();
        allFamilyMembers.forEach(u => {
            if (u.PhoneNumber) {
                userPhoneMap.set(u.Id.toUpperCase(), u.PhoneNumber);
            }
        });

        const tempGroups = new Map<string, any[]>();
        allFamilyMembers.forEach(u => {
            let phone = u.PhoneNumber;
            if (!phone && u.ParentUserId) {
                phone = userPhoneMap.get(u.ParentUserId.toUpperCase()) || "";
            }
            if (!phone) {
                phone = "unknown";
            }

            const uid = u.Id.toUpperCase();
            const isRegisteredAtHospital = Boolean(hasCheckedRegistration && registeredUserIds.has(uid));
            const tokenNumber = existingTokensMap.get(uid) || u.TokenNumber || null;

            if (!tempGroups.has(phone)) {
                tempGroups.set(phone, []);
            }

            const list = tempGroups.get(phone)!;
            if (!list.some(existing => existing.id.toUpperCase() === uid)) {
                list.push({
                    id: u.Id,
                    name: `${u.FirstName || ""} ${u.LastName || ""}`.trim(),
                    firstName: u.FirstName,
                    lastName: u.LastName,
                    email: u.Email,
                    phone: u.PhoneNumber || phone,
                    gender: u.Gender,
                    dateOfBirth: u.DateOfBirth,
                    relation: u.Relation,
                    isPrimary: Boolean(u.IsPrimary || (u as any).isPrimary),
                    status: u.Status,
                    bloodGroup: u.BloodGroup,
                    tokenNumber,
                    isRegisteredAtHospital,
                    action: isRegisteredAtHospital ? "already_registered" : "register_to_hospital"
                });
            }
        });

        const groups = Array.from(tempGroups.entries()).map(([phone, members]) => {
            // Find true primary user (isPrimary: true first, then no parentUserId)
            let primaryIndex = members.findIndex(m => m.isPrimary);
            if (primaryIndex === -1) {
                primaryIndex = members.findIndex(m => m.id === "6CDE8235-B520-4442-B912-9622A9D357D0" || m.relation === "Admin" || !m.relation);
            }
            if (primaryIndex === -1) {
                primaryIndex = 0;
            }

            const primary = members[primaryIndex];

            // Deduplicate relations
            const seenRelIds = new Set<string>();
            if (primary && primary.id) {
                seenRelIds.add(primary.id.toUpperCase());
            }

            const relations: any[] = [];
            members.forEach((m, idx) => {
                if (idx !== primaryIndex && m.id && !seenRelIds.has(m.id.toUpperCase())) {
                    seenRelIds.add(m.id.toUpperCase());
                    relations.push(m);
                }
            });

            return {
                primary,
                relations
            };
        });

        return groups;
    }
}

export const patientRegistrationService = new PatientRegistrationService();
