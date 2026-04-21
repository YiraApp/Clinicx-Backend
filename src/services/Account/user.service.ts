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

/**
 * Service implementation for User operations.
 */

export class UserService implements IUserService {
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

        // 7. Send Welcome Email
        if (savedUser.Email) {
            try {
                await mailService.sendDynamicEmail("WELCOME_EMAIL", savedUser.Email, {
                    FirstName: savedUser.FirstName,
                    LastName: savedUser.LastName || "",
                    RoleMessage: data.RoleMessage || (isEntityUser ? "Your account has been set up with administrative privileges." : "Welcome to the Clinicx family!"),
                    Email: savedUser.Email,
                    Password: passwordToUse, // Show the used password (either provided or generated)
                    Role: data.RoleName || (isEntityUser ? "Staff/Admin" : "User"),
                    OrganizationName: data.OrganizationName || "Clinicx",
                    LoginURL: data.LoginURL || process.env.CLIENT_URL || "https://clinicx.azurewebsites.net/"
                });
            } catch (mailError) {
                console.error(`[Mail] Failed to send welcome email to ${savedUser.Email}:`, mailError);
                // Non-blocking: user is created even if mail fails
            }
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

    async updateUser(data: UpdateUserRequest): Promise<any> {
        let user: User | null = null;

        // 1. Find or Create User
        if (data.Id) {
            user = await userRepository.findById(data.Id);
            if (!user) {
                throw new Error("User with provided ID not found.");
            }
        } else {
            // New user creation path
            // We use the existing createUser logic which handles:
            // 1. Finding high-level primary user for the phone
            // 2. Checking the 6-user limit
            // 3. Auto-linking as Secondary if an account exists
            const createResult = await this.createUser({
                FirstName: data.FirstName,
                LastName: data.LastName,
                Email: data.Email,
                PhoneNumber: data.PhoneNumber,
                Gender: data.Gender,
                DateOfBirth: data.DateOfBirth,
                Relation: data.Relation || "Admin" 
            }, true);
            user = await userRepository.findById(createResult.Id);
        }

        if (!user) {
            throw new Error("User could not be found or created.");
        }

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

            if (matchIndex === -1) {
                // Not requested anymore -> Inactivate if currently active
                if (cr.Status) {
                    cr.Status = false;
                    cr.UpdatedAt = new Date();
                    rolesToUpdate.push(cr);
                }
            } else {
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
        requestedAssignments.forEach(ra => {
            const newRole = new UserRole();
            newRole.UserId = user!.Id;
            newRole.RoleId = ra.roleId;
            newRole.OrganizationId = ra.organizationId;
            if (ra.hospitalId) newRole.HospitalId = Number(ra.hospitalId);
            newRole.Status = true;
            newRole.IsDeleted = false;
            newRole.CreatedAt = new Date();
            rolesToUpdate.push(newRole);
        });

        if (rolesToUpdate.length > 0) {
            await userRoleRepository.saveAll(rolesToUpdate);
        }

        return { message: "User updated successfully." };
    }

    async getPrimaryAccount(phoneNumber: string): Promise<any> {
        const primaryUser = await userRepository.findPrimaryByPhone(phoneNumber);
        if (!primaryUser) {
            return { exists: false, message: "No primary account found for this phone number." };
        }

        return {
            exists: true,
            user: {
                id: primaryUser.Id,
                name: `${primaryUser.FirstName} ${primaryUser.LastName || ""}`.trim(),
                email: primaryUser.Email,
                phoneNumber: primaryUser.PhoneNumber
            }
        };
    }
}

export const userService = new UserService();
