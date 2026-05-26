export enum AppointmentStatus {
    PaymentPending = "PaymentPending",
    Scheduled = "Scheduled",
    Confirmed = "Confirmed",
    Arrived = "Arrived",
    InProgress = "InProgress",
    Completed = "Completed",
    Cancelled = "Cancelled",
    NoShow = "NoShow"
}

export enum AppointmentType {
    Consultation = "Consultation",
    FollowUp = "FollowUp",
    CheckUp = "CheckUp",
    TeleConsultation = "TeleConsultation"
}

export enum QueueStatus {
    Waiting = "Waiting",
    Called = "Called",
    WithDoctor = "WithDoctor",
    Completed = "Completed",
    Skipped = "Skipped"
}

export enum ConsentStatus {
    Pending = "Pending",
    Sent = "Sent",
    Signed = "Signed"
}

export enum CheckInStatus {
    Pending = "Pending",
    Verified = "Verified",
    InProgress = "InProgress",
    Completed = "Completed"
}

export enum VisitStatus {
    InProgress = "InProgress",
    Completed = "Completed",
    Cancelled = "Cancelled"
}

export enum DocumentType {
    Prescription = "Prescription",
    Report = "Report",
    Invoice = "Invoice",
    IDProof = "IDProof",
    Insurance = "Insurance"
}
