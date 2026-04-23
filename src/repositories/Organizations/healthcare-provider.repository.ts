import { AppDataSource } from "../../config/database.js";
import { HealthcareProvider } from "../../models/Organizations/healthcare-provider.model.js";

export class HealthcareProviderRepository {
    private repo = AppDataSource.getRepository(HealthcareProvider);

    async saveProvider(data: Partial<HealthcareProvider>): Promise<HealthcareProvider> {
        const provider = this.repo.create(data);
        return await this.repo.save(provider);
    }

    async findByUserId(userId: string): Promise<HealthcareProvider | null> {
        console.log(`[Repository] Finding provider for UserId: ${userId}`);
        const provider = await this.repo.findOne({ 
            where: { UserId: userId, IsDeleted: false },
            relations: ["User", "Hospital"]
        });
        console.log(`[Repository] Provider find result for ${userId}:`, provider ? `Found (ID: ${provider.Id})` : "Not Found");
        return provider;
    }

    async findByHospital(hospitalId: number): Promise<HealthcareProvider[]> {
        return await this.repo.find({ 
            where: { HospitalId: hospitalId, IsDeleted: false },
            relations: ["User"]
        });
    }

    async findByUserIdAndHospital(userId: string, hospitalId: number): Promise<HealthcareProvider | null> {
        return await this.repo.findOne({
            where: { UserId: userId, HospitalId: hospitalId, IsDeleted: false }
        });
    }
}

export const healthcareProviderRepository = new HealthcareProviderRepository();
