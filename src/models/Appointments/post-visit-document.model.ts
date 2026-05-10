import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm/index.js";

@Entity({ name: "PostVisitDocuments" })
export class PostVisitDocument {
    @PrimaryGeneratedColumn({ type: "bigint" })
    Id: number;

    @Column({ type: "bigint" })
    AppointmentId: number;

    @Column({ type: "uniqueidentifier" })
    PatientId: string;

    @Column({ type: "uniqueidentifier", nullable: true })
    DoctorId?: string;

    @Column({ type: "bigint" })
    OrganizationId: number;

    @Column({ type: "bigint" })
    HospitalId: number;

    @Column({ type: "varchar", length: 50 })
    DocumentType: string;

    @Column({ type: "varchar", length: 255 })
    FileName: string;

    @Column({ type: "nvarchar", length: "MAX" })
    BlobUrl: string;

    @Column({ type: "bigint", nullable: true })
    FileSize?: number;

    @Column({ type: "varchar", length: 100, nullable: true })
    MimeType?: string;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    GeneratedAt: Date;

    @Column({ type: "bit", default: 0 })
    SentOnWhatsApp: boolean;

    @Column({ type: "bit", default: 0 })
    SentOnEmail: boolean;

    @Column({ type: "bit", default: 0 })
    SentOnSMS: boolean;

    @Column({ type: "datetime", nullable: true })
    WhatsAppSentAt?: Date;

    @Column({ type: "datetime", nullable: true })
    EmailSentAt?: Date;

    @Column({ type: "datetime", nullable: true })
    SmsSentAt?: Date;

    @Column({ type: "int", default: 0 })
    SmsSentCount: number;

    @Column({ type: "int", default: 0 })
    WhatsAppSentCount: number;

    @Column({ type: "int", default: 0 })
    EmailSentCount: number;

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

    @Column({ type: "bit", default: 0 })
    IsDeleted: boolean;

    @Column({ type: "varchar", length: 255, nullable: true })
    EmailSentTo?: string;

    @Column({ type: "varchar", length: 50, nullable: true })
    WhatsAppSentTo?: string;

    @Column({ type: "varchar", length: 50, nullable: true })
    SmsSentTo?: string;

    @Column({ type: "bit", default: 0 })
    ConsentForEmail: boolean;

    @Column({ type: "bit", default: 0 })
    ConsentForWhatsApp: boolean;

    @Column({ type: "bit", default: 0 })
    ConsentForSMS: boolean;

    @Column({ type: "datetime", nullable: true })
    SharedAt?: Date;

    @Column({ type: "varchar", length: 100, nullable: true })
    SharedBy?: string;

    @Column({ type: "bigint", nullable: true })
    ShareLinkId?: number;

    @Column({ type: "bit", default: 0 })
    IsPrimaryDocument: boolean;

    @Column({ type: "int", default: 0 })
    DownloadCount: number;

    @Column({ type: "datetime", nullable: true })
    LastDownloadedAt?: Date;
}
