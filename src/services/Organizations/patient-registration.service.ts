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
        const userRepo = AppDataSource.getRepository(User);
        
        const PATIENT_ROLE_ID = "4FC67429-28AE-4106-93EF-436228282ED0";

        // 1. Find all potential matches
        const query = userRepo.createQueryBuilder("u")
            .innerJoin("u.UserRoles", "ur")
            .where("u.IsDeleted = 0")
            .andWhere("ur.RoleId = :patientRole", { patientRole: PATIENT_ROLE_ID })
            .andWhere("ur.Status = 1");
            
        if (!globalSearch) {
            if (hospitalId) {
                query.andWhere("ur.HospitalId = :hospitalId", { hospitalId });
            } else if (organizationId) {
                query.andWhere("ur.OrganizationId = :organizationId", { organizationId });
            }
        } else if (organizationId) {
            // Even in global search, restrict to organization level to prevent cross-tenant leakage
            query.andWhere("ur.OrganizationId = :organizationId", { organizationId });
        }
            
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
        
        if (matches.length === 0) {
            return [];
        }
        
        // 2. Extract unique PhoneNumbers from matches to get entire family groups
        const phoneNumbers = [...new Set(matches.map(m => m.PhoneNumber).filter(Boolean))];
        
        if (phoneNumbers.length === 0) return [];

        // 3. Fetch all users belonging to those phone numbers
        const familyQuery = userRepo.createQueryBuilder("u")
            .innerJoin("u.UserRoles", "ur")
            .where("u.IsDeleted = 0")
            .andWhere("ur.RoleId = :patientRole", { patientRole: PATIENT_ROLE_ID })
            .andWhere("ur.Status = 1")
            .andWhere("u.PhoneNumber IN (:...phoneNumbers)", { phoneNumbers });
            
        if (!globalSearch) {
            if (hospitalId) {
                familyQuery.andWhere("ur.HospitalId = :hospitalId", { hospitalId });
            } else if (organizationId) {
                familyQuery.andWhere("ur.OrganizationId = :organizationId", { organizationId });
            }
        } else if (organizationId) {
            familyQuery.andWhere("ur.OrganizationId = :organizationId", { organizationId });
        }

        const allFamilyMembers = await familyQuery.getMany();
            
        // 4. Group by PhoneNumber
        const groupsMap = new Map<string, { primary: any, relations: any[] }>();
        
        allFamilyMembers.forEach(u => {
            const phone = u.PhoneNumber;
            if (!groupsMap.has(phone)) {
                groupsMap.set(phone, { primary: null, relations: [] });
            }
            
            const group = groupsMap.get(phone)!;
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
                bloodGroup: u.BloodGroup
            };
            
            if (u.IsPrimary || u.Relation === "Self") {
                group.primary = userData;
            } else {
                group.relations.push(userData);
            }
        });
        
        // Return array of groups
        return Array.from(groupsMap.values()).map(g => ({
            // If somehow primary is missing, fallback to first user
            primary: g.primary || g.relations[0],
            relations: g.primary ? g.relations : g.relations.slice(1)
        }));
    }
}

export const patientRegistrationService = new PatientRegistrationService();
