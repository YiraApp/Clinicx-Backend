import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/**
 * A patient's consent to create an ABHA from their Aadhaar (ABDM terms "abha-enrollment" v1.4),
 * recorded before the Aadhaar number is sent: who agreed, who confirmed it at the desk, and when.
 * No Aadhaar number is stored.
 */
@Entity({ name: "AbhaConsents" })
export class AbhaConsent {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "varchar", length: 50 })
    ConsentCode: string;

    @Column({ type: "varchar", length: 10 })
    ConsentVersion: string;

    /** JSON: the terms, each declaration and both confirmations, as ticked. */
    @Column({ type: "nvarchar", length: "MAX" })
    Declarations: string;

    /** The staff member signed in at the desk, who confirmed explaining the consent. */
    @Column({ type: "uniqueidentifier" })
    StaffUserId: string;

    @Column({ type: "nvarchar", length: 200, nullable: true })
    StaffName?: string | null;

    @Column({ type: "nvarchar", length: 200, nullable: true })
    BeneficiaryName?: string | null;

    @Column({ type: "int", nullable: true })
    HospitalId?: number | null;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number | null;

    /** ABDM transaction the consent was given for. */
    @Column({ type: "varchar", length: 64, nullable: true })
    TxnId?: string | null;

    @Column({ type: "varchar", length: 17, nullable: true })
    AbhaNumber?: string | null;

    /** The clinic patient record the ABHA was linked to. */
    @Column({ type: "uniqueidentifier", nullable: true })
    PatientUserId?: string | null;

    @Column({ type: "datetime" })
    AgreedAt: Date;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;
}
