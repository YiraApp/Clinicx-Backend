import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/**
 * One ABDM Scan and Share: a patient scanned a counter's QR code in their ABHA app and shared
 * their profile. Each row is also that counter's queue entry, with the token sent back to the app.
 */
@Entity({ name: "AbhaProfileShares" })
export class AbhaProfileShare {
    @PrimaryGeneratedColumn()
    Id: number;

    /** REQUEST-ID of ABDM's share call: the on-share reply quotes it, and a retried share is ignored. */
    @Column({ type: "varchar", length: 64 })
    RequestId: string;

    @Column({ type: "varchar", length: 50 })
    HipId: string;

    /** The counter id printed in the QR code (metaData.context). */
    @Column({ type: "varchar", length: 20 })
    CounterId: string;

    @Column({ type: "varchar", length: 17, nullable: true })
    AbhaNumber?: string | null;

    @Column({ type: "varchar", length: 100 })
    AbhaAddress: string;

    @Column({ type: "nvarchar", length: 200, nullable: true })
    PatientName?: string | null;

    /** The clinic patient record the share was registered against. */
    @Column({ type: "uniqueidentifier", nullable: true })
    UserId?: string | null;

    @Column({ type: "int", nullable: true })
    HospitalId?: number | null;

    @Column({ type: "varchar", length: 20, nullable: true })
    TokenNumber?: string | null;

    @Column({ type: "datetime", nullable: true })
    ExpiresAt?: Date | null;

    /** RECEIVED, REGISTERED, REVIEW (an uncertain match the desk resolves), ACKNOWLEDGED or FAILED. */
    @Column({ type: "varchar", length: 20 })
    Status: string;

    /** NEW, ABHA_NUMBER, DEMOGRAPHIC or AMBIGUOUS. */
    @Column({ type: "varchar", length: 20, nullable: true })
    MatchType?: string | null;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    Error?: string | null;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date | null;
}
