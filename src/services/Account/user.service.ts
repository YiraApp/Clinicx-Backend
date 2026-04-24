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
                Password : data.Password,
                PhoneNumber: data.PhoneNumber,
                Gender: data.Gender,
                CountryCode : data.CountryCode,
                DateOfBirth: data.DateOfBirth,
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
        user.FirstName = data.FirstName;
        if (data.LastName) user.LastName = data.LastName;
        if (data.Email) user.Email = data.Email;
        if (data.CountryCode) user.CountryCode = data.CountryCode;
        if (data.Gender) user.Gender = data.Gender;
        if (data.DateOfBirth) user.DateOfBirth = data.DateOfBirth;
        if (data.Relation) user.Relation = data.Relation;
        if (data.ParentUserId) user.ParentUserId = data.ParentUserId;
        if (data.Status !== undefined) user.Status = data.Status;

        if (data.Status !== undefined) user.Status = data.Status;

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

        if (data.EmergencyContactName) user.EmergencyContactName = data.EmergencyContactName;
        if (data.EmergencyContactPhone) user.EmergencyContactPhone = data.EmergencyContactPhone;
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
                // Found a match
                const ra = requestedAssignments[matchIndex];
                
                // Reactivate if currently inactive
                if (!cr.Status) {
                    cr.Status = true;
                    cr.UpdatedAt = new Date();
                    rolesToUpdate.push(cr);
                }
                
                // Remove from requested list so we don't treat it as a new creation
                requestedAssignments.splice(matchIndex, 1);
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
                status: r.Status
            }))
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

    async toggleStatus(id: string, status: boolean): Promise<void> {
        const user = await userRepository.findById(id);
        if (!user) throw new Error("User not found.");
        await userRepository.updateStatus(id, status);
    }
}

export const userService = new UserService();
