import { Organization } from "../../models/Organizations/organization.model.js";
import { organizationRepository } from "../../repositories/Organizations/organization.repository.js";
import { userRepository } from "../../repositories/Account/user.repository.js";
import { userService } from "../../services/Account/user.service.js";
import { AppDataSource } from "../../config/database.js";
import { UserRole } from "../../models/Account/userrole.model.js";
import type { IOrganizationService } from "../../interfaces/Service/Organizations/IOrganizationService.js";
import type { CreateOrganizationRequest } from "../../dtos/Request/Organizations/CreateOrganizationRequest.js";
import type { CreateOrganizationResponse } from "../../dtos/Response/Organizations/CreateOrganizationResponse.js";
import type { CreateUserRequest } from "../../dtos/Request/Account/CreateUserRequest.js";
import type { UpdateOrganizationRequest } from "../../dtos/Request/Organizations/UpdateOrganizationRequest.js";
import { dashboardService } from "../Common/dashboard.service.js";
import type { DashboardSummary } from "../../interfaces/Service/Common/IDashboardService.js";

import { IsNull } from "typeorm";

/**
 * Service for Organization-related business logic.
 */
export class OrganizationService implements IOrganizationService {
    async createOrganization(data: CreateOrganizationRequest, roleId: string): Promise<CreateOrganizationResponse> {


        // 2. Validation: Check for existing organization by OrgCode (if provided)
        if (data.OrgCode) {
            const existingByCode = await organizationRepository.findByCode(data.OrgCode);
            if (existingByCode) {
                throw new Error(`An organization with code ${data.OrgCode} already exists.`);
            }
        }

        // 1. Validation: Check for existing organization by Mobile Number
        const existingByMobile = await organizationRepository.findByMobile(data.MobileNumber);
        if (existingByMobile) {
            throw new Error(`An organization with mobile number ${data.MobileNumber} already exists.`);
        }

        // 3. Validation: Check for existing organization by Email (if provided)
        if (data.Email) {
            const existingByEmail = await organizationRepository.findByEmail(data.Email);
            if (existingByEmail) {
                throw new Error(`An organization with email ${data.Email} already exists.`);
            }
        }

        return await AppDataSource.transaction(async (transactionalEntityManager) => {
            // 1. Create Organization
            const orgPrepare: Partial<Organization> = {
                Name: data.Name,
                MobileNumber: data.MobileNumber,
                Status: true
            };
            if (data.OrgCode) orgPrepare.OrgCode = data.OrgCode;
            if (data.OrganizationType) orgPrepare.OrganizationType = data.OrganizationType;
            if (data.Email) orgPrepare.Email = data.Email;
            if (data.Address) orgPrepare.Address = data.Address;
            if (data.Website) orgPrepare.Website = data.Website;

            const org = await organizationRepository.createOrganization(orgPrepare);

            // 2. Check if user exists by mobile number
            let user = await userRepository.findPrimaryByPhone(data.MobileNumber);

            if (!user) {
                // 3. Create new user if doesn't exist
                const userCreateData: CreateUserRequest = {
                    FirstName: data.Name,
                    PhoneNumber: data.MobileNumber,
                    Password: this.generateStrongPassword(8),
                };
                if (data.Email) userCreateData.Email = data.Email;

                // Add details for Welcome Email
                userCreateData.OrganizationName = data.Name;
                userCreateData.RoleName = "Administrator";
                userCreateData.RoleMessage = `Welcome! You have been registered as an Administrator for:<br/><strong>${data.Name}</strong>${data.OrgCode ? `<br/>(Code: ${data.OrgCode})` : ""}`;
                userCreateData.LoginURL = process.env.CLIENT_URL || "https://clinicx.azurewebsites.net/";

                const userResponse = await userService.createUser(userCreateData, true);

                user = await userRepository.findById(userResponse.Id);
            } else {
                // 4. If user exists, check if they are already linked to THIS organization/role/hospital
                const existingRole = await transactionalEntityManager.findOne(UserRole, {
                    where: {
                        UserId: user.Id,
                        OrganizationId: org.Id,
                        RoleId: roleId,
                        HospitalId: data.HospitalId ?? IsNull()
                    }
                });

                if (existingRole) {
                    throw new Error("This member is already assigned to this role in this organization.");
                }
            }

            if (!user) {
                throw new Error("Failed to resolve user for organization linkage.");
            }

            // 5. Assign Role to User and Organization
            const userRole = new UserRole();
            userRole.UserId = user.Id;
            userRole.RoleId = roleId;
            userRole.OrganizationId = org.Id;
            if (data.HospitalId) userRole.HospitalId = data.HospitalId;
            userRole.Status = true;
            userRole.IsDeleted = false;

            await transactionalEntityManager.save(userRole);

            return {
                organization: org,
                user: {
                    Id: user.Id,
                    FirstName: user.FirstName!,
                    PhoneNumber: user.PhoneNumber
                }
            };
        });
    }

    async updateOrganization(data: UpdateOrganizationRequest): Promise<any> {
        const org = await organizationRepository.findById(data.Id);
        if (!org) {
            throw new Error("Organization not found.");
        }

        const oldMobile = org.MobileNumber;

        // Validation for unique fields if they are changing
        if (data.OrgCode && data.OrgCode !== org.OrgCode) {
            const existingByCode = await organizationRepository.findByCode(data.OrgCode);
            if (existingByCode) throw new Error(`An organization with code ${data.OrgCode} already exists.`);
        }
        if (data.Email && data.Email !== org.Email) {
            const existingByEmail = await organizationRepository.findByEmail(data.Email);
            if (existingByEmail) throw new Error(`An organization with email ${data.Email} already exists.`);
        }
        if (data.MobileNumber && data.MobileNumber !== org.MobileNumber) {
            const existingByMobile = await organizationRepository.findByMobile(data.MobileNumber);
            if (existingByMobile) throw new Error(`An organization with mobile number ${data.MobileNumber} already exists.`);
        }

        return await AppDataSource.transaction(async (transactionalEntityManager) => {
            // 1. Update Organization properties
            if (data.Name) org.Name = data.Name;
            if (data.OrgCode) org.OrgCode = data.OrgCode;
            if (data.OrganizationType) org.OrganizationType = data.OrganizationType;
            if (data.Email) org.Email = data.Email;
            if (data.MobileNumber) org.MobileNumber = data.MobileNumber;
            if (data.Address) org.Address = data.Address;
            if (data.Website) org.Website = data.Website;
            if (data.Status !== undefined) org.Status = data.Status;

            await transactionalEntityManager.save(Organization, org);

            // 2. Handle User Change if MobileNumber changed
            if (data.MobileNumber && data.MobileNumber !== oldMobile) {
                if (!data.roleId) {
                    throw new Error("RoleId is required when changing organization contact number.");
                }

                // A. Revoke previous user's role for this organization (effectively removing the admin)
                await transactionalEntityManager.update(UserRole,
                    { OrganizationId: org.Id, RoleId: data.roleId, IsDeleted: false },
                    { IsDeleted: true, Status: false, UpdatedAt: new Date() }
                );

                // B. Find or create new user for the new mobile number
                let newUser = await userRepository.findPrimaryByPhone(data.MobileNumber);
                if (!newUser) {
                    const userCreateData: CreateUserRequest = {
                        FirstName: data.Name || org.Name,
                        PhoneNumber: data.MobileNumber,
                        Password: this.generateStrongPassword(8),
                    };
                    const emailToUse = data.Email || org.Email;
                    if (emailToUse) userCreateData.Email = emailToUse;

                    const userResponse = await userService.createUser(userCreateData, true);
                    newUser = await userRepository.findById(userResponse.Id);
                }

                if (!newUser) throw new Error("Failed to resolve new user for organization linkage.");

                // C. Assign admin role to the new user for this organization
                const newUserRole = new UserRole();
                newUserRole.UserId = newUser.Id;
                newUserRole.RoleId = data.roleId;
                newUserRole.OrganizationId = org.Id;
                if (data.HospitalId) newUserRole.HospitalId = data.HospitalId;
                newUserRole.Status = true;
                newUserRole.IsDeleted = false;

                await transactionalEntityManager.save(UserRole, newUserRole);
            }

            return {
                message: "Organization updated successfully.",
                organization: org
            };
        });
    }

    private generateStrongPassword(length: number = 8): string {
        const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()";
        let password = "";
        for (let i = 0; i < length; i++) {
            const randomIndex = Math.floor(Math.random() * charset.length);
            password += charset[randomIndex];
        }
        return password;
    }

    async getAllOrganizations(page?: number, pageSize?: number, orgId?: number, type?: string, search?: string): Promise<DashboardSummary> {
        return await dashboardService.getDashboardSummary(page, pageSize, orgId, type, search);
    }
}

export const organizationService = new OrganizationService();
