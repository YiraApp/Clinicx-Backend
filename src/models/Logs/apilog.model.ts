import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";

@Entity({ name: "APILogs" })
export class APILog {
    @PrimaryGeneratedColumn()
    LogId: number;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    Method?: string;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    Path?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    QueryString?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    RequestBody?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Response?: string;

    @Column({ type: "int", nullable: true })
    ResponseStatusCode?: number;

    @Column({ type: "datetime", nullable: true })
    RequestedOn?: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedOn?: Date;

    @Column({ type: "int", nullable: true })
    ResponseTimeMs?: number;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    RequestHeaders?: string;
}
