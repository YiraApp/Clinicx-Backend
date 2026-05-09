import { SNOMED_SERVER_URL, SNOMED_CT_PARENT_IDS } from "./snomed.constants.js";

export class SnomedService {
    async searchConcepts(term: string, ecl: string, limit: number = 10, offset: number = 0) {
        try {
            const url = new URL(SNOMED_SERVER_URL);
            url.searchParams.append("term", term);
            url.searchParams.append("active", "true");
            url.searchParams.append("offset", String(offset));
            url.searchParams.append("limit", String(limit));
            
            // ECL (Expression Constraint Language) filter
            if (ecl) {
                // The server expects << before the concept ID for "descendant of or self"
                // If ecl doesn't start with << or other ECL operators, we can prepend it
                const encodedEcl = ecl.startsWith('<') || ecl.startsWith('>') || ecl.startsWith('(') 
                    ? ecl 
                    : `<<${ecl}`;
                url.searchParams.append("ecl", encodedEcl);
            }

            const response = await fetch(url.toString());
            if (!response.ok) {
                throw new Error(`SNOMED Server responded with status: ${response.status}`);
            }

            const data = await response.json();
            return data;
        } catch (error) {
            console.error("Error fetching SNOMED concepts:", error);
            throw error;
        }
    }

    async searchFindings(term: string, limit: number = 10) {
        return this.searchConcepts(term, SNOMED_CT_PARENT_IDS.FINDING, limit);
    }

    async searchDisorders(term: string, limit: number = 10) {
        return this.searchConcepts(term, SNOMED_CT_PARENT_IDS.DISORDER, limit);
    }

    async searchDrugs(term: string, limit: number = 10) {
        return this.searchConcepts(term, SNOMED_CT_PARENT_IDS.MEDICINAL_PRODUCT, limit);
    }

    async searchProcedures(term: string, limit: number = 10) {
        return this.searchConcepts(term, SNOMED_CT_PARENT_IDS.PROCEDURE, limit);
    }
}

export const snomedService = new SnomedService();
