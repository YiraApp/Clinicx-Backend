import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { User } from "../Account/user.model.js";
import { Appointment } from "./appointment.model.js";
import { Visit } from "./visit.model.js";

@Entity({ name: "MedicalRecords" })
export class MedicalRecord {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "uniqueidentifier" })
    PatientId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "PatientId" })
    Patient: Relation<User>;

    @Column({ type: "int", nullable: true })
    AppointmentId?: number;

    @ManyToOne(() => Appointment)
    @JoinColumn({ name: "AppointmentId" })
    Appointment?: Relation<Appointment>;

    @Column({ type: "int", nullable: true })
    VisitId?: number;

    @ManyToOne(() => Visit)
    @JoinColumn({ name: "VisitId" })
    Visit?: Relation<Visit>;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    RecordType?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    FileUrl?: string;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    CreatedBy?: string;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    UpdatedBy?: string;
}
