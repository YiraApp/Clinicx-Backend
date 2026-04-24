import { AppDataSource } from "../../config/database.js";
import { PatientInsurance } from "../../models/Organizations/patient-insurance.model.js";

export class PatientInsuranceRepository {
    private repo = AppDataSource.getRepository(PatientInsurance);

    async findByUserId(userId: string, organizationId: number, hospitalId?: number): Promise<PatientInsurance | null> {
        const where: any = { UserId: userId, OrganizationId: organizationId, IsDeleted: false };
        if (hospitalId) where.HospitalId = hospitalId;
        return await this.repo.findOne({ where });
    }

    async save(insurance: PatientInsurance): Promise<PatientInsurance> {
        return await this.repo.save(insurance);
    }
}

export const patientInsuranceRepository = new PatientInsuranceRepository();
