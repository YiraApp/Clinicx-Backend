import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

@Entity({ name: "MainSpecialties" })
export class MainSpecialty {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "varchar", length: 150 })
    Name: string;

    @Column({ type: "bit", default: true })
    Status: boolean;

    @Column({ type: "bit", default: false })
    IsDeleted: boolean;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;
}
