/**
 * Utility to manage consistent Redis cache keys across the application.
 */
export const CacheKeys = {
    /**
     * Cache key for dynamic sidebar menus.
     * Pattern: SIDEBAR_MENU:roleId:orgId:hospId
     */
    SIDEBAR_MENU: (roleId: string, orgId?: number | null, hospId?: number | null) =>
        `SIDEBAR_MENU:${roleId}:${orgId ?? "NULL"}:${hospId ?? "NULL"}`,

    /**
     * Cache key for dashboard summary statistics.
     * Pattern: DASHBOARD_SUMMARY:page:pageSize:orgId
     */
    DASHBOARD_SUMMARY: (page: number, pageSize: number, orgId?: number) =>
        `DASHBOARD_SUMMARY:${page}:${pageSize}:${orgId ?? "GLOBAL"}`,

    /**
     * Cache key for roles list.
     */
    ROLES_LIST: "ROLES_LIST",

    // Patterns for cache invalidation
    PATTERNS: {
        DASHBOARD_ALL: "DASHBOARD_SUMMARY:*",
        SIDEBAR_ALL: "SIDEBAR_MENU:*",
    }
} as const;
