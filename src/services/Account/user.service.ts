import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import { User } from "../../models/Account/user.model.js";
import { userRepository } from "../../repositories/Account/user.repository.js";
import type { CreateUserRequest } from "../../dtos/Request/Account/CreateUserRequest.js";
import type { CreateUserResponse } from "../../dtos/Response/Account/CreateUserResponse.js";
import type { IUserService } from "../../interfaces/Service/Account/IUserService.js";
import { mailService } from "../../services/Mail/mail.service.js";

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

        // 4. Hashing password if provided
        if (data.Password) {
            const salt = await bcrypt.genSalt(10);
            newUser.PasswordHash = await bcrypt.hash(data.Password, salt);
        }




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
                    Password: data.Password || "********", // Show masked if not available
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
}

export const userService = new UserService();
