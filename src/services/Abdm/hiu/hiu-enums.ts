/**
 * ABDM Milestone 3 (ClinicX as a Health Information User): the fixed vocabularies of the consent
 * and data-flow calls, as the HIE-CM M3 specification enumerates them, plus the small checks that
 * refuse anything else. Unknown values are refused, never defaulted.
 */

/** Purpose of use. ABDM pairs each code with exactly this text (consent/request/init purpose). */
export const HIU_PURPOSES = [
    { code: "CAREMGT", text: "Care Management" },
    { code: "BTG", text: "Break the Glass" },
    { code: "PUBHLTH", text: "Public Health" },
    { code: "HPAYMT", text: "Healthcare Payment" },
    { code: "DSRCH", text: "Disease Specific Healthcare Research" },
    { code: "PATRQT", text: "Self Requested" },
] as const;

export type HiuPurposeCode = (typeof HIU_PURPOSES)[number]["code"];

/**
 * purpose.refUri is required. The codes are a subset of HL7 v3 PurposeOfUse, so its value set is
 * the reference; it fits the spec's refUri pattern.
 */
export const HIU_PURPOSE_REF_URI = "http://terminology.hl7.org/ValueSet/v3-PurposeOfUse";
export const HIU_REF_URI_PATTERN = /^[a-zA-Z0-9_\-@,. ":/]{0,255}$/;

/** The eight health information types, in the order of the NHA test cases (HIU_FLOW_107 to 114). */
export const HIU_HI_TYPES = [
    { code: "DiagnosticReport", label: "Diagnostic report" },
    { code: "Prescription", label: "Prescription" },
    { code: "DischargeSummary", label: "Discharge summary" },
    { code: "OPConsultation", label: "OP consultation" },
    { code: "ImmunizationRecord", label: "Immunization record" },
    { code: "HealthDocumentRecord", label: "Health document record" },
    { code: "WellnessRecord", label: "Wellness record" },
    { code: "Invoice", label: "Invoice" },
] as const;

export type HiType = (typeof HIU_HI_TYPES)[number]["code"];

/** permission.accessMode. What each mode obliges the HIU to do is not documented; VIEW is the default. */
export const HIU_ACCESS_MODES = ["VIEW", "STORE", "STREAM", "QUERY"] as const;
export type HiuAccessMode = (typeof HIU_ACCESS_MODES)[number];
export const HIU_DEFAULT_PURPOSE: HiuPurposeCode = "CAREMGT";
export const HIU_DEFAULT_ACCESS_MODE: HiuAccessMode = "VIEW";

/** permission.frequency.unit. Every ABDM sample sends HOUR / 1 / 0, which is what we send. */
export const HIU_FREQUENCY_UNITS = ["HOUR", "DAY", "WEEK", "MONTH", "YEAR"] as const;
export type HiuFrequencyUnit = (typeof HIU_FREQUENCY_UNITS)[number];
export const HIU_DEFAULT_FREQUENCY = { unit: "HOUR" as HiuFrequencyUnit, value: 1, repeats: 0 };

/**
 * Our consent request's status. SENDING until on-init; FAILED when ABDM refused the init;
 * PARTLY_REVOKED when some but not all of its artefacts are revoked. The rest are ABDM's.
 */
export const CONSENT_STATUSES = ["SENDING", "REQUESTED", "GRANTED", "PARTLY_REVOKED", "DENIED", "EXPIRED", "REVOKED", "FAILED"] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];
/** A request in one of these states can still change; any other is final. */
export const OPEN_CONSENT_STATUSES: readonly ConsentStatus[] = ["SENDING", "REQUESTED"];

/** Statuses ABDM sends in consent/request/notify (on-status sends the same without GRANTED, which we accept anyway). */
export const NOTIFY_CONSENT_STATUSES = ["GRANTED", "EXPIRED", "DENIED", "REQUESTED", "REVOKED"] as const;
export type NotifyConsentStatus = (typeof NOTIFY_CONSENT_STATUSES)[number];

/** A consent artefact's status (on-fetch consent.status). */
export const ARTEFACT_STATUSES = ["GRANTED", "REVOKED", "EXPIRED", "DENIED"] as const;
export type ArtefactStatus = (typeof ARTEFACT_STATUSES)[number];

/** Our health-information transfer's state. */
export const SESSION_STATUSES = ["REQUESTED", "RECEIVING", "RECEIVED", "FAILED"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** What the HIU reports in health-information/notify: per transfer, and per care context. */
export const HIU_NOTIFY_SESSION_STATUSES = ["RECEIVED", "FAILED"] as const;
export type HiuNotifySessionStatus = (typeof HIU_NOTIFY_SESSION_STATUSES)[number];
export const HIU_HI_STATUSES = ["OK", "ERRORED"] as const;
export type HiuHiStatus = (typeof HIU_HI_STATUSES)[number];

/** Where an artefact stands, as the staff page shows it. */
export const ARTEFACT_STAGES = [
    "FETCHING_DETAILS",
    "REQUESTING_RECORDS",
    "WAITING_FOR_PROVIDER",
    "RECEIVING",
    "RECEIVED",
    "TRANSFER_FAILED",
    "RECORDS_DELETED",
    "BLOCKED",
] as const;
export type ArtefactStage = (typeof ARTEFACT_STAGES)[number];

/** The only entry media the push carries. */
export const HIU_ENTRY_MEDIA = "application/fhir+json";

/**
 * consent.patient.id: an ABHA address ending in @abdm or @sbx. Starts and ends with a letter or
 * digit; ".", "_", "-" and "!" allowed in the middle.
 */
export const ABHA_ADDRESS_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.\-!]+[a-zA-Z0-9]@(abdm|sbx)$/;

/** hiRequest.dataPushUrl: at most 255 characters from this set. */
export const DATA_PUSH_URL_PATTERN = /^[a-zA-Z0-9_\-@,. ":=?/&]{0,255}$/;

/** Every date-time ABDM accepts in these bodies: UTC, milliseconds, trailing Z. */
export const ABDM_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export const isPurposeCode = (value: unknown): value is HiuPurposeCode =>
    typeof value === "string" && HIU_PURPOSES.some((purpose) => purpose.code === value);

/** The text ABDM pairs with a purpose code; null for an unknown code. */
export const purposeText = (code: string): string | null =>
    HIU_PURPOSES.find((purpose) => purpose.code === code)?.text ?? null;

export const isHiType = (value: unknown): value is HiType =>
    typeof value === "string" && HIU_HI_TYPES.some((type) => type.code === value);

export const hiTypeLabel = (code: string): string =>
    HIU_HI_TYPES.find((type) => type.code === code)?.label ?? code;

export const isAccessMode = (value: unknown): value is HiuAccessMode =>
    typeof value === "string" && (HIU_ACCESS_MODES as readonly string[]).includes(value);

export const isFrequencyUnit = (value: unknown): value is HiuFrequencyUnit =>
    typeof value === "string" && (HIU_FREQUENCY_UNITS as readonly string[]).includes(value);

export const isConsentStatus = (value: unknown): value is ConsentStatus =>
    typeof value === "string" && (CONSENT_STATUSES as readonly string[]).includes(value);

export const isNotifyConsentStatus = (value: unknown): value is NotifyConsentStatus =>
    typeof value === "string" && (NOTIFY_CONSENT_STATUSES as readonly string[]).includes(value);

export const isArtefactStatus = (value: unknown): value is ArtefactStatus =>
    typeof value === "string" && (ARTEFACT_STATUSES as readonly string[]).includes(value);

export const isSessionStatus = (value: unknown): value is SessionStatus =>
    typeof value === "string" && (SESSION_STATUSES as readonly string[]).includes(value);

/**
 * An ABHA address the spec accepts. With [suffix] ("@sbx" or "@abdm", from abdmConfig.abhaAddressSuffix)
 * it must also belong to this environment.
 */
export const isAbhaAddress = (value: unknown, suffix?: string): value is string =>
    typeof value === "string" && ABHA_ADDRESS_PATTERN.test(value) && (!suffix || value.toLowerCase().endsWith(suffix.toLowerCase()));

/**
 * A list of HI types: at least one, every one known, no repeats. Returns the cleaned list, or null
 * when anything in it is refused.
 */
export const parseHiTypes = (value: unknown): HiType[] | null => {
    if (!Array.isArray(value) || value.length === 0) return null;
    if (!value.every(isHiType)) return null;
    const unique = [...new Set(value)] as HiType[];
    return unique.length === value.length ? unique : null;
};

/** A calendar date "YYYY-MM-DD" that exists (no 2026-02-30). */
export const isDateOnly = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    const match = DATE_ONLY_PATTERN.exec(value);
    if (!match) return false;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

/** A parseable ISO date-time (with a zone or Z), as the staff form sends dataEraseAt; null otherwise. */
export const parseDateTime = (value: unknown): Date | null => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

/** A date-time as ABDM wants it in a body: UTC ISO-8601 with milliseconds and Z. */
export const abdmDateTime = (date: Date): string => date.toISOString();

export const isDataPushUrl = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && DATA_PUSH_URL_PATTERN.test(value);

export type HiuErrorKind = "validation" | "not-found" | "conflict" | "not-configured" | "forbidden" | "abdm";

const DEFAULT_STATUS: Record<HiuErrorKind, number> = {
    validation: 400,
    forbidden: 403,
    "not-found": 404,
    conflict: 409,
    abdm: 422,
    "not-configured": 503,
};

/**
 * An HIU refusal the controller turns into ApiResponse.error(message, { kind, ...details }) with
 * [status]. Messages are shown to staff: they never name patient data, and never use the word the
 * frontend reads as its own login lapsing (that word is replaced with "lapsed" here as a backstop).
 * ABDM call failures stay AbdmApiError.
 */
export class HiuError extends Error {
    readonly status: number;
    readonly kind: HiuErrorKind;
    readonly details?: Record<string, unknown>;

    constructor(kind: HiuErrorKind, message: string, options: { status?: number; details?: Record<string, unknown> } = {}) {
        super(message.replace(/expired/gi, "lapsed"));
        this.name = "HiuError";
        this.kind = kind;
        this.status = options.status ?? DEFAULT_STATUS[kind];
        if (options.details) this.details = options.details;
    }
}

/** The 503 every HIU staff endpoint answers while the deployment's HIU settings are missing. */
export const hiuNotConfiguredError = (): HiuError =>
    new HiuError("not-configured", "ABDM record requests aren't set up on this server yet: the records key or push address is missing.");

/** The 503 a hospital's HIU staff endpoints answer while the hospital has no HIU id (AbdmFacilities). */
export const hiuFacilityNotConfiguredError = (): HiuError =>
    new HiuError("not-configured", "This hospital isn't set up as an ABDM HIU facility yet. A system admin can add its HFR facility id under ABDM Facilities.");
