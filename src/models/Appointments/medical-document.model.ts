import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { Appointment } from "./appointment.model.js";
import { User } from "../Account/user.model.js";
import { Hospital } from "../Organizations/hospital.model.js";
import { Organization } from "../Organizations/organization.model.js";

import { Hospital } from "../Organizations/hospital.model.js";
import { Organization } from "../Organizations/organization.model.js";

@Entity({ name: "MedicalDocuments" })
export class MedicalDocument {
    @PrimaryGeneratedColumn({ type: "bigint" })
    Id: number;

    @Column({ type: "bigint", nullable: true })
    AppointmentId?: number;

    @ManyToOne(() => Appointment)
    @JoinColumn({ name: "AppointmentId" })
    Appointment?: Relation<Appointment>;

    @Column({ type: "uniqueidentifier" })
    PatientId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "PatientId" })
    Patient?: Relation<User>;

    @Column({ type: "uniqueidentifier", nullable: true })
    DoctorId?: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "DoctorId" })
    Doctor?: Relation<User>;

    @Column({ type: "bigint" })
    OrganizationId: number;

    @ManyToOne(() => Organization)
    @JoinColumn({ name: "OrganizationId" })
    Organization?: Relation<Organization>;

    @Column({ type: "bigint" })
    HospitalId: number;

    @ManyToOne(() => Hospital)
    @JoinColumn({ name: "HospitalId" })
    Hospital?: Relation<Hospital>;

    @Column({ type: "varchar", length: 100 })
    DocumentCategory: string;

    @Column({ type: "varchar", length: 100 })
    DocumentType: string;

    @Column({ type: "varchar", length: 255 })
    FileName: string;

    @Column({ type: "varchar", length: 255, nullable: true })
    OriginalFileName?: string;

    @Column({ type: "nvarchar", length: "MAX" })
    BlobUrl: string;

    @Column({ type: "varchar", length: 100, nullable: true })
    MimeType?: string;

    @Column({ type: "varchar", length: 20, nullable: true })
    FileExtension?: string;

    @Column({ type: "bigint", nullable: true })
    FileSize?: number;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Description?: string;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    Tags?: string;

    @Column({ type: "varchar", length: 50, nullable: true })
    UploadedSource?: string;

    @Column({ type: "uniqueidentifier", nullable: true })
    UploadedByUserId?: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "UploadedByUserId" })
    UploadedByUser?: Relation<User>;

    @Column({ type: "bit", default: false })
    IsPatientUploaded: boolean;

    @Column({ type: "bit", default: false })
    IsDoctorUploaded: boolean;

    @Column({ type: "bit", default: false })
    IsSystemGenerated: boolean;

    @Column({ type: "bit", default: false })
    IsConfidential: boolean;

    @Column({ type: "bit", default: true })
    IsShareable: boolean;

    @Column({ type: "varchar", length: 50, default: "ACTIVE" })
    Status: string;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "varchar", length: 100, nullable: true })
    CreatedBy?: string;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @Column({ type: "varchar", length: 100, nullable: true })
    UpdatedBy?: string;

    @Column({ type: "bit", default: false })
    IsDeleted: boolean;
}
