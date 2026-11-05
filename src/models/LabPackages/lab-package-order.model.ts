import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { User } from "../Account/user.model.js";
import { Hospital } from "../Organizations/hospital.model.js";

export const LAB_ORDER_STATUSES = ["PaymentPending", "Paid", "SampleCollected", "ReportReady", "Completed", "Cancelled"] as const;
export type LabOrderStatus = typeof LAB_ORDER_STATUSES[number];

/**
 * A patient's purchase of a lab package at one hospital. The package's name, tests, price and GST
 * are copied in, so later changes to the package do not alter the order.
 */
@Entity({ name: "LabPackageOrders" })
export class LabPackageOrder {
    @PrimaryColumn("uniqueidentifier")
    Id: string;

    @Column({ type: "nvarchar", length: 50 })
    OrderNumber: string;

    @Column({ type: "int" })
    LabPackageId: number;

    @Column({ type: "nvarchar", length: 200 })
    PackageName: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    TestsIncluded?: string | null;

    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    Price: number;

    @Column({ type: "decimal", precision: 5, scale: 2, default: 0 })
    GstPercentage: number;

    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    GstAmount: number;

    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    TotalAmount: number;

    @Column({ type: "uniqueidentifier" })
    PatientId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "PatientId" })
    Patient?: Relation<User>;

    @Column({ type: "int" })
    HospitalId: number;

    @ManyToOne(() => Hospital)
    @JoinColumn({ name: "HospitalId" })
    Hospital?: Relation<Hospital>;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number | null;

    @Column({ type: "varchar", length: 10, nullable: true })
    Pincode?: string | null;

    /** The visit date (India time); with SlotStart/SlotEnd it is the booked slot */
    @Column({ type: "date", nullable: true })
    PreferredDate?: string | null;

    /** "HH:mm" of the booked visit slot, from the hospital's slot timings */
    @Column({ type: "varchar", length: 5, nullable: true })
    SlotStart?: string | null;

    @Column({ type: "varchar", length: 5, nullable: true })
    SlotEnd?: string | null;

    @Column({ type: "datetime", nullable: true })
    SlotUpdatedAt?: Date | null;

    /** Times the patient moved the slot after first choosing it */
    @Column({ type: "int", default: 0 })
    RescheduleCount: number;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    Notes?: string | null;

    @Column({ type: "varchar", length: 30, default: "PaymentPending" })
    Status: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    ReportUrl?: string | null;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    ReportFileName?: string | null;

    @Column({ type: "datetime", nullable: true })
    ReportUploadedAt?: Date | null;

    @Column({ type: "uniqueidentifier", nullable: true })
    ReportUploadedBy?: string | null;

    /** The report's copy in the patient's documents (MedicalDocuments); replacing the report updates it */
    @Column({ type: "bigint", nullable: true })
    MedicalDocumentId?: number | string | null;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date | null;

    @Column({ type: "uniqueidentifier", nullable: true })
    UpdatedBy?: string | null;
}
