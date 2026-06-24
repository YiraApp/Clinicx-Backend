import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from "typeorm/index.js";
import { User } from "./user.model.js";

@Entity({ name: "PasswordResetTokens" })
export class PasswordResetToken {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "uniqueidentifier" })
    UserId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "UserId" })
    User: User;

    @Column({ type: "varchar", length: 500 })
    Token: string;

    @Column({ type: "datetime" })
    ExpiryTime: Date;

    @Column({ type: "bit", default: false })
    IsUsed: boolean;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UsedAt?: Date | null;
}
