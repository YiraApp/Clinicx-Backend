import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from "typeorm/index.js";
import { User } from "./user.model.js";

@Entity({ name: "UserDevices" })
export class UserDevice {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "uniqueidentifier" })
    UserId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "UserId" })
    user: User;

    @Column({ type: "nvarchar", length: "MAX", nullable: false })
    FCMToken: string;

    @Column({ type: "varchar", length: 50, nullable: true })
    Platform?: string;

    @Column({ type: "varchar", length: 255, nullable: true })
    PhysicalDeviceId?: string;

    @Column({ type: "varchar", length: 50, nullable: true })
    CurrentVersion?: string;

    @Column({ type: "bit", default: true })
    IsActive: boolean;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;
}
