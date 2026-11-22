import { AppDataSource } from "../config/database.js";
import { User } from "../models/Account/user.model.js";
import { samePhoneNumber } from "./phone-number.js";

type PhoneOwner = Pick<User, "PhoneNumber" | "CountryCode">;

/** The primary account on exactly this number, country included. */
export async function findPrimaryOnSameNumber(user: PhoneOwner): Promise<User | null> {
    if (!user.PhoneNumber) return null; // an empty condition would match any primary account
    const rows = await AppDataSource.getRepository(User).find({
        where: { PhoneNumber: user.PhoneNumber, IsPrimary: true, IsDeleted: false },
    });
    return rows.find((row) => samePhoneNumber(row, user)) ?? null;
}

/** True when [other] belongs in [user]'s profile list: linked by parent, or on the same number in the same country. */
export function isRelatedAccount(user: User, other: User): boolean {
    const id = (value?: string | null) => String(value ?? "").toUpperCase();
    const root = id(user.ParentUserId || user.Id);
    return [id(user.Id), root].includes(id(other.Id))
        || [id(user.Id), root].includes(id(other.ParentUserId))
        || samePhoneNumber(user, other);
}
