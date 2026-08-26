import { Request, Response } from "express";
import { snomedService } from "./snomed.service.js";
import { SNOMED_CT_PARENT_IDS, SNOMED_CT_INDIAN_DRUG_CODES } from "./snomed.constants.js";

export class SnomedController {
    async search(req: Request, res: Response) {
        try {
            const { term, type, limit, offset } = req.query;
            
            if (!term || (term as string).trim().length < 2) {
                return res.json({
                    status: true,
                    message: "Concepts retrieved successfully",
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
                    // Broaden drug search to include Medicinal products, Clinical drugs, and Brand products
                    ecl = `<<${SNOMED_CT_INDIAN_DRUG_CODES.MEDICINAL_PRODUCT} OR <<${SNOMED_CT_INDIAN_DRUG_CODES.CLINICAL_DRUG} OR <<${SNOMED_CT_INDIAN_DRUG_CODES.BRAND_PRODUCT}`;
                    break;
                case "procedure":
                    ecl = SNOMED_CT_PARENT_IDS.PROCEDURE;
                    break;
                case "occupation":
                    ecl = SNOMED_CT_PARENT_IDS.OCCUPATION;
                    break;
                case "allergy":
                    ecl = SNOMED_CT_PARENT_IDS.FINDING; // Usually allergies are under findings
                    break;
                default:
                    ecl = (type as string) || ""; // Allow passing custom ECL or parent ID
            }

            let results: any = { items: [], total: 0 };
            try {
                results = await snomedService.searchConcepts(
                    term as string, 
                    ecl, 
                    limit ? parseInt(limit as string) : 10,
                    offset ? parseInt(offset as string) : 0
                );
            } catch (snomedError: any) {
                console.warn("SNOMED CT server error (returning empty results):", snomedError?.message || snomedError);
                results = { items: [], total: 0 };
            }

            res.json({
                status: true,
                message: "Concepts retrieved successfully",
                data: results
            });
        } catch (error: any) {
            console.error("SNOMED search error:", error?.message || error);
            res.json({
                status: true,
                message: "No results found",
                data: { items: [], total: 0 }
            });
        }
    }

    async getUcumCodes(req: Request, res: Response) {
        // We can just return the constants
        const { ucumCodes } = await import("./snomed.constants.js");
        res.json({
            status: true,
            data: ucumCodes
        });
    }
}

export const snomedController = new SnomedController();
