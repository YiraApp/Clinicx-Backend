import { Entity, PrimaryColumn, Column } from "typeorm";

@Entity({ name: "Roles" })
export class Role {
    @PrimaryColumn("uniqueidentifier")
    Id: string;

    @Column({ type: "varchar", length: 100 })
    RoleName: string;

    @Column({ type: "varchar", length: 100 })
    NormalizedName: string;

    @Column({ type: "bit", default: true })
    Status: boolean;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;

    @Column({ type: "varchar", length: 50, nullable: true })
    CreatedBy?: string;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @Column({ type: "varchar", length: 50, nullable: true })
    UpdatedBy?: string;
}
