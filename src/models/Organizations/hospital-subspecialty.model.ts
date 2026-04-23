import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from "typeorm";
import { Hospital } from "./hospital.model.js";
import { MainSubSpecialty } from "../Masters/main-subspecialty.model.js";

@Entity({ name: "HospitalSubSpecialties" })
export class HospitalSubSpecialty {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int" })
    HospitalId: number;

    @ManyToOne(() => Hospital)
    @JoinColumn({ name: "HospitalId" })
    Hospital: Hospital;

    @Column({ type: "int", nullable: true })
    MainSubSpecialtyId?: number;

    @ManyToOne(() => MainSubSpecialty)
    @JoinColumn({ name: "MainSubSpecialtyId" })
    MainSubSpecialty?: MainSubSpecialty;

    @Column({ type: "varchar", length: 150 })
    Name: string;

    @Column({ type: "bit", default: true })
    Status: boolean;

    @Column({ type: "bit", default: false })
    IsDeleted: boolean;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;
}
