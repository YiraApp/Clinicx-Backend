import dotenv from "dotenv";
dotenv.config();

export interface ZoomMeetingResponse {
    id: number;
    join_url: string;
    start_url: string;
    topic: string;
    start_time?: string;
    duration?: number;
}

export class ZoomService {
    private zoomApiUrl = "https://api.zoom.us/v2";

    /**
     * Generates a Zoom Access Token using Server-to-Server OAuth.
     * Requires ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, and ZOOM_CLIENT_SECRET in .env
     */
    private async getAccessToken(): Promise<string> {
        const accountId = process.env.ZOOM_ACCOUNT_ID;
        const clientId = process.env.ZOOM_CLIENT_ID;
        const clientSecret = process.env.ZOOM_CLIENT_SECRET;

        if (!accountId || !clientId || !clientSecret) {
            throw new Error("Zoom API credentials missing in .env (ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET).");
        }

        const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const response = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
            }
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(`Failed to get Zoom access token: ${data.reason || data.message || JSON.stringify(data)}`);
        }

        return data.access_token;
    }

    /**
     * Creates a Zoom meeting.
     * @param topic Meeting topic
     * @param startTime Optional start time (for scheduled meetings)
     * @param duration Optional duration in minutes
     */
    async createMeeting(topic: string, startTime?: Date, duration: number = 30): Promise<ZoomMeetingResponse> {
        try {
            const accessToken = await this.getAccessToken();

            // If no credentials, return a Jitsi / simulated meeting link for instant join
            if (accessToken === "MOCK_TOKEN") {
                const mockId = Math.floor(Math.random() * 10000000000);
                const jitsiUrl = this.generateJitsiUrl(`ClinicX-Consultation-${mockId}`);
                return {
                    id: mockId,
                    join_url: jitsiUrl,
                    start_url: jitsiUrl,
                    topic: topic,
                    start_time: startTime?.toISOString(),
                    duration: duration
                };
            }

            const meetingData = {
                topic: topic || "Doctor Consultation",
                type: startTime ? 2 : 1, // 1 for instant, 2 for scheduled
                start_time: startTime ? startTime.toISOString() : undefined,
                duration: duration || 30,
                settings: {
                    host_video: true,
                    participant_video: true,
                    join_before_host: true,
                    mute_upon_entry: true,
                    waiting_room: false
                }
            };

            const response = await fetch(`${this.zoomApiUrl}/users/me/meetings`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(meetingData)
            });

            const data = await response.json();
            if (!response.ok) {
                throw new Error(`Zoom API Error: ${data.message || JSON.stringify(data)}`);
            }

            const browserJoinUrl = this.convertToBrowserJoinUrl(data.join_url, data.id, data.password);
            return {
                id: data.id,
                join_url: browserJoinUrl,
                start_url: data.start_url || browserJoinUrl,
                topic: data.topic,
                start_time: data.start_time,
                duration: data.duration
            };
        } catch (error: any) {
            console.error("Zoom Service Error:", error.message);
            throw error;
        }
    }

    convertToBrowserJoinUrl(urlStr: string, meetingId?: number | string, password?: string): string {
        if (!urlStr) return urlStr;
        if (!urlStr.includes("zoom.us")) return urlStr;
        if (urlStr.includes("/wc/")) return urlStr;

        try {
            const parsed = new URL(urlStr);
            const match = parsed.pathname.match(/\/j\/(\d+)/);
            const id = meetingId || (match ? match[1] : null);
            const pwd = parsed.searchParams.get("pwd") || password;

            if (id) {
                const browserUrl = new URL(`https://app.zoom.us/wc/${id}/join`);
                if (pwd) {
                    browserUrl.searchParams.set("pwd", pwd);
                }
                parsed.searchParams.forEach((val, key) => {
                    if (key !== "pwd") {
                        browserUrl.searchParams.set(key, val);
                    }
                });
                return browserUrl.toString();
            }
        } catch (e) {
            return urlStr.replace(/\/j\/(\d+)/, "/wc/$1/join");
        }

        return urlStr;
    }

    generateJitsiUrl(roomName: string): string {
        const cleanRoom = encodeURIComponent(roomName.replace(/\s+/g, "-"));
        return `https://meet.jit.si/${cleanRoom}`;
    }
}

export const zoomService = new ZoomService();

