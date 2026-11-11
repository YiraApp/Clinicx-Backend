// Keeps a prescription's medicines in the order the doctor wrote them. Medicines have random ids
// and were saved with no position, so the database returned them in any order, and an edit moved
// the changed ones around. Each medicine now carries SortOrder (1, 2, 3...).

type MedicationLike = {
    Id?: string;
    SortOrder?: number | null;
    CreatedAt?: Date | string | null;
    Medication?: string | null;
    Dosage?: string | null;
    FrequencyType?: string | null;
    DurationUnit?: string | null;
    Route?: string | null;
    Instructions?: string | null;
};

const text = (value: unknown) => (value === null || value === undefined ? "" : String(value).trim().toLowerCase());
const time = (value: unknown) => {
    const t = value ? new Date(value as any).getTime() : NaN;
    return Number.isNaN(t) ? 0 : t;
};

/** Medicines with the same name, dosage, frequency, duration, route and instructions are the same line. */
export function medicationKey(m: any): string {
    return [
        text(m.Medication ?? m.medication),
        text(m.Dosage ?? m.dosage),
        text(m.FrequencyType ?? m.frequencyType ?? m.Frequency ?? m.frequency),
        text(m.DurationUnit ?? m.durationUnit ?? m.Duration ?? m.duration),
        text(m.Route ?? m.route),
        text(m.Instructions ?? m.instructions),
    ].join("|");
}

/** By position; older rows without one keep their saved order after the numbered ones. */
export function compareMedications(a: MedicationLike, b: MedicationLike): number {
    const sa = a.SortOrder ?? null;
    const sb = b.SortOrder ?? null;
    if (sa !== null && sb !== null && sa !== sb) return sa - sb;
    if (sa !== null && sb === null) return -1;
    if (sa === null && sb !== null) return 1;
    return time(a.CreatedAt) - time(b.CreatedAt);
}

/** A sorted copy. */
export function sortMedications<T extends MedicationLike>(list: T[] | null | undefined): T[] {
    return [...(list ?? [])].sort(compareMedications);
}

/**
 * What an edit changes: lines that stay get their new position, new lines are inserted at theirs,
 * and lines no longer on the prescription (or duplicated) are deleted. [incoming] is in the order
 * the doctor wants, so a line's position is its index + 1.
 */
export function planMedicationChanges<E extends MedicationLike, I>(existing: E[], incoming: I[]) {
    const byKey = new Map<string, E[]>();
    for (const row of sortMedications(existing)) {
        const key = medicationKey(row);
        byKey.set(key, [...(byKey.get(key) ?? []), row]);
    }
    const keep: Array<{ id: string; sortOrder: number }> = [];
    const insert: Array<{ medication: I; sortOrder: number }> = [];
    const used = new Set<string>();
    for (const medication of incoming) {
        const key = medicationKey(medication);
        if (used.has(key)) continue; // the same line twice is kept once
        used.add(key);
        const sortOrder = used.size;
        const match = byKey.get(key)?.[0];
        if (match?.Id) keep.push({ id: match.Id, sortOrder });
        else insert.push({ medication, sortOrder });
    }
    const keptIds = new Set(keep.map((k) => k.id));
    const remove = existing.filter((row) => row.Id && !keptIds.has(row.Id)).map((row) => row.Id as string);
    return { keep, insert, remove };
}
