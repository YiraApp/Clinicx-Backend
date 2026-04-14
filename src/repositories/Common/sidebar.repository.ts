import { AppDataSource } from "../../config/database.js";
import { RoleSidebarMenu } from "../../models/Common/role-sidebar-menu.model.js";
import type { ISidebarRepository } from "../../interfaces/Repository/Common/ISidebarRepository.js";

/**
 * Repository for Sidebar operations.
 */
export class SidebarRepository implements ISidebarRepository {
    private repo = AppDataSource.getRepository(RoleSidebarMenu);

    async getRoleSidebarMenus(roleId: string, orgId?: number | null, hospId?: number | null): Promise<RoleSidebarMenu[]> {
        // Step 1: Try to find menus specific to this Organization / Hospital
        const query = this.repo.createQueryBuilder("rsm")
            .leftJoinAndSelect("rsm.Menu", "menu")
            .where("rsm.RoleId = :roleId", { roleId })
            .andWhere("rsm.Status = 1")
            .andWhere("menu.Status = 1");

        if (orgId !== undefined && orgId !== null) {
            query.andWhere("rsm.OrganizationId = :orgId", { orgId });
        } else {
            query.andWhere("rsm.OrganizationId IS NULL");
        }

        if (hospId !== undefined && hospId !== null) {
            query.andWhere("rsm.HospitalId = :hospId", { hospId });
        } else {
            query.andWhere("rsm.HospitalId IS NULL");
        }

        query.orderBy("menu.OrderNo", "ASC");
        let results = await query.getMany();

        // Step 2: Fallback Logic
        // If no menus found for specific org/hosp, fall back to global role-based menus (where org/hosp are NULL)
        if (results.length === 0 && (orgId || hospId)) {
            const fallbackQuery = this.repo.createQueryBuilder("rsm")
                .leftJoinAndSelect("rsm.Menu", "menu")
                .where("rsm.RoleId = :roleId", { roleId })
                .andWhere("rsm.OrganizationId IS NULL")
                .andWhere("rsm.HospitalId IS NULL")
                .andWhere("rsm.Status = 1")
                .andWhere("menu.Status = 1")
                .orderBy("menu.OrderNo", "ASC");

            results = await fallbackQuery.getMany();
        }

        return results;
    }
}

export const sidebarRepository = new SidebarRepository();
