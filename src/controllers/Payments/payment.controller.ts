import { Request, Response } from "express";
import { paymentService } from "../../services/Payments/payment.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

export class PaymentController {
    async createOrder(req: Request, res: Response) {
        try {
            const result = await paymentService.createOrder(req.body);
            return res.status(201).json(ApiResponse.success(result, "Order created successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async verify(req: Request, res: Response) {
        try {
            const result = await paymentService.verifyPayment(req.body);
            return res.json(ApiResponse.success(result, "Payment verified successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async webhook(req: Request, res: Response) {
        try {
            const signature = req.headers["x-razorpay-signature"] as string;
            const result = await paymentService.handleWebhook(req.body, signature);
            return res.json(result);
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async collectManualCash(req: Request, res: Response) {
        try {
            const result = await paymentService.collectManualCash(req.body);
            return res.json(ApiResponse.success(result, "Cash payment recorded successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async sendPaymentLink(req: Request, res: Response) {
        try {
            const rawOrigin = req.headers.origin;
            let clientUrl = Array.isArray(rawOrigin) ? rawOrigin[0] : (rawOrigin || "");
            if (!clientUrl && req.headers.referer) {
                try {
                    clientUrl = new URL(req.headers.referer as string).origin;
                } catch {
                    clientUrl = "http://localhost:5173";
                }
            }
            if (!clientUrl) {
                clientUrl = "http://localhost:5173";
            }
            
            const result = await paymentService.sendPaymentLink({ ...req.body, clientUrl });
            return res.json(ApiResponse.success(result, "Payment link sent successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }


    async lookupTransaction(req: Request, res: Response) {
        try {
            const { transactionId } = req.params;
            const result = await paymentService.lookupTransaction(transactionId as string);
            return res.json(ApiResponse.success(result, "Transaction looked up successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async getBillsList(req: Request, res: Response) {
        try {
            const { orgId, hospitalId, providerId, billStatus, startDate, endDate, search, page, limit } = req.query;
            const result = await paymentService.getBillsList({
                orgId: orgId ? parseInt(orgId as string) : undefined,
                hospitalId: hospitalId ? parseInt(hospitalId as string) : undefined,
                providerId: providerId as string | undefined,
                billStatus: billStatus as string | undefined,
                startDate: startDate as string | undefined,
                endDate: endDate as string | undefined,
                search: search as string | undefined,
                page: page ? parseInt(page as string) : 1,
                limit: limit ? parseInt(limit as string) : 20
            });
            return res.json(ApiResponse.success(result, "Bills list fetched successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async getBillingList(req: Request, res: Response) {
        try {
            const {
                orgId,
                hospitalId,
                providerId,
                status,
                startDate,
                endDate,
                page,
                limit,
                search
            } = req.query;

            const { data, total, totalAmount, totalPages } = await paymentService.getBillingList({
                orgId: orgId ? parseInt(orgId as string) : undefined,
                hospitalId: hospitalId ? parseInt(hospitalId as string) : undefined,
                providerId: providerId as string | undefined,
                status: status as string | undefined,
                startDate: startDate as string | undefined,
                endDate: endDate as string | undefined,
                page: page ? parseInt(page as string) : 1,
                limit: limit ? parseInt(limit as string) : 50,
                search: search as string | undefined
            });

            return res.json({
                status: true,
                message: "Billing list fetched successfully.",
                data,
                total,
                totalAmount,
                page: page ? parseInt(page as string) : 1,
                limit: limit ? parseInt(limit as string) : 50,
                totalPages
            });
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async getPaymentDetail(req: Request, res: Response) {
        try {
            const { paymentId } = req.params;
            const result = await paymentService.getPaymentDetail(paymentId as string);
            return res.json(ApiResponse.success(result, "Payment details retrieved successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async getHospitalPaymentConfiguration(req: Request, res: Response) {
        try {
            const hospitalId = parseInt(req.params.hospitalId as string);
            if (!hospitalId) {
                return res.status(400).json(ApiResponse.error("Hospital ID is required."));
            }
            const result = await paymentService.getHospitalPaymentConfiguration(hospitalId);
            return res.json(ApiResponse.success(result, "Hospital payment configurations retrieved successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async saveHospitalPaymentConfiguration(req: Request, res: Response) {
        try {
            const result = await paymentService.saveHospitalPaymentConfiguration(req.body);
            return res.json(ApiResponse.success(result, "Hospital payment configurations saved successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

}


export const paymentController = new PaymentController();
