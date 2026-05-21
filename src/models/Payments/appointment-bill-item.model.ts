import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { AppointmentBill } from "./appointment-bill.model.js";

@Entity({ name: "AppointmentBillItems" })
export class AppointmentBillItem {
    @PrimaryColumn("uniqueidentifier")
    AppointmentBillItemId: string;

    @Column({ type: "uniqueidentifier" })
    AppointmentBillId: string;

    @ManyToOne(() => AppointmentBill, (bill) => bill.BillItems)
    @JoinColumn({ name: "AppointmentBillId" })
    AppointmentBill?: Relation<AppointmentBill>;

    @Column({ type: "varchar", length: 50 })
    ItemType: string;

    @Column({ type: "uniqueidentifier", nullable: true })
    ItemReferenceId?: string | null;

    @Column({ type: "nvarchar", length: 255 })
    ItemName: string;

    @Column({ type: "decimal", precision: 18, scale: 2, default: 1 })
    Quantity: number;

    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    UnitPrice: number;

    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    DiscountAmount: number;

    @Column({ type: "decimal", precision: 5, scale: 2, default: 0 })
    GstPercentage: number;

    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    GstAmount: number;

    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    TotalAmount: number;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;
}
