import { AppDataSource } from "../../config/database.js";
import { OfferBanner } from "../../models/Offers/offer-banner.model.js";

export class OfferBannerRepository {
    private get repo() {
        return AppDataSource.getRepository(OfferBanner);
    }

    /**
     * Retrieves active banners for patients/clients filtered by organization and placement.
     */
    async getActiveOffers(organizationId?: number, placement?: string): Promise<OfferBanner[]> {
        const now = new Date();
        const qb = this.repo.createQueryBuilder("b")
            .where("b.IsActive = :isActive", { isActive: 1 })
            .andWhere("(b.StartDate IS NULL OR b.StartDate <= :now)", { now })
            .andWhere("(b.EndDate IS NULL OR b.EndDate >= :now)", { now });

        if (placement && placement !== "all") {
            qb.andWhere("(b.Placement = :placement OR (:placement = 'carousel' AND (b.Placement IS NULL OR b.Placement = '')))", { placement });
        }

        if (organizationId !== undefined && organizationId !== null && !isNaN(Number(organizationId))) {
            const orgIdStr = String(organizationId);
            // Matches if banner applies to all orgs, or target list contains orgId
            qb.andWhere(
                "(b.IsAllOrganizations = 1 OR b.TargetOrganizationIds LIKE :exactId OR b.TargetOrganizationIds LIKE :midId OR b.TargetOrganizationIds LIKE :startId OR b.TargetOrganizationIds LIKE :endId)",
                {
                    exactId: `%"${orgIdStr}"%`,
                    midId: `%,${orgIdStr},%`,
                    startId: `[${orgIdStr},%`,
                    endId: `%,${orgIdStr}]%`,
                }
            );
        } else {
            qb.andWhere("b.IsAllOrganizations = 1");
        }

        qb.orderBy("b.DisplayOrder", "ASC")
          .addOrderBy("b.CreatedAt", "DESC");

        return await qb.getMany();
    }

    /**
     * Admin: Retrieve all banners with optional filtering.
     */
    async findAll(options?: { organizationId?: number; isActive?: boolean; placement?: string }): Promise<OfferBanner[]> {
        const qb = this.repo.createQueryBuilder("b");

        if (options?.isActive !== undefined) {
            qb.andWhere("b.IsActive = :isActive", { isActive: options.isActive ? 1 : 0 });
        }

        if (options?.placement && options.placement !== "all") {
            qb.andWhere("(b.Placement = :placement OR (:placement = 'carousel' AND (b.Placement IS NULL OR b.Placement = '')))", { placement: options.placement });
        }

        if (options?.organizationId !== undefined && !isNaN(Number(options.organizationId))) {
            const orgIdStr = String(options.organizationId);
            qb.andWhere(
                "(b.IsAllOrganizations = 1 OR b.TargetOrganizationIds LIKE :exactId)",
                { exactId: `%${orgIdStr}%` }
            );
        }

        qb.orderBy("b.DisplayOrder", "ASC")
          .addOrderBy("b.CreatedAt", "DESC");

        return await qb.getMany();
    }

    async findById(id: number): Promise<OfferBanner | null> {
        return await this.repo.findOne({ where: { Id: id } });
    }

    async create(data: Partial<OfferBanner>): Promise<OfferBanner> {
        const banner = this.repo.create(data);
        return await this.repo.save(banner);
    }

    async update(id: number, data: Partial<OfferBanner>): Promise<OfferBanner | null> {
        const existing = await this.findById(id);
        if (!existing) return null;

        Object.assign(existing, data);
        existing.UpdatedAt = new Date();
        return await this.repo.save(existing);
    }

    async toggleStatus(id: number): Promise<OfferBanner | null> {
        const existing = await this.findById(id);
        if (!existing) return null;

        existing.IsActive = !existing.IsActive;
        existing.UpdatedAt = new Date();
        return await this.repo.save(existing);
    }

    async delete(id: number): Promise<boolean> {
        const result = await this.repo.delete(id);
        return (result.affected ?? 0) > 0;
    }
}

export const offerBannerRepository = new OfferBannerRepository();
