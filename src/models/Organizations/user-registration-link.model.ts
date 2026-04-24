import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";

@Entity({ name: "UserRegistrationLinks" })
export class UserRegistrationLink {
    @PrimaryGeneratedColumn()
    Id!: number;

    @Column({ type: "uniqueidentifier", default: () => "NEWID()" })
    Token!: string;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    Email?: string | null;

    @Column({ type: "int", nullable: true })
    UserId?: number | null;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    Role?: string | null;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number | null;

    @Column({ type: "int", nullable: true })
    HospitalId?: number | null;

    @Column({ type: "datetime" })
    ExpiryTime!: Date;

    @Column({ type: "bit", default: () => "0" })
    IsUsed!: boolean;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt!: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    CreatedBy?: string | null;

    @Column({ type: "nvarchar", length: 20, default: "Email" })
    Type!: "Email" | "SMS" | "WhatsApp";

    @Column({ type: "nvarchar", length: 20, nullable: true })
    PhoneNumber?: string | null;

    @Column({ type: "nvarchar", length: 10, nullable: true })
    CountryCode?: string | null;
}
