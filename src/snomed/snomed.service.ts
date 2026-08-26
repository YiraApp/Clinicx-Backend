import { SNOMED_BASE_URL, BRANCH_INTERNATIONAL, BRANCH_INDIAN, SNOMED_CT_PARENT_IDS, SNOMED_CT_INDIAN_DRUG_CODES } from "./snomed.constants.js";

export class SnomedService {
    private getBranch(ecl: string): string {
        // List of parent IDs that should use the Indian branch
        const indianBranchIds = [
            SNOMED_CT_INDIAN_DRUG_CODES.MEDICINAL_PRODUCT,
            SNOMED_CT_INDIAN_DRUG_CODES.MEDICINAL_PRODUCT_FORM,
            SNOMED_CT_INDIAN_DRUG_CODES.CLINICAL_DRUG,
            SNOMED_CT_INDIAN_DRUG_CODES.PACKAGED_CLINICAL_DRUG,
            SNOMED_CT_INDIAN_DRUG_CODES.REAL_CLINICAL_DRUG,
            SNOMED_CT_INDIAN_DRUG_CODES.REAL_MEDICINAL_PRODUCT,
            SNOMED_CT_INDIAN_DRUG_CODES.REAL_PACKAGED_CLINICAL_DRUG,
            SNOMED_CT_INDIAN_DRUG_CODES.BRAND_PRODUCT,
            SNOMED_CT_PARENT_IDS.QUALIFIER_VALUE,
            SNOMED_CT_PARENT_IDS.ADMINISTRATION_METHOD,
        ];

        // If ecl contains any of the Indian branch IDs, use the Indian branch
        if (indianBranchIds.some(id => ecl.includes(id))) {
            return BRANCH_INDIAN;
        }

        return BRANCH_INTERNATIONAL;
    }

    async searchConcepts(term: string, ecl: string, limit: number = 10, offset: number = 0) {
        try {
            const branch = this.getBranch(ecl);
            const encodedBranch = encodeURIComponent(branch);
            
            const url = new URL(`${SNOMED_BASE_URL}/${encodedBranch}/concepts`);
            url.searchParams.append("term", term);
            url.searchParams.append("active", "true");
            url.searchParams.append("offset", String(offset));
            url.searchParams.append("limit", String(limit));
            url.searchParams.append("includeLeafFlag", "false");
            url.searchParams.append("form", "inferred");
            
            if (ecl) {
                const encodedEcl = ecl.startsWith('<') || ecl.startsWith('>') || ecl.startsWith('(') 
                    ? ecl 
                    : `<<${ecl}`;
                url.searchParams.append("ecl", encodedEcl);
            }

            console.log(`SNOMED Search: ${url.toString()}`);

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000); // 8 second timeout

            const response = await fetch(url.toString(), {
                headers: {
                    'Accept': 'application/json',
                    'Accept-Language': 'en-X-900000000000509007,en-X-900000000000508004,en'
                },
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!response.ok) {
                console.warn(`SNOMED Server responded with status: ${response.status} — returning empty results`);
                return { items: [], total: 0 };
            }

            const data = await response.json();
            return data;
        } catch (error: any) {
            if (error?.name === 'AbortError') {
                console.warn("SNOMED CT request timed out — returning empty results");
            } else {
                console.warn("Error fetching SNOMED concepts:", error?.message || error);
            }
            return { items: [], total: 0 };
        }
    }

    async searchFindings(term: string, limit: number = 10) {
        return this.searchConcepts(term, SNOMED_CT_PARENT_IDS.FINDING, limit);
    }

    async searchDisorders(term: string, limit: number = 10) {
        return this.searchConcepts(term, SNOMED_CT_PARENT_IDS.DISORDER, limit);
    }

    async searchDrugs(term: string, limit: number = 10) {
        return this.searchConcepts(term, SNOMED_CT_INDIAN_DRUG_CODES.MEDICINAL_PRODUCT, limit);
    }

    async searchProcedures(term: string, limit: number = 10) {
        return this.searchConcepts(term, SNOMED_CT_PARENT_IDS.PROCEDURE, limit);
    }
}

export const snomedService = new SnomedService();
