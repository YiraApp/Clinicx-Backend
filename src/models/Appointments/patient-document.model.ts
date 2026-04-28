import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { Appointment } from "./appointment.model.js";
import { Visit } from "./visit.model.js";

@Entity({ name: "PatientDocuments" })
export class PatientDocument {
    @PrimaryGeneratedColumn()
    Id: number;

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
    DocumentType?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    FileUrl?: string;

    @Column({ type: "bit", default: 0 })
    SentToPatient: boolean;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    SentVia?: string;

    @Column({ type: "datetime", nullable: true })
    SentAt?: Date;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    CreatedBy?: string;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    UpdatedBy?: string;
}
