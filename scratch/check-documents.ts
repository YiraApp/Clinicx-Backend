import { AppDataSource } from "../src/config/database.js";
import { MedicalDocument } from "../src/models/Appointments/medical-document.model.js";

async function run() {
    await AppDataSource.initialize();
    console.log("Database initialized.");

    const docs = await AppDataSource.getRepository(MedicalDocument).find({
        take: 10,
        order: { Id: "DESC" }
    });

    console.log("Recent documents in DB:");
    for (const d of docs) {
        console.log({
            id: d.Id,
            patientId: d.PatientId,
            fileName: d.FileName,
            documentCategory: d.DocumentCategory,
            documentType: d.DocumentType,
            blobUrl: d.BlobUrl,
            fileSize: d.FileSize,
            createdAt: d.CreatedAt
        });
    }

    await AppDataSource.destroy();
}

run().catch(console.error);
