import { Entity, PrimaryColumn, Column } from "typeorm/index.js";

/** A Razorpay payment for a lab package order, kept apart from appointment payments. */
@Entity({ name: "LabPackagePayments" })
export class LabPackagePayment {
    @PrimaryColumn("uniqueidentifier")
    Id: string;

    @Column({ type: "uniqueidentifier" })
    LabPackageOrderId: string;

    @Column({ type: "int" })
    HospitalId: number;

    @Column({ type: "nvarchar", length: 100 })
    TransactionId: string;

    @Column({ type: "nvarchar", length: 200, nullable: true })
    GatewayOrderId?: string | null;

    @Column({ type: "nvarchar", length: 200, nullable: true })
    GatewayPaymentId?: string | null;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    GatewaySignature?: string | null;

    @Column({ type: "decimal", precision: 18, scale: 2 })
    Amount: number;

    @Column({ type: "varchar", length: 10, default: "INR" })
    Currency: string;

    @Column({ type: "varchar", length: 50, nullable: true })
    Method?: string | null;

    /** Pending, Success or Failed */
    @Column({ type: "varchar", length: 20, default: "Pending" })
    Status: string;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    FailureReason?: string | null;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date | null;
}
