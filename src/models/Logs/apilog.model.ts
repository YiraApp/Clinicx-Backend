import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

@Entity({ name: "APILogs" })
export class APILog {
    @PrimaryGeneratedColumn()
    LogId: number;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    Method?: string | null;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    Path?: string | null;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    QueryString?: string | null;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    RequestBody?: string | null;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Response?: string | null;

    @Column({ type: "int", nullable: true })
    ResponseStatusCode?: number | null;

    @Column({ type: "datetime", nullable: true })
    RequestedOn?: Date | null;

    @Column({ type: "datetime", nullable: true })
    UpdatedOn?: Date | null;

    @Column({ type: "int", nullable: true })
    ResponseTimeMs?: number | null;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    RequestHeaders?: string | null;

    // User & Role Context
    @Column({ type: "uniqueidentifier", nullable: true })
    UserId?: string | null;

    @Column({ type: "uniqueidentifier", nullable: true })
    RoleId?: string | null;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    RoleName?: string | null;

    // Organization Context
    @Column({ type: "int", nullable: true })
    OrgId?: number | null;

    @Column({ type: "int", nullable: true })
    HospitalId?: number | null;

    // Network & Device Info
    @Column({ type: "nvarchar", length: 50, nullable: true })
    IPAddress?: string | null;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    Location?: string | null;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    DeviceInfo?: string | null;

    // Audit Tracking
    @Column({ type: "nvarchar", length: 100, nullable: true })
    Action?: string | null;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    EntityId?: string | null;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    EntityType?: string | null;
}
