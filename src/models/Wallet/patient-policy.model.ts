import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/**
 * An insurance policy or government health scheme the patient adds, shown in
 * My policies next to the insurance hospitals record at registration.
 */
@Entity({ name: "PatientPolicies" })
export class PatientPolicy {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "uniqueidentifier" })
    PatientId: string;

    @Column({ type: "uniqueidentifier" })
    CreatedByUserId: string;

    /** Health, Life, Accident, Critical illness, Government scheme, Other. */
    @Column({ type: "varchar", length: 40 })
    PolicyType: string;

    @Column({ type: "nvarchar", length: 200 })
    Insurer: string;

    @Column({ type: "nvarchar", length: 200, nullable: true })
    PolicyName?: string | null;

    @Column({ type: "nvarchar", length: 100 })
    PolicyNumber: string;

    /** Member or card ID printed on the health card, when different. */
    @Column({ type: "nvarchar", length: 100, nullable: true })
    MemberId?: string | null;

    @Column({ type: "decimal", precision: 18, scale: 2, nullable: true })
    SumInsured?: number | null;

    @Column({ type: "decimal", precision: 18, scale: 2, nullable: true })
    Premium?: number | null;

    @Column({ type: "date", nullable: true })
    StartDate?: string | null;

    @Column({ type: "date", nullable: true })
    EndDate?: string | null;

    @Column({ type: "nvarchar", length: 200, nullable: true })
    TpaName?: string | null;

    @Column({ type: "nvarchar", length: 40, nullable: true })
    HelplineNumber?: string | null;

    /** Who the policy covers, as the patient wrote it ("Self, spouse, 2 kids"). */
    @Column({ type: "nvarchar", length: 500, nullable: true })
    CoveredMembers?: string | null;

    @Column({ type: "nvarchar", length: 1000, nullable: true })
    Notes?: string | null;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    FileUrl?: string | null;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    FileName?: string | null;

    @Column({ type: "bit", default: false })
    IsDeleted: boolean;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date | null;
}
