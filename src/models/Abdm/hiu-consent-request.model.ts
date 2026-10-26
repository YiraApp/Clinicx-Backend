import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/**
 * One ABDM consent request ClinicX raised as a Health Information User (consent/request/init):
 * which patient, for what purpose, which record types and dates, and where it stands. Only staff
 * of [HospitalId] may read it. No clinical content is stored here.
 */
@Entity({ name: "AbdmHiuConsentRequests" })
export class HiuConsentRequest {
    @PrimaryGeneratedColumn()
    Id: number;

    /** Our REQUEST-ID on consent/request/init, stored before sending: on-init quotes it. */
    @Column({ type: "varchar", length: 64 })
    InitRequestId: string;

    /** ABDM's consent request id, from on-init. Null until then, or when the init was refused. */
    @Column({ type: "varchar", length: 64, nullable: true })
    ConsentRequestId?: string | null;

    /** Our REQUEST-ID on the latest consent/request/status: on-status quotes it. */
    @Column({ type: "varchar", length: 64, nullable: true })
    StatusRequestId?: string | null;

    @Column({ type: "int" })
    HospitalId: number;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number | null;

    /** The staff member who raised the request. */
    @Column({ type: "uniqueidentifier" })
    StaffUserId: string;

    @Column({ type: "nvarchar", length: 200, nullable: true })
    StaffName?: string | null;

    /** The clinic patient record the request is for. */
    @Column({ type: "uniqueidentifier" })
    PatientUserId: string;

    /** consent.patient.id, as sent. */
    @Column({ type: "varchar", length: 100 })
    AbhaAddress: string;

    /** CAREMGT, BTG, PUBHLTH, HPAYMT, DSRCH or PATRQT. */
    @Column({ type: "varchar", length: 10 })
    PurposeCode: string;

    /** JSON array of the HI types requested. */
    @Column({ type: "nvarchar", length: 400 })
    HiTypes: string;

    /** Requested permission.dateRange.from / to and dataEraseAt. What was granted is on each artefact. */
    @Column({ type: "datetime2", precision: 3 })
    DateFrom: Date;

    @Column({ type: "datetime2", precision: 3 })
    DateTo: Date;

    @Column({ type: "datetime2", precision: 3 })
    DataEraseAt: Date;

    /** VIEW, STORE, STREAM or QUERY. */
    @Column({ type: "varchar", length: 10 })
    AccessMode: string;

    /** SENDING, REQUESTED, GRANTED, PARTLY_REVOKED, DENIED, EXPIRED, REVOKED or FAILED. */
    @Column({ type: "varchar", length: 20 })
    Status: string;

    /** When [Status] last changed. */
    @Column({ type: "datetime2", precision: 3 })
    StatusAt: Date;

    /** ABDM's error code and message when it refused the request (FAILED). */
    @Column({ type: "varchar", length: 20, nullable: true })
    AbdmErrorCode?: string | null;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    AbdmError?: string | null;

    @Column({ type: "datetime2", precision: 3, default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime2", precision: 3, nullable: true })
    UpdatedAt?: Date | null;
}
