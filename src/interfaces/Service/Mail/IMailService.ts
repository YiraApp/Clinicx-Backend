/**
 * Interface for Mail Service.
 */
export interface IMailService {
    /**
     * Sends a dynamic email based on a database template.
     * @param templateCode The unique code for the template.
     * @param to Recipient email address or comma-separated list of addresses.
     * @param data Data for placeholder replacement.
     */
    sendDynamicEmail(templateCode: string, to: string, data: Record<string, any>): Promise<void>;

    /**
     * Sends a simple test email to verify SMTP configuration.
     * @param to Recipient email address.
     */
    sendTestEmail(to: string): Promise<void>;
}
