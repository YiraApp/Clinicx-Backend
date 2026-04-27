import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, OneToMany } from "typeorm/index.js";

@Entity({ name: "SidebarMenus" })
export class SidebarMenu {
    @PrimaryGeneratedColumn()
    MenuId: number;

    @Column({ type: "varchar", length: 100 })
    MenuName: string;

    @Column({ type: "varchar", length: 255, nullable: true })
    Route?: string;

    @Column({ type: "varchar", length: 50, nullable: true })
    Icon?: string;

    @Column({ type: "int", nullable: true })
    ParentMenuId?: number;

    @ManyToOne(() => SidebarMenu, (menu) => menu.Children, { nullable: true })
    @JoinColumn({ name: "ParentMenuId" })
    Parent?: SidebarMenu;

    @OneToMany(() => SidebarMenu, (menu) => menu.Parent)
    Children?: SidebarMenu[];

    @Column({ type: "int", nullable: true })
    OrderNo?: number;

    @Column({ type: "bit", default: 1 })
    Status: boolean;

    @CreateDateColumn({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;
}
