import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/**
 * One consent artefact a granted consent request produced (one per HIP). Every artefact id ABDM
 * notifies is stored; the granted terms arrive with on-fetch and may differ from those requested.
 * Carries [HospitalId] so staff reads need no join.
 */
@Entity({ name: "AbdmHiuConsentArtefacts" })
export class HiuConsentArtefact {
    @PrimaryGeneratedColumn()
    Id: number;

    /** ABDM's consent artefact id. */
    @Column({ type: "varchar", length: 64 })
    ConsentArtefactId: string;

    /** AbdmHiuConsentRequests.Id. */
    @Column({ type: "int" })
    ConsentRequestFk: number;

    @Column({ type: "int" })
    HospitalId: number;

    @Column({ type: "varchar", length: 50, nullable: true })
    HipId?: string | null;

    @Column({ type: "nvarchar", length: 200, nullable: true })
    HipName?: string | null;

    /** GRANTED, REVOKED, EXPIRED or DENIED. */
    @Column({ type: "varchar", length: 20 })
    Status: string;

    @Column({ type: "datetime2", precision: 3 })
    StatusAt: Date;

    /** Granted terms, from on-fetch; null until then. HiTypes is a JSON array. */
    @Column({ type: "nvarchar", length: 400, nullable: true })
    HiTypes?: string | null;

    @Column({ type: "datetime2", precision: 3, nullable: true })
    DateFrom?: Date | null;

    @Column({ type: "datetime2", precision: 3, nullable: true })
    DateTo?: Date | null;

    @Column({ type: "datetime2", precision: 3, nullable: true })
    DataEraseAt?: Date | null;

    @Column({ type: "varchar", length: 10, nullable: true })
    AccessMode?: string | null;

    /** permission.frequency as granted, JSON ({ unit, value, repeats }). */
    @Column({ type: "nvarchar", length: 200, nullable: true })
    Frequency?: string | null;

    /** The granted care contexts as JSON, sealed at rest (hiu-at-rest seal()). */
    @Column({ type: "varchar", length: "MAX", nullable: true })
    CareContexts?: string | null;

    /** The artefact's signature from on-fetch. */
    @Column({ type: "varchar", length: "MAX", nullable: true })
    Signature?: string | null;

    /** Our REQUEST-ID on consent/fetch: on-fetch quotes it. */
    @Column({ type: "varchar", length: 64, nullable: true })
    FetchRequestId?: string | null;

    @Column({ type: "datetime2", precision: 3, nullable: true })
    FetchedAt?: Date | null;

    /** consent/fetch calls made for this artefact (the notify's and the sweep's retries), so retries stop. */
    @Column({ type: "int", default: 0 })
    FetchAttempts: number;

    /** When the records received under this artefact were deleted (dataEraseAt, revoke or lapse). */
    @Column({ type: "datetime2", precision: 3, nullable: true })
    RecordsPurgedAt?: Date | null;

    @Column({ type: "datetime2", precision: 3, default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime2", precision: 3, nullable: true })
    UpdatedAt?: Date | null;
}
