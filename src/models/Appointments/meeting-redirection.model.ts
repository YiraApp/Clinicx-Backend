import { Entity, PrimaryGeneratedColumn, Column, Index } from "typeorm/index.js";

@Entity({ name: "MeetingRedirections" })
export class MeetingRedirection {
    @PrimaryGeneratedColumn({ type: "bigint" })
    Id: number;

    @Index({ unique: true })
    @Column({ type: "nvarchar", length: 100 })
    UrlId: string;

    @Column({ type: "int" })
    AppointmentId: number;

    @Column({ type: "uniqueidentifier" })
    PatientId: string;

    @Column({ type: "int" })
    OrganizationId: number;

    @Column({ type: "int" })
    HospitalId: number;

    @Column({ type: "uniqueidentifier" })
    DoctorId: string;

    @Column({ type: "nvarchar", length: 500 })
    MeetingUrl: string;

    @Column({ type: "date" })
    AppointmentDate: Date;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    StartTime?: string;

    @Column({ type: "bit", default: 1 })
    IsActive: boolean;

    @Column({ type: "int", default: 0 })
    AccessCount: number;

    @Column({ type: "datetime", nullable: true })
    LastAccessedAt?: Date;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;
}
