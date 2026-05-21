import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { User } from "../Account/user.model.js";
import { Appointment } from "../Appointments/appointment.model.js";
import { AppointmentBill } from "./appointment-bill.model.js";

@Entity({ name: "Payments" })
export class Payment {
    @PrimaryColumn("uniqueidentifier")
    PaymentId: string;

    @Column({ type: "int", nullable: true })
    AppointmentId?: number | null;


    @ManyToOne(() => Appointment)
    @JoinColumn({ name: "AppointmentId" })
    Appointment?: Relation<Appointment> | null;

    @Column({ type: "uniqueidentifier", nullable: true })
    AppointmentBillId?: string | null;

    @ManyToOne(() => AppointmentBill)
    @JoinColumn({ name: "AppointmentBillId" })
    AppointmentBill?: Relation<AppointmentBill> | null;

    @Column({ type: "uniqueidentifier" })
    PatientId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "PatientId" })
    Patient?: Relation<User>;

    @Column({ type: "uniqueidentifier", nullable: true })
    ProviderId?: string | null;

    @ManyToOne(() => User)
    @JoinColumn({ name: "ProviderId" })
    Provider?: Relation<User> | null;

    @Column({ type: "uniqueidentifier", nullable: true })
    InvoiceId?: string | null;

    @Column({ type: "nvarchar", length: 100 })
    TransactionId: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    ReceiptNumber?: string | null;

    @Column({ type: "decimal", precision: 18, scale: 2 })
    Amount: number;

    @Column({ type: "varchar", length: 10, default: "INR" })
    Currency: string;

    @Column({ type: "varchar", length: 50, nullable: true })
    PaymentGateway?: string | null;

    @Column({ type: "varchar", length: 50, nullable: true })
    PaymentMethod?: string | null;

    @Column({ type: "nvarchar", length: 200, nullable: true })
    GatewayOrderId?: string | null;

    @Column({ type: "nvarchar", length: 200, nullable: true })
    GatewayPaymentId?: string | null;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    GatewaySignature?: string | null;

    @Column({ type: "varchar", length: 50, nullable: true })
    Status?: string | null;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    FailureReason?: string | null;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    GatewayResponse?: string | null;

    @Column({ type: "datetime", nullable: true })
    TransactionDate?: Date | null;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "uniqueidentifier", nullable: true })
    CreatedBy?: string | null;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date | null;

    @Column({ type: "uniqueidentifier", nullable: true })
    UpdatedBy?: string | null;

    @Column({ type: "bit", default: 0 })
    IsDeleted: boolean;
}
