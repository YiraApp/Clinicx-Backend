import { AppDataSource } from "../../config/database.js";

export class MigrationService {
    static async ensureLogIndexes() {
        try {
            console.log("Checking APILog indexes...");
            const queries = [
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_APILogs_RequestedOn' AND object_id = OBJECT_ID('APILogs')) CREATE INDEX IX_APILogs_RequestedOn ON APILogs (RequestedOn DESC);",
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_APILogs_LogId_DESC' AND object_id = OBJECT_ID('APILogs')) CREATE INDEX IX_APILogs_LogId_DESC ON APILogs (LogId DESC);",
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_APILogs_Method' AND object_id = OBJECT_ID('APILogs')) CREATE INDEX IX_APILogs_Method ON APILogs (Method);",
                
                // Consent Request Schema Updates
                "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ConsentRequests') AND name = 'SignedPdfUrl') ALTER TABLE ConsentRequests ADD SignedPdfUrl NVARCHAR(MAX) NULL;",
                "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ConsentRequests') AND name = 'SignatureImageUrl') ALTER TABLE ConsentRequests ADD SignatureImageUrl NVARCHAR(MAX) NULL;",

                // Consent Template Fields Schema Updates
                "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('ConsentTemplateFields') AND name = 'FieldKey') ALTER TABLE ConsentTemplateFields ADD FieldKey NVARCHAR(100) NULL;",

                // Password Reset Tokens Table
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PasswordResetTokens')
                CREATE TABLE PasswordResetTokens (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    UserId UNIQUEIDENTIFIER NOT NULL,
                    Token VARCHAR(500) NOT NULL,
                    ExpiryTime DATETIME NOT NULL,
                    IsUsed BIT DEFAULT 0,
                    CreatedAt DATETIME DEFAULT GETDATE(),
                    UsedAt DATETIME NULL,
                    CONSTRAINT FK_PasswordResetTokens_Users FOREIGN KEY (UserId) REFERENCES Users(Id)
                );`,

                // Patient Access Consents Table (Doctor Medical Record Access Permissions)
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PatientAccessConsents')
                CREATE TABLE PatientAccessConsents (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    PatientId UNIQUEIDENTIFIER NOT NULL,
                    DoctorId UNIQUEIDENTIFIER NOT NULL,
                    HospitalId INT NULL,
                    OrganizationId INT NULL,
                    Duration NVARCHAR(50) NOT NULL,
                    DurationMinutes INT NOT NULL DEFAULT 60,
                    Status NVARCHAR(50) NOT NULL DEFAULT 'PENDING',
                    RequestedAt DATETIME NOT NULL DEFAULT GETDATE(),
                    ApprovedAt DATETIME NULL,
                    ExpiresAt DATETIME NULL,
                    Notes NVARCHAR(500) NULL,
                    CreatedAt DATETIME DEFAULT GETDATE(),
                    UpdatedAt DATETIME DEFAULT GETDATE()
                );`,

                // Patient Profile Share Links (read-only web links for doctors not on Yira)
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PatientProfileShareLinks')
                CREATE TABLE PatientProfileShareLinks (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    PatientId UNIQUEIDENTIFIER NOT NULL,
                    CreatedByUserId UNIQUEIDENTIFIER NOT NULL,
                    TokenHash VARCHAR(64) NOT NULL,
                    Label NVARCHAR(120) NULL,
                    ExpiresAt DATETIME NOT NULL,
                    RevokedAt DATETIME NULL,
                    ViewCount INT NOT NULL DEFAULT 0,
                    LastViewedAt DATETIME NULL,
                    CreatedAt DATETIME NOT NULL DEFAULT GETDATE()
                );`,
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_PatientProfileShareLinks_TokenHash' AND object_id = OBJECT_ID('PatientProfileShareLinks')) CREATE UNIQUE INDEX UX_PatientProfileShareLinks_TokenHash ON PatientProfileShareLinks (TokenHash);",
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_PatientProfileShareLinks_PatientId' AND object_id = OBJECT_ID('PatientProfileShareLinks')) CREATE INDEX IX_PatientProfileShareLinks_PatientId ON PatientProfileShareLinks (PatientId);",

                // My billing: bills patients add themselves
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PatientManualBills')
                CREATE TABLE PatientManualBills (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    PatientId UNIQUEIDENTIFIER NOT NULL,
                    CreatedByUserId UNIQUEIDENTIFIER NOT NULL,
                    Title NVARCHAR(150) NOT NULL,
                    ProviderName NVARCHAR(200) NULL,
                    Category VARCHAR(40) NOT NULL,
                    BillDate DATE NOT NULL,
                    BillNumber NVARCHAR(80) NULL,
                    TotalAmount DECIMAL(18,2) NOT NULL,
                    PaidAmount DECIMAL(18,2) NOT NULL DEFAULT 0,
                    PaymentMode VARCHAR(40) NULL,
                    Notes NVARCHAR(1000) NULL,
                    FileUrl NVARCHAR(MAX) NULL,
                    FileName NVARCHAR(255) NULL,
                    IsDeleted BIT NOT NULL DEFAULT 0,
                    CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                    UpdatedAt DATETIME NULL
                );`,
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_PatientManualBills_PatientId' AND object_id = OBJECT_ID('PatientManualBills')) CREATE INDEX IX_PatientManualBills_PatientId ON PatientManualBills (PatientId, BillDate DESC);",

                // My policies: insurance policies and schemes patients add themselves
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PatientPolicies')
                CREATE TABLE PatientPolicies (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    PatientId UNIQUEIDENTIFIER NOT NULL,
                    CreatedByUserId UNIQUEIDENTIFIER NOT NULL,
                    PolicyType VARCHAR(40) NOT NULL,
                    Insurer NVARCHAR(200) NOT NULL,
                    PolicyName NVARCHAR(200) NULL,
                    PolicyNumber NVARCHAR(100) NOT NULL,
                    MemberId NVARCHAR(100) NULL,
                    SumInsured DECIMAL(18,2) NULL,
                    Premium DECIMAL(18,2) NULL,
                    StartDate DATE NULL,
                    EndDate DATE NULL,
                    TpaName NVARCHAR(200) NULL,
                    HelplineNumber NVARCHAR(40) NULL,
                    CoveredMembers NVARCHAR(500) NULL,
                    Notes NVARCHAR(1000) NULL,
                    FileUrl NVARCHAR(MAX) NULL,
                    FileName NVARCHAR(255) NULL,
                    IsDeleted BIT NOT NULL DEFAULT 0,
                    CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                    UpdatedAt DATETIME NULL
                );`,
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_PatientPolicies_PatientId' AND object_id = OBJECT_ID('PatientPolicies')) CREATE INDEX IX_PatientPolicies_PatientId ON PatientPolicies (PatientId);",

                // Lab tests: each hospital's list, and the tests doctors order
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'HospitalLabTests')
                CREATE TABLE HospitalLabTests (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    HospitalId INT NOT NULL,
                    OrganizationId INT NULL,
                    TestName NVARCHAR(200) NOT NULL,
                    TestCode NVARCHAR(50) NULL,
                    Category NVARCHAR(100) NOT NULL,
                    SampleType NVARCHAR(100) NULL,
                    Price DECIMAL(18,2) NULL,
                    Preparation NVARCHAR(500) NULL,
                    IsActive BIT NOT NULL DEFAULT 1,
                    IsDeleted BIT NOT NULL DEFAULT 0,
                    CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                    UpdatedAt DATETIME NULL
                );`,
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_HospitalLabTests_Hospital') CREATE INDEX IX_HospitalLabTests_Hospital ON HospitalLabTests(HospitalId, IsDeleted, IsActive);",
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PrescriptionLabTests')
                CREATE TABLE PrescriptionLabTests (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    PrescriptionId UNIQUEIDENTIFIER NOT NULL,
                    HospitalLabTestId INT NULL,
                    TestName NVARCHAR(200) NOT NULL,
                    Category NVARCHAR(100) NULL,
                    Priority NVARCHAR(20) NOT NULL DEFAULT 'Routine',
                    Instructions NVARCHAR(500) NULL,
                    CreatedAt DATETIME NOT NULL DEFAULT GETDATE()
                );`,
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_PrescriptionLabTests_Prescription') CREATE INDEX IX_PrescriptionLabTests_Prescription ON PrescriptionLabTests(PrescriptionId);",

                // Lab packages sold in the patient app, the hospitals offering them, their orders and payments
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'LabPackages')
                CREATE TABLE LabPackages (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    Name NVARCHAR(200) NOT NULL,
                    Description NVARCHAR(MAX) NULL,
                    TestsIncluded NVARCHAR(MAX) NULL,
                    SampleType NVARCHAR(100) NULL,
                    Preparation NVARCHAR(500) NULL,
                    ReportTurnaround NVARCHAR(100) NULL,
                    Mrp DECIMAL(18,2) NULL,
                    Price DECIMAL(18,2) NOT NULL DEFAULT 0,
                    GstPercentage DECIMAL(5,2) NOT NULL DEFAULT 0,
                    GstAmount DECIMAL(18,2) NOT NULL DEFAULT 0,
                    TotalAmount DECIMAL(18,2) NOT NULL DEFAULT 0,
                    ShowInMobileApp BIT NOT NULL DEFAULT 1,
                    Pincodes NVARCHAR(MAX) NULL,
                    IsActive BIT NOT NULL DEFAULT 1,
                    IsDeleted BIT NOT NULL DEFAULT 0,
                    CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                    CreatedBy UNIQUEIDENTIFIER NULL,
                    UpdatedAt DATETIME NULL,
                    UpdatedBy UNIQUEIDENTIFIER NULL
                );`,
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'LabPackageHospitals')
                CREATE TABLE LabPackageHospitals (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    LabPackageId INT NOT NULL,
                    HospitalId INT NOT NULL,
                    CreatedAt DATETIME NOT NULL DEFAULT GETDATE()
                );`,
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_LabPackageHospitals_Package' AND object_id = OBJECT_ID('LabPackageHospitals')) CREATE INDEX IX_LabPackageHospitals_Package ON LabPackageHospitals(LabPackageId, HospitalId);",
                "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('LabPackages') AND name = 'Benefits') ALTER TABLE LabPackages ADD Benefits NVARCHAR(MAX) NULL;",
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'LabPackageOrders')
                CREATE TABLE LabPackageOrders (
                    Id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
                    OrderNumber NVARCHAR(50) NOT NULL,
                    LabPackageId INT NOT NULL,
                    PackageName NVARCHAR(200) NOT NULL,
                    TestsIncluded NVARCHAR(MAX) NULL,
                    Price DECIMAL(18,2) NOT NULL DEFAULT 0,
                    GstPercentage DECIMAL(5,2) NOT NULL DEFAULT 0,
                    GstAmount DECIMAL(18,2) NOT NULL DEFAULT 0,
                    TotalAmount DECIMAL(18,2) NOT NULL DEFAULT 0,
                    PatientId UNIQUEIDENTIFIER NOT NULL,
                    HospitalId INT NOT NULL,
                    OrganizationId INT NULL,
                    Pincode VARCHAR(10) NULL,
                    PreferredDate DATE NULL,
                    Notes NVARCHAR(500) NULL,
                    Status VARCHAR(30) NOT NULL DEFAULT 'PaymentPending',
                    ReportUrl NVARCHAR(MAX) NULL,
                    ReportFileName NVARCHAR(255) NULL,
                    ReportUploadedAt DATETIME NULL,
                    ReportUploadedBy UNIQUEIDENTIFIER NULL,
                    CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                    UpdatedAt DATETIME NULL,
                    UpdatedBy UNIQUEIDENTIFIER NULL
                );`,
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_LabPackageOrders_Hospital' AND object_id = OBJECT_ID('LabPackageOrders')) CREATE INDEX IX_LabPackageOrders_Hospital ON LabPackageOrders(HospitalId, Status, CreatedAt DESC);",
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_LabPackageOrders_Patient' AND object_id = OBJECT_ID('LabPackageOrders')) CREATE INDEX IX_LabPackageOrders_Patient ON LabPackageOrders(PatientId, CreatedAt DESC);",
                // Visit slot of a lab package order, and the hospital's slot timings (Lab Package Orders → Settings)
                "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('LabPackageOrders') AND name = 'SlotStart') ALTER TABLE LabPackageOrders ADD SlotStart VARCHAR(5) NULL;",
                "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('LabPackageOrders') AND name = 'SlotEnd') ALTER TABLE LabPackageOrders ADD SlotEnd VARCHAR(5) NULL;",
                "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('LabPackageOrders') AND name = 'SlotUpdatedAt') ALTER TABLE LabPackageOrders ADD SlotUpdatedAt DATETIME NULL;",
                // The lab report's copy in the patient's documents
                "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('LabPackageOrders') AND name = 'MedicalDocumentId') ALTER TABLE LabPackageOrders ADD MedicalDocumentId BIGINT NULL;",
                "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('LabPackageOrders') AND name = 'RescheduleCount') ALTER TABLE LabPackageOrders ADD RescheduleCount INT NOT NULL CONSTRAINT DF_LabPackageOrders_RescheduleCount DEFAULT 0;",
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'LabSlotTimings')
                CREATE TABLE LabSlotTimings (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    HospitalId INT NOT NULL,
                    StartTime VARCHAR(5) NOT NULL,
                    EndTime VARCHAR(5) NOT NULL,
                    IsActive BIT NOT NULL DEFAULT 1,
                    CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                    CreatedBy UNIQUEIDENTIFIER NULL
                );`,
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_LabSlotTimings_Hospital' AND object_id = OBJECT_ID('LabSlotTimings')) CREATE INDEX IX_LabSlotTimings_Hospital ON LabSlotTimings(HospitalId, StartTime);",
                // What the patient app offers per hospital (Lab Packages → Settings); no row = defaults
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'LabPackageSettings')
                CREATE TABLE LabPackageSettings (
                    HospitalId INT NOT NULL PRIMARY KEY,
                    PatientSlots BIT NOT NULL DEFAULT 1,
                    PatientReschedule BIT NOT NULL DEFAULT 1,
                    CollectAddress BIT NOT NULL DEFAULT 0,
                    UpdatedAt DATETIME NULL,
                    UpdatedBy UNIQUEIDENTIFIER NULL
                );`,
                "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('LabPackageOrders') AND name = 'CollectionAddress') ALTER TABLE LabPackageOrders ADD CollectionAddress NVARCHAR(MAX) NULL;",
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'LabPackagePayments')
                CREATE TABLE LabPackagePayments (
                    Id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
                    LabPackageOrderId UNIQUEIDENTIFIER NOT NULL,
                    HospitalId INT NOT NULL,
                    TransactionId NVARCHAR(100) NOT NULL,
                    GatewayOrderId NVARCHAR(200) NULL,
                    GatewayPaymentId NVARCHAR(200) NULL,
                    GatewaySignature NVARCHAR(MAX) NULL,
                    Amount DECIMAL(18,2) NOT NULL,
                    Currency VARCHAR(10) NOT NULL DEFAULT 'INR',
                    Method VARCHAR(50) NULL,
                    Status VARCHAR(20) NOT NULL DEFAULT 'Pending',
                    FailureReason NVARCHAR(500) NULL,
                    CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                    UpdatedAt DATETIME NULL
                );`,
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_LabPackagePayments_Order' AND object_id = OBJECT_ID('LabPackagePayments')) CREATE INDEX IX_LabPackagePayments_Order ON LabPackagePayments(LabPackageOrderId);",
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_LabPackagePayments_GatewayOrder' AND object_id = OBJECT_ID('LabPackagePayments')) CREATE INDEX IX_LabPackagePayments_GatewayOrder ON LabPackagePayments(GatewayOrderId);",

                // India Post pincode directory (loaded with `npm run import-pincodes`) for adding pincodes by state/district
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PincodeDirectory')
                CREATE TABLE PincodeDirectory (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    Pincode VARCHAR(6) NOT NULL,
                    OfficeName NVARCHAR(200) NOT NULL,
                    OfficeType VARCHAR(30) NULL,
                    Delivery VARCHAR(30) NULL,
                    District NVARCHAR(100) NOT NULL,
                    State NVARCHAR(100) NOT NULL
                );`,
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_PincodeDirectory_StateDistrict' AND object_id = OBJECT_ID('PincodeDirectory')) CREATE INDEX IX_PincodeDirectory_StateDistrict ON PincodeDirectory(State, District, Pincode);",
                "IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_PincodeDirectory_Pincode' AND object_id = OBJECT_ID('PincodeDirectory')) CREATE INDEX IX_PincodeDirectory_Pincode ON PincodeDirectory(Pincode);",
                "IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('PincodeDirectory') AND name = 'Source') ALTER TABLE PincodeDirectory ADD Source VARCHAR(20) NULL;",

                // Seed default AppVersions if not existing
                `IF NOT EXISTS (SELECT * FROM AppVersions WHERE Platform = 'android')
                INSERT INTO AppVersions (Platform, Version, MinVersion, ForceUpdate, Url, IsLatest, IsDeleted, CreatedAt, Maintenance, Logout)
                VALUES ('android', '1.0.0', '1.0.0', 0, 'https://play.google.com/store/apps/details?id=ai.yira.clinicx', 1, 0, GETDATE(), 0, 0);`,

                `IF NOT EXISTS (SELECT * FROM AppVersions WHERE Platform = 'ios')
                INSERT INTO AppVersions (Platform, Version, MinVersion, ForceUpdate, Url, IsLatest, IsDeleted, CreatedAt, Maintenance, Logout)
                VALUES ('ios', '1.0.0', '1.0.0', 0, 'https://apps.apple.com/app/yira-clinx/id6741477759', 1, 0, GETDATE(), 0, 0);`
            ];

            for (const query of queries) {
                await AppDataSource.query(query);
            }
            console.log("APILog indexes guaranteed.");
        } catch (error) {
            console.error("Failed to ensure log indexes:", error);
        }
    }

    /**
     * Columns for the medicine order on prescriptions and the clinical note in medical records.
     * Each statement runs on its own, so one failure doesn't skip the rest; all are no-ops once added.
     */
    static async ensureClinicalColumns() {
        const columns: Array<[string, string, string]> = [
            ["PrescriptionMedication", "SortOrder", "INT NULL"],
            ["PatientMedicalRecord", "RespiratoryRate", "NVARCHAR(50) NULL"],
            ["PatientMedicalRecord", "Allergies", "NVARCHAR(MAX) NULL"],
            ["PatientMedicalRecord", "FamilyHistory", "NVARCHAR(MAX) NULL"],
            ["PatientMedicalRecord", "HistoryOfPresentIllness", "NVARCHAR(MAX) NULL"],
            ["PatientMedicalRecord", "PastHistory", "NVARCHAR(MAX) NULL"],
            ["PatientMedicalRecord", "CurrentMedications", "NVARCHAR(MAX) NULL"],
            ["PatientMedicalRecord", "CvsExamination", "NVARCHAR(1000) NULL"],
            ["PatientMedicalRecord", "RespiratoryExamination", "NVARCHAR(1000) NULL"],
            ["PatientMedicalRecord", "AbdomenExamination", "NVARCHAR(1000) NULL"],
            ["PatientMedicalRecord", "CnsExamination", "NVARCHAR(1000) NULL"],
            ["PatientMedicalRecord", "DiagnosisType", "NVARCHAR(20) NULL"],
            ["PatientMedicalRecord", "SpO2", "NVARCHAR(50) NULL"],
        ];
        for (const [table, column, type] of columns) {
            try {
                await AppDataSource.query(
                    `IF OBJECT_ID('${table}') IS NOT NULL AND NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('${table}') AND name = '${column}') ALTER TABLE ${table} ADD ${column} ${type};`
                );
            } catch (error: any) {
                console.error(`[Migration] ${table}.${column}: ${error.message}`);
            }
        }
    }
}
