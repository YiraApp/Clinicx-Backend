import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { Appointment } from "./appointment.model.js";
import { ConsentTemplate } from "../Consent/consent-template.model.js";

@Entity({ name: "PatientConsents" })
export class PatientConsent {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int" })
    AppointmentId: number;

    @ManyToOne(() => Appointment)
    @JoinColumn({ name: "AppointmentId" })
    Appointment: Relation<Appointment>;

    @Column({ type: "int" })
    TemplateId: number;

    @ManyToOne(() => ConsentTemplate)
    @JoinColumn({ name: "TemplateId" })
    Template: Relation<ConsentTemplate>;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    Status?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    PdfUrl?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    SignedPdfUrl?: string;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    SentVia?: string;

    @Column({ type: "datetime", nullable: true })
    SentAt?: Date;

    @Column({ type: "datetime", nullable: true })
    SignedAt?: Date;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    CreatedBy?: string;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    UpdatedBy?: string;
}
