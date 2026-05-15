import { AppDataSource } from "../../config/database.js";
import { Hospital } from "../../models/Organizations/hospital.model.js";
import { UserRole } from "../../models/Account/userrole.model.js";
import { Organization } from "../../models/Organizations/organization.model.js";
import { hospitalRepository } from "../../repositories/Organizations/hospital.repository.js";
import { userRepository } from "../../repositories/Account/user.repository.js";
import { userService } from "../../services/Account/user.service.js";
import type { IHospitalService } from "../../interfaces/Service/Organizations/IHospitalService.js";
import type { CreateHospitalRequest, CreateHospitalResponse, UpdateHospitalRequest } from "../../dtos/Request/Organizations/CreateHospitalRequest.js";
import type { CreateUserRequest } from "../../dtos/Request/Account/CreateUserRequest.js";
import { User } from "../../models/Account/user.model.js";

/**
 * Service to handle Hospital management logic.
 */
export class HospitalService implements IHospitalService {
    async createHospital(data: CreateHospitalRequest): Promise<CreateHospitalResponse> {
        const org = await AppDataSource.getRepository(Organization).findOne({ where: { Id: data.OrganizationId } });
        if (!org) throw new Error("Organization not found.");

        const existingHospital = await hospitalRepository.findByCode(data.HospitalCode);
        if (existingHospital) throw new Error("Hospital code already exists.");

        return await AppDataSource.transaction(async (transactionalEntityManager) => {
            const hospital = new Hospital();
            Object.assign(hospital, data);
            hospital.Status = true;
            hospital.IsDeleted = false;
            await transactionalEntityManager.save(hospital);

            let user = await userRepository.findPrimaryByPhone(data.MobileNumber);
            if (!user) {
                const userCreateData: CreateUserRequest = {
                    FirstName: `${data.Name} Admin`,
                    PhoneNumber: data.MobileNumber,
                    CountryCode: data.CountryCode,
                    Password: data.MobileNumber,
                };

                if (data.Email) userCreateData.Email = data.Email;
                
                // Details for Welcome Email
                userCreateData.OrganizationName = org.Name;
                userCreateData.RoleName = "Hospital Administrator";
                userCreateData.RoleMessage = `Welcome! You have been registered as an Administrator for:<br/><strong>${data.Name}</strong><br/>(Code: ${data.HospitalCode})`;
                
                const userResponse = await userService.createUser(userCreateData, true);
                user = await userRepository.findById(userResponse.Id);
            }

            if (!user) throw new Error("Failed to create or find admin user.");

            const userRole = new UserRole();
            userRole.UserId = user.Id;
            userRole.RoleId = data.roleId;
            userRole.OrganizationId = data.OrganizationId;
            userRole.HospitalId = hospital.Id;
            userRole.Status = true;
            userRole.IsDeleted = false;
            await transactionalEntityManager.save(userRole);

            return {
                hospital,
                user: {
                    Id: user.Id,
                    FirstName: user.FirstName,
                    PhoneNumber: user.PhoneNumber
                }
            };
        });
    }

    async updateHospital(data: UpdateHospitalRequest): Promise<any> {
        const hospital = await hospitalRepository.findById(data.Id);
        if (!hospital) throw new Error("Hospital not found.");

        const oldMobile = hospital.MobileNumber;

        // Validation
        if (data.HospitalCode && data.HospitalCode !== hospital.HospitalCode) {
            const existing = await hospitalRepository.findByCode(data.HospitalCode);
            if (existing) throw new Error("Hospital code already exists.");
        }

        // Allowed to share mobile numbers across hospitals


        return await AppDataSource.transaction(async (transactionalEntityManager) => {
            // 1. Update Hospital fields
            Object.assign(hospital, data);
            await transactionalEntityManager.save(Hospital, hospital);

            // 2. Handle User Change if MobileNumber changed
            if (data.MobileNumber && data.MobileNumber !== oldMobile) {
                if (!data.roleId) throw new Error("RoleId is required when changing hospital admin number.");

                // Check if the user for the new mobile number is already the current admin
                let newUser = await userRepository.findPrimaryByPhone(data.MobileNumber);
                
                // Find current active role
                const currentRole = await transactionalEntityManager.findOne(UserRole, {
                    where: { HospitalId: hospital.Id, RoleId: data.roleId, IsDeleted: false }
                });

                if (currentRole && newUser && currentRole.UserId === newUser.Id) {
                    // Same user, just different phone string format. Skip swap.
                    return { message: "Hospital updated successfully.", hospital };
                }

                // A. Revoke previous user's role for this hospital
                if (currentRole) {
                    currentRole.IsDeleted = true;
                    currentRole.Status = false;
                    currentRole.UpdatedAt = new Date();
                    await transactionalEntityManager.save(UserRole, currentRole);
                }

                // B. Find or create new user
                if (!newUser) {
                    const userCreateData: CreateUserRequest = {
                        FirstName: `${data.Name || hospital.Name} Admin`,
                        PhoneNumber: data.MobileNumber,
                        CountryCode: data.CountryCode || hospital.CountryCode,
                        Password: data.MobileNumber,
                    };

                    if (data.Email || hospital.Email) {
                        userCreateData.Email = (data.Email || hospital.Email) as string;
                    }

                    const userResponse = await userService.createUser(userCreateData, true);
                    newUser = await userRepository.findById(userResponse.Id);
                }

                if (!newUser) throw new Error("Failed to resolve new user for hospital linkage.");

                // C. Assign role to new user (Check if a record already exists to avoid UQ constraint)
                let newUserRole = await transactionalEntityManager.findOne(UserRole, {
                    where: { 
                        UserId: newUser.Id, 
                        RoleId: data.roleId, 
                        OrganizationId: data.OrganizationId || hospital.OrganizationId,
                        HospitalId: hospital.Id 
                    }
                });

                if (newUserRole) {
                    newUserRole.IsDeleted = false;
                    newUserRole.Status = true;
                    newUserRole.UpdatedAt = new Date();
                } else {
                    newUserRole = new UserRole();
                    newUserRole.UserId = newUser.Id;
                    newUserRole.RoleId = data.roleId;
                    newUserRole.OrganizationId = data.OrganizationId || hospital.OrganizationId;
                    newUserRole.HospitalId = hospital.Id;
                    newUserRole.Status = true;
                    newUserRole.IsDeleted = false;
                }

                await transactionalEntityManager.save(UserRole, newUserRole);
            }


            return { message: "Hospital updated successfully.", hospital };
        });
    }

    async deleteHospital(id: number): Promise<void> {
        const hospital = await hospitalRepository.findById(id);
        if (!hospital) throw new Error("Hospital not found.");

        await hospitalRepository.softDelete(id);
    }

    async getHospitalById(id: number): Promise<any> {
        const hospital = await hospitalRepository.findById(id);
        if (!hospital) throw new Error("Hospital not found.");
        return hospital;
    }

    async getAllHospitals(orgId?: number, page: number = 1, pageSize: number = 10, grouped: boolean = false, search?: string, hospitalId?: number): Promise<any> {
        const { data: hospitals, total, stats } = await hospitalRepository.getAllHospitals(orgId, page, pageSize, search, hospitalId);

        if (!grouped) {
            return {
                stats,
                hospitals,
                total,
                page,
                pageSize,
                totalPages: Math.ceil(total / pageSize)
            };
        }

        // Grouping logic for OrgHospitalsResponse
        const groupedData = hospitals.reduce((acc: any[], current: any) => {
            const org = current.Organization;
            if (!org) return acc;

            let orgGroup = acc.find(o => o.OrganizationId === org.Id);
            if (!orgGroup) {
                orgGroup = {
                    OrganizationId: org.Id,
                    OrganizationName: org.Name,
                    OrgCode: org.OrgCode,
                    Hospitals: []
                };
                acc.push(orgGroup);
            }

            // Map only the specific hospital fields requested
            orgGroup.Hospitals.push({
                Id: current.Id,
                Name: current.Name,
                HospitalCode: current.HospitalCode || null,
                City: current.City || null,
                State: current.State || null,
                Is24Hours: !!current.Is24Hours,
                MedicalStaff: current.MedicalStaff || 0
            });

            return acc;
        }, []);

        return {
            stats,
            groupedData,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize)
        };
    }

    async toggleStatus(id: number, status: boolean): Promise<void> {
        const hospital = await hospitalRepository.findById(id);
        if (!hospital) throw new Error("Hospital not found.");
        await hospitalRepository.updateStatus(id, status);
    }
}

export const hospitalService = new HospitalService();
