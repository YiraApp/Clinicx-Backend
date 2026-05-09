import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { Appointment } from "./appointment.model.js";
import { Visit } from "./visit.model.js";
import { User } from "../Account/user.model.js";

@Entity({ name: "PatientClinicalNotes" })
export class ClinicalNote {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int", nullable: true })
    AppointmentId?: number;

    @ManyToOne(() => Appointment)
    @JoinColumn({ name: "AppointmentId" })
    Appointment?: Relation<Appointment>;

    @Column({ type: "uniqueidentifier", nullable: true })
    DoctorId?: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "DoctorId" })
    Doctor?: Relation<User>;

    @Column({ type: "uniqueidentifier" })
    PatientId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "PatientId" })
    Patient: Relation<User>;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Notes?: string;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number;

    @Column({ type: "int", nullable: true })
    HospitalId?: number;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    CreatedBy?: string;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    UpdatedBy?: string;
}
