import { AppDataSource } from "../../config/database.js";
import { RoleSidebarMenu } from "../../models/Common/role-sidebar-menu.model.js";
import type { ISidebarRepository } from "../../interfaces/Repository/Common/ISidebarRepository.js";

import { SidebarMenu } from "../../models/Common/sidebar-menu.model.js";
import { MobileSidebarMenu } from "../../models/Common/mobile-sidebar-menu.model.js";
import { RoleMobileSidebarMenu } from "../../models/Common/role-mobile-sidebar-menu.model.js";

/**
 * Repository for Sidebar operations.
 */
export class SidebarRepository implements ISidebarRepository {
    private repo = AppDataSource.getRepository(RoleSidebarMenu);
    private menuRepo = AppDataSource.getRepository(SidebarMenu);
    private mobileRepo = AppDataSource.getRepository(RoleMobileSidebarMenu);
    private mobileMenuRepo = AppDataSource.getRepository(MobileSidebarMenu);

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

    async hasMenuAccess(roleId: string, routePatterns: string[], orgId?: number | null, hospId?: number | null): Promise<boolean> {
        const roleMenus = await this.getRoleSidebarMenus(roleId, orgId, hospId);
        return roleMenus.some(rm =>
            rm.Menu?.Route &&
            routePatterns.some(pattern => rm.Menu!.Route!.toLowerCase().includes(pattern.toLowerCase()))
        );
    }

    async updateMenu(menuId: number, menuData: Partial<SidebarMenu>): Promise<SidebarMenu> {
        const allowedFields: (keyof SidebarMenu)[] = [
            "MenuName", "Route", "Icon", "ImagePath", "ParentMenuId", "OrderNo", "Status"
        ];
        const sanitizedData: any = {};
        for (const key of allowedFields) {
            if ((menuData as any)[key] !== undefined) {
                sanitizedData[key] = (menuData as any)[key];
            }
        }
        if (Object.keys(sanitizedData).length > 0) {
            await this.menuRepo.update(menuId, sanitizedData);
        }
        return await this.menuRepo.findOneBy({ MenuId: menuId }) as SidebarMenu;
    }

    async deleteMenu(menuId: number): Promise<void> {
        // Soft delete
        await this.menuRepo.update(menuId, { Status: false });
    }

    async updateRoleSidebarMenus(roleId: string, menuIds: number[], orgId?: number | null, hospId?: number | null): Promise<void> {
        await AppDataSource.transaction(async (transactionalEntityManager) => {
            // 1. Determine the baseline (inherited permissions)
            // If we are saving for a hospital, baseline is the Organization level
            // If we are saving for an organization, baseline is the Global level
            let baselineRecords: RoleSidebarMenu[] = [];
            if (hospId) {
                // Baseline for Hospital is the Org-level effective permissions
                baselineRecords = await this.getRoleSidebarMenus(roleId, orgId, null);
            } else if (orgId) {
                // Baseline for Organization is the Global-level effective permissions
                baselineRecords = await this.getRoleSidebarMenus(roleId, null, null);
            } else {
                // Baseline for Global is nothing (empty)
                baselineRecords = [];
            }

            const baselineIds = baselineRecords.map(r => r.MenuId);
            const allPossibleMenus = await this.menuRepo.find({ where: { Status: true } });

            // 2. Fetch existing records for THIS SPECIFIC scope
            const query = transactionalEntityManager.createQueryBuilder(RoleSidebarMenu, "rsm")
                .where("rsm.RoleId = :roleId", { roleId });

            if (orgId) query.andWhere("rsm.OrganizationId = :orgId", { orgId });
            else query.andWhere("rsm.OrganizationId IS NULL");

            if (hospId) query.andWhere("rsm.HospitalId = :hospId", { hospId });
            else query.andWhere("rsm.HospitalId IS NULL");

            const currentScopeRecords = await query.getMany();
            const currentScopeMap = new Map<number, RoleSidebarMenu>();
            currentScopeRecords.forEach(r => currentScopeMap.set(r.MenuId, r));

            // 3. Process every possible menu to see if an override is needed
            for (const menu of allPossibleMenus) {
                const menuId = menu.MenuId;
                const isTargetActive = menuIds.includes(menuId);
                const isInheritedActive = baselineIds.includes(menuId);
                const existingRecord = currentScopeMap.get(menuId);

                if (isTargetActive !== isInheritedActive) {
                    // We need an override record at this scope
                    if (existingRecord) {
                        // Update existing record to match target status
                        await transactionalEntityManager.update(RoleSidebarMenu, existingRecord.RoleSidebarMenuId, { 
                            Status: isTargetActive 
                        });
                    } else {
                        // Create new override record
                        const newRecord = new RoleSidebarMenu();
                        newRecord.RoleId = roleId;
                        newRecord.MenuId = menuId;
                        newRecord.OrganizationId = orgId ?? null;
                        newRecord.HospitalId = hospId ?? null;
                        newRecord.Status = isTargetActive;
                        await transactionalEntityManager.save(RoleSidebarMenu, newRecord);
                    }
                } else {
                    // No override needed (target matches inherited)
                    // If an override record already exists, deactivate or delete it to revert to inheritance
                    if (existingRecord) {
                        // We delete it or set status such that it doesn't conflict. 
                        // Actually, the priority system picks the most specific one, 
                        // so if we want to inherit, we should just remove the specific record.
                        await transactionalEntityManager.delete(RoleSidebarMenu, existingRecord.RoleSidebarMenuId);
                    }
                }
            }
        });
    }

    async getRoleMobileSidebarMenus(roleId: string, orgId?: number | null, hospId?: number | null): Promise<RoleMobileSidebarMenu[]> {
        const query = this.mobileRepo.createQueryBuilder("rsm")
            .leftJoinAndSelect("rsm.Menu", "menu")
            .where("rsm.RoleId = :roleId", { roleId });

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
        
        const allRecords = await query.getMany();
        const menuMap = new Map<number, RoleMobileSidebarMenu>();

        for (const record of allRecords) {
            const existing = menuMap.get(record.MenuId);
            if (!existing) {
                menuMap.set(record.MenuId, record);
                continue;
            }

            const getPriority = (r: RoleMobileSidebarMenu) => {
                if (r.HospitalId) return 2;
                if (r.OrganizationId) return 1;
                return 0;
            };

            if (getPriority(record) > getPriority(existing)) {
                menuMap.set(record.MenuId, record);
            }
        }

        return Array.from(menuMap.values())
            .filter(r => r.Status === true && r.Menu && r.Menu.Status === true)
            .sort((a, b) => (a.Menu.OrderNo || 0) - (b.Menu.OrderNo || 0));
    }

    async getAllMobileMenus(): Promise<MobileSidebarMenu[]> {
        return await this.mobileMenuRepo.find({
            where: { Status: true },
            order: { OrderNo: "ASC" }
        });
    }

    async createMobileMenu(menuData: Partial<MobileSidebarMenu>): Promise<MobileSidebarMenu> {
        const menu = this.mobileMenuRepo.create(menuData);
        return await this.mobileMenuRepo.save(menu);
    }

    async updateMobileMenu(menuId: number, menuData: Partial<MobileSidebarMenu>): Promise<MobileSidebarMenu> {
        const allowedFields: (keyof MobileSidebarMenu)[] = [
            "MenuName", "TaskCode", "TaskId", "Icon", "ImagePath", "UseImage", "OrderNo", "Status"
        ];
        const sanitizedData: any = {};
        for (const key of allowedFields) {
            if ((menuData as any)[key] !== undefined) {
                sanitizedData[key] = (menuData as any)[key];
            }
        }
        if (Object.keys(sanitizedData).length > 0) {
            await this.mobileMenuRepo.update(menuId, sanitizedData);
        }
        return await this.mobileMenuRepo.findOneBy({ MenuId: menuId }) as MobileSidebarMenu;
    }

    async deleteMobileMenu(menuId: number): Promise<void> {
        await this.mobileMenuRepo.update(menuId, { Status: false });
    }

    async updateRoleMobileSidebarMenus(roleId: string, menuIds: number[], orgId?: number | null, hospId?: number | null): Promise<void> {
        await AppDataSource.transaction(async (transactionalEntityManager) => {
            let baselineRecords: RoleMobileSidebarMenu[] = [];
            if (hospId) {
                baselineRecords = await this.getRoleMobileSidebarMenus(roleId, orgId, null);
            } else if (orgId) {
                baselineRecords = await this.getRoleMobileSidebarMenus(roleId, null, null);
            } else {
                baselineRecords = [];
            }

            const baselineIds = baselineRecords.map(r => r.MenuId);
            const allPossibleMenus = await this.mobileMenuRepo.find({ where: { Status: true } });

            const query = transactionalEntityManager.createQueryBuilder(RoleMobileSidebarMenu, "rsm")
                .where("rsm.RoleId = :roleId", { roleId });

            if (orgId) query.andWhere("rsm.OrganizationId = :orgId", { orgId });
            else query.andWhere("rsm.OrganizationId IS NULL");

            if (hospId) query.andWhere("rsm.HospitalId = :hospId", { hospId });
            else query.andWhere("rsm.HospitalId IS NULL");

            const currentScopeRecords = await query.getMany();
            const currentScopeMap = new Map<number, RoleMobileSidebarMenu>();
            currentScopeRecords.forEach(r => currentScopeMap.set(r.MenuId, r));

            for (const menu of allPossibleMenus) {
                const menuId = menu.MenuId;
                const isTargetActive = menuIds.includes(menuId);
                const isInheritedActive = baselineIds.includes(menuId);
                const existingRecord = currentScopeMap.get(menuId);

                if (isTargetActive !== isInheritedActive) {
                    if (existingRecord) {
                        await transactionalEntityManager.update(RoleMobileSidebarMenu, existingRecord.RoleMobileSidebarMenuId, { 
                            Status: isTargetActive 
                        });
                    } else {
                        const newRecord = new RoleMobileSidebarMenu();
                        newRecord.RoleId = roleId;
                        newRecord.MenuId = menuId;
                        newRecord.OrganizationId = orgId ?? null;
                        newRecord.HospitalId = hospId ?? null;
                        newRecord.Status = isTargetActive;
                        await transactionalEntityManager.save(RoleMobileSidebarMenu, newRecord);
                    }
                } else {
                    if (existingRecord) {
                        await transactionalEntityManager.delete(RoleMobileSidebarMenu, existingRecord.RoleMobileSidebarMenuId);
                    }
                }
            }
        });
    }
}

export const sidebarRepository = new SidebarRepository();
