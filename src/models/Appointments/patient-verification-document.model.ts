import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { Appointment } from "./appointment.model.js";

@Entity({ name: "PatientVerificationDocuments" })
export class PatientVerificationDocument {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int" })
    AppointmentId: number;

    @ManyToOne(() => Appointment)
    @JoinColumn({ name: "AppointmentId" })
    Appointment: Relation<Appointment>;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    DocumentType?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    FileUrl?: string;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    UploadedAt: Date;

    @Column({ type: "bit", default: 0 })
    Verified: boolean;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    CreatedBy?: string;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    UpdatedBy?: string;
}
