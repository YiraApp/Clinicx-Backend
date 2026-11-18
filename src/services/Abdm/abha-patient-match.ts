/**
 * Clinic records that may be the person on a verified ABHA, for a desk that would otherwise
 * register them twice. A patient registered before they had an ABHA holds no ABHA number or
 * address, so the ABHA lookup never finds them, and ABDM shows the ABHA's mobile masked, so the
 * phone lookup has nothing to search with. These candidates come from the ABHA profile instead:
 * the same date of birth and gender, then the name and the mobile's last 4 digits decide.
 *
 * Kept free of the database: the store reads the rows, this file decides which ones to offer.
 */

import type { AbhaProfileSummary } from "./abha-session.store.js";

/** A clinic record the store found with the ABHA's date of birth and gender, and no ABHA of its own. */
export interface PatientCandidateRow {
    userId: string;
    firstName: string | null;
    lastName: string | null;
    /** YYYY-MM-DD. */
    dateOfBirth: string | null;
    gender: string | null;
    phone: string | null;
    email: string | null;
    relation: string | null;
    isPrimary: boolean;
    bloodGroup: string | null;
    tokenNumber: string | null;
    /** Registered at the desk's hospital (or its organization, when no hospital is known). */
    registeredHere: boolean;
    /** The family's primary record, for a record that hangs off one. */
    primary: CandidatePerson | null;
}

/** One person as the registration form's family list reads them. */
export interface CandidatePerson {
    id: string;
    name: string;
    firstName: string;
    lastName: string;
    phone: string;
    email: string;
    gender: string;
    dateOfBirth: string | null;
    relation: string;
    isPrimary: boolean;
}

/** How a record's name compares with the ABHA's. */
export type NameAgreement = "same" | "close" | "different";

export interface AbhaPatientMatch extends CandidatePerson {
    bloodGroup: string;
    tokenNumber: string;
    isRegisteredAtHospital: boolean;
    primary: CandidatePerson | null;
    /**
     * Why it is offered: the date of birth always agrees. The gender agrees ("same"), or the record
     * has none ("not-recorded"), or the ABHA has none to compare with ("not-compared": U or missing).
     */
    match: { name: NameAgreement; mobileLast4: boolean; gender: "same" | "not-recorded" | "not-compared" };
}

/** M, F, or O (ABDM's O and T, a stored Other or Transgender); null when there is none to go by. */
export type GenderLetter = "M" | "F" | "O";

/** What the store needs to read candidates. */
export interface PatientCandidateQuery {
    /** YYYY-MM-DD. */
    dateOfBirth: string;
    /** Records of this gender or of none recorded; null reads every gender (ABDM's U, or none). */
    gender: GenderLetter | null;
    /** Rows read before ranking: those with this mobile's last 4 or a word of this name come first. */
    limit: number;
    mobileLast4: string | null;
    nameWords: string[];
    hospitalId: number | null;
    organizationId: number | null;
}

/** The most candidates the desk is shown. */
export const MAX_MATCHES = 10;
/** The most rows one read ranks. Reaching it means some records may not have been checked. */
export const CANDIDATE_ROWS = 300;

/** YYYY-MM-DD from the profile's DD-MM-YYYY, when it is a real calendar date; else null. */
export const profileDateToSql = (value: string | null | undefined): string | null => {
    const match = String(value ?? "").trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (!match) return null;
    const [, dd, mm, yyyy] = match;
    const date = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
    if (date.getUTCFullYear() !== Number(yyyy) || date.getUTCMonth() !== Number(mm) - 1 || date.getUTCDate() !== Number(dd)) return null;
    return `${yyyy}-${mm}-${dd}`;
};

/**
 * The gender as the registration form compares it: M, F, or O for ABDM's O and T (the form calls
 * both "Other") and a stored Other or Transgender. U (undisclosed) and none say nothing.
 */
export const genderLetter = (value: string | null | undefined): GenderLetter | null => {
    const letter = String(value ?? "").trim().charAt(0).toUpperCase();
    if (letter === "M" || letter === "F") return letter;
    if (letter === "O" || letter === "T") return "O";
    return null;
};

/** Lower-case words of a name, letters only: "R. Kumar" gives ["r", "kumar"]. */
const words = (...parts: Array<string | null | undefined>): string[] =>
    parts.filter(Boolean).join(" ").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);

/** The ABHA name's whole words (two letters or more), for the store to read likely records first. */
export const profileNameWords = (profile: Pick<AbhaProfileSummary, "firstName" | "middleName" | "lastName" | "fullName">): string[] =>
    [...new Set(words(profile.firstName, profile.middleName, profile.lastName, profile.fullName).filter((word) => word.length > 1))].slice(0, 6);

const levenshtein = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let previous = row[0]!;
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const current = row[j]!;
            row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
            previous = current;
        }
    }
    return row[b.length]!;
};

/** One word of a name against another: the same, a slip of one letter in five, or an initial. */
const wordsAgree = (a: string, b: string): boolean => {
    if (a === b) return true;
    if (a.length === 1 || b.length === 1) return a.charAt(0) === b.charAt(0);
    return levenshtein(a, b) <= Math.floor(Math.max(a.length, b.length) / 5);
};

/**
 * Whether every word of [shorter] can agree with a different word of [longer], with at least one
 * whole word agreeing with a whole word (initials alone say nothing). Every pairing is tried, so
 * an initial never takes the word a whole word needed ("R Ramesh" against "Ramesh Raman").
 */
const pairsUp = (shorter: string[], longer: string[]): boolean => {
    const used = longer.map(() => false);
    // Whole words first, longest first: they have the fewest partners.
    const order = [...shorter].sort((a, b) => b.length - a.length);
    const search = (index: number, wholePairs: number): boolean => {
        if (index === order.length) return wholePairs > 0;
        const word = order[index]!;
        for (let j = 0; j < longer.length; j++) {
            if (used[j] || !wordsAgree(word, longer[j]!)) continue;
            used[j] = true;
            if (search(index + 1, wholePairs + (word.length > 1 && longer[j]!.length > 1 ? 1 : 0))) return true;
            used[j] = false;
        }
        return false;
    };
    return search(0, 0);
};

/**
 * "same": the same words in any order, or the same letters ignoring spaces ("Ravi Kumar",
 * "Kumar Ravi", "RaviKumar"). "close": every word of the shorter name agrees with a different word
 * of the longer one (a missing middle name or surname, an initial, a one-letter slip), at least
 * one of them whole word to whole word. Else "different".
 */
export const nameAgreement = (
    abha: Pick<AbhaProfileSummary, "firstName" | "middleName" | "lastName" | "fullName">,
    record: { firstName: string | null; lastName: string | null },
): NameAgreement => {
    // A name of more than 8 words is cut there: the pairing search stays small.
    const mine = words(record.firstName, record.lastName).slice(0, 8);
    if (mine.length === 0) return "different";
    const candidates = [words(abha.firstName, abha.middleName, abha.lastName), words(abha.fullName)]
        .map((list) => list.slice(0, 8))
        .filter((list) => list.length > 0);
    let best: NameAgreement = "different";
    for (const theirs of candidates) {
        if (mine.join("") === theirs.join("") || [...mine].sort().join(" ") === [...theirs].sort().join(" ")) return "same";
        const [shorter, longer] = mine.length <= theirs.length ? [mine, theirs] : [theirs, mine];
        if (pairsUp(shorter, longer)) best = "close";
    }
    return best;
};

const lastFourOf = (phone: string | null | undefined): string | null => {
    const digits = String(phone ?? "").replace(/\D/g, "");
    return digits.length >= 4 ? digits.slice(-4) : null;
};

const person = (row: Pick<PatientCandidateRow, "userId" | "firstName" | "lastName" | "phone" | "email" | "gender" | "dateOfBirth" | "relation" | "isPrimary">): CandidatePerson => {
    const firstName = row.firstName?.trim() ?? "";
    const lastName = row.lastName?.trim() ?? "";
    return {
        id: row.userId,
        name: `${firstName} ${lastName}`.trim(),
        firstName,
        lastName,
        phone: row.phone?.trim() ?? "",
        email: row.email?.trim() ?? "",
        gender: row.gender?.trim() ?? "",
        dateOfBirth: row.dateOfBirth,
        relation: row.relation?.trim() ?? "",
        isPrimary: row.isPrimary,
    };
};

/**
 * The records to offer, best first, at most [MAX_MATCHES]. Every row already shares the ABHA's
 * date of birth; a record whose gender is recorded and differs is never offered. A record is
 * offered when its name is the same or close, or when its name differs but its mobile ends in the
 * ABHA mobile's last 4 digits (a nickname, a married name). The name weighs more than the mobile,
 * which a family shares.
 */
export const rankPatientMatches = (rows: PatientCandidateRow[], profile: AbhaProfileSummary, mobileLast4: string | null): AbhaPatientMatch[] => {
    const abhaGender = genderLetter(profile.gender);
    const seen = new Set<string>();
    const scored: Array<{ match: AbhaPatientMatch; score: number }> = [];
    for (const row of rows) {
        const key = row.userId.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const recordGender = genderLetter(row.gender);
        if (abhaGender && recordGender && recordGender !== abhaGender) continue;
        const name = nameAgreement(profile, row);
        const sameMobile = !!mobileLast4 && lastFourOf(row.phone) === mobileLast4;
        if (name === "different" && !sameMobile) continue;
        const score = (name === "same" ? 8 : name === "close" ? 4 : 0) + (sameMobile ? 2 : 0) + (row.registeredHere ? 1 : 0);
        scored.push({
            score,
            match: {
                ...person(row),
                bloodGroup: row.bloodGroup?.trim() ?? "",
                tokenNumber: row.tokenNumber?.trim() ?? "",
                isRegisteredAtHospital: row.registeredHere,
                primary: row.primary,
                match: { name, mobileLast4: sameMobile, gender: !abhaGender ? "not-compared" : recordGender ? "same" : "not-recorded" },
            },
        });
    }
    return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_MATCHES)
        .map((entry) => entry.match);
};
