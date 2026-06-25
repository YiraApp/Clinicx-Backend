import { Entity, PrimaryColumn, Column, OneToMany, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { UserRole } from "./userrole.model.js";
import { Address } from "./address.model.js";

@Entity({ name: "Users" })
export class User {
    @PrimaryColumn("uniqueidentifier")
    Id: string;

    @Column({ type: "varchar", length: 256 })
    PhoneNumber: string;

    @Column({ type: "varchar", length: 256, nullable: true })
    Email?: string | null;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    PasswordHash?: string | null;

    @Column({ type: "varchar", length: 100, nullable: true })
    FirstName?: string | null;

    @Column({ type: "varchar", length: 100, nullable: true })
    LastName?: string | null;

    @Column({ type: "varchar", length: 10, nullable: true })
    Gender?: string | null;

    @Column({ type: "date", nullable: true })
    DateOfBirth?: string | null;

    @Column({ type: "varchar", length: 10, nullable: true })
    BloodGroup?: string | null;

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
    ParentUserId?: string | null;

    @Column({ type: "varchar", length: 50, nullable: true })
    Relation?: string | null;

    @Column({ type: "bit", default: false })
    IsPrimary: boolean;

    @Column({ type: "int", nullable: true })
    PermanentAddressId?: number;

    @ManyToOne(() => Address)
    @JoinColumn({ name: "PermanentAddressId" })
    PermanentAddress?: Address;

    @Column({ type: "int", nullable: true })
    TemporaryAddressId?: number;

    @ManyToOne(() => Address)
    @JoinColumn({ name: "TemporaryAddressId" })
    TemporaryAddress?: Address;

    @Column({ type: "datetime", nullable: true })
    LastLoginTime?: Date;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "varchar", length: 50, nullable: true })
    CreatedBy?: string | null;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date | null;

    @Column({ type: "varchar", length: 50, nullable: true })
    UpdatedBy?: string | null;

    @Column({ type: "bit", default: false })
    IsDeleted: boolean;

    @Column({ type: "varchar", length: "MAX", nullable: true })
    ImagePath?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    UserSignature?: string;

    @Column({ type: "decimal", precision: 5, scale: 2, nullable: true })
    Height?: number | null;

    @Column({ type: "decimal", precision: 5, scale: 2, nullable: true })
    Weight?: number | null;

    @Column({ type: "varchar", length: 10, nullable: true })
    CountryCode?: string | null;



    @Column({ type: "nvarchar", length: 200, nullable: true })
    EmergencyContactName?: string | null;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    EmergencyContactPhone?: string | null;

    @Column({ type: "int", nullable: true })
    RecentOrgId?: number | null;

    @Column({ type: "int", nullable: true })
    RecentHospitalId?: number | null;

    @Column({ type: "uniqueidentifier", nullable: true })
    RecentRoleId?: string | null;

    @OneToMany(() => UserRole, (userRole) => userRole.User)
    UserRoles: Relation<UserRole>[];

    @OneToMany("Appointment", "User")
    Appointments: any[];
}
