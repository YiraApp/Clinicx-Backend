import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm/index.js";

@Entity({ name: "MobileSidebarMenus" })
export class MobileSidebarMenu {
    @PrimaryGeneratedColumn()
    MenuId: number;

    @Column({ type: "varchar", length: 100 })
    MenuName: string;

    @Column({ type: "varchar", length: 100, nullable: true })
    TaskCode?: string;

    @Column({ type: "varchar", length: 100, nullable: true })
    TaskId?: string;

    @Column({ type: "varchar", length: 50, nullable: true })
    Icon?: string;

    @Column({ type: "varchar", length: 255, nullable: true })
    ImagePath?: string;

    @Column({ type: "bit", default: 0 })
    UseImage: boolean;

    @Column({ type: "int", nullable: true })
    OrderNo?: number;

    @Column({ type: "bit", default: 1 })
    Status: boolean;

    @CreateDateColumn({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;
}
