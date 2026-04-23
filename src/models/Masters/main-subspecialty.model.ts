import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from "typeorm";
import { MainSpecialty } from "./main-specialty.model.js";

@Entity({ name: "MainSubSpecialties" })
export class MainSubSpecialty {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int" })
    MainSpecialtyId: number;

    @ManyToOne(() => MainSpecialty)
    @JoinColumn({ name: "MainSpecialtyId" })
    MainSpecialty: MainSpecialty;

    @Column({ type: "varchar", length: 150 })
    Name: string;

    @Column({ type: "bit", default: true })
    Status: boolean;

    @Column({ type: "bit", default: false })
    IsDeleted: boolean;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;
}
