import { Request, Response } from "express";
import { snomedService } from "./snomed.service.js";
import { SNOMED_CT_PARENT_IDS, SNOMED_CT_INDIAN_DRUG_CODES } from "./snomed.constants.js";

export class SnomedController {
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
                    ecl = SNOMED_CT_INDIAN_DRUG_CODES.MEDICINAL_PRODUCT;
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

            const results = await snomedService.searchConcepts(
                term as string, 
                ecl, 
                limit ? parseInt(limit as string) : 10,
                offset ? parseInt(offset as string) : 0
            );

            res.json({
                status: true,
                message: "Concepts retrieved successfully",
                data: results
            });
        } catch (error: any) {
            res.status(500).json({
                status: false,
                message: error.message || "Failed to search SNOMED concepts"
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
