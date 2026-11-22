/**
 * A phone number in the international form WhatsApp and SMS gateways need: country code then the
 * number, digits only (e.g. 919876543210, 61449679321).
 *
 * Users.PhoneNumber holds the national number and Users.CountryCode the code, but numbers are not
 * all 10 digits: an Australian mobile is 9 (449679321), and some are saved with their trunk 0
 * (0551234567 in the UAE) or with the code already in front. Adding the code only to 10-digit
 * numbers sent every other country's numbers out without one.
 */
export function toInternationalPhone(phone: string | null | undefined, countryCode?: string | null): string {
    const raw = String(phone ?? "").trim();
    let digits = raw.replace(/\D/g, "");
    if (!digits) return "";
    // Written in international form already: +61 449 679 321 or 0061449679321.
    if (raw.startsWith("+")) return digits;
    if (raw.startsWith("00")) return digits.replace(/^00/, "");

    const code = String(countryCode ?? "").replace(/\D/g, "") || "91";
    digits = digits.replace(/^0+/, "");
    // Code already in front (919876543210, 61449679321). National numbers are at most 10 digits here,
    // so a 10-digit Indian number that happens to start with 91 still gets its code.
    if (digits.length > 10 && digits.startsWith(code)) return digits;
    return `${code}${digits}`;
}

/** A stored number: Users.PhoneNumber with Users.CountryCode. */
interface StoredPhone {
    PhoneNumber?: string | null;
    CountryCode?: string | null;
}

/** True when two stored numbers are one number: the same digits in the same country. */
export function samePhoneNumber(a: StoredPhone, b: StoredPhone): boolean {
    const number = toInternationalPhone(a.PhoneNumber, a.CountryCode);
    return !!number && number === toInternationalPhone(b.PhoneNumber, b.CountryCode);
}

/**
 * True when a stored number is the one typed. A row without a country code is Indian when it looks
 * like an Indian mobile; otherwise it takes the country typed, since older rows never saved one.
 */
export function isOnNumber(stored: StoredPhone, q: PhoneQuery): boolean {
    const raw = String(stored.PhoneNumber ?? "").trim();
    let code = String(stored.CountryCode ?? "").replace(/\D/g, "");
    if (!code) {
        const digits = raw.replace(/\D/g, "").replace(/^0+/, "");
        const indian = /^(91)?[6-9]\d{9}$/.test(digits);
        code = indian ? "91" : q.code;
    }
    return toInternationalPhone(raw, code) === `${q.code}${q.national}`;
}

/** A patient's number as typed for a lookup or a booking, split into country code and national number. */
export interface PhoneQuery {
    /** Country calling code, digits only ("91", "61", "971"). */
    code: string;
    /** National number, digits only, without its trunk 0 ("8099421902", "449679321"). */
    national: string;
}

/**
 * Reads a number typed with a country picker. India (the default code) keeps the 10-digit rule and
 * its old matching; other countries take 6 to 14 digits, since mobile numbers are not 10 digits
 * everywhere (Australia 9, UAE 9, UK 10). Returns null when the number is too short or too long.
 */
export function parsePhoneQuery(phone: string | null | undefined, countryCode?: string | null): PhoneQuery | null {
    const code = String(countryCode ?? "").replace(/\D/g, "") || "91";
    const raw = String(phone ?? "").trim();
    let digits = raw.replace(/\D/g, "").replace(/^0+/, "");
    // Written with its code in front: +61 449 679 321, 0061449679321, or longer than any national number
    const max = code === "91" ? 10 : 14;
    if ((raw.startsWith("+") || raw.startsWith("00") || digits.length > max) && digits.startsWith(code)) {
        digits = digits.slice(code.length).replace(/^0+/, "");
    }
    if (code === "91") {
        return digits.length >= 10 ? { code, national: digits.slice(-10) } : null;
    }
    return digits.length >= 6 && digits.length <= 14 ? { code, national: digits } : null;
}

/**
 * The WHERE clause that finds the users on this number. Indian numbers match on their 10 digits
 * (older rows have no country code), unless the row names another country. Elsewhere the national
 * number must carry the same country code, or be stored in full international form, so a number in
 * one country never pulls in a family from another.
 */
export function phoneMatchSql(alias: string, q: PhoneQuery): [string, Record<string, string>] {
    if (q.code === "91") {
        return [
            `((${alias}.PhoneNumber = :pqNational OR ${alias}.PhoneNumber LIKE :pqLast10)`
            + ` AND REPLACE(COALESCE(${alias}.CountryCode, ''), '+', '') IN ('', '91')`
            + ` AND (${alias}.PhoneNumber NOT LIKE '+%' OR ${alias}.PhoneNumber LIKE '+91%'))`,
            { pqNational: q.national, pqLast10: `%${q.national}` },
        ];
    }
    return [
        `((${alias}.PhoneNumber = :pqNational AND REPLACE(COALESCE(${alias}.CountryCode, ''), '+', '') = :pqCode) OR ${alias}.PhoneNumber = :pqIntl OR ${alias}.PhoneNumber = :pqPlusIntl)`,
        { pqNational: q.national, pqCode: q.code, pqIntl: `${q.code}${q.national}`, pqPlusIntl: `+${q.code}${q.national}` },
    ];
}
