import { AppDataSource } from "../../config/database.js";
import { STANDARD_LAB_TESTS } from "../../constants/standard-lab-tests.js";
import { HospitalLabTest } from "../../models/Organizations/hospital-lab-test.model.js";
import { Hospital } from "../../models/Organizations/hospital.model.js";

export interface LabTestInput {
    testName?: string;
    testCode?: string | null;
    category?: string;
    sampleType?: string | null;
    price?: number | string | null;
    preparation?: string | null;
    isActive?: boolean;
}

const toPrice = (value: LabTestInput["price"]): number | null => {
    if (value === null || value === undefined || value === "") return null;
    const price = Number(value);
    if (!Number.isFinite(price) || price < 0) throw new Error("Price must be zero or more.");
    return price;
};

export class HospitalLabTestService {
    private repo = AppDataSource.getRepository(HospitalLabTest);

    /** A hospital gets the standard list the first time its list is opened. */
    private async seedIfNew(hospitalId: number): Promise<void> {
        if ((await this.repo.count({ where: { HospitalId: hospitalId } })) > 0) return;
        const hospital = await AppDataSource.getRepository(Hospital).findOne({ where: { Id: hospitalId } as any });
        if (!hospital) throw new Error("Hospital not found.");
        const organizationId = (hospital as any).OrganizationId ?? null;
        await this.repo.save(STANDARD_LAB_TESTS.map((test) => this.repo.create({
            HospitalId: hospitalId,
            OrganizationId: organizationId,
            TestName: test.name,
            TestCode: test.code,
            Category: test.category,
            SampleType: test.sampleType,
            Preparation: test.preparation ?? null,
        })), { chunk: 20 });
    }

    async list(hospitalId: number, options: { includeInactive?: boolean; search?: string } = {}): Promise<HospitalLabTest[]> {
        await this.seedIfNew(hospitalId);
        const query = this.repo.createQueryBuilder("t")
            .where("t.HospitalId = :hospitalId", { hospitalId })
            .andWhere("t.IsDeleted = 0");
        if (!options.includeInactive) query.andWhere("t.IsActive = 1");
        const search = options.search?.trim();
        if (search) {
            query.andWhere("(t.TestName LIKE :search OR t.TestCode LIKE :search OR t.Category LIKE :search)", { search: `%${search}%` });
        }
        return query.orderBy("t.Category", "ASC").addOrderBy("t.TestName", "ASC").getMany();
    }

    private async assertNameFree(hospitalId: number, name: string, ownId?: number): Promise<void> {
        const taken = await this.repo.findOne({ where: { HospitalId: hospitalId, TestName: name, IsDeleted: false } });
        if (taken && taken.Id !== ownId) throw new Error("This hospital already has a test with that name.");
    }

    async create(hospitalId: number, input: LabTestInput): Promise<HospitalLabTest> {
        await this.seedIfNew(hospitalId);
        const name = input.testName?.trim();
        const category = input.category?.trim();
        if (!name) throw new Error("Test name is required.");
        if (!category) throw new Error("Category is required.");
        await this.assertNameFree(hospitalId, name);
        const hospital = await AppDataSource.getRepository(Hospital).findOne({ where: { Id: hospitalId } as any });
        return this.repo.save(this.repo.create({
            HospitalId: hospitalId,
            OrganizationId: (hospital as any)?.OrganizationId ?? null,
            TestName: name,
            TestCode: input.testCode?.trim() || null,
            Category: category,
            SampleType: input.sampleType?.trim() || null,
            Price: toPrice(input.price),
            Preparation: input.preparation?.trim() || null,
            IsActive: input.isActive ?? true,
        }));
    }

    private async own(hospitalId: number, id: number): Promise<HospitalLabTest> {
        const test = await this.repo.findOne({ where: { Id: id, HospitalId: hospitalId, IsDeleted: false } });
        if (!test) throw new Error("Lab test not found.");
        return test;
    }

    async update(hospitalId: number, id: number, input: LabTestInput): Promise<HospitalLabTest> {
        const test = await this.own(hospitalId, id);
        if (input.testName !== undefined) {
            const name = input.testName.trim();
            if (!name) throw new Error("Test name is required.");
            await this.assertNameFree(hospitalId, name, id);
            test.TestName = name;
        }
        if (input.category !== undefined) {
            const category = input.category.trim();
            if (!category) throw new Error("Category is required.");
            test.Category = category;
        }
        if (input.testCode !== undefined) test.TestCode = input.testCode?.trim() || null;
        if (input.sampleType !== undefined) test.SampleType = input.sampleType?.trim() || null;
        if (input.price !== undefined) test.Price = toPrice(input.price);
        if (input.preparation !== undefined) test.Preparation = input.preparation?.trim() || null;
        if (input.isActive !== undefined) test.IsActive = Boolean(input.isActive);
        test.UpdatedAt = new Date();
        return this.repo.save(test);
    }

    async remove(hospitalId: number, id: number): Promise<void> {
        const test = await this.own(hospitalId, id);
        test.IsDeleted = true;
        test.UpdatedAt = new Date();
        await this.repo.save(test);
    }
}

export const hospitalLabTestService = new HospitalLabTestService();
