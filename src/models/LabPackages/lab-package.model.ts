import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/**
 * A lab test package the Yira admin sells through the patient app. Offered by the hospitals in
 * LabPackageHospitals; GST is added on top of Price (TotalAmount = Price + GstAmount).
 */
@Entity({ name: "LabPackages" })
export class LabPackage {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "nvarchar", length: 200 })
    Name: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Description?: string | null;

    /** JSON array of the test names in the package */
    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    TestsIncluded?: string | null;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    SampleType?: string | null;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    Preparation?: string | null;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    ReportTurnaround?: string | null;

    /** Original price before GST, shown struck through next to the offer price; optional */
    @Column({ type: "decimal", precision: 18, scale: 2, nullable: true })
    Mrp?: number | null;

    /** Offer price before GST */
    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    Price: number;

    @Column({ type: "decimal", precision: 5, scale: 2, default: 0 })
    GstPercentage: number;

    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    GstAmount: number;

    /** Price + GstAmount: what the patient pays */
    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    TotalAmount: number;

    @Column({ type: "bit", default: true })
    ShowInMobileApp: boolean;

    /**
     * "Why it is worth it": JSON array of { icon, title, description, value, valuePlus, highlight },
     * each card showing what that part of the package would cost if booked separately
     */
    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Benefits?: string | null;

    /** Comma-separated 6-digit pincodes the package is offered in; empty means every pincode */
    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Pincodes?: string | null;

    @Column({ type: "bit", default: true })
    IsActive: boolean;

    @Column({ type: "bit", default: false })
    IsDeleted: boolean;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "uniqueidentifier", nullable: true })
    CreatedBy?: string | null;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date | null;

    @Column({ type: "uniqueidentifier", nullable: true })
    UpdatedBy?: string | null;
}
