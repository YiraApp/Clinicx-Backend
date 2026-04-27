import { AppDataSource } from "../../config/database.js";
import { PatientRegistration } from "../../models/Organizations/patient-registration.model.js";

export class PatientRegistrationRepository {
    private repo = AppDataSource.getRepository(PatientRegistration);

    async findByUserId(userId: string, organizationId?: number): Promise<PatientRegistration | null> {
        const where: any = { UserId: userId, IsDeleted: false };
        if (organizationId) where.OrganizationId = organizationId;
        return await this.repo.findOne({ where });
    }

    async findByUserAndHospital(userId: string, hospitalId: number): Promise<PatientRegistration | null> {
        return await this.repo.findOne({
            where: { UserId: userId, HospitalId: hospitalId, IsDeleted: false }
        });
    }

    async save(registration: PatientRegistration): Promise<PatientRegistration> {
        return await this.repo.save(registration);
    }

    async getPatients(page: number = 1, pageSize: number = 10, filters: any): Promise<any> {
        const skip = (page - 1) * pageSize;

        const query = this.repo.createQueryBuilder("pr")
            .leftJoinAndSelect("pr.User", "u")
            .leftJoinAndSelect("u.PermanentAddress", "pa")
            .leftJoinAndSelect("pr.Organization", "org")
            .leftJoinAndSelect("pr.Hospital", "h")
            .where("pr.IsDeleted = 0 AND u.IsDeleted = 0");

        if (filters.organizationId) {
            query.andWhere("pr.OrganizationId = :orgId", { orgId: filters.organizationId });
        }
        if (filters.hospitalId) {
            query.andWhere("pr.HospitalId = :hospId", { hospId: filters.hospitalId });
        }
        if (filters.search) {
            query.andWhere(
                "(u.FirstName LIKE :search OR u.LastName LIKE :search OR u.PhoneNumber LIKE :search OR u.Email LIKE :search)",
                { search: `%${filters.search}%` }
            );
        }

        query.orderBy("pr.CreatedAt", "DESC");

        const [registrations, total] = await query.skip(skip).take(pageSize).getManyAndCount();

        const data = registrations.map(pr => ({
            id: pr.Id,
            userId: pr.UserId,
            firstName: pr.User?.FirstName,
            lastName: pr.User?.LastName,
            name: `${pr.User?.FirstName || ""} ${pr.User?.LastName || ""}`.trim(),
            email: pr.User?.Email,
            phone: pr.User?.PhoneNumber,
            countryCode: pr.User?.CountryCode || "91",
            gender: pr.User?.Gender,
            dateOfBirth: pr.User?.DateOfBirth,
            bloodGroup: pr.User?.BloodGroup,
            address: pr.User?.PermanentAddress?.AddressLine1,
            city: pr.User?.PermanentAddress?.City,
            state: pr.User?.PermanentAddress?.State,
            pincode: pr.User?.PermanentAddress?.Pincode,
            emergencyContactName: pr.User?.EmergencyContactName,
            emergencyContactPhone: pr.User?.EmergencyContactPhone,
            allergies: pr.Allergies,
            medicalHistory: pr.MedicalHistory,
            organizationName: pr.Organization?.Name,
            hospitalName: pr.Hospital?.Name,
            createdAt: pr.CreatedAt,
        }));

        return {
            data,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
        };
    }
}

export const patientRegistrationRepository = new PatientRegistrationRepository();
