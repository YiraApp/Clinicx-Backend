import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/**
 * One HIU audit event: a consent or data-flow step, or a staff member viewing records. Ids,
 * statuses and outcomes only; never patient data, content, keys or ABHA addresses.
 */
@Entity({ name: "AbdmHiuAuditEvents" })
export class HiuAuditEvent {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "datetime2", precision: 3, default: () => "GETDATE()" })
    At: Date;

    @Column({ type: "int", nullable: true })
    HospitalId?: number | null;

    /** The staff member, for staff actions; null for ABDM's callbacks and the scheduler. */
    @Column({ type: "uniqueidentifier", nullable: true })
    StaffUserId?: string | null;

    /** One of HIU_AUDIT_EVENTS (services/Abdm/hiu/hiu-audit.ts). */
    @Column({ type: "varchar", length: 50 })
    Event: string;

    @Column({ type: "varchar", length: 64, nullable: true })
    ConsentRequestId?: string | null;

    @Column({ type: "varchar", length: 64, nullable: true })
    ArtefactId?: string | null;

    @Column({ type: "varchar", length: 64, nullable: true })
    TransactionId?: string | null;

    @Column({ type: "varchar", length: 64, nullable: true })
    RequestId?: string | null;

    @Column({ type: "varchar", length: 50 })
    Outcome: string;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    Detail?: string | null;
}
