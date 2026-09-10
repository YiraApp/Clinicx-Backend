import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
} from "typeorm";

@Entity("PushCampaigns")
export class PushCampaign {
    @PrimaryGeneratedColumn()
    Id!: number;

    @Column({ type: "nvarchar", length: 255 })
    Title!: string;

    @Column({ type: "nvarchar", length: "max" })
    Body!: string;

    @Column({ type: "nvarchar", length: 1000, nullable: true })
    ImageUrl?: string | null;

    @Column({ type: "bit", default: false })
    HasImage!: boolean;

    @Column({ type: "varchar", length: 50, default: "now" })
    ScheduleType!: string; // 'now' | 'scheduled' | 'recurring'

    @Column({ type: "date", nullable: true })
    ScheduledDate?: Date | null;

    @Column({ type: "varchar", length: 10, nullable: true })
    ScheduledTime?: string | null; // 'HH:mm'

    @Column({ type: "varchar", length: 50, nullable: true })
    RecurringPattern?: string | null; // 'daily' | 'weekly' | 'weekdays' | 'weekends'

    @Column({ type: "varchar", length: 50, nullable: true })
    RecurringDays?: string | null; // e.g. '1,3,5'

    @Column({ type: "varchar", length: 50, default: "in_app" })
    RedirectionType!: string; // 'in_app' | 'browser'

    @Column({ type: "nvarchar", length: 1000, nullable: true })
    RedirectionUrl?: string | null;

    @Column({ type: "varchar", length: 255, nullable: true, default: "/patientDashboard" })
    InAppRoute?: string | null;

    @Column({ type: "nvarchar", length: "max", nullable: true })
    InAppParams?: string | null;

    @Column({ type: "bit", default: true })
    IsAllOrganizations!: boolean;

    @Column({ type: "nvarchar", length: "max", nullable: true })
    TargetOrganizationIds?: string | null;

    @Column({ type: "varchar", length: 50, default: "GENERAL" })
    NotificationCategory!: string; // 'GENERAL' | 'HEALTH_TIP' | 'OFFER' | 'REMINDER' | 'ALERT'

    @Column({ type: "varchar", length: 50, default: "ACTIVE" })
    Status!: string; // 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'SENT' | 'COMPLETED'

    @Column({ type: "bit", default: true })
    IsActive!: boolean;

    @Column({ type: "int", default: 0 })
    TotalSentCount!: number;

    @Column({ type: "datetime", nullable: true })
    LastSentAt?: Date | null;

    @CreateDateColumn({ type: "datetime" })
    CreatedAt!: Date;

    @UpdateDateColumn({ type: "datetime", nullable: true })
    UpdatedAt?: Date | null;
}
