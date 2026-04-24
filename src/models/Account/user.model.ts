import { Entity, PrimaryColumn, Column, OneToMany } from "typeorm";
import { UserRole } from "./userrole.model.js";

@Entity({ name: "Users" })
export class User {
    @PrimaryColumn("uniqueidentifier")
    Id: string;

    @Column({ type: "varchar", length: 256 })
    PhoneNumber: string;

    @Column({ type: "varchar", length: 256, nullable: true })
    Email?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    PasswordHash?: string;

    @Column({ type: "varchar", length: 100, nullable: true })
    FirstName?: string;

    @Column({ type: "varchar", length: 100, nullable: true })
    LastName?: string;

    @Column({ type: "varchar", length: 10, nullable: true })
    Gender?: string;

    @Column({ type: "date", nullable: true })
    DateOfBirth?: string;

    @Column({ type: "varchar", length: 10, nullable: true })
    BloodGroup?: string;

    @Column({ type: "varchar", length: 255, nullable: true })
    AadharNo?: string;

    @Column({ type: "varchar", length: 15, nullable: true })
    AlternatePhoneNumber?: string;

    @Column({ type: "bit", default: 0 })
    IsMobileVerified: boolean;

    @Column({ type: "bit", default: 0 })
    IsEmailVerified: boolean;

    @Column({ type: "bit", default: true })
    Status: boolean;

    @Column({ type: "uniqueidentifier", nullable: true })
    ParentUserId?: string;

    @Column({ type: "varchar", length: 50, nullable: true })
    Relation?: string;

    @Column({ type: "bit", default: false })
    IsPrimary: boolean;

    @Column({ type: "int", nullable: true })
    PermanentAddressId?: number;

    @Column({ type: "int", nullable: true })
    TemporaryAddressId?: number;

    @Column({ type: "datetime", nullable: true })
    LastLoginTime?: Date;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;

    @Column({ type: "varchar", length: 50, nullable: true })
    CreatedBy?: string;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @Column({ type: "varchar", length: 50, nullable: true })
    UpdatedBy?: string;

    @Column({ type: "bit", default: false })
    IsDeleted: boolean;

    @Column({ type: "varchar", length: "MAX", nullable: true })
    ImagePath?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    UserSignature?: string;

    @Column({ type: "decimal", precision: 5, scale: 2, nullable: true })
    Height?: number;

    @Column({ type: "decimal", precision: 5, scale: 2, nullable: true })
    Weight?: number;

    @Column({ type: "varchar", length: 10, nullable: true })
    CountryCode?: string;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    Address?: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    City?: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    State?: string;

    @Column({ type: "varchar", length: 10, nullable: true })
    Pincode?: string;

    @Column({ type: "nvarchar", length: 200, nullable: true })
    EmergencyContactName?: string;

    @Column({ type: "varchar", length: 15, nullable: true })
    EmergencyContactPhone?: string;

    @OneToMany(() => UserRole, (userRole) => userRole.User)
    UserRoles: UserRole[];
}
