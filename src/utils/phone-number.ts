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
