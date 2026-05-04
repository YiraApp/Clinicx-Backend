import { userService } from "../Account/user.service.js";
import { healthcareProviderRepository } from "../../repositories/Organizations/healthcare-provider.repository.js";
import { AppDataSource } from "../../config/database.js";
import { HealthcareProvider } from "../../models/Organizations/healthcare-provider.model.js";
import { HealthcareProviderAvailability } from "../../models/Organizations/healthcare-provider-availability.model.js";
import { roleRepository } from "../../repositories/Account/role.repository.js";
import { healthcareProviderScheduleSlotRepository } from "../../repositories/Organizations/healthcare-provider-schedule-slot.repository.js";
import { HealthcareProviderScheduleSlot } from "../../models/Organizations/healthcare-provider-schedule-slot.model.js";

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
                            // Auto-detect overnight: if EndTime is before StartTime,
                            // it means the shift crosses midnight (e.g., 22:00 → 06:00)
                            const isOvernight = slot.end < slot.start;

                            const availability = manager.create(HealthcareProviderAvailability, {
                                ProviderId: provider.Id,
                                DayOfWeek: day,
                                StartTime: slot.start,
                                EndTime: slot.end,
                                IsOvernight: isOvernight
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

    async getDoctors(page: number, pageSize: number, filters: any): Promise<any> {
        const result = await healthcareProviderRepository.getDoctors(page, pageSize, filters);

        // Group provider rows by UserId so each doctor appears once
        const userMap = new Map<string, any>();

        for (const provider of result.data.data) {
            const userId = provider.UserId;

            if (!userMap.has(userId)) {
                userMap.set(userId, {
                    Id: provider.Id, // Primary provider ID (first encountered)
                    UserId: userId,
                    User: provider.User,
                    // First hospital's specialty shown as primary
                    Specialty: provider.Specialty,
                    Department: provider.Department,
                    Status: provider.Status,
                    hospitals: []
                });
            }

            userMap.get(userId).hospitals.push({
                providerId: provider.Id,
                hospitalId: provider.HospitalId,
                hospitalName: provider.Hospital?.Name || null,
                hospitalCode: provider.Hospital?.HospitalCode || null,
                specialty: provider.Specialty,
                subSpecialty: provider.SubSpecialty,
                department: provider.Department,
                status: provider.Status
            });
        }

        const groupedData = Array.from(userMap.values());

        return {
            summary: result.summary,
            data: {
                data: groupedData,
                total: result.data.total,
                page: result.data.page,
                pageSize: result.data.pageSize,
                totalPages: result.data.totalPages
            }
        };
    }

    async getDoctorById(id: number): Promise<any> {
        // 1. Fetch the requested provider to get UserId and org context
        const doctor = await healthcareProviderRepository.getDoctorById(id);
        if (!doctor) return null;

        // 2. Fetch ALL provider records for this user within the same org
        const organizationId = doctor.Hospital?.OrganizationId;
        const allProviders = await healthcareProviderRepository.getAllProvidersByUserId(
            doctor.UserId, organizationId
        );

        // Helper: transform availability into timeSlots for a single provider
        const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
        const buildTimeSlots = (availability: any[]) => {
            const timeSlots: Record<string, { id: number; StartTime: string; EndTime: string; IsOvernight: boolean }[]> = {};
            DAYS.forEach(day => { timeSlots[day] = []; });

            if (Array.isArray(availability)) {
                availability.forEach((avail: any) => {
                    if (avail.DayOfWeek && timeSlots[avail.DayOfWeek] !== undefined) {
                        timeSlots[avail.DayOfWeek].push({
                            id: avail.Id,
                            StartTime: avail.StartTime,
                            EndTime: avail.EndTime,
                            IsOvernight: avail.IsOvernight || false
                        });
                    }
                });
            }

            const availableDays = DAYS.filter(day => timeSlots[day].length > 0);
            return { timeSlots, availableDays };
        };

        // 3. Build hospitals array — each entry has provider-level details + availability
        const hospitals = allProviders.map((p: any) => {
            const { timeSlots, availableDays } = buildTimeSlots(p.Availability || []);
            return {
                providerId: p.Id,
                hospitalId: p.HospitalId,
                hospitalName: p.Hospital?.Name || null,
                hospitalCode: p.Hospital?.HospitalCode || null,
                specialty: p.Specialty,
                subSpecialty: p.SubSpecialty,
                department: p.Department,
                registrationNumber: p.RegistrationNumber,
                qualification: p.Qualification,
                experience: p.Experience,
                consultationFee: p.ConsultationFee,
                bio: p.Bio,
                status: p.Status,
                timeSlots,
                availableDays,
                organizationId: p.Hospital?.OrganizationId,
                createdAt: p.CreatedAt
            };
        });

        // 4. Return user info once + hospitals array
        const user = doctor.User;
        return {
            userId: doctor.UserId,
            firstName: user?.FirstName,
            lastName: user?.LastName,
            email: user?.Email,
            phone: user?.PhoneNumber,
            countryCode: user?.CountryCode,
            gender: user?.Gender,
            dateOfBirth: user?.DateOfBirth,
            status: user?.Status,
            address: user?.PermanentAddress ? {
                addressLine1: user.PermanentAddress.AddressLine1,
                addressLine2: user.PermanentAddress.AddressLine2,
                city: user.PermanentAddress.City,
                state: user.PermanentAddress.State,
                pincode: user.PermanentAddress.Pincode,
                country: user.PermanentAddress.Country
            } : null,
            hospitals,
            organizationId: doctor.Hospital?.OrganizationId,
            currentProviderId: id,
            Id: id // Added for frontend compatibility
        };
    }

    async updateProvider(id: number, data: any): Promise<any> {
        const provider = await healthcareProviderRepository.getDoctorById(id);
        if (!provider) throw new Error("Doctor not found.");

        return await AppDataSource.transaction(async (manager) => {
            // 1. Update User Profile (Personal Details & Address)
            const userUpdateData: any = {
                Id: provider.UserId,
                FirstName: data.firstName,
                LastName: data.lastName,
                Email: data.email,
                PhoneNumber: data.phoneNumber,
                Gender: data.gender,
                DateOfBirth: data.dateOfBirth && data.dateOfBirth !== "" ? data.dateOfBirth : null,
                PermanentAddress: data.permanentAddress
            };


            // If simple address fields are provided directly
            if (data.addressLine1) {
                userUpdateData.AddressLine1 = data.addressLine1;
                userUpdateData.AddressLine2 = data.addressLine2;
                userUpdateData.City = data.city;
                userUpdateData.State = data.state;
                userUpdateData.Pincode = data.pincode;
                userUpdateData.Country = data.country;
            }

            await userService.updateUser(userUpdateData);

            // 2. Update Provider Profile (Professional Details)
            const providerUpdateData: Partial<HealthcareProvider> = {
                HospitalId: data.hospitalId ? Number(data.hospitalId) : provider.HospitalId,
                Specialty: data.specialty,
                SubSpecialty: data.subSpecialty,
                Department: data.department,
                RegistrationNumber: data.registrationNumber,
                Qualification: data.qualification,
                Experience: data.experience,
                ConsultationFee: data.consultationFee,
                Bio: data.bio,
                Status: data.status !== undefined ? data.status : provider.Status
            };

            await healthcareProviderRepository.updateDoctor(id, providerUpdateData);

            // 3. Update Availability Slots (if provided)
            if (data.timeSlots) {
                // Soft-delete all existing availability for this provider
                await manager
                    .getRepository(HealthcareProviderAvailability)
                    .update(
                        { ProviderId: id, IsDeleted: false },
                        { IsDeleted: true, UpdatedAt: new Date() }
                    );

                // Insert new availability records
                const availabilityRecords: HealthcareProviderAvailability[] = [];
                for (const day in data.timeSlots) {
                    const slots = data.timeSlots[day];
                    if (Array.isArray(slots)) {
                        slots.forEach((slot: any) => {
                            // Auto-detect overnight if not explicitly provided: if EndTime is before StartTime
                            const isOvernight = slot.IsOvernight !== undefined 
                                ? slot.IsOvernight 
                                : (slot.EndTime < slot.StartTime);
                            
                            const availability = manager.create(HealthcareProviderAvailability, {
                                ProviderId: id,
                                DayOfWeek: day,
                                StartTime: slot.StartTime,
                                EndTime: slot.EndTime,
                                IsOvernight: isOvernight
                            });
                            availabilityRecords.push(availability);
                        });
                    }
                }
                if (availabilityRecords.length > 0) {
                    await manager.save(HealthcareProviderAvailability, availabilityRecords);
                }
            }

            return { message: "Doctor profile updated successfully." };
        });
    }

    async getDoctorSlots(providerId: number, hospitalId: number, startDate: string, endDate: string): Promise<any> {
        const start = new Date(startDate);
        const end = new Date(endDate);
        return await healthcareProviderScheduleSlotRepository.getSlots(providerId, hospitalId, start, end);
    }

    async generateSlotsForDateRange(providerId: number, hospitalId: number, startDate: string, endDate: string, slotDuration: number = 15): Promise<any> {
        const provider = await healthcareProviderRepository.getDoctorById(providerId);
        if (!provider) throw new Error("Doctor not found.");

        const start = new Date(startDate);
        const end = new Date(endDate);
        const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

        // Helper to convert "HH:mm" to minutes from midnight
        const timeToMinutes = (time: string) => {
            const [hrs, mins] = time.split(":").map(Number);
            return (hrs * 60) + mins;
        };

        // Helper to convert minutes to "HH:mm"
        const minutesToTime = (totalMinutes: number) => {
            const hrs = Math.floor(totalMinutes / 60);
            const mins = totalMinutes % 60;
            return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`;
        };

        // 1. Fetch Weekly Availability
        const weeklyAvailability = provider.Availability || [];
        if (weeklyAvailability.length === 0) return { message: "No weekly availability defined for this doctor.", count: 0 };

        // 2. Clear existing slots for this range
        await healthcareProviderScheduleSlotRepository.deleteSlotsForDateRange(providerId, hospitalId, start, end);

        // 3. Generate sliced slots
        const newSlots: HealthcareProviderScheduleSlot[] = [];
        let currentDate = new Date(start);

        while (currentDate <= end) {
            const dayName = DAYS[currentDate.getDay()];
            const dayTemplates = weeklyAvailability.filter(a => a.DayOfWeek === dayName && !a.IsDeleted);

            dayTemplates.forEach(template => {
                let currentSlotMinutes = timeToMinutes(template.StartTime);
                const endMinutes = timeToMinutes(template.EndTime);

                // Loop and create slices
                while (currentSlotMinutes + slotDuration <= endMinutes) {
                    const slot = new HealthcareProviderScheduleSlot();
                    slot.ProviderId = providerId;
                    slot.HospitalId = hospitalId;
                    slot.OrganizationId = provider.Hospital.OrganizationId;
                    slot.SlotDate = new Date(currentDate);
                    slot.StartTime = minutesToTime(currentSlotMinutes);
                    slot.EndTime = minutesToTime(currentSlotMinutes + slotDuration);
                    slot.IsAvailable = template.Status;
                    slot.IsBooked = false;
                    slot.Status = template.Status ? "Available" : "Blocked";
                    
                    newSlots.push(slot);
                    currentSlotMinutes += slotDuration;
                }
            });

            currentDate.setDate(currentDate.getDate() + 1);
        }

        if (newSlots.length > 0) {
            await healthcareProviderScheduleSlotRepository.saveSlots(newSlots);
        }

        return {
            message: `Successfully generated ${newSlots.length} slots (${slotDuration} mins each) from ${startDate} to ${endDate}.`,
            count: newSlots.length
        };
    }

    async updateWeeklySchedule(id: number, data: any): Promise<any> {
        return await AppDataSource.transaction(async (manager) => {
            if (data.timeSlots) {
                // Soft-delete all existing availability for this provider
                await manager
                    .getRepository(HealthcareProviderAvailability)
                    .update(
                        { ProviderId: id, IsDeleted: false },
                        { IsDeleted: true, UpdatedAt: new Date() }
                    );

                const availabilityRecords: HealthcareProviderAvailability[] = [];
                for (const day in data.timeSlots) {
                    const slots = data.timeSlots[day];
                    if (Array.isArray(slots)) {
                        slots.forEach((slot: any) => {
                            const isOvernight = slot.IsOvernight !== undefined 
                                ? slot.IsOvernight 
                                : (slot.EndTime < slot.StartTime);
                            
                            const availability = manager.create(HealthcareProviderAvailability, {
                                ProviderId: id,
                                DayOfWeek: day,
                                StartTime: slot.StartTime,
                                EndTime: slot.EndTime,
                                IsOvernight: isOvernight
                            });
                            availabilityRecords.push(availability);
                        });
                    }
                }
                if (availabilityRecords.length > 0) {
                    await manager.save(HealthcareProviderAvailability, availabilityRecords);
                }
            }
            return { message: "Weekly schedule updated successfully." };
        });
    }

    async updateSlotStatus(slotId: number, data: { status?: string, isAvailable?: boolean }): Promise<any> {
        const slot = await healthcareProviderScheduleSlotRepository.updateSlotStatus(slotId, data);
        if (!slot) throw new Error("Slot not found.");
        return slot;
    }
}




export const healthcareProviderService = new HealthcareProviderService();
