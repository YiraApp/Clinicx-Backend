/** Lab tests from the request, or undefined when it sent none (older app versions). */
export const normalizeLabTests = (source: any) => {
    if (!Array.isArray(source.labTests)) return undefined;
    const seen = new Set<string>();
    return source.labTests
        .map((test: any) => ({
            HospitalLabTestId: Number(test.hospitalLabTestId ?? test.id) || null,
            TestName: String(test.testName ?? test.name ?? "").trim(),
            Category: test.category ? String(test.category) : null,
            Priority: String(test.priority).toLowerCase() === "urgent" ? "Urgent" : "Routine",
            Instructions: test.instructions ? String(test.instructions).trim() : null
        }))
        .filter((test: any) => {
            const key = test.TestName.toLowerCase();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
};
