import { AppDataSource } from "../../config/database.js";
import { RoleSidebarMenu } from "../../models/Common/role-sidebar-menu.model.js";
import type { ISidebarRepository } from "../../interfaces/Repository/Common/ISidebarRepository.js";

import { SidebarMenu } from "../../models/Common/sidebar-menu.model.js";

/**
 * Repository for Sidebar operations.
 */
export class SidebarRepository implements ISidebarRepository {
    private repo = AppDataSource.getRepository(RoleSidebarMenu);
    private menuRepo = AppDataSource.getRepository(SidebarMenu);

    async getRoleSidebarMenus(roleId: string, orgId?: number | null, hospId?: number | null): Promise<RoleSidebarMenu[]> {
        // Fetch all potential records for this role across all levels (Global, Org, Hosp)
        const query = this.repo.createQueryBuilder("rsm")
            .leftJoinAndSelect("rsm.Menu", "menu")
            .where("rsm.RoleId = :roleId", { roleId });

        // Build the hierarchical filter
        const contextConditions = ["(rsm.OrganizationId IS NULL AND rsm.HospitalId IS NULL)"];
        const params: any = { roleId };

        if (orgId) {
            contextConditions.push("(rsm.OrganizationId = :orgId AND rsm.HospitalId IS NULL)");
            params.orgId = orgId;
            
            if (hospId) {
                contextConditions.push("(rsm.OrganizationId = :orgId AND rsm.HospitalId = :hospId)");
                params.hospId = hospId;
            }
        }
        
        query.andWhere(`(${contextConditions.join(" OR ")})`, params);
        
        // We need all records to determine overrides, even inactive ones
        const allRecords = await query.getMany();

        // Group by MenuId to find the most specific record for each menu
        const menuMap = new Map<number, RoleSidebarMenu>();

        for (const record of allRecords) {
            const existing = menuMap.get(record.MenuId);
            
            if (!existing) {
                menuMap.set(record.MenuId, record);
                continue;
            }

            // Priority: Hospital (2) > Organization (1) > Global (0)
            const getPriority = (r: RoleSidebarMenu) => {
                if (r.HospitalId) return 2;
                if (r.OrganizationId) return 1;
                return 0;
            };

            if (getPriority(record) > getPriority(existing)) {
                menuMap.set(record.MenuId, record);
            }
        }

        // Return only those that are active and have an active menu
        return Array.from(menuMap.values())
            .filter(r => r.Status === true && r.Menu && r.Menu.Status === true)
            .sort((a, b) => (a.Menu.OrderNo || 0) - (b.Menu.OrderNo || 0));
    }

    async getAllMenus(): Promise<SidebarMenu[]> {
        return await this.menuRepo.find({
            where: { Status: true },
            order: { OrderNo: "ASC" }
        });
    }

    async createMenu(menuData: Partial<SidebarMenu> & { children?: any[] }): Promise<SidebarMenu> {
        return await AppDataSource.transaction(async (manager) => {
            const { children, ...rest } = menuData;
            const menu = manager.create(SidebarMenu, rest);
            const savedMenu = await manager.save(SidebarMenu, menu);

            if (children && children.length > 0) {
                for (const child of children) {
                    child.ParentMenuId = savedMenu.MenuId;
                    await this.createMenuWithManager(child, manager);
                }
            }
            return savedMenu;
        });
    }

    // Helper for recursive creation within transaction
    private async createMenuWithManager(menuData: any, manager: any): Promise<SidebarMenu> {
        const { children, ...rest } = menuData;
        const menu = manager.create(SidebarMenu, rest);
        const savedMenu = await manager.save(SidebarMenu, menu);

        if (children && children.length > 0) {
            for (const child of children) {
                child.ParentMenuId = savedMenu.MenuId;
                await this.createMenuWithManager(child, manager);
            }
        }
        return savedMenu;
    }

    async updateMenu(menuId: number, menuData: Partial<SidebarMenu>): Promise<SidebarMenu> {
        await this.menuRepo.update(menuId, menuData);
        return await this.menuRepo.findOneBy({ MenuId: menuId }) as SidebarMenu;
    }

    async deleteMenu(menuId: number): Promise<void> {
        // Soft delete
        await this.menuRepo.update(menuId, { Status: false });
    }

    async updateRoleSidebarMenus(roleId: string, menuIds: number[], orgId?: number | null, hospId?: number | null): Promise<void> {
        await AppDataSource.transaction(async (transactionalEntityManager) => {
            // 1. Fetch ALL existing records for this specific scope (regardless of status)
            const query = transactionalEntityManager.createQueryBuilder(RoleSidebarMenu, "rsm")
                .where("rsm.RoleId = :roleId", { roleId });

            if (orgId) query.andWhere("rsm.OrganizationId = :orgId", { orgId });
            else query.andWhere("rsm.OrganizationId IS NULL");

            if (hospId) query.andWhere("rsm.HospitalId = :hospId", { hospId });
            else query.andWhere("rsm.HospitalId IS NULL");

            const existingRecords = await query.getMany();
            const existingMenuIds = existingRecords.map(r => r.MenuId);

            // 2. Deactivate records that are NOT in the new menuIds list
            const recordsToDeactivate = existingRecords.filter(r => !menuIds.includes(r.MenuId) && r.Status === true);
            if (recordsToDeactivate.length > 0) {
                const ids = recordsToDeactivate.map(r => r.RoleSidebarMenuId);
                await transactionalEntityManager.update(RoleSidebarMenu, ids, { Status: false });
            }

            // 3. Activate records that ARE in the new menuIds list but were inactive
            const recordsToActivate = existingRecords.filter(r => menuIds.includes(r.MenuId) && r.Status === false);
            if (recordsToActivate.length > 0) {
                const ids = recordsToActivate.map(r => r.RoleSidebarMenuId);
                await transactionalEntityManager.update(RoleSidebarMenu, ids, { Status: true });
            }

            // 4. Insert entirely new records
            const newMenuIds = menuIds.filter(id => !existingMenuIds.includes(id));
            if (newMenuIds.length > 0) {
                const newAssignments = newMenuIds.map(menuId => {
                    const assignment = new RoleSidebarMenu();
                    assignment.RoleId = roleId;
                    assignment.MenuId = menuId;
                    assignment.OrganizationId = orgId ?? null;
                    assignment.HospitalId = hospId ?? null;
                    assignment.Status = true;
                    return assignment;
                });
                await transactionalEntityManager.save(RoleSidebarMenu, newAssignments);
            }
        });
    }
}

export const sidebarRepository = new SidebarRepository();
