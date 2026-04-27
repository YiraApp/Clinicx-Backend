import { BlobServiceClient, ContainerClient, PublicAccessType } from "@azure/storage-blob";
import path from "path";
import mime from "mime-types";
import dotenv from "dotenv";

if (process.env.NODE_ENV !== "production") {
    dotenv.config();
}

export interface FileUploadResponse {
    fileName: string;
    fileUrl: string;
    fileType: string;
}

/**
 * Service for handling file uploads to Azure Blob Storage.
 */
export class BlobService {
    private blobServiceClient: BlobServiceClient;
    private containerClient: ContainerClient;

    constructor() {
        const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
        const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || "uploadedfiles";

        if (!connectionString) {
            throw new Error("Azure Storage Connection String is missing in environment variables.");
        }

        this.blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        this.containerClient = this.blobServiceClient.getContainerClient(containerName.toLowerCase());
    }

    /**
     * Uploads multiple files to Azure Blob Storage.
     * @param files List of files from Multer (buffer based)
     * @param userName User directory name in blob
     * @param serviceConstant Folder name inside user directory
     */
    async uploadFiles(files: Express.Multer.File[], userName: string, serviceConstant: string): Promise<FileUploadResponse[]> {
        const uploadResponses: FileUploadResponse[] = [];

        try {
            // Ensure container exists and has blob public access
            await this.containerClient.createIfNotExists({
                access: 'blob' as PublicAccessType
            });

            for (const file of files) {
                // Generate a unique filename using IST timestamp
                const now = new Date();
                const istTimestamp = now.toLocaleString("en-IN", {
                    timeZone: "Asia/Kolkata",
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    hour12: false
                }).replace(/[/, :]/g, "-");
                
                const imageName = `${serviceConstant}_${istTimestamp}_${file.originalname}`;
                const fileExtension = path.extname(file.originalname);
                
                // Construct blob path: username/service/imagename
                const blobPath = `${userName.toLowerCase()}/${serviceConstant}/${imageName}`;
                const blockBlobClient = this.containerClient.getBlockBlobClient(blobPath);

                // Determine MIME type
                const contentType = mime.lookup(file.originalname) || 'application/octet-stream';

                // Upload the file buffer
                await blockBlobClient.uploadData(file.buffer, {
                    blobHTTPHeaders: { blobContentType: contentType }
                });

                uploadResponses.push({
                    fileName: file.originalname,
                    fileUrl: blockBlobClient.url,
                    fileType: fileExtension
                });
            }
        } catch (error: any) {
            console.error("[Blob Service] Error uploading files:", error.message);
            throw new Error(`Failed to upload files to Azure: ${error.message}`);
        }

        return uploadResponses;
    }
}

export const blobService = new BlobService();
