import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from "typeorm";
import { Hospital } from "./hospital.model.js";
import { MainDepartment } from "../Masters/main-department.model.js";

@Entity({ name: "HospitalDepartments" })
export class HospitalDepartment {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int" })
    HospitalId: number;

    @ManyToOne(() => Hospital)
    @JoinColumn({ name: "HospitalId" })
    Hospital: Hospital;

    @Column({ type: "int", nullable: true })
    MainDepartmentId?: number;

    @ManyToOne(() => MainDepartment)
    @JoinColumn({ name: "MainDepartmentId" })
    MainDepartment?: MainDepartment;

    @Column({ type: "varchar", length: 150 })
    Name: string;

    @Column({ type: "bit", default: true })
    Status: boolean;

    @Column({ type: "bit", default: false })
    IsDeleted: boolean;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;
}
