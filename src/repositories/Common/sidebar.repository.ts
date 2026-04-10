import { AppDataSource } from "../../config/database.js";
import { RoleSidebarMenu } from "../../models/Common/role-sidebar-menu.model.js";
import type { ISidebarRepository } from "../../interfaces/Repository/Common/ISidebarRepository.js";

/**
 * Repository for Sidebar operations.
 */
export class SidebarRepository implements ISidebarRepository {
    private repo = AppDataSource.getRepository(RoleSidebarMenu);

    async getRoleSidebarMenus(roleId: string, orgId?: number | null, hospId?: number | null): Promise<RoleSidebarMenu[]> {
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

        // Sort by OrderNo if available
        query.orderBy("menu.OrderNo", "ASC");

        return await query.getMany();
    }
}

export const sidebarRepository = new SidebarRepository();
