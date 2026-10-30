import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/**
 * One decrypted entry of a data push, sealed at rest until [DeleteAt] (the artefact's
 * dataEraseAt), and deleted at once when its artefact is revoked or lapses. Unique on
 * (DataRequestFk, PageNumber, EntryIndex), so a repeated page stores nothing twice.
 */
@Entity({ name: "AbdmHiuRecords" })
export class HiuRecord {
    @PrimaryGeneratedColumn()
    Id: number;

    /** AbdmHiuDataRequests.Id. */
    @Column({ type: "int" })
    DataRequestFk: number;

    /** AbdmHiuConsentArtefacts.Id. */
    @Column({ type: "int" })
    ArtefactFk: number;

    @Column({ type: "int" })
    HospitalId: number;

    @Column({ type: "int" })
    PageNumber: number;

    /** The entry's position in its page's entries array. */
    @Column({ type: "int" })
    EntryIndex: number;

    /** Sealed at rest. */
    @Column({ type: "varchar", length: 1000, nullable: true })
    CareContextReference?: string | null;

    @Column({ type: "varchar", length: 100, nullable: true })
    Media?: string | null;

    /** The entry's MD5 checksum matched what was decrypted. */
    @Column({ type: "bit", default: false })
    ChecksumOk: boolean;

    /**
     * The decrypted entry (a FHIR bundle), sealed at rest: ASCII, so VARCHAR (half NVARCHAR's size; a
     * table made as NVARCHAR is converted by run-hiu-content-migration.ts). Null for an entry that failed.
     */
    @Column({ type: "varchar", length: "MAX", nullable: true })
    Content?: string | null;

    @Column({ type: "datetime2", precision: 3, nullable: true })
    DeleteAt?: Date | null;

    @Column({ type: "datetime2", precision: 3, default: () => "GETDATE()" })
    ReceivedAt: Date;
}
