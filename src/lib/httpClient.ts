import axios from "axios";
import { API_CONFIG } from "@/config/api.config";

console.log("[httpClient] Module loaded ✅");

// Base axios instance with global settings
const httpClient = axios.create({
    baseURL: API_CONFIG.BASE_URL,
    timeout: API_CONFIG.TIMEOUT,
    headers: {
        "Content-Type": "application/json",
    },
});

// Separate clean axios instance for refresh (no interceptors attached)
const refreshClient = axios.create({
    baseURL: API_CONFIG.BASE_URL,
    timeout: API_CONFIG.TIMEOUT,
    headers: {
        "Content-Type": "application/json",
    },
});

// Interceptor: Add Authorization header automatically
httpClient.interceptors.request.use(
    (config) => {
        const token = localStorage.getItem("token");
        if (token && config.headers) {
            config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
    },
    (error) => Promise.reject(error)
);

// --- Refresh Token Queue Logic ---
let isRefreshing = false;
let failedQueue: { resolve: (token: string) => void; reject: (err: any) => void }[] = [];

const processQueue = (error: any, token: string | null = null) => {
    failedQueue.forEach((prom) => {
        if (error) {
            prom.reject(error);
        } else {
            prom.resolve(token!);
        }
    });
    failedQueue = [];
};

/**
 * Attempts to refresh the access token using the stored refresh token.
 * Returns the new access token on success, or throws on failure.
 */
async function doRefreshToken(): Promise<string> {
    const storedRefreshToken = localStorage.getItem("refreshToken");

    if (!storedRefreshToken) {
        throw new Error("No refresh token in localStorage");
    }

    console.log("[httpClient] 🔄 Calling POST /api/auth/refresh...");

    const refreshResponse = await refreshClient.post("/api/auth/refresh", {
        refreshToken: storedRefreshToken,
    });

    console.log("[httpClient] 🔄 Refresh response:", refreshResponse.data);

    // Handle both wrapped { success, data: { accessToken } } and flat { accessToken } responses
    const responseData = refreshResponse.data?.data || refreshResponse.data;
    const newAccessToken = responseData?.accessToken || responseData?.token;
    const newRefreshToken = responseData?.refreshToken;

    if (!newAccessToken) {
        throw new Error("No accessToken in refresh response body");
    }

    // Update localStorage
    localStorage.setItem("token", newAccessToken);
    if (newRefreshToken) {
        localStorage.setItem("refreshToken", newRefreshToken);
    }

    // Update default header for future requests
    httpClient.defaults.headers.common.Authorization = `Bearer ${newAccessToken}`;

    console.log("[httpClient] ✅ Token refreshed successfully!");
    return newAccessToken;
}

/**
 * Determines if this error is a 401 / token-expired error.
 * Handles both:
 *  1. Standard HTTP 401 responses
 *  2. CORS-blocked 401s where error.response is undefined (network errors after auth failure)
 */
function is401Error(error: any): boolean {
    // Case 1: Standard 401
    if (error?.response?.status === 401) {
        return true;
    }

    // Case 2: Check the response body for "expired" keyword (some wrappers)
    const body = error?.response?.data;
    if (body && typeof body === "object") {
        const msg = body.message || body.error || body.Message || "";
        if (typeof msg === "string" && msg.toLowerCase().includes("expired")) {
            return true;
        }
    }

    return false;
}

// --- Response Interceptor ---
httpClient.interceptors.response.use(
    (response) => {
        // Unwrap standard { success/status, message, data } envelope
        const { data } = response;

        if (data && typeof data === "object") {
            const hasWrapper =
                ("status" in data || "success" in data || "Success" in data) &&
                ("message" in data || "Message" in data);

            if (hasWrapper) {
                const isSuccess = data.status === true || data.success === true || data.Success === true;

                if (isSuccess) {
                    return { ...response, data: data.data, statusMessage: data.message || data.Message };
                } else {
                    // Business logic error (status: false)
                    return Promise.reject({
                        response: {
                            ...response,
                            data: { message: data.message || data.Message || "Operation failed" },
                            status: 400,
                        },
                    });
                }
            }
        }

        return response;
    },
    async (error) => {
        const originalRequest = error.config;

        console.log(
            `[httpClient] ❌ Error [${error.response?.status || "NETWORK"}] for: ${originalRequest?.url}`,
            error.response?.data || error.message
        );

        // --- 401 / Token Expired Handling ---
        if (is401Error(error) && originalRequest && !originalRequest._retry) {
            // Don't try to refresh for login or refresh-token requests
            const isAuthEndpoint =
                originalRequest.url?.includes("/api/auth/login") ||
                originalRequest.url?.includes("/api/auth/refresh");
            const isOnLoginPage = window.location.pathname === "/login";

            if (isAuthEndpoint || isOnLoginPage) {
                console.log("[httpClient] Skipping refresh for auth endpoint / login page.");
                return Promise.reject(error);
            }

            // If already refreshing, queue this request
            if (isRefreshing) {
                console.log("[httpClient] Already refreshing, queuing request:", originalRequest.url);
                return new Promise<string>((resolve, reject) => {
                    failedQueue.push({ resolve, reject });
                }).then((newToken) => {
                    originalRequest.headers.Authorization = `Bearer ${newToken}`;
                    return httpClient(originalRequest);
                });
            }

            // Start refresh
            originalRequest._retry = true;
            isRefreshing = true;

            try {
                const newToken = await doRefreshToken();
                processQueue(null, newToken);

                // Retry the original request with new token
                originalRequest.headers.Authorization = `Bearer ${newToken}`;
                return httpClient(originalRequest);
            } catch (refreshError) {
                processQueue(refreshError, null);
                console.error("[httpClient] 🚫 Refresh failed. Logging out.", refreshError);
                localStorage.clear();
                window.location.href = "/login";
                return Promise.reject(refreshError);
            } finally {
                isRefreshing = false;
            }
        }

        // --- Extract error messages consistently ---
        const apiError = error.response?.data;
        if (apiError && typeof apiError === "object") {
            const msg = apiError.message || apiError.error || apiError.Message;
            if (msg) error.message = msg;
        }

        return Promise.reject(error);
    }
);

export default httpClient;
