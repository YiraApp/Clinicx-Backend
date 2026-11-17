import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/**
 * A bill the patient adds themselves (pharmacy, lab, another hospital), shown
 * in My billing next to the bills Yira hospitals raise.
 */
@Entity({ name: "PatientManualBills" })
export class PatientManualBill {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "uniqueidentifier" })
    PatientId: string;

    /** The account that added it (the patient or a parent account). */
    @Column({ type: "uniqueidentifier" })
    CreatedByUserId: string;

    @Column({ type: "nvarchar", length: 150 })
    Title: string;

    /** Hospital, pharmacy or lab that issued the bill. */
    @Column({ type: "nvarchar", length: 200, nullable: true })
    ProviderName?: string | null;

    /** Consultation, Pharmacy, Lab tests, Hospital stay, Procedure, Other. */
    @Column({ type: "varchar", length: 40 })
    Category: string;

    @Column({ type: "date" })
    BillDate: string;

    @Column({ type: "nvarchar", length: 80, nullable: true })
    BillNumber?: string | null;

    @Column({ type: "decimal", precision: 18, scale: 2 })
    TotalAmount: number;

    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    PaidAmount: number;

    @Column({ type: "varchar", length: 40, nullable: true })
    PaymentMode?: string | null;

    @Column({ type: "nvarchar", length: 1000, nullable: true })
    Notes?: string | null;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    FileUrl?: string | null;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    FileName?: string | null;

    @Column({ type: "bit", default: false })
    IsDeleted: boolean;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date | null;
}
