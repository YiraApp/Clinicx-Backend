import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { Hospital } from "./hospital.model.js";

@Entity({ name: "HospitalPaymentConfigurations" })
export class HospitalPaymentConfiguration {
    @PrimaryColumn("uniqueidentifier")
    HospitalPaymentConfigurationId: string;

    @Column({ type: "int" })
    HospitalId: number;

    @ManyToOne(() => Hospital)
    @JoinColumn({ name: "HospitalId" })
    Hospital?: Relation<Hospital>;

    @Column({ type: "varchar", length: 50, nullable: true })
    PaymentGateway?: string | null;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    RazorpayKeyId?: string | null;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    RazorpayKeySecret?: string | null;

    @Column({ type: "decimal", precision: 5, scale: 2, default: 0 })
    GstPercentage: number;

    @Column({ type: "decimal", precision: 5, scale: 2, default: 0 })
    CgstPercentage: number;

    @Column({ type: "decimal", precision: 5, scale: 2, default: 0 })
    SgstPercentage: number;

    @Column({ type: "decimal", precision: 5, scale: 2, default: 0 })
    IgstPercentage: number;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    GstNumber?: string | null;

    @Column({ type: "nvarchar", length: 50, default: "INV" })
    InvoicePrefix: string;

    @Column({ type: "int", default: 1 })
    InvoiceSequence: number;

    @Column({ type: "varchar", length: 10, default: "INR" })
    CurrencyCode: string;

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
