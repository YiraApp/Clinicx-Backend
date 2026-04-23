import { userService } from "../Account/user.service.js";
import { healthcareProviderRepository } from "../../repositories/Organizations/healthcare-provider.repository.js";
import { AppDataSource } from "../../config/database.js";
import { HealthcareProvider } from "../../models/Organizations/healthcare-provider.model.js";
import { HealthcareProviderAvailability } from "../../models/Organizations/healthcare-provider-availability.model.js";
import { roleRepository } from "../../repositories/Account/role.repository.js";

export class HealthcareProviderService {
    async onboardProvider(data: any): Promise<any> {
        return await AppDataSource.transaction(async (manager) => {
            // 1. Resolve Primary Account (Prioritize provided ID from frontend)
            const providedUserId = data.userId;
            let targetUserId = providedUserId;

            if (!targetUserId) {
                const existingAccount = await userService.getPrimaryAccount(data.phone);
                targetUserId = existingAccount.exists ? existingAccount.user.id : undefined;
            }

            // 2. Resolve Provider Role ID
            const providerRole = await roleRepository.findByNormalizedName("PROVIDER");
            if (!providerRole) throw new Error("CRITICAL: 'PROVIDER' role not found in database.");

            // 3. Sync User Profile and Assign Roles
            const userResult = await userService.updateUser({
                Id: targetUserId, // Pass ID if found, otherwise updateUser will create new
                FirstName: data.firstName,
                LastName: data.lastName,
                Email: data.email,
                PhoneNumber: data.phone,
                Password: data.password,
                CountryCode : data.countryCode,
                workspaces: [{
                    roleId: data.roleId || providerRole.Id,
                    organizationId: data.organizationId,
                    hospitalId: data.hospitalId
                }]
            });

            // 4. Extract Final User ID directly from update result
            const userId = userResult.userId;
            if (!userId) throw new Error("Failed to resolve user identity during onboarding.");

            // 3. Prevent duplicate provider in SAME hospital
            const duplicate = await healthcareProviderRepository.findByUserIdAndHospital(userId, Number(data.hospitalId));
            if (duplicate) throw new Error("DUPLICATE_PROVIDER_HOSPITAL");

            const profileData: Partial<HealthcareProvider> = {
                UserId: userId,
                HospitalId: Number(data.hospitalId),
                Specialty: data.specialty,
                SubSpecialty: data.subSpecialty,
                Department: data.department,
                RegistrationNumber: data.registrationNumber,
                Qualification: data.qualification,
                Experience: data.experience,
                ConsultationFee: data.consultationFee,
                Bio: data.bio
            };

            let provider: HealthcareProvider;
            // const existing = await healthcareProviderRepository.findByUserId(userId);
            // if (existing) {
            //     Object.assign(existing, profileData);
            //     provider = await manager.save(HealthcareProvider, existing);
                
            //     // Clear old availability slots
            //     await manager.delete(HealthcareProviderAvailability, { ProviderId: provider.Id });
            // } else {
                const newProvider = manager.create(HealthcareProvider, profileData);
                provider = await manager.save(HealthcareProvider, newProvider);
            // }

            // 4. Save New Availability Slots
            if (data.timeSlots) {
                const availabilityRecords: HealthcareProviderAvailability[] = [];
                for (const day in data.timeSlots) {
                    const slots = data.timeSlots[day];
                    if (Array.isArray(slots)) {
                        slots.forEach((slot: any) => {
                            const availability = manager.create(HealthcareProviderAvailability, {
                                ProviderId: provider.Id,
                                DayOfWeek: day,
                                StartTime: slot.start,
                                EndTime: slot.end
                            });
                            availabilityRecords.push(availability);
                        });
                    }
                }
                if (availabilityRecords.length > 0) {
                    await manager.save(HealthcareProviderAvailability, availabilityRecords);
                }
            }

            return { 
                message: "Healthcare provider onboarded successfully.", 
                userId: userId,
                providerId: provider.Id
            };
        });
    }
}

export const healthcareProviderService = new HealthcareProviderService();
