import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm/index.js";

@Entity({ name: "AppointmentShareLinks" })
export class AppointmentShareLink {
    @PrimaryGeneratedColumn({ type: "bigint" })
    Id: number;

    @Column({ type: "bigint" })
    AppointmentId: number;

    @Column({ type: "uniqueidentifier" })
    PatientId: string;

    @Column({ type: "bigint" })
    OrganizationId: number;

    @Column({ type: "bigint" })
    HospitalId: number;

    @Column({ type: "nvarchar", length: "MAX" })
    ShareToken: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    ShareLink?: string;

    @Column({ type: "datetime" })
    ExpiryAt: Date;

    @Column({ type: "int", default: 0 })
    DownloadCount: number;

    @Column({ type: "datetime", nullable: true })
    LastAccessedAt?: Date;

    @Column({ type: "bit", default: 1 })
    IsActive: boolean;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "varchar", length: 100, nullable: true })
    CreatedBy?: string;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @Column({ type: "varchar", length: 100, nullable: true })
    UpdatedBy?: string;

    @Column({ type: "bit", default: 0 })
    IsDeleted: boolean;
}
