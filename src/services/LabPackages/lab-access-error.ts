/** An error the lab package APIs report with this HTTP status instead of 400. */
export class LabAccessError extends Error {
    constructor(message: string, public status = 403) {
        super(message);
    }
}
