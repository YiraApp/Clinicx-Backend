/**
 * Standard API Response structure.
 */
export interface BaseResponse<T> {
    status: boolean;
    message: string;
    data: T | null;
}
