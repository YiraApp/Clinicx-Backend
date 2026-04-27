import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from "typeorm/index.js";
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
    OrganizationId: number | null;

    @Column({ type: "int", nullable: true })
    HospitalId: number | null;

    @Column({ type: "bit", default: 1 })
    Status: boolean;

    @CreateDateColumn({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;
}
