import nodemailer from "nodemailer";
import { templateRepository } from "../../repositories/Common/template.repository.js";
import type { IMailService } from "../../interfaces/Service/Mail/IMailService.js";

/**
 * Service for sending emails using dynamic templates from the database.
 */
export class MailService implements IMailService {
    private transporter: nodemailer.Transporter;

    constructor() {
        const port = parseInt(process.env.EMAIL_PORT!);
        this.transporter = nodemailer.createTransport({
            host: process.env.EMAIL_HOST!,
            port: port,
            secure: port === 465, // true for 465, false for other ports
            auth: {
                user: process.env.EMAIL_USER!,
                pass: process.env.EMAIL_PASS!,
            },
        });
    }

    /**
     * Replaces placeholders in a string with data from a dictionary.
     * Supports both {{variableName}} and {variableName} formats.
     */
    private replacePlaceholders(content: string, data: Record<string, any>): string {
        if (!content) return "";
        // Replace {{variable}} or {variable}
        return content.replace(/{{?(\w+)}?}/g, (match, key) => {
            return data[key] !== undefined ? data[key] : match;
        });
    }

    /**
     * Sends a dynamic email based on a database template.
     * @param templateCode The unique code for the template.
     * @param to Recipient email address or comma-separated list of addresses.
     * @param data Data for placeholder replacement (e.g., { name: "John", link: "..." }).
     */
    async sendDynamicEmail(templateCode: string, to: string, data: Record<string, any>): Promise<void> {
        const template = await templateRepository.findByCode(templateCode);

        if (!template) {
            console.error(`Mail Template with code ${templateCode} not found.`);
            return; // Or throw error based on preference
        }

        const subject = this.replacePlaceholders(template.Title, data);
        const html = this.replacePlaceholders(template.Message, data);

        await this.sendMail({
            to: to,
            subject: subject,
            body: html
        });
    }

    /**
     * Sends a direct email with provided subject and body.
     */
    async sendMail(options: { to: string; subject: string; body: string }): Promise<void> {
        const mailOptions = {
            from: `"${process.env.EMAIL_FROM_ALIAS}" <${process.env.EMAIL_FROM}>`,
            to: options.to,
            subject: options.subject,
            html: options.body,
            replyTo: process.env.EMAIL_REPLY_TO,
        };

        try {
            await this.transporter.sendMail(mailOptions);
            console.log(`Email sent successfully to ${options.to}`);
        } catch (error: any) {
            console.error(`Error sending email to ${options.to}:`, error);
            throw new Error(`Failed to send email: ${error.message}`);
        }
    }

    /**
     * Sends a simple test email to verify SMTP configuration.
     * @param to Recipient email address.
     */
    async sendTestEmail(to: string): Promise<void> {
        const mailOptions = {
            from: `"${process.env.EMAIL_FROM_ALIAS}" <${process.env.EMAIL_FROM}>`,
            to: to,
            subject: "Clinicx - SMTP Test Email",
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                    <h2 style="color: #1920d9;">SMTP Configuration Test</h2>
                    <p>Hello,</p>
                    <p>This is a test email from the <strong>Clinicx Backend</strong> to verify your SMTP settings.</p>
                    <p>If you received this, your email configuration is working correctly!</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                    <p style="font-size: 12px; color: #777;">Sent at: ${new Date().toLocaleString()}</p>
                </div>
            `,
            replyTo: process.env.EMAIL_REPLY_TO,
        };

        try {
            await this.transporter.sendMail(mailOptions);
            console.log(`Test email sent successfully to ${to}`);
        } catch (error) {
            console.error(`Error sending test email to ${to}:`, error);
            throw new Error("Failed to send test email.");
        }
    }
}

export const mailService = new MailService();
