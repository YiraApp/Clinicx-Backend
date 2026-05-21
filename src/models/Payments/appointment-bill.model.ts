import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, Relation, OneToMany } from "typeorm/index.js";
import { User } from "../Account/user.model.js";
import { Hospital } from "../Organizations/hospital.model.js";
import { Appointment } from "../Appointments/appointment.model.js";
import { AppointmentBillItem } from "./appointment-bill-item.model.js";

@Entity({ name: "AppointmentBills" })
export class AppointmentBill {
    @PrimaryColumn("uniqueidentifier")
    AppointmentBillId: string;

    @Column({ type: "int", nullable: true })
    AppointmentId?: number | null;

    @ManyToOne(() => Appointment)
    @JoinColumn({ name: "AppointmentId" })
    Appointment?: Relation<Appointment> | null;

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

    @Column({ type: "int" })
    HospitalId: number;

    @ManyToOne(() => Hospital)
    @JoinColumn({ name: "HospitalId" })
    Hospital?: Relation<Hospital>;

    @Column({ type: "nvarchar", length: 50 })
    BillNumber: string;

    @Column({ type: "varchar", length: 50 })
    BillType: string;

    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    SubTotal: number;

    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    DiscountAmount: number;

    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    GstAmount: number;

    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    CgstAmount: number;

    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    SgstAmount: number;

    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    IgstAmount: number;

    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    TotalAmount: number;

    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    PaidAmount: number;

    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    DueAmount: number;

    @Column({ type: "varchar", length: 50 })
    BillStatus: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Notes?: string | null;

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

    @OneToMany(() => AppointmentBillItem, (item) => item.AppointmentBill)
    BillItems?: Relation<AppointmentBillItem[]>;
}
