import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/**
 * A link a patient creates so a doctor who is not on Yira can read their
 * profile in a browser without logging in. Only a hash of the link's secret
 * is stored, so the database alone cannot be used to open a profile.
 */
@Entity({ name: "PatientProfileShareLinks" })
export class PatientProfileShareLink {
    @PrimaryGeneratedColumn()
    Id: number;

    /** Whose records the link shows. */
    @Column({ type: "uniqueidentifier" })
    PatientId: string;

    /** The account that created the link (the patient or a parent account). */
    @Column({ type: "uniqueidentifier" })
    CreatedByUserId: string;

    /** SHA-256 of the secret in the link, hex encoded. */
    @Column({ type: "varchar", length: 64 })
    TokenHash: string;

    /** Optional note, for example the doctor's name. */
    @Column({ type: "nvarchar", length: 120, nullable: true })
    Label?: string | null;

    @Column({ type: "datetime" })
    ExpiresAt: Date;

    @Column({ type: "datetime", nullable: true })
    RevokedAt?: Date | null;

    @Column({ type: "int", default: 0 })
    ViewCount: number;

    @Column({ type: "datetime", nullable: true })
    LastViewedAt?: Date | null;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;
}
