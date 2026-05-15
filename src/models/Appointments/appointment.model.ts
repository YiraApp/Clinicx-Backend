import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, JoinColumn, Relation, Index } from "typeorm/index.js";
import { User } from "../Account/user.model.js";
import { Organization } from "../Organizations/organization.model.js";
import { Hospital } from "../Organizations/hospital.model.js";
import { HealthcareProviderScheduleSlot } from "../Organizations/healthcare-provider-schedule-slot.model.js";
import { PatientVerification } from "./patient-verification.model.js";

@Entity({ name: "Appointments" })
export class Appointment {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "uniqueidentifier" })
    UserId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "UserId" })
    User: Relation<User>;

    @Index()
    @Column({ type: "int" })
    OrgId: number;

    @ManyToOne(() => Organization)
    @JoinColumn({ name: "OrgId" })
    Organization: Relation<Organization>;

    @Index()
    @Column({ type: "int" })
    HospitalId: number;

    @ManyToOne(() => Hospital)
    @JoinColumn({ name: "HospitalId" })
    Hospital: Relation<Hospital>;

    @Column({ type: "uniqueidentifier" })
    DoctorId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "DoctorId" })
    Doctor: Relation<User>;

    @Column({ type: "int", nullable: true })
    SlotId?: number;

    @ManyToOne(() => HealthcareProviderScheduleSlot)
    @JoinColumn({ name: "SlotId" })
    Slot: Relation<HealthcareProviderScheduleSlot>;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    AppointmentType?: string;

    @Index()
    @Column({ type: "nvarchar", length: 50, nullable: true })
    Status?: string;

    @Index()
    @Column({ type: "date" })
    AppointmentDate: Date;

    @Column({ type: "time" })
    StartTime: string;

    @Column({ type: "time", nullable: true })
    EndTime?: string;

    @Column({ type: "int", nullable: true })
    Duration?: number;

    @Column({ type: "bit", default: 0 })
    IsTeleConsultation: boolean;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    MeetingUrl?: string;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    Location?: string;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    Reason?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    ChiefComplaint?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Notes?: string;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    CreatedBy?: string;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    UpdatedBy?: string;

    @Column({ type: "int", nullable: true })
    AppointmentNumber?: number;

    @OneToMany(() => PatientVerification, (verification) => verification.Appointment)
    Verifications: Relation<PatientVerification[]>;
}
