import { createClient, type RedisClientType } from "redis";
/**
 * Service to handle Redis caching operations.
 */
export class RedisService {
    private client: RedisClientType | null = null;
    private isConnected: boolean = false;
    private hasLoggedError: boolean = false;
    private readonly defaultTTL: number = parseInt(process.env.REDIS_TTL!);

    constructor() {
        this.initialize();
    }

    private async initialize() {
        try {
            const host = process.env.REDIS_HOST!;
            const port = process.env.REDIS_PORT!;
            const password = process.env.REDIS_PASSWORD || "";

            const url = password
                ? `redis://:${password}@${host}:${port}`
                : `redis://${host}:${port}`;

            this.client = createClient({
                url,
                socket: {
                    reconnectStrategy: (retries) => {
                        if (retries > 5) {
                            if (!this.hasLoggedError) {
                                console.warn("[Redis] Max reconnection attempts reached. Continuing in fail-safe mode.");
                                this.hasLoggedError = true;
                            }
                            return false; // Stop retrying
                        }
                        return Math.min(retries * 100, 3000);
                    }
                }
            });

            this.client.on("error", (err) => {
                if (!this.hasLoggedError) {
                    console.error("[Redis] Offline:", err.message);
                    this.hasLoggedError = true;
                }
                this.isConnected = false;
            });

            this.client.on("connect", () => {
                console.log("[Redis] Connected successfully.");
                this.isConnected = true;
                this.hasLoggedError = false; // Reset on successful connect
            });

            await this.client.connect();
        } catch (error: any) {
            if (!this.hasLoggedError) {
                console.error("[Redis] Initialization Failed:", error.message);
                this.hasLoggedError = true;
            }
            this.isConnected = false;
        }
    }

    /**
     * Gets a value from cache and parses it as JSON.
     */
    async get<T>(key: string): Promise<T | null> {
        if (!this.isConnected || !this.client) return null;
        try {
            const data = await this.client.get(key);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            console.error(`[Redis] Error getting key ${key}:`, error);
            return null;
        }
    }

    /**
     * Sets a value in cache with an optional TTL.
     */
    async set(key: string, value: any, ttl: number = this.defaultTTL): Promise<void> {
        if (!this.isConnected || !this.client) return;
        try {
            const stringValue = JSON.stringify(value);
            await this.client.set(key, stringValue, {
                EX: ttl
            });
        } catch (error) {
            console.error(`[Redis] Error setting key ${key}:`, error);
        }
    }

    /**
     * Deletes one or more keys from cache.
     */
    async del(key: string | string[]): Promise<void> {
        if (!this.isConnected || !this.client) return;
        try {
            if (Array.isArray(key)) {
                await this.client.del(key);
            } else {
                await this.client.del(key);
            }
        } catch (error) {
            console.error(`[Redis] Error deleting key(s) ${key}:`, error);
        }
    }

    /**
     * Checks if a key exists in cache.
     */
    async exists(key: string): Promise<boolean> {
        if (!this.isConnected || !this.client) return false;
        try {
            const result = await this.client.exists(key);
            return result === 1;
        } catch (error) {
            return false;
        }
    }

    /**
     * Flushes (clears) all keys from the current database.
     */
    async flush(): Promise<void> {
        if (!this.isConnected || !this.client) return;
        try {
            await this.client.flushDb();
            console.log("[Redis] Cache flushed successfully.");
        } catch (error) {
            console.error("[Redis] Error flushing cache:", error);
        }
    }

    /**
     * Deletes keys matching a specific pattern.
     */
    async delByPattern(pattern: string): Promise<void> {
        if (!this.isConnected || !this.client) return;
        try {
            const keys = await this.client.keys(pattern);
            if (keys.length > 0) {
                await this.client.del(keys);
            }
        } catch (error) {
            console.error(`[Redis] Error deleting pattern ${pattern}:`, error);
        }
    }
}

export const redisService = new RedisService();
