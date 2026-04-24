import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";

@Entity({ name: "UserRegistrationLinks" })
export class UserRegistrationLink {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "uniqueidentifier", default: () => "newid()" })
    Token: string;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    Email?: string;

    @Column({ type: "int", nullable: true })
    UserId?: number;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    Role?: string;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number;

    @Column({ type: "int", nullable: true })
    HospitalId?: number;

    @Column({ type: "datetime" })
    ExpiryTime: Date;

    @Column({ type: "bit", default: false })
    IsUsed: boolean;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    CreatedBy?: string;

    @Column({ type: "nvarchar", length: 20, default: 'Email' })
    Type: string;

    @Column({ type: "nvarchar", length: 20, nullable: true })
    PhoneNumber?: string;

    @Column({ type: "nvarchar", length: 10, nullable: true })
    CountryCode?: string;
}
