import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/**
 * One health-information request under a granted artefact, and the transfer it opens: our
 * ephemeral key (sealed), the push token's hash, and the pages received. The private key is set
 * to NULL once the transfer ends or the key passes [KeyExpiresAt].
 */
@Entity({ name: "AbdmHiuDataRequests" })
export class HiuDataRequest {
    @PrimaryGeneratedColumn()
    Id: number;

    /** Our REQUEST-ID on health-information/request: on-request quotes it. */
    @Column({ type: "varchar", length: 64 })
    HiRequestId: string;

    /** ABDM's transaction id, from on-request. Null until then. */
    @Column({ type: "varchar", length: 64, nullable: true })
    TransactionId?: string | null;

    /** AbdmHiuConsentArtefacts.Id. */
    @Column({ type: "int" })
    ArtefactFk: number;

    @Column({ type: "int" })
    HospitalId: number;

    /** The date range asked for: always inside the grant. */
    @Column({ type: "datetime2", precision: 3 })
    DateFrom: Date;

    @Column({ type: "datetime2", precision: 3 })
    DateTo: Date;

    /** SHA-256 hex of the push token in our dataPushUrl. The token itself is never stored. */
    @Column({ type: "char", length: 64 })
    PushTokenHash: string;

    /** Our ephemeral private key, sealed at rest. Secret; NULL once the transfer ends. */
    @Column({ type: "varchar", length: 2000, nullable: true })
    PrivateKey?: string | null;

    /** Our keyMaterial.nonce. Never logged. */
    @Column({ type: "varchar", length: 100, nullable: true })
    Nonce?: string | null;

    /** keyMaterial.dhPublicKey.expiry. */
    @Column({ type: "datetime2", precision: 3 })
    KeyExpiresAt: Date;

    /** Pages arriving after this are refused, and an unfinished transfer is notified FAILED. */
    @Column({ type: "datetime2", precision: 3, nullable: true })
    TransferDeadline?: Date | null;

    /** REQUESTED, RECEIVING, RECEIVED or FAILED. */
    @Column({ type: "varchar", length: 20 })
    SessionStatus: string;

    @Column({ type: "int", nullable: true })
    PageCount?: number | null;

    @Column({ type: "int", default: 0 })
    PagesReceived: number;

    /** Entry content accepted so far (the pages taken for processing), capped per transfer. */
    @Column({ type: "bigint", default: 0 })
    BytesReceived: number;

    /**
     * JSON: each care context's hiStatus (OK / ERRORED) for health-information/notify. Seal it
     * (hiu-at-rest) when it carries care-context references.
     */
    @Column({ type: "varchar", length: "MAX", nullable: true })
    CareContextStatus?: string | null;

    @Column({ type: "datetime2", precision: 3, nullable: true })
    NotifiedAt?: Date | null;

    /** Our REQUEST-ID on health-information/notify. */
    @Column({ type: "varchar", length: 64, nullable: true })
    NotifyRequestId?: string | null;

    /** Why the transfer failed, for staff. No patient data. */
    @Column({ type: "nvarchar", length: 500, nullable: true })
    Error?: string | null;

    @Column({ type: "datetime2", precision: 3, default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime2", precision: 3, nullable: true })
    CompletedAt?: Date | null;
}
