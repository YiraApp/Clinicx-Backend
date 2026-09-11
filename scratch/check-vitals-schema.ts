import { AppDataSource } from "../src/config/database.js";
import dotenv from "dotenv";
dotenv.config();

async function check() {
  try {
    await AppDataSource.initialize();
    const cols = await AppDataSource.query(`
      SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'PatientMedicalRecord';
    `);
    console.log('PatientMedicalRecord columns:', cols.map((c: any) => c.COLUMN_NAME));

    const userCols = await AppDataSource.query(`
      SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'Users';
    `);
    console.log('Users vitals-related columns:', userCols.filter((c: any) => 
      ['BloodPressure', 'HeartRate', 'Temperature', 'SpO2', 'Weight', 'Height'].includes(c.COLUMN_NAME)
    ).map((c: any) => c.COLUMN_NAME));

    // Check if there are any existing vitals recorded in PatientMedicalRecord
    const count = await AppDataSource.query(`
      SELECT COUNT(*) as total,
             COUNT(BloodPressure) as withBP,
             COUNT(HeartRate) as withHR,
             COUNT(Temperature) as withTemp,
             COUNT(Weight) as withWeight
      FROM PatientMedicalRecord;
    `);
    console.log('PatientMedicalRecord stats:', count);

    await AppDataSource.destroy();
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
check();
