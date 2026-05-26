-- Add Notes column to main PatientPrescription table
-- Run this against your database (MSSQL)

ALTER TABLE PatientPrescription
ADD Notes NVARCHAR(MAX) NULL;

-- Optionally, backfill existing prescriptions with empty string instead of NULL:
-- UPDATE PatientPrescription SET Notes = '' WHERE Notes IS NULL;
