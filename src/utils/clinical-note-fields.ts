// The clinical note fields of a medical record (history, examination, diagnosis type), read from a
// request body in camelCase or PascalCase. Shared by the web and app medical record endpoints.

const FIELDS: Array<[column: string, keys: string[]]> = [
    ["SpO2", ["spo2", "SpO2", "oxygenSaturation", "OxygenSaturation"]],
    ["RespiratoryRate", ["respiratoryRate", "RespiratoryRate", "rr"]],
    ["HistoryOfPresentIllness", ["historyOfPresentIllness", "HistoryOfPresentIllness", "presentIllness"]],
    ["PastHistory", ["pastHistory", "PastHistory", "comorbidities"]],
    ["CurrentMedications", ["currentMedications", "CurrentMedications"]],
    ["CvsExamination", ["cvsExamination", "CvsExamination", "cvs"]],
    ["RespiratoryExamination", ["respiratoryExamination", "RespiratoryExamination", "rs"]],
    ["AbdomenExamination", ["abdomenExamination", "AbdomenExamination", "perAbdomen"]],
    ["CnsExamination", ["cnsExamination", "CnsExamination", "cns"]],
    ["DiagnosisType", ["diagnosisType", "DiagnosisType"]],
];

const clean = (column: string, value: unknown) => {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!text) return null;
    if (column === "DiagnosisType") return /^confirm/i.test(text) ? "Confirmed" : "Provisional";
    return text;
};

/**
 * The note fields present in [body]. With [onlySent], fields the request left out are left out
 * (for updates); otherwise every field is returned, null when empty (for new records).
 */
export function clinicalNoteFields(body: any, onlySent = false): Record<string, string | Date | null> {
    const out: Record<string, string | Date | null> = {};
    // Follow-up date ("YYYY-MM-DD" or an ISO time); an empty value clears it.
    const followKey = ["followUpDate", "FollowUpDate"].find((k) => body?.[k] !== undefined);
    if (followKey) {
        const raw = String(body[followKey] ?? "").trim();
        const date = raw ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00` : raw) : null;
        out.FollowUpDate = date && !Number.isNaN(date.getTime()) ? date : null;
    }
    for (const [column, keys] of FIELDS) {
        const key = keys.find((k) => body?.[k] !== undefined);
        if (key === undefined) {
            if (!onlySent) out[column] = null;
            continue;
        }
        out[column] = clean(column, body[key]);
    }
    return out;
}
