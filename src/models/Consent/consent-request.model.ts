import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from "typeorm/index.js";
import { User } from "../Account/user.model.js";
import { ConsentTemplate } from "./consent-template.model.js";
import { Hospital } from "../Organizations/hospital.model.js";
import { Organization } from "../Organizations/organization.model.js";

@Entity({ name: "ConsentRequests" })
export class ConsentRequest {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "uniqueidentifier" })
    PatientId: string; // User UUID

    @Column({ type: "int", nullable: true })
    AppointmentId?: number;

    @ManyToOne(() => User)
    @JoinColumn({ name: "PatientId" })
    Patient: User;

    @Column({ type: "int" })
    TemplateId: number;

    @ManyToOne(() => ConsentTemplate)
    @JoinColumn({ name: "TemplateId" })
    Template: ConsentTemplate;

    @Column({ type: "int" })
    HospitalId: number;

    @ManyToOne(() => Hospital)
    @JoinColumn({ name: "HospitalId" })
    Hospital: Hospital;

    @Column({ type: "int" })
    OrganizationId: number;

    @ManyToOne(() => Organization)
    @JoinColumn({ name: "OrganizationId" })
    Organization: Organization;

    @Column({ type: "nvarchar", length: 50, default: "Pending" })
    Status: string; // Pending, Signed, Rejected

    @Column({ type: "uniqueidentifier", default: () => "NEWID()" })
    RequestLink: string;

    @Column({ type: "nvarchar", length: "max", nullable: true })
    Signature?: string; // Base64 signature

    @Column({ type: "nvarchar", length: 100, nullable: true })
    IpAddress?: string;

    @Column({ type: "nvarchar", length: "max", nullable: true })
    SignedPdfUrl?: string;

    @Column({ type: "nvarchar", length: "max", nullable: true })
    SignatureImageUrl?: string;

    @Column({ type: "datetime", nullable: true })
    SignedAt?: Date;

    @Column({ type: "datetime", nullable: true })
    ExpiresAt?: Date;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;
}
