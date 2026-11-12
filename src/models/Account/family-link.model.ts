import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/**
 * A link between two people who each have their own Yira account (their own
 * phone). Unlike a dependent (Users.ParentUserId), a linked person keeps their
 * own login; once the link is ACCEPTED each can see and act for the other.
 *
 * Status: PENDING (a request waiting for the other person, until ExpiresAt),
 * ACCEPTED, DECLINED, CANCELLED (the sender withdrew it), REMOVED (either side
 * ended an accepted link) or EXPIRED.
 */
@Entity({ name: "FamilyLinks" })
export class FamilyLink {
    @PrimaryGeneratedColumn()
    Id: number;

    /** The account that asked for the link (always an account holder, never a dependent). */
    @Column({ type: "uniqueidentifier" })
    RequesterUserId: string;

    /** The account that was found by phone number. */
    @Column({ type: "uniqueidentifier" })
    TargetUserId: string;

    /** How the requester describes the target, e.g. "Father". */
    @Column({ type: "nvarchar", length: 50 })
    Relation: string;

    /** How the target describes the requester. Set when they accept, or inferred. */
    @Column({ type: "nvarchar", length: 50, nullable: true })
    TargetRelation?: string | null;

    @Column({ type: "varchar", length: 20 })
    Status: string;

    /** CODE (linked at once with the target's family code) or REQUEST (the target accepted). */
    @Column({ type: "varchar", length: 10 })
    Method: string;

    /** When a PENDING request lapses. */
    @Column({ type: "datetime", nullable: true })
    ExpiresAt?: Date | null;

    @Column({ type: "datetime", nullable: true })
    RespondedAt?: Date | null;

    @Column({ type: "datetime", nullable: true })
    LinkedAt?: Date | null;

    @Column({ type: "datetime", nullable: true })
    RemovedAt?: Date | null;

    @Column({ type: "uniqueidentifier", nullable: true })
    RemovedByUserId?: string | null;

    @Column({ type: "datetime" })
    CreatedAt: Date;

    @Column({ type: "datetime" })
    UpdatedAt: Date;
}

/**
 * A user's 4-digit family code, valid for a few minutes. The code is never
 * stored: it is derived from CodeSeed with a server-side secret, so the table
 * alone cannot be used to read or guess anyone's code.
 */
@Entity({ name: "FamilyCodes" })
export class FamilyCode {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "uniqueidentifier" })
    UserId: string;

    /** Random value the code is derived from (HMAC with the server secret). */
    @Column({ type: "varchar", length: 64 })
    CodeSeed: string;

    @Column({ type: "datetime" })
    ExpiresAt: Date;

    /** Set when the owner asks for a new code, or the code is locked after wrong tries. */
    @Column({ type: "datetime", nullable: true })
    RevokedAt?: Date | null;

    @Column({ type: "int", default: 0 })
    FailedAttempts: number;

    @Column({ type: "datetime" })
    CreatedAt: Date;
}

/**
 * One phone lookup or family-code try, kept to throttle guessing. LOOKUP rows
 * count every request that names a phone number; CODE rows count code tries.
 */
@Entity({ name: "FamilyLinkAttempts" })
export class FamilyLinkAttempt {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "uniqueidentifier" })
    RequesterUserId: string;

    @Column({ type: "uniqueidentifier", nullable: true })
    TargetUserId?: string | null;

    @Column({ type: "varchar", length: 10 })
    Kind: string;

    @Column({ type: "bit" })
    Success: boolean;

    @Column({ type: "datetime" })
    CreatedAt: Date;
}
