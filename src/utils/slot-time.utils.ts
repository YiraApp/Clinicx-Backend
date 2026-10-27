/** Minutes after midnight of a slot time: "14:15", "14:15:00" or "2:15 PM". Null when it is none of those. */
export const slotMinutes = (time: string | null | undefined): number | null => {
    const s = String(time ?? "").trim();
    const twelve = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
    if (twelve) {
        let h = parseInt(twelve[1]!, 10);
        const pm = twelve[3]!.toUpperCase() === "PM";
        if (pm && h < 12) h += 12;
        if (!pm && h === 12) h = 0;
        return h * 60 + parseInt(twelve[2]!, 10);
    }
    const twentyFour = s.match(/^(\d{1,2}):(\d{2})/);
    return twentyFour ? parseInt(twentyFour[1]!, 10) * 60 + parseInt(twentyFour[2]!, 10) : null;
};

/**
 * Why a slot can no longer be booked: its day has gone ("date"), or it is today and over ("time").
 * Null while it can be. A slot is bookable until it ends, so one already under way (14:00–14:15 at
 * 14:05) still is; a slot with no end time closes when it starts. Days and times are the server's
 * local ones, as the slots are kept.
 */
export const slotClosed = (
    slot: { SlotDate: Date | string; StartTime?: string | null; EndTime?: string | null },
    now: Date,
): "date" | "time" | null => {
    const dateStr = slot.SlotDate instanceof Date ? slot.SlotDate.toISOString().split("T")[0]! : String(slot.SlotDate).split("T")[0]!;
    const [y, m, d] = dateStr.split("-").map(Number);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const slotDay = new Date(y!, m! - 1, d!);
    if (slotDay < today) return "date";
    if (slotDay > today) return null;
    const closesAt = slotMinutes(slot.EndTime) ?? slotMinutes(slot.StartTime);
    return closesAt !== null && closesAt <= now.getHours() * 60 + now.getMinutes() ? "time" : null;
};
