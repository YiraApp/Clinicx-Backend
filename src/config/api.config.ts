// Centralized API configuration
export const API_CONFIG = {
    // Vite uses import.meta.env for environment variables
    // You can define VITE_API_BASE_URL in your .env file
    // Development default: localhost
    // Production default: will use the environment variable
    BASE_URL: import.meta.env.VITE_API_BASE_URL || "http://localhost:5000",
    TIMEOUT: 10000,
    ENDPOINTS: {
        AUTH: "/api/auth",
        USERS: "/api/users",
        ACCOUNTS: "/api/accounts",
        ORGANIZATIONS: "/api/organizations",
        PATIENTS: "/api/patients",
        APPOINTMENTS: "/api/appointments",
        ROLES: "/api/roles",
        SIDEBAR: "/api/sidebar",
    }
};

export default API_CONFIG;
