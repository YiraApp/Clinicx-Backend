import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

@Entity({ name: "Feedbacks" })
export class Feedback {
    @PrimaryGeneratedColumn()
    Id!: number;

    @Column({ type: "uniqueidentifier", nullable: true })
    UserId?: string | null;

    @Column({ type: "nvarchar", length: 150 })
    Name!: string;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    Phone?: string | null;

    @Column({ type: "nvarchar", length: 150, nullable: true })
    Email?: string | null;

    @Column({ type: "int" })
    Rating!: number;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    Category?: string | null;

    @Column({ type: "nvarchar", length: "max" })
    Message!: string;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number | null;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    OrganizationName?: string | null;

    @Column({ type: "int", nullable: true })
    HospitalId?: number | null;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    HospitalName?: string | null;

    @Column({ type: "varchar", length: 50, default: "Public" })
    Source!: string;

    @Column({ type: "varchar", length: 50, default: "New" })
    Status!: string;

    @Column({ type: "nvarchar", length: "max", nullable: true })
    AdminNotes?: string | null;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt!: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date | null;
}
