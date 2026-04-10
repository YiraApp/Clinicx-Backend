import type { BaseResponse } from "../dtos/Common/BaseResponse.js";

/**
 * Utility to generate standardized API responses.
 */
export const ApiResponse = {
    success: <T>(data: T, message: string = "Success"): BaseResponse<T> => {
        return {
            status: true,
            message,
            data
        };
    },

    error: (message: string = "Error", data: any = null): BaseResponse<any> => {
        return {
            status: false,
            message,
            data
        };
    }
};
