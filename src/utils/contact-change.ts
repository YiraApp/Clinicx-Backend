import { AppDataSource } from "../config/database.js";
import { User } from "../models/Account/user.model.js";
import { userRepository } from "../repositories/Account/user.repository.js";
import { isSameFamily } from "../middlewares/request-identity.js";
import { samePhoneNumber, toInternationalPhone } from "./phone-number.js";

/**
 * A phone number or email decides who can sign in and who is family. So only the signed-in account's
 * own login may change one, and never to one another family's account already uses.
 */
export async function assertContactChange(
    signedInId: string | null,
    user: User,
    next: { phone?: string | null; email?: string | null },
): Promise<void> {
    const email = String(next.email ?? "").trim();
    const phoneChanged = next.phone !== undefined
        && toInternationalPhone(next.phone, user.CountryCode) !== toInternationalPhone(user.PhoneNumber, user.CountryCode);
    const emailChanged = next.email !== undefined && email.toLowerCase() !== String(user.Email ?? "").trim().toLowerCase();
    if (!phoneChanged && !emailChanged) return;

    if (!signedInId || !(await isSameFamily(signedInId, user.Id))) {
        throw new Error("Only the account holder can change this phone number or email.");
    }
    if (phoneChanged && next.phone) {
        const wanted = { PhoneNumber: next.phone, CountryCode: user.CountryCode };
        for (const other of await userRepository.findAllByPhone(String(next.phone))) {
            if (samePhoneNumber(other, wanted) && !(await isSameFamily(user.Id, other.Id))) {
                throw new Error("This mobile number is already used by another account.");
            }
        }
    }
    if (emailChanged && email) {
        for (const other of await AppDataSource.getRepository(User).find({ where: { Email: email, IsDeleted: false } })) {
            if (!(await isSameFamily(user.Id, other.Id))) {
                throw new Error("This email address is already used by another account.");
            }
        }
    }
}
