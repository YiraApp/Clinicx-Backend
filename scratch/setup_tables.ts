import { AppDataSource } from "../src/config/database.js";
import dotenv from "dotenv";
dotenv.config();

async function run() {
    console.log("Initializing database connection...");
    await AppDataSource.initialize();
    console.log("Database initialized successfully!");

    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();

    try {
        console.log("Checking if HospitalPaymentConfigurations exists...");
        const hasConfigTable = await queryRunner.hasTable("HospitalPaymentConfigurations");
        if (!hasConfigTable) {
            console.log("Creating HospitalPaymentConfigurations table...");
            await queryRunner.query(`
                CREATE TABLE HospitalPaymentConfigurations
                (
                    HospitalPaymentConfigurationId UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
                    HospitalId INT NOT NULL,
                    PaymentGateway VARCHAR(50) NULL,
                    RazorpayKeyId NVARCHAR(255) NULL,
                    RazorpayKeySecret NVARCHAR(500) NULL,
                    GstPercentage DECIMAL(5,2) NOT NULL DEFAULT 0,
                    CgstPercentage DECIMAL(5,2) NOT NULL DEFAULT 0,
                    SgstPercentage DECIMAL(5,2) NOT NULL DEFAULT 0,
                    IgstPercentage DECIMAL(5,2) NOT NULL DEFAULT 0,
                    GstNumber NVARCHAR(100) NULL,
                    InvoicePrefix NVARCHAR(50) NOT NULL DEFAULT 'INV',
                    InvoiceSequence INT NOT NULL DEFAULT 1,
                    CurrencyCode VARCHAR(10) NOT NULL DEFAULT 'INR',
                    IsActive BIT NOT NULL DEFAULT 1,
                    IsDeleted BIT NOT NULL DEFAULT 0,
                    CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                    CreatedBy UNIQUEIDENTIFIER NULL,
                    UpdatedAt DATETIME NULL,
                    UpdatedBy UNIQUEIDENTIFIER NULL
                );
            `);
            console.log("HospitalPaymentConfigurations table created successfully!");
        } else {
            console.log("HospitalPaymentConfigurations table already exists.");
        }

        console.log("Checking if AppointmentBills exists...");
        const hasBillsTable = await queryRunner.hasTable("AppointmentBills");
        if (!hasBillsTable) {
            console.log("Creating AppointmentBills table...");
            await queryRunner.query(`
                CREATE TABLE AppointmentBills
                (
                    AppointmentBillId UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
                    AppointmentId INT NULL,
                    PatientId UNIQUEIDENTIFIER NOT NULL,
                    ProviderId UNIQUEIDENTIFIER NULL,
                    HospitalId INT NOT NULL,
                    BillNumber NVARCHAR(50) NOT NULL,
                    BillType VARCHAR(50) NOT NULL,
                    SubTotal DECIMAL(18,2) NOT NULL DEFAULT 0,
                    DiscountAmount DECIMAL(18,2) NOT NULL DEFAULT 0,
                    GstAmount DECIMAL(18,2) NOT NULL DEFAULT 0,
                    CgstAmount DECIMAL(18,2) NOT NULL DEFAULT 0,
                    SgstAmount DECIMAL(18,2) NOT NULL DEFAULT 0,
                    IgstAmount DECIMAL(18,2) NOT NULL DEFAULT 0,
                    TotalAmount DECIMAL(18,2) NOT NULL DEFAULT 0,
                    PaidAmount DECIMAL(18,2) NOT NULL DEFAULT 0,
                    DueAmount DECIMAL(18,2) NOT NULL DEFAULT 0,
                    BillStatus VARCHAR(50) NOT NULL,
                    Notes NVARCHAR(MAX) NULL,
                    CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                    CreatedBy UNIQUEIDENTIFIER NULL,
                    UpdatedAt DATETIME NULL,
                    UpdatedBy UNIQUEIDENTIFIER NULL,
                    IsDeleted BIT NOT NULL DEFAULT 0
                );
            `);
            console.log("AppointmentBills table created successfully!");
        } else {
            console.log("AppointmentBills table already exists.");
        }

        console.log("Checking if AppointmentBillItems exists...");
        const hasBillItemsTable = await queryRunner.hasTable("AppointmentBillItems");
        if (!hasBillItemsTable) {
            console.log("Creating AppointmentBillItems table...");
            await queryRunner.query(`
                CREATE TABLE AppointmentBillItems
                (
                    AppointmentBillItemId UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
                    AppointmentBillId UNIQUEIDENTIFIER NOT NULL,
                    ItemType VARCHAR(50) NOT NULL,
                    ItemReferenceId UNIQUEIDENTIFIER NULL,
                    ItemName NVARCHAR(255) NOT NULL,
                    Quantity DECIMAL(18,2) NOT NULL DEFAULT 1,
                    UnitPrice DECIMAL(18,2) NOT NULL DEFAULT 0,
                    DiscountAmount DECIMAL(18,2) NOT NULL DEFAULT 0,
                    GstPercentage DECIMAL(5,2) NOT NULL DEFAULT 0,
                    GstAmount DECIMAL(18,2) NOT NULL DEFAULT 0,
                    TotalAmount DECIMAL(18,2) NOT NULL DEFAULT 0,
                    CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                    CONSTRAINT FK_AppointmentBillItems_AppointmentBills
                    FOREIGN KEY (AppointmentBillId)
                    REFERENCES AppointmentBills(AppointmentBillId)
                );
            `);
            console.log("AppointmentBillItems table created successfully!");
        } else {
            console.log("AppointmentBillItems table already exists.");
        }

        console.log("Modifying Payments table to add AppointmentBillId...");
        const columns = await queryRunner.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'Payments' AND COLUMN_NAME = 'AppointmentBillId'
        `);

        if (columns.length === 0) {
            console.log("Adding AppointmentBillId to Payments...");
            await queryRunner.query(`
                ALTER TABLE Payments
                ADD AppointmentBillId UNIQUEIDENTIFIER NULL;
            `);
            console.log("AppointmentBillId added to Payments successfully!");
        } else {
            console.log("AppointmentBillId column already exists in Payments table.");
        }

        console.log("Adding constraint FK_Payments_AppointmentBills if it doesn't exist...");
        const constraints = await queryRunner.query(`
            SELECT CONSTRAINT_NAME 
            FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS 
            WHERE CONSTRAINT_NAME = 'FK_Payments_AppointmentBills'
        `);

        if (constraints.length === 0) {
            console.log("Adding foreign key constraint FK_Payments_AppointmentBills...");
            await queryRunner.query(`
                ALTER TABLE Payments
                ADD CONSTRAINT FK_Payments_AppointmentBills
                FOREIGN KEY (AppointmentBillId)
                REFERENCES AppointmentBills(AppointmentBillId);
            `);
            console.log("Foreign key constraint added successfully!");
        } else {
            console.log("Foreign key constraint already exists.");
        }

        console.log("All database migrations completed successfully!");
    } catch (err: any) {
        console.error("Error during table setup:", err.message || err);
    } finally {
        await queryRunner.release();
        await AppDataSource.destroy();
    }
}

run();
