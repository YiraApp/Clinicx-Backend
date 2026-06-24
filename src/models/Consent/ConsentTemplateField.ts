import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    JoinColumn,
    Relation
} from "typeorm/index.js";
import { ConsentTemplate } from "./consent-template.model.js";

@Entity({ name: "ConsentTemplateFields" })
export class ConsentTemplateField {

    @PrimaryGeneratedColumn()
    FieldId: number;

    @Column({ type: "int" })
    TemplateId: number;

    @ManyToOne(() => ConsentTemplate)
    @JoinColumn({ name: "TemplateId" })
    Template: Relation<ConsentTemplate>;

    @Column({ type: "int" })
    PageNumber: number;

    @Column({ type: "float" })
    X: number;

    @Column({ type: "float" })
    Y: number;

    @Column({ type: "float", default: 150 })
    Width: number;

    @Column({ type: "float", default: 50 })
    Height: number;

    @Column({ type: "nvarchar", length: 50 })
    FieldType: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    FieldKey?: string;

    @Column({ type: "bit", default: 1 })
    IsRequired: boolean;

    @Column({ type: "bit", default: 1 })
    Status: boolean;

    @Column({ type: "bit", default: 0 })
    IsDeleted: boolean;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    CreatedBy?: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    UpdatedBy?: string;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;
}