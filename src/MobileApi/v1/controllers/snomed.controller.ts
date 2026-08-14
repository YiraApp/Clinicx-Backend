import { Request, Response } from "express";
import { snomedService } from "../../../snomed/snomed.service.js";
import { SNOMED_CT_PARENT_IDS, SNOMED_CT_INDIAN_DRUG_CODES } from "../../../snomed/snomed.constants.js";

export class MobileSnomedController {
    async search(req: Request, res: Response) {
        try {
            const { term, type, limit, offset } = req.query;

            if (!term) {
                return res.status(400).json({ status: false, message: "Search term is required" });
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

            const results = await snomedService.searchConcepts(
                term as string,
                ecl,
                limit ? parseInt(limit as string) : 15,
                offset ? parseInt(offset as string) : 0
            );

            res.json({
                status: true,
                message: "SNOMED CT concepts retrieved successfully",
                data: results
            });
        } catch (error: any) {
            console.error("Mobile SNOMED search error:", error);
            res.status(500).json({
                status: false,
                message: error.message || "Failed to search SNOMED concepts"
            });
        }
    }
}

export const mobileSnomedController = new MobileSnomedController();
