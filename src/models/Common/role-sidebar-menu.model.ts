import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { SidebarMenu } from "./sidebar-menu.model.js";

@Entity({ name: "RoleSidebarMenus" })
export class RoleSidebarMenu {
    @PrimaryGeneratedColumn()
    RoleSidebarMenuId: number;

    @Column({ type: "uniqueidentifier" })
    RoleId: string;

    @Column({ type: "int" })
    MenuId: number;

    @ManyToOne(() => SidebarMenu)
    @JoinColumn({ name: "MenuId" })
    Menu: SidebarMenu;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number;

    @Column({ type: "int", nullable: true })
    HospitalId?: number;

    @Column({ type: "bit", default: 1 })
    Status: boolean;

    @CreateDateColumn({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;
}
