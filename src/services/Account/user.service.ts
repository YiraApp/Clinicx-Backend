import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import { User } from "../../models/Account/user.model.js";
import { userRepository } from "../../repositories/Account/user.repository.js";
import { userOTPRepository } from "../../repositories/Account/userotp.repository.js";
import { OTPType, OTPPurpose } from "../../enums/OTPType.enum.js";
import type { CreateUserRequest } from "../../dtos/Request/Account/CreateUserRequest.js";
import type { CreateUserResponse } from "../../dtos/Response/Account/CreateUserResponse.js";
import type { IUserService } from "../../interfaces/Service/Account/IUserService.js";
import { mailService } from "../../services/Mail/mail.service.js";
import { userRoleRepository } from "../../repositories/Account/userrole.repository.js";
import { UserRole } from "../../models/Account/userrole.model.js";
import type { UpdateUserRequest } from "../../dtos/Request/Account/UpdateUserRequest.js";
import { generateTemporaryPassword } from "../../utils/password.utils.js";
import { roleRepository } from "../../repositories/Account/role.repository.js";
import { organizationRepository } from "../../repositories/Organizations/organization.repository.js";
import { hospitalRepository } from "../../repositories/Organizations/hospital.repository.js";
import { addressRepository } from "../../repositories/Account/address.repository.js";
import { Address } from "../../models/Account/address.model.js";
import { tokenRepository } from "../../repositories/Account/token.repository.js";
import { AppDataSource } from "../../config/database.js";
import { PatientRegistration } from "../../models/Organizations/patient-registration.model.js";
import { PatientInsurance } from "../../models/Organizations/patient-insurance.model.js";
import { PatientPrescription } from "../../models/Appointments/patient-prescription.model.js";

/**
 * Service implementation for User operations.
 */

export class UserService implements IUserService {
    private async saveAddress(addressData: any, existingAddressId?: number, addressType?: boolean): Promise<number | undefined> {
        console.log("[UserService] saveAddress called with:", { addressData, existingAddressId, addressType });
        if (!addressData || !addressData.AddressLine1) {
            console.log("[UserService] saveAddress skipped: Missing addressData or AddressLine1");
            return undefined;
        }

        let address: Address | null = null;
        if (existingAddressId) {
            address = await addressRepository.findById(existingAddressId);
        }

        if (!address) {
            address = new Address();
        }

        address.AddressLine1 = addressData.AddressLine1;
        address.AddressLine2 = addressData.AddressLine2;
        address.City = addressData.City;
        address.State = addressData.State;
        address.Pincode = addressData.Pincode;
        address.Landmark = addressData.Landmark;
        address.Country = addressData.Country;
        if (addressType !== undefined) address.AddressType = addressType;

        const savedAddress = await addressRepository.save(address);
        return savedAddress.Id;
    }

    async createUser(data: CreateUserRequest, isEntityUser: boolean = false): Promise<CreateUserResponse> {
        // 1. Check if a primary user exists for this phone number
        const primaryUser = await userRepository.findPrimaryByPhone(data.PhoneNumber);

        // 2. Count existing users for this phone number
        const userCount = await userRepository.countUsersByPhone(data.PhoneNumber);

        // 3. Business Rule: Max 6 users per phone number
        if (userCount >= 6) {
            throw new Error("Maximum of 6 users allowed per phone number account.");
        }

        const newUser = new User();
        newUser.Id = uuidv4();
        newUser.PhoneNumber = data.PhoneNumber;
        newUser.FirstName = data.FirstName;
        newUser.CountryCode = data?.CountryCode || "91";

        if (data.LastName) newUser.LastName = data.LastName;
        if (data.Email) newUser.Email = data.Email;
        if (data.Gender) newUser.Gender = data.Gender;
        if (data.DateOfBirth) newUser.DateOfBirth = data.DateOfBirth;
        if (data.BloodGroup) newUser.BloodGroup = data.BloodGroup;
        if (data.Height) newUser.Height = data.Height;
        if (data.Weight) newUser.Weight = data.Weight;

        newUser.Status = true;
        newUser.IsDeleted = false;

        // 4. Hashing password (auto-generate if missing)
        let passwordToUse = data.Password;
        if (!passwordToUse) {
            passwordToUse = generateTemporaryPassword(8);
        }

        const salt = await bcrypt.genSalt(10);
        newUser.PasswordHash = await bcrypt.hash(passwordToUse, salt);

        if (data.IsMobileVerified !== undefined) newUser.IsMobileVerified = data.IsMobileVerified;
        if (data.IsEmailVerified !== undefined) newUser.IsEmailVerified = data.IsEmailVerified;

        if (data.IsEmailVerified !== undefined) newUser.IsEmailVerified = data.IsEmailVerified;

        // 5. Handle Addresses
        let permData = data.PermanentAddress;
        if (!permData && data.AddressLine1) {
            permData = {
                AddressLine1: data.AddressLine1,
                AddressLine2: data.AddressLine2,
                City: data.City,
                State: data.State,
                Pincode: data.Pincode,
                Landmark: data.Landmark,
                Country: data.Country
            };
        }

        const permId = await this.saveAddress(permData, undefined, true);
        if (permId) newUser.PermanentAddressId = permId;

        const tempId = await this.saveAddress(data.TemporaryAddress, undefined, false);
        if (tempId) newUser.TemporaryAddressId = tempId;




        // 5. Check if this is the first user (Primary) or a linked user (Secondary)
        if (!primaryUser) {
            // First user for this phone number -> BECOMES PRIMARY
            newUser.IsPrimary = true;
            newUser.Relation = "Self"; // Standard for primary
        } else {
            // Secondary user -> MUST have a relation, unless it's an entity user (Admin/Staff)
            if (isEntityUser) {
                newUser.IsPrimary = false;
                newUser.Relation = data.Relation || "Admin"; // Default to Admin for organization users
                newUser.ParentUserId = primaryUser.Id;
            } else {
                if (!data.Relation || data.Relation.toLowerCase() === "self") {
                    throw new Error("Relation is mandatory for secondary users and cannot be 'Self'.");
                }
                newUser.IsPrimary = false;
                newUser.Relation = data.Relation;
                newUser.ParentUserId = primaryUser.Id;
            }
        }

        // 6. Save the user
        const savedUser = await userRepository.save(newUser);

        // 7. Send Welcome Email (Non-blocking to prevent transaction timeouts)
        if (savedUser.Email) {
            mailService.sendDynamicEmail("WELCOME_EMAIL", savedUser.Email, {
                FirstName: savedUser.FirstName,
                LastName: savedUser.LastName || "",
                RoleMessage: data.RoleMessage || (isEntityUser ? "Your account has been set up with administrative privileges." : "Welcome to the Clinicx family!"),
                Email: savedUser.Email,
                Password: passwordToUse, // Show the used password (either provided or generated)
                Role: data.RoleName || (isEntityUser ? "Staff/Admin" : "User"),
                OrganizationName: data.OrganizationName || "Clinicx",
                LoginURL: data.LoginURL || process.env.CLIENT_URL || "https://clinicx.azurewebsites.net/"
            }).catch(mailError => {
                console.error(`[Mail] Background sending failed for ${savedUser.Email}:`, mailError);
            });
        }

        return {
            Id: savedUser.Id,
            PhoneNumber: savedUser.PhoneNumber,
            IsPrimary: savedUser.IsPrimary,
            Message: savedUser.IsPrimary
                ? "Primary user created successfully."
                : `Secondary user created and linked to primary account (${savedUser.Relation}).`
        };
    }

    async getUsers(page: number = 1, pageSize: number = 10, filters?: any): Promise<any> {
        return await userRepository.getUsers(page, pageSize, filters);
    }

    async getOrgUsers(page: number = 1, pageSize: number = 10, filters: any): Promise<any> {
        return await userRepository.getOrgUsers(page, pageSize, filters);
    }

    async getHospUsers(page: number = 1, pageSize: number = 10, filters: any): Promise<any> {
        return await userRepository.getHospUsers(page, pageSize, filters);
    }

    async updateUser(data: UpdateUserRequest): Promise<any> {
        let user: User | null = null;

        // 1. Find or Create User
        if (data.Id) {
            user = await userRepository.findById(data.Id);
            if (!user) {
                throw new Error("User with provided ID not found.");
            }
        } else {
            const createResult = await this.createUser({
                FirstName: data.FirstName,
                LastName: data.LastName,
                Email: data.Email,
                Password: data.Password,
                PhoneNumber: data.PhoneNumber,
                Gender: data.Gender,
                CountryCode: data.CountryCode,
                DateOfBirth: data.DateOfBirth,
                BloodGroup: data.BloodGroup,
                Relation: data.Relation || "Admin"
            }, true);
            user = await userRepository.findById(createResult.Id);
        }

        if (!user) {
            throw new Error("User could not be found or created.");
        }

        console.log("data.PhoneNumber", data.PhoneNumber);
        console.log("user.PhoneNumber", user.PhoneNumber);
        // 2. Enforce Business Rule (Max 6 users) if phone number is changed for an existing user
        if (data.Id && data.PhoneNumber !== user.PhoneNumber) {
            const userCount = await userRepository.countUsersByPhone(data.PhoneNumber);
            if (userCount >= 6) {
                throw new Error("Maximum of 6 users allowed per phone number account.");
            }
            user.PhoneNumber = data.PhoneNumber;
        }

        // 3. Update basic fields
        user.FirstName = data.FirstName ?? null;
        user.LastName = data.LastName ?? null;
        user.Email = data.Email ?? null;
        user.CountryCode = data.CountryCode ?? "91";
        user.Gender = data.Gender ?? null;
        user.DateOfBirth = data.DateOfBirth ?? null;
        user.BloodGroup = data.BloodGroup ?? null;
        user.Relation = data.Relation ?? "Admin";
        user.ParentUserId = data.ParentUserId ?? null;
        user.Status = data.Status !== undefined ? data.Status : true;
        user.Height = data.Height ?? null;
        user.Weight = data.Weight ?? null;

        // 4. Update addresses
        let permData = data.PermanentAddress;
        if (!permData && data.AddressLine1) {
            permData = {
                AddressLine1: data.AddressLine1,
                AddressLine2: data.AddressLine2,
                City: data.City,
                State: data.State,
                Pincode: data.Pincode,
                Landmark: data.Landmark,
                Country: data.Country
            };
        }

        const permId = await this.saveAddress(permData, user.PermanentAddressId, true);
        if (permId) user.PermanentAddressId = permId;

        const tempId = await this.saveAddress(data.TemporaryAddress, user.TemporaryAddressId, false);
        if (tempId) user.TemporaryAddressId = tempId;

        user.EmergencyContactName = data.EmergencyContactName ?? null;
        user.EmergencyContactPhone = data.EmergencyContactPhone ?? null;
        user.UpdatedAt = new Date();

        await userRepository.save(user);

        // 4. Manage Roles Safely
        const currentRoles = await userRoleRepository.findAllByUserId(user.Id);
        const requestedAssignments = [...(data.workspaces || [])]; // Create a copy as we will splice

        const rolesToUpdate: UserRole[] = [];

        // Identify existing roles and mark for update (reactivate or deactivate)
        currentRoles.forEach(cr => {
            const matchIndex = requestedAssignments.findIndex(ra =>
                (ra.userRoleId && Number(ra.userRoleId) === cr.UserRoleId) ||
                (ra.roleId === cr.RoleId &&
                    ra.organizationId === cr.OrganizationId &&
                    (ra.hospitalId ? Number(ra.hospitalId) === cr.HospitalId : !cr.HospitalId))
            );

            if (matchIndex !== -1) {
                // Found a match - should be active
                const ra = requestedAssignments[matchIndex];

                // Reactivate if currently inactive
                if (!cr.Status) {
                    cr.Status = true;
                    cr.UpdatedAt = new Date();
                    rolesToUpdate.push(cr);
                }

                // Remove from requested list so we don't treat it as a new creation
                requestedAssignments.splice(matchIndex, 1);
            } else {
                // NOT in requested assignments - deactivate if currently active
                if (cr.Status) {
                    cr.Status = false;
                    cr.UpdatedAt = new Date();
                    rolesToUpdate.push(cr);
                }
            }
        });

        // Any remaining requestedAssignments are new
        for (const ra of requestedAssignments) {
            let finalRoleId = ra.roleId;

            // If it's not a valid GUID, try to resolve by name
            const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
            if (!guidRegex.test(finalRoleId)) {
                const resolvedRole = await roleRepository.findByNormalizedName(finalRoleId);
                if (resolvedRole) {
                    finalRoleId = resolvedRole.Id;
                } else {
                    console.warn(`[UserService] Role name "${finalRoleId}" could not be resolved to a GUID.`);
                    continue; // Skip invalid roles
                }
            }

            const newRole = new UserRole();
            newRole.UserId = user!.Id;
            newRole.RoleId = finalRoleId;
            newRole.OrganizationId = ra.organizationId;
            if (ra.hospitalId) newRole.HospitalId = Number(ra.hospitalId);
            newRole.Status = true;
            newRole.IsDeleted = false;
            newRole.CreatedAt = new Date();
            rolesToUpdate.push(newRole);
        }

        if (rolesToUpdate.length > 0) {
            await userRoleRepository.saveAll(rolesToUpdate);

            // Revoke all existing sessions to force immediate role reflection on all devices
            if (data.revokeTokens !== false) {
                await tokenRepository.revokeAllUserTokens(user.Id);
            } else {
                console.log(`[UserService] Skipping token revocation for user ${user.Id} because revokeTokens=false`);
            }

            // Only notify for roles that are currently active (newly assigned or reactivated)
            const activeNewRoles = rolesToUpdate.filter(r => r.Status);

            if (activeNewRoles.length > 0 && user!.Email) {
                for (const ur of activeNewRoles) {
                    try {
                        const role = await roleRepository.findById(ur.RoleId);
                        let orgName = "N/A";
                        let hospitalName = "N/A (Organization Level)";

                        if (ur.OrganizationId) {
                            const org = await organizationRepository.findById(ur.OrganizationId);
                            if (org) orgName = org.Name;
                        }

                        if (ur.HospitalId) {
                            const hospital = await hospitalRepository.findById(ur.HospitalId);
                            if (hospital) hospitalName = hospital.Name;
                        }

                        await mailService.sendDynamicEmail("NEW_ROLE_ASSIGNED", user!.Email, {
                            firstName: user!.FirstName,
                            roleName: role?.RoleName || "Member",
                            organizationName: orgName,
                            hospitalName: hospitalName,
                            link: `${process.env.FRONTEND_URL}/login`
                        });
                    } catch (mailErr) {
                        console.error("[UserService] Failed to send role assignment email:", mailErr);
                    }
                }
            }
        }

        return {
            message: "User updated successfully.",
            userId: user!.Id
        };
    }

    async getPrimaryAccount(phoneNumber: string): Promise<any> {
        const primaryUser = await userRepository.findPrimaryByPhone(phoneNumber);
        if (!primaryUser) {
            return { exists: false, message: "No primary account found for this phone number." };
        }

        // 1. Resolve Provider Role ID dynamically
        const providerRole = await roleRepository.findByNormalizedName("PROVIDER");
        const providerRoleId = providerRole?.Id || "FE80173F-9DB3-4703-84A8-5C23E7CC493C"; // Fallback to verified ID

        // check if user is already a healthcare provider
        const isHealthcareProvider = await userRoleRepository.findByUserIdAndRoleId(primaryUser.Id, providerRoleId);
        const roles = await userRoleRepository.findAllByUserId(primaryUser.Id);

        const providerAssignments = roles
            .filter(r => r.RoleId === providerRoleId)
            .map(r => ({
                roleId: r.RoleId,
                roleName: r.Role?.RoleName || r.RoleId,
                status: r.Status,
                organizationId: r.OrganizationId,
                organizationName: r.Organization?.Name || null,
                hospitalId: r.HospitalId,
                hospitalName: r.Hospital?.Name || null
            }));

        const userPayload = {
            id: primaryUser.Id,
            firstName: primaryUser.FirstName,
            lastName: primaryUser.LastName,
            email: primaryUser.Email,
            phoneNumber: primaryUser.PhoneNumber,
            roles: roles.map(r => ({
                roleId: r.RoleId,
                roleName: r.Role?.RoleName || r.RoleId,
                organizationId: r.OrganizationId,
                hospitalId: r.HospitalId,
                status: r.Status,
                organizationName: r.Organization?.Name || null,
                hospitalName: r.Hospital?.Name || null
            })),
            providerAssignments
        };

        if (isHealthcareProvider) {
            return {
                exists: true,
                message: "User is already a healthcare provider.",
                user: userPayload
            };
        }

        return {
            exists: true,
            user: userPayload
        };
    }

    async exportUsers(filters: any): Promise<any[]> {
        return await userRepository.getAllUsersForExport(filters);
    }

    async toggleStatus(id: string, status: boolean): Promise<void> {
        const user = await userRepository.findById(id);
        if (!user) throw new Error("User not found.");
        await userRepository.updateStatus(id, status);
    }

    async updatePassword(userId: string, newPassword: string): Promise<void> {
        const user = await userRepository.findById(userId);
        if (!user) throw new Error("User not found.");

        const salt = await bcrypt.genSalt(10);
        user.PasswordHash = await bcrypt.hash(newPassword, salt);
        user.UpdatedAt = new Date();

        await userRepository.save(user);
    }

    /**
     * Fetches details of the authenticated patient's profile.
     */
    async getPatientProfile(userId: string): Promise<any> {
        // 1. Fetch user with addresses
        const userRepo = AppDataSource.getRepository(User);
        const user = await userRepo.findOne({
            where: { Id: userId },
            relations: ["PermanentAddress", "TemporaryAddress"]
        });

        if (!user) {
            throw new Error("Patient not found");
        }

        // 2. Fetch patient registration details (allergies, medical history)
        const patientRegRepo = AppDataSource.getRepository(PatientRegistration);
        const patientReg = await patientRegRepo.findOne({
            where: { UserId: userId, IsDeleted: false, Status: true }
        });

        // 3. Fetch patient insurance details
        const patientInsRepo = AppDataSource.getRepository(PatientInsurance);
        const patientIns = await patientInsRepo.findOne({
            where: { UserId: userId, IsDeleted: false, Status: true }
        });

        // 4. Fetch latest prescriptions for medications
        const prescriptionRepo = AppDataSource.getRepository(PatientPrescription);
        const prescriptions = await prescriptionRepo.find({
            where: { PatientId: userId },
            relations: ["Medications"],
            order: { Date: "DESC", CreatedAt: "DESC" }
        });

        // Collect all medications
        const currentMedications: any[] = [];
        const seenMeds = new Set<string>();
        for (const presc of prescriptions) {
            if (presc.Medications) {
                for (const med of presc.Medications) {
                    const medKey = `${med.Medication.trim().toLowerCase()}-${(med.Dosage || "").trim().toLowerCase()}`;
                    if (!seenMeds.has(medKey)) {
                        seenMeds.add(medKey);
                        currentMedications.push({
                            name: med.Medication,
                            dosage: med.Dosage ?? null,
                            frequency: med.FrequencyType ?? null
                        });
                    }
                }
            }
        }

        // Parse lists of allergies and chronic conditions safely
        const parseList = (str: string | null | undefined): string[] => {
            if (!str) return [];
            try {
                if (str.trim().startsWith("[") && str.trim().endsWith("]")) {
                    return JSON.parse(str);
                }
            } catch {}
            return str.split(",").map(s => s.trim()).filter(Boolean);
        };

        const allergies = patientReg ? parseList(patientReg.Allergies) : [];
        const chronicConditions = patientReg ? parseList(patientReg.MedicalHistory) : [];

        const addressStr = user.PermanentAddress
            ? [user.PermanentAddress.AddressLine1, user.PermanentAddress.AddressLine2, user.PermanentAddress.City, user.PermanentAddress.State, user.PermanentAddress.Pincode, user.PermanentAddress.Country]
                .filter(Boolean)
                .join(", ")
            : null;

        const dateOfBirthStr = user.DateOfBirth 
            ? (typeof user.DateOfBirth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(user.DateOfBirth)
                ? user.DateOfBirth
                : new Date(user.DateOfBirth).toISOString().split('T')[0])
            : null;

        const responseData = {
            personalInfo: {
                firstName: user.FirstName ?? null,
                lastName: user.LastName ?? null,
                email: user.Email ?? null,
                phone: user.PhoneNumber ?? null,
                dateOfBirth: dateOfBirthStr,
                gender: user.Gender ?? null,
                address: addressStr || null,
                emergencyContact: {
                    name: user.EmergencyContactName ?? null,
                    relationship: user.Relation ?? null,
                    phone: user.EmergencyContactPhone ?? null
                }
            },
            medicalInfo: {
                bloodGroup: user.BloodGroup ?? null,
                height: user.Height != null ? String(user.Height) : null,
                weight: user.Weight != null ? String(user.Weight) : null,
                allergies: allergies,
                chronicConditions: chronicConditions,
                currentMedications: currentMedications
            },
            insurance: {
                provider: patientIns?.InsuranceProvider ?? null,
                policyNumber: patientIns?.InsuranceNumber ?? null,
                validUntil: null,
                coverage: null
            },
            preferences: {
                notifications: {
                    appointments: true,
                    medications: true,
                    testResults: true,
                    healthTips: false,
                    marketing: false
                },
                privacy: {
                    shareDataWithProviders: true,
                    allowResearch: false,
                    twoFactorAuth: true
                }
            }
        };

        return responseData;
    }

    /**
     * Updates details of the authenticated patient's profile.
     */
    async updatePatientProfile(userId: string, profileData: any): Promise<any> {
        const userRepo = AppDataSource.getRepository(User);
        const user = await userRepo.findOne({
            where: { Id: userId },
            relations: ["PermanentAddress"]
        });

        if (!user) {
            throw new Error("Patient not found");
        }

        // 1. Update basic personal info
        const personal = profileData.personalInfo || {};
        if (personal.firstName !== undefined) user.FirstName = personal.firstName;
        if (personal.lastName !== undefined) user.LastName = personal.lastName;
        if (personal.email !== undefined) user.Email = personal.email;
        if (personal.phone !== undefined) user.PhoneNumber = personal.phone;
        if (personal.dateOfBirth !== undefined) user.DateOfBirth = personal.dateOfBirth;
        if (personal.gender !== undefined) user.Gender = personal.gender;

        // Emergency Contact
        const emergency = personal.emergencyContact || {};
        if (emergency.name !== undefined) user.EmergencyContactName = emergency.name;
        if (emergency.relationship !== undefined) user.Relation = emergency.relationship;
        if (emergency.phone !== undefined) user.EmergencyContactPhone = emergency.phone;

        // Medical basic info
        const medical = profileData.medicalInfo || {};
        if (medical.bloodGroup !== undefined) user.BloodGroup = medical.bloodGroup;
        if (medical.height !== undefined) user.Height = medical.height ? Number(medical.height) : null;
        if (medical.weight !== undefined) user.Weight = medical.weight ? Number(medical.weight) : null;

        // 2. Parse and save Address if provided
        if (personal.address !== undefined) {
            let address = user.PermanentAddress;
            if (!address) {
                address = new Address();
                address.AddressType = true;
            }
            address.AddressLine1 = personal.address;
            const savedAddress = await AppDataSource.getRepository(Address).save(address);
            user.PermanentAddressId = savedAddress.Id;
        }

        user.UpdatedAt = new Date();
        await userRepo.save(user);

        // 3. Save Allergies and Chronic Conditions into PatientRegistration
        const patientRegRepo = AppDataSource.getRepository(PatientRegistration);
        let patientReg = await patientRegRepo.findOne({
            where: { UserId: userId, IsDeleted: false, Status: true }
        });

        if (!patientReg) {
            patientReg = new PatientRegistration();
            patientReg.UserId = userId;
            patientReg.Status = true;
            patientReg.IsDeleted = false;
        }

        if (medical.allergies !== undefined) {
            patientReg.Allergies = Array.isArray(medical.allergies) 
                ? JSON.stringify(medical.allergies) 
                : String(medical.allergies);
        }

        if (medical.chronicConditions !== undefined) {
            patientReg.MedicalHistory = Array.isArray(medical.chronicConditions)
                ? JSON.stringify(medical.chronicConditions)
                : String(medical.chronicConditions);
        }

        await patientRegRepo.save(patientReg);

        // 4. Save Insurance Details
        const insurance = profileData.insurance || {};
        if (insurance.provider !== undefined || insurance.policyNumber !== undefined) {
            const patientInsRepo = AppDataSource.getRepository(PatientInsurance);
            let patientIns = await patientInsRepo.findOne({
                where: { UserId: userId, IsDeleted: false, Status: true }
            });

            if (!patientIns) {
                patientIns = new PatientInsurance();
                patientIns.UserId = userId;
                patientIns.Status = true;
                patientIns.IsDeleted = false;
                
                const userRoleRepo = AppDataSource.getRepository(UserRole);
                const userRole = await userRoleRepo.findOne({ where: { UserId: userId } });
                patientIns.OrganizationId = userRole?.OrganizationId || 1;
            }

            if (insurance.provider !== undefined) {
                patientIns.InsuranceProvider = insurance.provider;
            }
            if (insurance.policyNumber !== undefined) {
                patientIns.InsuranceNumber = insurance.policyNumber;
            }

            if (patientIns.InsuranceProvider && patientIns.InsuranceNumber) {
                await patientInsRepo.save(patientIns);
            }
        }

        return { message: "Profile updated successfully" };
    }
}

export const userService = new UserService();
