import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from "typeorm";
import { Hospital } from "./hospital.model.js";
import { MainSpecialty } from "../Masters/main-specialty.model.js";

@Entity({ name: "HospitalSpecialties" })
export class HospitalSpecialty {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int" })
    HospitalId: number;

    @ManyToOne(() => Hospital)
    @JoinColumn({ name: "HospitalId" })
    Hospital: Hospital;

    @Column({ type: "int", nullable: true })
    MainSpecialtyId?: number;

    @ManyToOne(() => MainSpecialty)
    @JoinColumn({ name: "MainSpecialtyId" })
    MainSpecialty?: MainSpecialty;

    @Column({ type: "varchar", length: 150 })
    Name: string;

    @Column({ type: "bit", default: true })
    Status: boolean;

    @Column({ type: "bit", default: false })
    IsDeleted: boolean;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;
}
