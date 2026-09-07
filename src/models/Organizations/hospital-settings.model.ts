import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation, CreateDateColumn, UpdateDateColumn } from "typeorm/index.js";
import { Hospital } from "./hospital.model.js";
import { Organization } from "./organization.model.js";

@Entity({ name: "HospitalSettings" })
export class HospitalSetting {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int" })
    HospitalId: number;

    @ManyToOne(() => Hospital)
    @JoinColumn({ name: "HospitalId" })
    Hospital?: Relation<Hospital>;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number;

    @ManyToOne(() => Organization)
    @JoinColumn({ name: "OrganizationId" })
    Organization?: Relation<Organization>;

    // ── Hospital Settings (Slots & Payments) ──
    @Column({ type: "bit", default: false })
    AutoSlotGeneration: boolean;

    @Column({ type: "int", default: 30 })
    AdvanceDays: number; // e.g. 7, 14, 30, 60, 90

    @Column({ type: "bit", default: false })
    TakeBuffer: boolean; // Default: 0 (No buffer)

    @Column({ type: "int", default: 0 })
    BufferMinutes: number; // 0, 5, 10, 15, 20, 30

    @Column({ type: "bit", default: false })
    AutoSyncDaily: boolean;

    @Column({ type: "bit", default: false })
    OverwriteExisting: boolean;

    @Column({ type: "bit", default: false })
    OnlinePayments: boolean;

    @Column({ type: "bit", default: false })
    ConsultationFeeForPackages: boolean; // Consultation Fee for Packages

    // ── Profile Settings (4 Department Feature Flags) ──
    @Column({ type: "bit", default: false })
    HomeSample: boolean; // Home Sample Collection

    @Column({ type: "bit", default: false })
    DentalConsultation: boolean; // Dental Consultation

    @Column({ type: "bit", default: false })
    EyeCare: boolean; // Eye Care & Ophthalmology

    @Column({ type: "bit", default: false })
    NotifyTemplate: boolean; // Automated SMS & WhatsApp Notification Templates

    // ── Extensible Future Flags (JSON) ──
    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    AdditionalFlags?: string | null; // Stores future dynamic flags as JSON: { [flagKey: string]: any }

    @Column({ type: "int", default: 1 })
    Version: number; // Incrementing version number for change tracking

    // ── Audit & Lifecycle ──
    @Column({ type: "bit", default: true })
    IsActive: boolean;

    @Column({ type: "bit", default: false })
    IsDeleted: boolean;

    @CreateDateColumn({ type: "datetime" })
    CreatedAt: Date;

    @UpdateDateColumn({ type: "datetime" })
    UpdatedAt: Date;

    @Column({ type: "int", nullable: true })
    CreatedBy?: number | null;

    @Column({ type: "int", nullable: true })
    UpdatedBy?: number | null;

}
