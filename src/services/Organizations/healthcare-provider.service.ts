import { userService } from "../Account/user.service.js";
import { healthcareProviderRepository } from "../../repositories/Organizations/healthcare-provider.repository.js";
import { AppDataSource } from "../../config/database.js";
import { HealthcareProvider } from "../../models/Organizations/healthcare-provider.model.js";
import { HealthcareProviderAvailability } from "../../models/Organizations/healthcare-provider-availability.model.js";
import { roleRepository } from "../../repositories/Account/role.repository.js";
import { userRoleRepository } from "../../repositories/Account/userrole.repository.js";
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
            const workspaces: any[] = [{
                roleId: data.roleId || providerRole.Id,
                organizationId: data.organizationId,
                hospitalId: data.hospitalId
            }];

            // Preserve existing active roles to prevent deactivation
            if (targetUserId) {
                const existingRoles = await userRoleRepository.findByUserId(targetUserId);
                for (const role of existingRoles) {
                    workspaces.push({
                        userRoleId: role.UserRoleId,
                        roleId: role.RoleId,
                        organizationId: role.OrganizationId,
                        hospitalId: role.HospitalId
                    });
                }
            }

            const userResult = await userService.updateUser({
                Id: targetUserId, // Pass ID if found, otherwise updateUser will create new
                FirstName: data.firstName,
                LastName: data.lastName,
                Email: data.email,
                PhoneNumber: data.phone,
                Password: data.password,
                CountryCode : data.countryCode,
                Gender: data.gender,
                DateOfBirth: data.dateOfBirth && data.dateOfBirth !== "" ? data.dateOfBirth : null,
                workspaces,
                revokeTokens: false
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
                ConsultationFee: data.consultationFee !== undefined && data.consultationFee !== null && data.consultationFee !== "" ? Number(data.consultationFee) : 0,
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
                    ConsultationFee: provider.ConsultationFee,
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
                consultationFee: provider.ConsultationFee,
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

    async getDoctorById(id: number, userId?: string): Promise<any> {
        // 1. Fetch the requested provider to get UserId and org context
        const doctor = await healthcareProviderRepository.getDoctorById(id, userId);
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
            // Preserve existing active roles to prevent deactivation
            const existingRoles = await userRoleRepository.findByUserId(provider.UserId);
            const workspaces = existingRoles.map(role => ({
                userRoleId: role.UserRoleId,
                roleId: role.RoleId,
                organizationId: role.OrganizationId,
                hospitalId: role.HospitalId
            }));

            const userUpdateData: any = {
                Id: provider.UserId,
                FirstName: data.firstName,
                LastName: data.lastName,
                Email: data.email,
                PhoneNumber: data.phoneNumber,
                Gender: data.gender,
                DateOfBirth: data.dateOfBirth && data.dateOfBirth !== "" ? data.dateOfBirth : null,
                PermanentAddress: data.permanentAddress,
                workspaces
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

            await userService.updateUser({ ...userUpdateData, revokeTokens: false });

            // 2. Update Provider Profile (Professional Details)
            const providerUpdateData: Partial<HealthcareProvider> = {
                HospitalId: data.hospitalId ? Number(data.hospitalId) : provider.HospitalId,
                Specialty: data.specialty,
                SubSpecialty: data.subSpecialty,
                Department: data.department,
                RegistrationNumber: data.registrationNumber,
                Qualification: data.qualification,
                Experience: data.experience,
                ConsultationFee: data.consultationFee !== undefined && data.consultationFee !== null && data.consultationFee !== "" ? Number(data.consultationFee) : 0,
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

    async getDoctorSlots(providerId: number, hospitalId: number, startDate: string, endDate: string, userId?: string): Promise<any> {
        if (userId) {
            const provider = await healthcareProviderRepository.getDoctorById(providerId, userId);
            if (!provider) throw new Error("Doctor not found or access denied.");
        }
        const [sy, sm, sd] = startDate.split("-").map(Number);
        const [ey, em, ed] = endDate.split("-").map(Number);
        const start = new Date(sy, sm - 1, sd);
        const end = new Date(ey, em - 1, ed);
        const slots = await healthcareProviderScheduleSlotRepository.getSlots(providerId, hospitalId, start, end);
        return slots;
    }

    async generateSlotsForDateRange(providerId: number, hospitalId: number, startDate: string, endDate: string, slotDuration: number = 15, buffer: number = 0, overwrite: boolean = false): Promise<any> {
        const provider = await healthcareProviderRepository.getDoctorById(providerId);
        if (!provider) throw new Error("Doctor not found.");

        // Parse as local midnight to avoid UTC timezone shifting dates by 1 day
        const [sy, sm, sd] = startDate.split("-").map(Number);
        const [ey, em, ed] = endDate.split("-").map(Number);
        let start = new Date(sy, sm - 1, sd);
        const end = new Date(ey, em - 1, ed);

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (start < today) {
            start = today; // Silently skip past dates
        }
        if (end < start) {
            throw new Error("Date range cannot be entirely in the past.");
        }

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

        return await AppDataSource.transaction(async (manager) => {
            // Check for existing slots in the range
            const existingSlots = await manager.createQueryBuilder(HealthcareProviderScheduleSlot, "slot")
                .where("slot.ProviderId = :providerId", { providerId })
                .andWhere("slot.HospitalId = :hospitalId", { hospitalId })
                .andWhere("slot.SlotDate >= :start AND slot.SlotDate <= :end", { 
                    start: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`,
                    end: `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`
                })
                .andWhere("slot.IsDeleted = 0")
                .getMany();

            if (existingSlots.length > 0 && !overwrite) {
                throw new Error("SLOTS_ALREADY_EXIST");
            }

            // 2. Delete only UNBOOKED slots for this range — booked slots are preserved
            const deleteResult = await manager.createQueryBuilder()
                .update(HealthcareProviderScheduleSlot)
                .set({ IsDeleted: true, UpdatedAt: new Date() })
                .where("ProviderId = :providerId", { providerId })
                .andWhere("HospitalId = :hospitalId", { hospitalId })
                .andWhere("SlotDate >= :start AND SlotDate <= :end", { 
                    start: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`,
                    end: `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`
                })
                .andWhere("IsBooked = 0")
                .andWhere("IsDeleted = 0")
                .execute();

            const deletedCount = deleteResult.affected || 0;
            console.log(`[Slots] Soft-deleted ${deletedCount} unbooked slots for range ${startDate} to ${endDate}`);

            // Fetch preserved booked slots to prevent overlaps
            const bookedSlots = existingSlots.filter(s => s.IsBooked);

            // 3. Generate new slots
            const newSlots: HealthcareProviderScheduleSlot[] = [];
            let currentDate = new Date(start);
            const isSingleDay = startDate === endDate;

            while (currentDate <= end) {
                const dayName = DAYS[currentDate.getDay()];
                const dayTemplates = weeklyAvailability.filter(a => a.DayOfWeek === dayName && !a.IsDeleted);
                if (dayTemplates.length === 0) {
                    if (isSingleDay) {
                        throw new Error("DOCTOR_NOT_AVAILABLE_ON_DAY");
                    }
                    currentDate.setDate(currentDate.getDate() + 1);
                    continue
                }
                const effectiveTemplates = dayTemplates;
                // Use local date parts to avoid timezone shifting YYYY-MM-DD
                const y = currentDate.getFullYear();
                const m = String(currentDate.getMonth() + 1).padStart(2, "0");
                const d = String(currentDate.getDate()).padStart(2, "0");
                const dateStr = `${y}-${m}-${d}`;

                // Filter booked slots for this specific date
                const todaysBookedSlots = bookedSlots.filter(s => {
                    const sd = new Date(s.SlotDate);
                    return sd.getFullYear() === y && 
                           String(sd.getMonth() + 1).padStart(2, "0") === m && 
                           String(sd.getDate()).padStart(2, "0") === d;
                });

                effectiveTemplates.forEach(template => {
                    // Use effectiveTemplates instead of dayTemplates
                    const tmpl = effectiveTemplates.find(t => t.StartTime === template.StartTime && t.EndTime === template.EndTime) || template;
                    let currentSlotMinutes = timeToMinutes(template.StartTime);
                    const endMinutes = timeToMinutes(template.EndTime);

                    // Loop and create slices
                    while (currentSlotMinutes + slotDuration <= endMinutes) {
                        const startTime = minutesToTime(currentSlotMinutes);
                        const endTime = minutesToTime(currentSlotMinutes + slotDuration);

                        // Overlap check (same as existing)
                        const isOverlapping = todaysBookedSlots.some(b => {
                            const bStart = timeToMinutes(b.StartTime);
                            const bEnd = timeToMinutes(b.EndTime);
                            return (currentSlotMinutes >= bStart && currentSlotMinutes < bEnd) ||
                                   (currentSlotMinutes + slotDuration > bStart && currentSlotMinutes + slotDuration <= bEnd) ||
                                   (currentSlotMinutes <= bStart && currentSlotMinutes + slotDuration >= bEnd);
                        });

                        if (!isOverlapping) {
                            const slot = new HealthcareProviderScheduleSlot();
                            slot.ProviderId = providerId;
                            slot.HospitalId = hospitalId;
                            slot.OrganizationId = provider.Hospital.OrganizationId;
                            slot.SlotDate = dateStr as any;
                            slot.StartTime = startTime;
                            slot.EndTime = endTime;
                            slot.IsAvailable = template.Status !== undefined ? template.Status : true;
                            slot.IsBooked = false;
                            slot.Status = template.Status !== false ? "Available" : "Blocked";
                            newSlots.push(slot);
                        }

                        currentSlotMinutes += slotDuration + buffer;
                    }
                });

                currentDate.setDate(currentDate.getDate() + 1);
            }

            if (newSlots.length > 0) {
                await manager.save(HealthcareProviderScheduleSlot, newSlots);
            }

            return {
                message: `Successfully generated ${newSlots.length} slots (${slotDuration} mins each) from ${startDate} to ${endDate}. Replaced ${deletedCount} previous unbooked slots.`,
                count: newSlots.length,
                replaced: deletedCount
            };
        });
    }

    async generateManualSlots(providerId: number, hospitalId: number, date: string, slots: any[], overwrite: boolean = false): Promise<any> {
        const provider = await healthcareProviderRepository.getDoctorById(providerId);
        if (!provider) throw new Error("Doctor not found.");

        // Normalize date to avoid timezone shifts (take only YYYY-MM-DD)
        const dateStr = date.split('T')[0];
        console.log(`[Service] Generating manual slots for Date: ${dateStr}, Slots: ${slots.length}`);

        // 1. Prevent editing past dates
        const targetDate = new Date(dateStr);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (targetDate < today) {
            throw new Error("Cannot edit slots for previous days.");
        }

        // 2. Check if doctor has weekly availability for this day of the week
        const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
        const dayName = DAYS[targetDate.getDay()];
        const weeklyAvailability = provider.Availability || [];
        const hasAvailability = weeklyAvailability.some((a: any) => a.DayOfWeek === dayName && !a.IsDeleted);
        if (!hasAvailability) {
            throw new Error("DOCTOR_NOT_AVAILABLE_ON_DAY");
        }

        return await AppDataSource.transaction(async (manager) => {
            // Check for existing slots
            const existingSlots = await manager.getRepository(HealthcareProviderScheduleSlot).find({
                where: {
                    ProviderId: providerId,
                    HospitalId: hospitalId,
                    SlotDate: dateStr as any,
                    IsDeleted: false
                }
            });

            let bookedSlots: HealthcareProviderScheduleSlot[] = [];
            let deletedCount = 0;

            if (existingSlots.length > 0) {
                const hasBooking = existingSlots.some(s => s.IsBooked);
                if (hasBooking) {
                    // If there is a booking, only allow overwriting when the flag is true.
                    if (!overwrite) {
                        throw new Error("Cannot edit slots for this day because a booking already exists.");
                    }
                    // Booked slots are preserved; we only soft‑delete unbooked ones below.
                }

                // 1. Soft-delete existing UNBOOKED slots for this specific date
                const deleteResult = await manager.getRepository(HealthcareProviderScheduleSlot).update(
                    { 
                        ProviderId: providerId, 
                        HospitalId: hospitalId, 
                        SlotDate: dateStr as any,
                        IsBooked: false,
                        IsDeleted: false
                    },
                    { IsDeleted: true, UpdatedAt: new Date() }
                );
                
                deletedCount = deleteResult.affected || 0;
                console.log(`[Service] Soft-deleted ${deletedCount} existing slots for ${dateStr}`);

                bookedSlots = existingSlots.filter(s => s.IsBooked);
            }

            // Prepare a set of booked slot time ranges to avoid duplicates (allow re‑creating unbooked slots)
            const existingTimes = new Set<string>(bookedSlots.map(s => `${s.StartTime}-${s.EndTime}`));

            // 2. Create new manual slots, skipping any that would duplicate an existing time range
            const newSlots: HealthcareProviderScheduleSlot[] = [];
            const newTimes = new Set<string>(); // track times added in this request

            for (const s of slots) {
                if (!s.startTime || !s.endTime) {
                    console.warn("[Service] Skipping invalid slot:", s);
                    continue;
                }
                
                // Duplicate check against existing slots (including booked)
                const timeKey = `${s.startTime}-${s.endTime}`;
                if (existingTimes.has(timeKey)) {
                    console.warn(`[Service] Skipping duplicate slot ${timeKey} (exists in DB)`);
                    continue;
                }
                // Duplicate check within the incoming list
                if (newTimes.has(timeKey)) {
                    console.warn(`[Service] Skipping duplicate slot ${timeKey} (duplicate in request)`);
                    continue;
                }
                // Overlap check with existing booked slots
                const timeToMins = (t: string) => {
                    const [h, m] = t.split(':').map(Number);
                    return h * 60 + m;
                };
                const newStart = timeToMins(s.startTime);
                const newEnd = timeToMins(s.endTime);
                let overlaps = false;
                for (const b of bookedSlots) {
                    const bStart = timeToMins(b.StartTime);
                    const bEnd = timeToMins(b.EndTime);
                    if ((newStart < bEnd && newEnd > bStart) || (newStart === bStart && newEnd === bEnd)) {
                        overlaps = true;
                        break;
                    }
                }
                if (overlaps) {
                    console.warn(`[Service] Skipping overlapping slot ${timeKey} with booked slot`);
                    continue;
                }
                newTimes.add(timeKey);

                const slot = manager.create(HealthcareProviderScheduleSlot, {
                    ProviderId: providerId,
                    HospitalId: hospitalId,
                    OrganizationId: provider.Hospital.OrganizationId,
                    SlotDate: dateStr as any,
                    StartTime: s.startTime,
                    EndTime: s.endTime,
                    IsAvailable: s.isAvailable !== undefined ? s.isAvailable : true,
                    IsBooked: false,
                    Status: s.status || (s.isAvailable === false ? "Blocked" : "Available"),
                    IsDeleted: false
                });
                newSlots.push(slot);
            }

            if (newSlots.length > 0) {
                await manager.save(HealthcareProviderScheduleSlot, newSlots);
                console.log(`[Service] Successfully saved ${newSlots.length} new slots.`);
            }

            return {
                message: `Successfully updated slots for ${dateStr}.`,
                count: newSlots.length,
                deletedCount: deletedCount
            };
        });
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
