import { Request, Response } from "express";
import { snomedService } from "../../../snomed/snomed.service.js";
import { SNOMED_CT_PARENT_IDS, SNOMED_CT_INDIAN_DRUG_CODES } from "../../../snomed/snomed.constants.js";

export class MobileSnomedController {
    async search(req: Request, res: Response) {
        try {
            const { term, type, limit, offset } = req.query;

            if (!term || (term as string).trim().length < 2) {
                return res.json({
                    status: true,
                    message: "SNOMED CT concepts retrieved successfully",
                    data: { items: [], total: 0 }
                });
            }

            let ecl = "";
            switch (type) {
                case "finding":
                    ecl = SNOMED_CT_PARENT_IDS.FINDING;
                    break;
                case "disorder":
                    ecl = SNOMED_CT_PARENT_IDS.DISORDER;
                    break;
                case "drug":
                    ecl = `<<${SNOMED_CT_INDIAN_DRUG_CODES.MEDICINAL_PRODUCT} OR <<${SNOMED_CT_INDIAN_DRUG_CODES.CLINICAL_DRUG} OR <<${SNOMED_CT_INDIAN_DRUG_CODES.BRAND_PRODUCT}`;
                    break;
                case "procedure":
                    ecl = SNOMED_CT_PARENT_IDS.PROCEDURE;
                    break;
                case "occupation":
                    ecl = SNOMED_CT_PARENT_IDS.OCCUPATION;
                    break;
                case "allergy":
                    ecl = SNOMED_CT_PARENT_IDS.FINDING;
                    break;
                default:
                    ecl = (type as string) || "";
            }

            let results: any = { items: [], total: 0 };
            try {
                results = await snomedService.searchConcepts(
                    term as string,
                    ecl,
                    limit ? parseInt(limit as string) : 15,
                    offset ? parseInt(offset as string) : 0
                );
            } catch (snomedError: any) {
                // Log but don't throw — return empty results gracefully
                console.warn("SNOMED CT server error (returning empty results):", snomedError?.message || snomedError);
                results = { items: [], total: 0 };
            }

            res.json({
                status: true,
                message: "SNOMED CT concepts retrieved successfully",
                data: results
            });
        } catch (error: any) {
            // Even top-level errors should not return 500 — return empty results
            console.error("Mobile SNOMED search error:", error?.message || error);
            res.json({
                status: true,
                message: "No results found",
                data: { items: [], total: 0 }
            });
        }
    }
}

export const mobileSnomedController = new MobileSnomedController();

