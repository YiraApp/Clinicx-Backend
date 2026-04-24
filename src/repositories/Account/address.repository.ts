import { AppDataSource } from "../../config/database.js";
import { Address } from "../../models/Account/address.model.js";

/**
 * Repository for managing Address entities.
 */
export class AddressRepository {
    private repo = AppDataSource.getRepository(Address);

    async findById(id: number): Promise<Address | null> {
        return await this.repo.findOne({ where: { Id: id } });
    }

    async save(address: Address): Promise<Address> {
        return await this.repo.save(address);
    }

    async update(id: number, data: Partial<Address>): Promise<void> {
        await this.repo.update(id, { ...data, UpdatedAt: new Date() });
    }
}

export const addressRepository = new AddressRepository();
