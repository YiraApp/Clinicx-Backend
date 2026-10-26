/**
 * The ABHA filter on patient lists: patients registered through the ABHA step, or the rest.
 * Only these two values become SQL; anything else means no filter.
 */

export type AbhaPatientFilter = "registered" | "not-registered";

export const parseAbhaPatientFilter = (value: unknown): AbhaPatientFilter | undefined =>
    value === "registered" || value === "not-registered" ? value : undefined;

/** The WHERE condition for [filter] on the Users alias [userAlias], or null for no filter. */
export const abhaPatientCondition = (filter: AbhaPatientFilter | undefined, userAlias: string): string | null => {
    if (filter === "registered") return `${userAlias}.RegisteredViaAbha = 1`;
    if (filter === "not-registered") return `${userAlias}.RegisteredViaAbha = 0`;
    return null;
};
