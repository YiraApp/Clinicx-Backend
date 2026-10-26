/**
 * The ABHA filter on patient lists: patients registered through ABHA at this hospital (the
 * PatientRegistrations flag), or the rest. Only these two values become SQL; anything else means no filter.
 */

export type AbhaPatientFilter = "registered" | "not-registered";

export const parseAbhaPatientFilter = (value: unknown): AbhaPatientFilter | undefined =>
    value === "registered" || value === "not-registered" ? value : undefined;

/** The WHERE condition for [filter] on the PatientRegistrations alias [registrationAlias], or null for no filter. */
export const abhaPatientCondition = (filter: AbhaPatientFilter | undefined, registrationAlias: string): string | null => {
    if (filter === "registered") return `${registrationAlias}.RegisteredViaAbha = 1`;
    if (filter === "not-registered") return `${registrationAlias}.RegisteredViaAbha = 0`;
    return null;
};
