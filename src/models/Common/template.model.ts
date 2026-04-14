import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

@Entity({ name: "Templates" })
export class Template {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "nvarchar", length: 100, unique: true })
    TemplateCode: string;

    @Column({ type: "nvarchar", length: 255 })
    Type: string;

    @Column({ type: "nvarchar", length: 255 })
    Category: string;

    @Column({ type: "nvarchar", length: 255 })
    Title: string;

    @Column({ type: "nvarchar", length: "max" })
    Message: string;

    @Column({ type: "bit" })
    Status: boolean;

    @CreateDateColumn({ type: "datetime", nullable: true, default: () => "getdate()" })
    CreatedAt: Date;

    @Column({ type: "nvarchar", length: 100 })
    CreatedBy: string;
}
