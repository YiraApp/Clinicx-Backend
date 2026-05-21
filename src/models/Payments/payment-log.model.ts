import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { Payment } from "./payment.model.js";

@Entity({ name: "PaymentLogs" })
export class PaymentLog {
    @PrimaryColumn("uniqueidentifier")
    PaymentLogId: string;

    @Column({ type: "uniqueidentifier" })
    PaymentId: string;

    @ManyToOne(() => Payment)
    @JoinColumn({ name: "PaymentId" })
    Payment?: Relation<Payment>;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    TransactionId?: string | null;

    @Column({ type: "varchar", length: 100 })
    EventType: string;

    @Column({ type: "varchar", length: 50, nullable: true })
    Status?: string | null;

    @Column({ type: "nvarchar", length: 1000, nullable: true })
    Message?: string | null;

    @Column({ type: "nvarchar", length: 200, nullable: true })
    GatewayPaymentId?: string | null;

    @Column({ type: "nvarchar", length: 200, nullable: true })
    GatewayOrderId?: string | null;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    LoggedAt: Date;

    @Column({ type: "uniqueidentifier", nullable: true })
    CreatedBy?: string | null;
}
