import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";

@Entity({ name: "Organizations" })
export class Organization {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "varchar", length: 50, nullable: true })
    OrgCode?: string;

    @Column({ type: "varchar", length: 100, nullable: true })
    OrganizationType?: string;

    @Column({ type: "varchar", length: 255 })
    Name: string;

    @Column({ type: "varchar", length: 256, nullable: true })
    Email?: string;

    @Column({ type: "varchar", length: 15, nullable: true })
    MobileNumber?: string;

    @Column({ type: "varchar", length: 500, nullable: true })
    Address?: string;

    @Column({ type: "bit", nullable: true })
    TermsAccepted?: boolean;

    @Column({ type: "bit", nullable: true })
    Status?: boolean;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;

    @Column({ type: "varchar", length: 255, nullable: true })
    Website?: string;
}
