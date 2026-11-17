/**
 * Loads India Post's "All India Pincode Directory" (data.gov.in, Government Open Data Licence –
 * India) into the PincodeDirectory table, replacing what is there. The same import runs when a Yira
 * admin uploads the CSV on the Lab Packages page; this script is for loading it from the server.
 *
 *   npm run import-pincodes                      # reads data/pincode-directory.csv
 *   npm run import-pincodes -- path/to/file.csv
 *
 * Download the CSV from https://www.data.gov.in/resource/all-india-pincode-directory-till-last-month
 */
import fs from "fs";
import path from "path";
import { AppDataSource } from "../config/database.js";
import { parseDirectoryCsv, pincodeService } from "../services/LabPackages/pincode.service.js";

const file = path.resolve(process.argv[2] || "data/pincode-directory.csv");

async function main() {
    if (!fs.existsSync(file)) {
        console.error(`CSV not found: ${file}\nDownload it from https://www.data.gov.in/resource/all-india-pincode-directory-till-last-month and pass its path.`);
        process.exit(1);
    }
    const records = parseDirectoryCsv(fs.readFileSync(file, "utf8"));

    const log = console.log;
    console.log = () => {};
    await AppDataSource.initialize();
    console.log = log;

    // The table is normally made at server start; make sure it exists if the server has not restarted
    await AppDataSource.query(`IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PincodeDirectory')
        CREATE TABLE PincodeDirectory (Id INT IDENTITY(1,1) PRIMARY KEY, Pincode VARCHAR(6) NOT NULL, OfficeName NVARCHAR(200) NOT NULL,
            OfficeType VARCHAR(30) NULL, Delivery VARCHAR(30) NULL, District NVARCHAR(100) NOT NULL, State NVARCHAR(100) NOT NULL, Source VARCHAR(20) NULL);`);
    await AppDataSource.query("IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('PincodeDirectory') AND name = 'Source') ALTER TABLE PincodeDirectory ADD Source VARCHAR(20) NULL;");

    let lastShown = 0;
    await pincodeService.importRecords(records, done => {
        if (done - lastShown >= 15000 || done === records.length) {
            lastShown = done;
            log(`  ${done.toLocaleString()} / ${records.length.toLocaleString()} post offices`);
        }
    });

    const summary = await AppDataSource.query(`SELECT COUNT(*) AS offices, COUNT(DISTINCT Pincode) AS pincodes,
        COUNT(DISTINCT State) AS states, COUNT(DISTINCT State + '|' + District) AS districts FROM PincodeDirectory`);
    log(`Loaded ${summary[0].offices.toLocaleString()} post offices: ${summary[0].pincodes.toLocaleString()} pincodes in ${summary[0].districts} districts of ${summary[0].states} states/UTs.`);
    await AppDataSource.destroy();
}

main().catch(err => {
    console.error("Import failed:", err?.message || err);
    process.exit(1);
});
