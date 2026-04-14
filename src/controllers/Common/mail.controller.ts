import type { Request, Response } from "express";
import { mailService } from "../../services/Mail/mail.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

/**
 * Controller for Mail related operations.
 */
export class MailController {
    /**
     * Sends a test email to verify SMTP configuration.
     * POST /api/mail/test
     */
    async sendTestEmail(req: Request, res: Response): Promise<any> {
        try {
            const { to } = req.body;
            if (!to) {
                return res.status(400).json(ApiResponse.error("Recipient email (to) is required."));
            }

            await mailService.sendTestEmail(to);
            return res.json(ApiResponse.success(null, `Test email sent successfully to ${to}.`));
        } catch (error: any) {
            console.error("[MailController] Error sending test email:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to send test email."));
        }
    }

    /**
     * Sends a detailed welcome test email using the WELCOME_EMAIL template.
     * POST /api/mail/test-welcome
     */
    async sendWelcomeTestEmail(req: Request, res: Response): Promise<any> {
        try {
            const { to } = req.body;
            if (!to) {
                return res.status(400).json(ApiResponse.error("Recipient email (to) is required."));
            }

            // Using dummy data to test all placeholders in the WELCOME_EMAIL template
            await mailService.sendDynamicEmail("WELCOME_EMAIL", to, {
                FirstName: "John",
                LastName: "Doe",
                RoleMessage: "You have been successfully registered as a <strong>System Administrator</strong>.",
                Email: to,
                Password: "TemporaryPassword@123",
                Role: "Administrator",
                OrganizationName: "Clinicx Global Health",
                LoginURL: process.env.CLIENT_URL || "https://clinicx.azurewebsites.net/"
            });
            
            return res.json(ApiResponse.success(null, `Welcome test email sent successfully to ${to}.`));
        } catch (error: any) {
            console.error("[MailController] Error sending welcome test email:", error);
            return res.status(500).json(ApiResponse.error(error.message || "Failed to send welcome test email."));
        }
    }
}

export const mailController = new MailController();
