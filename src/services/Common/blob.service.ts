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

    /**
     * Downloads a file from a URL to a Buffer.
     */
    async downloadFile(fileUrl: string): Promise<Buffer> {
        try {
            // Extract blob name from URL
            // Example URL: https://account.blob.core.windows.net/container/path/to/blob
            const url = new URL(fileUrl);
            const pathParts = url.pathname.split('/');
            const containerName = pathParts[1];
            const blobName = decodeURIComponent(pathParts.slice(2).join('/'));

            const blockBlobClient = this.blobServiceClient.getContainerClient(containerName).getBlockBlobClient(blobName);
            return await blockBlobClient.downloadToBuffer();
        } catch (error: any) {
            console.error("[Blob Service] Error downloading file:", error.message);
            throw new Error(`Failed to download file from Azure: ${error.message}`);
        }
    }

    /**
     * Uploads a Buffer directly to a specific path.
     */
    async uploadBuffer(buffer: Buffer, blobPath: string, contentType: string): Promise<string> {
        try {
            const blockBlobClient = this.containerClient.getBlockBlobClient(blobPath);
            await blockBlobClient.uploadData(buffer, {
                blobHTTPHeaders: { blobContentType: contentType }
            });
            return blockBlobClient.url;
        } catch (error: any) {
            console.error("[Blob Service] Error uploading buffer:", error.message);
            throw new Error(`Failed to upload buffer to Azure: ${error.message}`);
        }
    }

    /**
     * Downloads a file from an external URL and uploads it to Azure Blob Storage.
     * @param url The external URL to download
     * @param userName User directory name in blob
     * @param serviceConstant Folder name inside user directory
     * @param originalName Optional original file name to preserve extension and construct unique name
     */
    async uploadFromUrl(url: string, userName: string, serviceConstant: string, originalName?: string): Promise<FileUploadResponse> {
        try {
            // Ensure container exists
            await this.containerClient.createIfNotExists({
                access: 'blob' as PublicAccessType
            });

            // Fetch the file from the external URL
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to fetch file from URL: ${response.statusText} (${response.status})`);
            }

            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // Determine content-type and extension
            const contentType = response.headers.get("content-type") || 'application/octet-stream';
            const extension = mime.extension(contentType) || 'bin';
            const baseName = originalName || `downloaded_file.${extension}`;
            const fileExtension = path.extname(baseName) || `.${extension}`;

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

            const imageName = `${serviceConstant}_${istTimestamp}_${baseName}`;
            const blobPath = `${userName.toLowerCase()}/${serviceConstant}/${imageName}`;
            const blockBlobClient = this.containerClient.getBlockBlobClient(blobPath);

            // Upload the file buffer
            await blockBlobClient.uploadData(buffer, {
                blobHTTPHeaders: { blobContentType: contentType }
            });

            return {
                fileName: baseName,
                fileUrl: blockBlobClient.url,
                fileType: fileExtension
            };
        } catch (error: any) {
            console.error("[Blob Service] Error uploading from URL:", error.message);
            throw new Error(`Failed to upload from URL to Azure: ${error.message}`);
        }
    }
}

export const blobService = new BlobService();
