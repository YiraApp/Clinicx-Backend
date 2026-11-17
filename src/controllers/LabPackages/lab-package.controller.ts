import type { Request, Response } from "express";
import { ApiResponse } from "../../utils/response.utils.js";
import { isYiraSystemAdmin } from "../../utils/staff-access.js";
import { labPackageService } from "../../services/LabPackages/lab-package.service.js";
import { labPackageOrderService, LabAccessError } from "../../services/LabPackages/lab-package-order.service.js";
import { pincodeService } from "../../services/LabPackages/pincode.service.js";
import { labSlotService } from "../../services/LabPackages/lab-slot.service.js";

const requesterOf = (req: Request): string => {
    const user = (req as any).user;
    return String(user?.userId || user?.Id || user?.id || "").trim();
};

const fail = (res: Response, error: any) => {
    const status = error instanceof LabAccessError ? error.status : 400;
    return res.status(status).json(ApiResponse.error(error?.message || "Something went wrong."));
};

/** Package management is for the Yira System Admin only. */
async function requireYiraAdmin(req: Request, res: Response): Promise<string | null> {
    const requesterId = requesterOf(req);
    if (!requesterId || !(await isYiraSystemAdmin(requesterId))) {
        res.status(403).json(ApiResponse.error("Only the Yira System Admin can manage lab packages."));
        return null;
    }
    return requesterId;
}

const sendFile = (res: Response, file: { buffer: Buffer; fileName: string; contentType: string }) => {
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `inline; filename="${file.fileName.replace(/"/g, "")}"`);
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(file.buffer);
};

export class LabPackageController {
    // ---------- Web: Yira System Admin ----------

    async list(req: Request, res: Response) {
        try {
            if (!(await requireYiraAdmin(req, res))) return;
            const data = await labPackageService.listForAdmin({
                search: req.query.search as string | undefined,
                hospitalId: req.query.hospitalId ? Number(req.query.hospitalId) : undefined
            });
            return res.json(ApiResponse.success(data, "Lab packages fetched."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    async get(req: Request, res: Response) {
        try {
            if (!(await requireYiraAdmin(req, res))) return;
            return res.json(ApiResponse.success(await labPackageService.getById(Number(req.params.id)), "Lab package fetched."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    async create(req: Request, res: Response) {
        try {
            const requesterId = await requireYiraAdmin(req, res);
            if (!requesterId) return;
            return res.status(201).json(ApiResponse.success(await labPackageService.create(req.body, requesterId), "Lab package created."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    async update(req: Request, res: Response) {
        try {
            const requesterId = await requireYiraAdmin(req, res);
            if (!requesterId) return;
            return res.json(ApiResponse.success(await labPackageService.update(Number(req.params.id), req.body, requesterId), "Lab package updated."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    async remove(req: Request, res: Response) {
        try {
            const requesterId = await requireYiraAdmin(req, res);
            if (!requesterId) return;
            return res.json(ApiResponse.success(await labPackageService.remove(Number(req.params.id), requesterId), "Lab package deleted."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    async testSuggestions(req: Request, res: Response) {
        try {
            if (!(await requireYiraAdmin(req, res))) return;
            return res.json(ApiResponse.success(labPackageService.testSuggestions(), "Test suggestions fetched."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    // ---------- Web: pincodes for a package (Yira System Admin) ----------

    async pincodeStatus(req: Request, res: Response) {
        try {
            if (!(await requireYiraAdmin(req, res))) return;
            return res.json(ApiResponse.success(await pincodeService.status(), "Pincode directory status."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    /** Upload India Post's directory CSV; it loads in the background and pincodeStatus() follows it. */
    async pincodeImport(req: Request, res: Response) {
        try {
            if (!(await requireYiraAdmin(req, res))) return;
            const file = (req as any).file as Express.Multer.File | undefined;
            if (!file) return res.status(400).json(ApiResponse.error("Choose India Post's pincode directory CSV to upload."));
            if (!/\.csv$/i.test(file.originalname)) return res.status(400).json(ApiResponse.error("Upload the directory as a .csv file."));
            const job = pincodeService.startImport(file.buffer.toString("utf8"), file.originalname);
            return res.status(202).json(ApiResponse.success(job, "Pincode directory import started."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    /** Fetch a pincode series (e.g. 500 = Hyderabad) from India Post's API into the global table, in the background. */
    async pincodeFetchSeries(req: Request, res: Response) {
        try {
            if (!(await requireYiraAdmin(req, res))) return;
            const job = pincodeService.startSeriesFetch(String(req.body?.series || ""));
            return res.status(202).json(ApiResponse.success(job, "Fetching the pincode series from India Post."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    async pincodeStates(req: Request, res: Response) {
        try {
            if (!(await requireYiraAdmin(req, res))) return;
            return res.json(ApiResponse.success(await pincodeService.states(), "States fetched."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    async pincodeDistricts(req: Request, res: Response) {
        try {
            if (!(await requireYiraAdmin(req, res))) return;
            return res.json(ApiResponse.success(await pincodeService.districts(String(req.query.state || "")), "Districts fetched."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    async pincodeList(req: Request, res: Response) {
        try {
            if (!(await requireYiraAdmin(req, res))) return;
            const districts = Array.isArray(req.body?.districts) ? req.body.districts.map(String) : [];
            return res.json(ApiResponse.success(await pincodeService.pincodesIn(String(req.body?.state || ""), districts), "Pincodes fetched."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    async pincodeLookup(req: Request, res: Response) {
        try {
            if (!(await requireYiraAdmin(req, res))) return;
            const pincodes = Array.isArray(req.body?.pincodes) ? req.body.pincodes.map(String) : [];
            return res.json(ApiResponse.success(await pincodeService.lookup(pincodes), "Pincodes looked up."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    /** A package's uploaded pincodes matched against the global pincode table. */
    async pincodeMatch(req: Request, res: Response) {
        try {
            if (!(await requireYiraAdmin(req, res))) return;
            const pincodes = Array.isArray(req.body?.pincodes) ? req.body.pincodes.map(String) : [];
            return res.json(ApiResponse.success(await pincodeService.match(pincodes), "Pincodes matched."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    async pincodeSearch(req: Request, res: Response) {
        try {
            if (!(await requireYiraAdmin(req, res))) return;
            return res.json(ApiResponse.success(await pincodeService.search(String(req.query.q || "")), "Pincode search."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    // ---------- Web: orders (Yira System Admin: all hospitals; hospital staff: their hospitals) ----------

    async listOrders(req: Request, res: Response) {
        try {
            const result = await labPackageOrderService.listOrders(requesterOf(req), {
                hospitalId: req.query.hospitalId ? Number(req.query.hospitalId) : undefined,
                status: req.query.status as string | undefined,
                search: req.query.search as string | undefined,
                startDate: req.query.startDate as string | undefined,
                endDate: req.query.endDate as string | undefined,
                page: req.query.page ? Number(req.query.page) : undefined,
                limit: req.query.limit ? Number(req.query.limit) : undefined
            });
            return res.json(ApiResponse.success(result, "Lab package orders fetched."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    async updateOrderStatus(req: Request, res: Response) {
        try {
            const order = await labPackageOrderService.updateStatus(requesterOf(req), String(req.params.id), String(req.body?.status || ""));
            return res.json(ApiResponse.success(order, "Order status updated."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    async uploadReport(req: Request, res: Response) {
        try {
            const order = await labPackageOrderService.uploadReport(requesterOf(req), String(req.params.id), (req as any).file);
            return res.json(ApiResponse.success(order, "Report uploaded."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    async staffReport(req: Request, res: Response) {
        try {
            return sendFile(res, await labPackageOrderService.reportForStaff(requesterOf(req), String(req.params.id)));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    // ---------- Web: visit slot timings per hospital (Lab Package Orders → Settings) ----------

    async slotTimings(req: Request, res: Response) {
        try {
            const data = await labSlotService.timingsForStaff(requesterOf(req), Number(req.query.hospitalId));
            return res.json(ApiResponse.success(data, "Slot timings fetched."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    async saveSlotTimings(req: Request, res: Response) {
        try {
            const data = await labSlotService.saveTimings(requesterOf(req), Number(req.body?.hospitalId), req.body?.slots ?? []);
            return res.json(ApiResponse.success(data, "Slot timings saved."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    /** The patient-app switches for a hospital: slot choice, rescheduling, collection address. */
    async saveAppOptions(req: Request, res: Response) {
        try {
            const data = await labSlotService.saveAppOptions(requesterOf(req), Number(req.body?.hospitalId), req.body?.appOptions);
            return res.json(ApiResponse.success(data, "App options saved."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    // ---------- Mobile: patient ----------

    async patientPackages(req: Request, res: Response) {
        try {
            const data = await labPackageService.listForPatient(requesterOf(req), req.body?.pincode ?? (req.query.pincode as string | undefined));
            return res.json(ApiResponse.success(data, "Lab packages fetched."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    async patientHospitals(req: Request, res: Response) {
        try {
            const data = await labPackageService.hospitalsForPackage(Number(req.body?.packageId), req.body?.pincode);
            return res.json(ApiResponse.success(data, "Hospitals fetched."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    async patientCreateOrder(req: Request, res: Response) {
        try {
            const requesterId = requesterOf(req);
            if (!requesterId) return res.status(401).json(ApiResponse.error("Sign in again to book a lab package."));
            const data = await labPackageOrderService.createOrder(requesterId, {
                packageId: Number(req.body?.packageId),
                hospitalId: Number(req.body?.hospitalId),
                pincode: req.body?.pincode,
                preferredDate: req.body?.preferredDate,
                slotStart: req.body?.slotStart,
                notes: req.body?.notes,
                address: req.body?.address
            });
            return res.json(ApiResponse.success(data, "Lab package order created."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    /** Addresses the patient can pick for sample collection. */
    async patientAddresses(req: Request, res: Response) {
        try {
            const requesterId = requesterOf(req);
            if (!requesterId) return res.status(401).json(ApiResponse.error("Sign in again to see your addresses."));
            const data = await labPackageOrderService.savedAddresses(requesterId);
            return res.json(ApiResponse.success(data, "Addresses fetched."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    async patientVerifyPayment(req: Request, res: Response) {
        try {
            const data = await labPackageOrderService.verifyPayment(req.body || {});
            return res.json(ApiResponse.success(data, "Payment verified."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    async patientOrders(req: Request, res: Response) {
        try {
            return res.json(ApiResponse.success(await labPackageOrderService.myOrders(requesterOf(req)), "Lab orders fetched."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    /** Bookable visit slots, for an order ({orderId}) or a hospital at checkout ({hospitalId}). */
    async patientSlots(req: Request, res: Response) {
        try {
            const data = await labPackageOrderService.slotOptions(requesterOf(req), {
                orderId: req.body?.orderId,
                hospitalId: req.body?.hospitalId ? Number(req.body.hospitalId) : undefined
            });
            return res.json(ApiResponse.success(data, "Slots fetched."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    /** Pick or move the visit slot of a paid order ({date, slotStart}). */
    async patientSetSlot(req: Request, res: Response) {
        try {
            const data = await labPackageOrderService.setSlot(requesterOf(req), String(req.params.id), {
                date: req.body?.date,
                slotStart: req.body?.slotStart
            });
            return res.json(ApiResponse.success(data, "Visit slot saved."));
        } catch (error: any) {
            return fail(res, error);
        }
    }

    async patientReport(req: Request, res: Response) {
        try {
            return sendFile(res, await labPackageOrderService.reportForPatient(requesterOf(req), String(req.params.id)));
        } catch (error: any) {
            return fail(res, error);
        }
    }
}

export const labPackageController = new LabPackageController();
