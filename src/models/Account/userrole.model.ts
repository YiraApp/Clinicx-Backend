import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm";
import { User } from "./user.model.js";
import { Role } from "./role.model.js";
import { Organization } from "../Organizations/organization.model.js";
import { Hospital } from "../Organizations/hospital.model.js";

@Entity({ name: "UserRoles" })
export class UserRole {
    @PrimaryGeneratedColumn()
    UserRoleId: number;

    @Column("uniqueidentifier")
    UserId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "UserId" })
    User: Relation<User>;

    @Column("uniqueidentifier")
    RoleId: string;

    @ManyToOne(() => Role)
    @JoinColumn({ name: "RoleId" })
    Role: Role;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number;

    @ManyToOne(() => Organization)
    @JoinColumn({ name: "OrganizationId" })
    Organization?: Organization;

    @Column({ type: "int", nullable: true })
    HospitalId?: number;

    @ManyToOne(() => Hospital)
    @JoinColumn({ name: "HospitalId" })
    Hospital?: Hospital;

    @Column({ type: "bit", default: true })
    Status: boolean;

    @Column({ type: "bit", default: false })
    IsDeleted: boolean;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;

    @Column({ type: "varchar", length: 50, nullable: true })
    CreatedBy?: string;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @Column({ type: "varchar", length: 50, nullable: true })
    UpdatedBy?: string;
}
