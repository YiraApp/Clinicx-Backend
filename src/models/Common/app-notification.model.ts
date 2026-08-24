import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

@Entity({ name: "AppNotifications" })
export class AppNotification {
    @PrimaryGeneratedColumn("uuid")
    Id: string;

    @Index()
    @Column({ type: "uniqueidentifier", nullable: false })
    UserId: string;

    @Column({ type: "uniqueidentifier", nullable: true })
    SenderId: string | null;

    @Column({ type: "nvarchar", length: 255, nullable: false })
    Title: string;

    @Column({ type: "nvarchar", length: "max", nullable: false })
    Body: string;

    @Column({ type: "varchar", length: 50, nullable: false, default: "SYSTEM" })
    Type: string;

    @Column({ type: "varchar", length: 100, nullable: true })
    ReferenceId: string | null;

    @Column({ type: "varchar", length: 255, nullable: true })
    Route: string | null;

    @Column({ type: "bit", default: false })
    IsRead: boolean;

    @CreateDateColumn({ type: "datetime" })
    CreatedAt: Date;

    @UpdateDateColumn({ type: "datetime", nullable: true })
    UpdatedAt: Date | null;
}
