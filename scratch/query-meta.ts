import dotenv from "dotenv";
dotenv.config();
import { initializeDatabase } from "../src/config/database.js";
import { defaultOrganizationRepository } from "../src/repositories/Organizations/default-organization.repository.js";

async function run() {
  await initializeDatabase();
  const activeDefault = await defaultOrganizationRepository.getActiveDefault();
  const allDefaults = await defaultOrganizationRepository.getAll();
  console.log("ACTIVE DEFAULT FROM DB:", activeDefault ? {
    id: activeDefault.Id,
    orgId: activeDefault.OrganizationId,
    orgName: activeDefault.Organization?.Name,
    hospitalId: activeDefault.HospitalId,
    hospitalName: activeDefault.Hospital?.Name,
    isDefault: activeDefault.IsDefault
  } : "None");

  console.log("ALL DEFAULT ENTRIES:", allDefaults.map(d => ({
    id: d.Id,
    orgId: d.OrganizationId,
    orgName: d.Organization?.Name,
    hospitalId: d.HospitalId,
    hospitalName: d.Hospital?.Name,
    isDefault: d.IsDefault
  })));
  process.exit(0);
}
run();
