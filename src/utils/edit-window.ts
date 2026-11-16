// Prescriptions, medical records and diet plans can be changed for one hour after they are saved; after that they
// are part of the patient's record and stay as written. The web and the app hide Edit past the hour;
// this refuses the change on the server too, for any client.
import { AppDataSource } from "../config/database.js";

export const EDIT_WINDOW_MINUTES = 60;

const TABLES = {
    prescription: "PatientPrescription",
    record: "PatientMedicalRecord",
    dietPlan: "PatientDietPlans",
} as const;

const NAMES: Record<keyof typeof TABLES, string> = {
    prescription: "prescription",
    record: "medical record",
    dietPlan: "diet plan",
};

/** Whether something saved at [createdAt] may still be changed at [now]. Unknown age stays editable. */
export function isWithinEditWindow(createdAt: unknown, now: Date = new Date()): boolean {
    const created = createdAt ? new Date(String(createdAt)) : null;
    if (!created || Number.isNaN(created.getTime())) return true;
    return now.getTime() - created.getTime() <= EDIT_WINDOW_MINUTES * 60_000;
}

/**
 * Null when the prescription or record [id] may still be changed (or doesn't exist, which the
 * caller reports as before); otherwise the message to send back with a 403.
 */
export async function editLockMessage(kind: keyof typeof TABLES, id: string | number): Promise<string | null> {
    const [row] = await AppDataSource.query(`SELECT CreatedAt FROM ${TABLES[kind]} WHERE Id = @0`, [id]);
    if (!row || isWithinEditWindow(row.CreatedAt)) return null;
    return `This ${NAMES[kind]} can't be changed any more: changes are allowed only within ${EDIT_WINDOW_MINUTES} minutes of saving.`;
}
