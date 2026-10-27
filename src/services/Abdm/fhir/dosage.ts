import { SNOMED, UCUM } from "./fhir-common.js";
import type { MedicationSource } from "./fhir-sources.js";

/**
 * A prescription line's dosage as FHIR Dosage, read from the words the clinic's prescriptions use:
 * "1-0-1 (Morning & Night)", "Once daily", "Every 8 hours", "SOS"; "7 days" or a number of "Days";
 * "650 mg"; "Oral"; "After food". A PHR app shows frequency, duration, dose, route, method and
 * instructions from these elements, and "NA" when only the sentence is there. What can't be read is
 * left to the text, never guessed.
 */

type Timing = { repeat: Record<string, unknown> };

const SLOTS = ["MORN", "AFT", "NIGHT"] as const;
const PER_DAY: Record<string, number> = { once: 1, twice: 2, thrice: 3, "three times": 3, "four times": 4 };

/** Meal and bedtime timings as FHIR's event codes (AC before meals, PC after, HS at bedtime), and weekly or alternate-day doses. */
const WHEN: Array<[RegExp, Record<string, unknown>]> = [
    [/^(at )?bed\s?time\b/, { frequency: 1, period: 1, periodUnit: "d", when: ["HS"] }],
    [/^before (meals|food)\b/, { when: ["AC"] }],
    [/^after (meals|food)\b/, { when: ["PC"] }],
    [/^(once (a )?week(ly)?|weekly)\b/, { frequency: 1, period: 1, periodUnit: "wk" }],
    [/^(alternate days?|every other day)\b/, { frequency: 1, period: 2, periodUnit: "d" }],
];

/** "1-0-1", "Once daily", "Every 8 hours", "At bedtime" or "SOS" as a timing; null when it isn't one of those. */
export const timingOf = (frequency?: string | null): { timing?: Timing; asNeeded?: boolean } | null => {
    const f = (frequency ?? "").trim().toLowerCase();
    if (!f) return null;
    if (/^(sos|prn|as needed|when required)\b/.test(f)) return { asNeeded: true };
    const event = WHEN.find(([re]) => re.test(f));
    if (event) return { timing: { repeat: { ...event[1] } } };

    const slots = f.match(/^([01])\s*-\s*([01])\s*-\s*([01])\b/);
    if (slots) {
        const taken = slots.slice(1, 4).map(Number);
        const count = taken.reduce((a, b) => a + b, 0);
        if (!count) return null;
        return { timing: { repeat: { frequency: count, period: 1, periodUnit: "d", when: SLOTS.filter((_, i) => taken[i]) } } };
    }
    const every = f.match(/every\s+(\d+)\s*(hour|hr|h|day|d)/);
    if (every) return { timing: { repeat: { frequency: 1, period: Number(every[1]), periodUnit: /^d/.test(every[2]!) ? "d" : "h" } } };
    const daily = Object.entries(PER_DAY).find(([words]) => f.startsWith(words) && /(daily|a day|per day)/.test(f));
    if (daily) return { timing: { repeat: { frequency: daily[1], period: 1, periodUnit: "d" } } };
    return null;
};

const DURATION_UNITS: Array<[RegExp, string, string]> = [
    [/^d(ay)?s?$/, "d", "days"], [/^w(ee)?k?s?$/, "wk", "weeks"], [/^mo(nth)?s?$/, "mo", "months"],
];

/** "7 days", or a number beside "Days", as a duration; null when it isn't one. */
export const durationOf = (duration?: string | null) => {
    const m = (duration ?? "").trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/);
    if (!m) return null;
    const unit = DURATION_UNITS.find(([re]) => re.test(m[2]!));
    return unit ? { value: Number(m[1]), unit: unit[2], system: UCUM, code: unit[1] } : null;
};

const DOSE_UNITS: Record<string, string> = { mg: "mg", g: "g", gm: "g", mcg: "ug", ug: "ug", ml: "mL", iu: "[iU]" };

/** "650 mg", "1 g", "500mg" as a quantity; null without a unit it knows. */
export const doseOf = (dosage?: string | null) => {
    const m = (dosage ?? "").trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/);
    const code = m && DOSE_UNITS[m[2]!];
    return m && code ? { value: Number(m[1]), unit: m[2], system: UCUM, code } : null;
};

const ROUTES: Array<[RegExp, string, string]> = [
    [/^(oral|by mouth|po)\b/, "26643006", "Oral route"],
    [/intravenous|\biv\b/, "47625008", "Intravenous route"],
    [/intramuscular|\bim\b/, "78421000", "Intramuscular route"],
    [/subcutaneous|\bsc\b|\bs\/c\b/, "34206005", "Subcutaneous route"],
    [/intradermal|\bid\b/, "372464004", "Intradermal route"],
    [/sublingual/, "37839007", "Sublingual route"],
    [/topical|apply|cutaneous/, "6064005", "Topical route"],
    [/inhal/, "447694001", "Respiratory tract route"],
    [/nasal/, "46713006", "Nasal route"],
    [/ophthalmic|eye/, "54485002", "Ophthalmic route"],
    [/otic|\bear\b/, "10547007", "Otic route"],
    [/rectal/, "37161004", "Rectal route"],
    [/vaginal/, "16857009", "Vaginal route"],
];

/** The route as SNOMED CT when the words name one ("Injection" alone does not), its words always. */
export const routeOf = (route?: string | null) => {
    const text = (route ?? "").trim();
    if (!text) return null;
    const known = ROUTES.find(([re]) => re.test(text.toLowerCase()));
    return known ? { coding: [{ system: SNOMED, code: known[1], display: known[2] }], text } : { text };
};

// Additional dosage instructions (SNOMED CT 419492006) for the advice the prescription form offers
const INSTRUCTIONS: Array<[RegExp, string, string]> = [
    [/(after|with)\s+(food|meals?)/, "311504000", "With or after food"],
    [/before\s+(food|meals?)/, "311501008", "Half to one hour before food"],
    [/empty\s+stomach/, "717154004", "Take on an empty stomach"],
    [/with (plenty of )?water/, "419303009", "With plenty of water"],
    [/swallow(ed)? whole|do not (chew|crush)/, "418693002", "Swallow whole"],
    [/avoid alcohol/, "419822006", "Warning. Avoid alcoholic drink"],
    [/drows/, "418639000", "Warning. May cause drowsiness"],
    [/complete the (full )?course/, "418577003", "Take at regular intervals. Complete the prescribed course unless otherwise directed"],
    [/under the tongue/, "419529008", "Dissolved under the tongue"],
];

/** One piece of advice ("After food") as its SNOMED CT instruction, or as words when it isn't one. */
export const instructionOf = (instructions?: string | null) => {
    const text = (instructions ?? "").trim();
    if (!text) return null;
    const known = INSTRUCTIONS.find(([re]) => re.test(text.toLowerCase()));
    return known ? { coding: [{ system: SNOMED, code: known[1], display: known[2] }], text } : { text };
};

/** The advice as written, split where the form joins several ("After food; Avoid alcohol"), each coded when it can be. */
export const instructionsOf = (instructions?: string | null) =>
    (instructions ?? "").split(/[;\n]|\.\s/).map((part) => instructionOf(part.replace(/\.$/, ""))).filter((x): x is NonNullable<typeof x> => x !== null);

// How the dose is taken, from the dosing instruction imperatives FHIR's administration-method value set
// draws on (SNOMED CT 422096002), where the route and the form say it plainly
const METHODS: Array<[RegExp, string, string]> = [
    [/chewable/, "419747000", "Chew"],
    [/lozenge/, "420045007", "Suck"],
    [/^(oral|by mouth|po)\b/, "421521009", "Swallow"],
    [/intravenous|\biv\b|intramuscular|\bim\b|subcutaneous|\bsc\b|injection/, "422145002", "Inject"],
    [/topical|cutaneous|cream|ointment|gel\b/, "417924000", "Apply"],
    [/inhal/, "421134003", "Inhale"],
    [/eye|ophthalmic|ear\b|otic/, "421538008", "Instill"],
    [/rectal|vaginal|suppositor|pessary/, "421257003", "Insert"],
];

/** The method for a medicine and its route ("Swallow" for an oral tablet); null when neither says. */
export const methodOf = (route?: string | null, medicine?: string | null) => {
    const name = (medicine ?? "").toLowerCase();
    const byForm = METHODS.slice(0, 2).find(([re]) => re.test(name));
    const known = byForm ?? METHODS.slice(2).find(([re]) => re.test((route ?? "").trim().toLowerCase()));
    return known ? { coding: [{ system: SNOMED, code: known[1], display: known[2] }], text: known[2] } : null;
};

/** The FHIR Dosage for a prescription line: the sentence always, each element it can read beside it. */
export const dosageOf = (m: MedicationSource) => {
    const sentence = [m.dosage, m.frequency, m.duration ? `for ${m.duration}` : null].map((part) => part?.trim()).filter(Boolean).join(", ");
    const timing = timingOf(m.frequency);
    const bounds = durationOf(m.duration);
    const dose = doseOf(m.dosage);
    const route = routeOf(m.route);
    const method = methodOf(m.route, m.name);
    const instructions = instructionsOf(m.instructions);
    const repeat = { ...(timing?.timing?.repeat ?? {}), ...(bounds ? { boundsDuration: bounds } : {}) };
    return {
        text: sentence || "Dosage not recorded",
        ...(instructions.length ? { additionalInstruction: instructions, patientInstruction: m.instructions!.trim() } : {}),
        ...(Object.keys(repeat).length ? { timing: { repeat } } : {}),
        ...(timing?.asNeeded ? { asNeededBoolean: true } : {}),
        ...(route ? { route } : {}),
        ...(method ? { method } : {}),
        ...(dose ? { doseAndRate: [{ doseQuantity: dose }] } : {}),
    };
};
