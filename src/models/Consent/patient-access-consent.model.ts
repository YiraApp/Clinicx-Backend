import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from "typeorm/index.js";
import { User } from "../Account/user.model.js";
import { Hospital } from "../Organizations/hospital.model.js";

@Entity({ name: "PatientAccessConsents" })
export class PatientAccessConsent {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "uniqueidentifier" })
    PatientId: string; // User UUID of Patient

    @ManyToOne(() => User)
    @JoinColumn({ name: "PatientId" })
    Patient?: User;

    @Column({ type: "uniqueidentifier" })
    DoctorId: string; // User UUID of Doctor

    @ManyToOne(() => User)
    @JoinColumn({ name: "DoctorId" })
    Doctor?: User;

    @Column({ type: "int", nullable: true })
    HospitalId?: number;

    @ManyToOne(() => Hospital)
    @JoinColumn({ name: "HospitalId" })
    Hospital?: Hospital;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number;

    @Column({ type: "nvarchar", length: 50 })
    Duration: string; // '1_HOUR', '5_HOURS', '1_DAY', '3_DAYS', '7_DAYS', '1_MONTH', 'NEVER'

    @Column({ type: "int", default: 60 })
    DurationMinutes: number; // 60, 300, 1440, 4320, 10080, 43200, 0 for infinite

    @Column({ type: "nvarchar", length: 50, default: "PENDING" })
    Status: string; // 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'REVOKED'

    @Column({ type: "datetime", default: () => "getdate()" })
    RequestedAt: Date;

    @Column({ type: "datetime", nullable: true })
    ApprovedAt?: Date;

    @Column({ type: "datetime", nullable: true })
    ExpiresAt?: Date;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    Notes?: string;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;

    @Column({ type: "datetime", default: () => "getdate()" })
    UpdatedAt: Date;
}
