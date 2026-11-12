import crypto from "crypto";
import { In } from "typeorm/index.js";
import { AppDataSource } from "../../config/database.js";
import { User } from "../../models/Account/user.model.js";
import { FamilyCode, FamilyLink, FamilyLinkAttempt } from "../../models/Account/family-link.model.js";
import { UserRole } from "../../models/Account/userrole.model.js";
import { HealthcareProvider } from "../../models/Organizations/healthcare-provider.model.js";
import { PATIENT_ROLE_ID } from "../../utils/staff-access.js";
import { pushNotificationService } from "../Notifications/push-notification.service.js";

/** How long a family code works after it is shown. */
export const FAMILY_CODE_TTL_MS = 10 * 60 * 1000;
/** How long a link request waits for an answer. */
export const FAMILY_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Family members besides the account holder: dependents and linked accounts together. */
export const MAX_FAMILY_MEMBERS = 6;
/** Wrong codes allowed per person trying, and per person whose code is tried, in the window. */
export const CODE_FAIL_LIMIT = 5;
/** Phone numbers one person may look up (lookups, code links and requests) in the window. */
export const PHONE_LOOKUP_LIMIT = 15;
export const THROTTLE_WINDOW_MS = 15 * 60 * 1000;

export const FAMILY_RELATIONS = ["Spouse", "Child", "Son", "Daughter", "Father", "Mother", "Brother", "Sister", "Other"] as const;

const STATUS = {
    PENDING: "PENDING",
    ACCEPTED: "ACCEPTED",
    DECLINED: "DECLINED",
    CANCELLED: "CANCELLED",
    REMOVED: "REMOVED",
    EXPIRED: "EXPIRED",
} as const;

const FAMILY_ROUTE = "/patientMyFamily";

export class FamilyLinkError extends Error {
    constructor(message: string, public status = 400, public code = "FAMILY_LINK_ERROR", public extra?: Record<string, any>) {
        super(message);
    }
}

const sameId = (a?: string | null, b?: string | null) => !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();
const isUuid = (id?: string | null): id is string =>
    !!id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim());

/** The 10-digit Indian mobile number in [raw], or null. Accepts +91, 91 and 0 prefixes. */
export function normalizeFamilyPhone(raw: unknown): string | null {
    let digits = String(raw ?? "").replace(/\D/g, "");
    if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
    return /^\d{10}$/.test(digits) ? digits : null;
}

/** "Ravi Kumar" -> "Ra*** K***": enough to recognise someone, not to learn a stranger's name. */
export function maskFamilyName(firstName?: string | null, lastName?: string | null): string {
    const part = (word: string, keep: number) => {
        const w = word.trim();
        if (!w) return "";
        return `${w.slice(0, Math.min(keep, Math.max(1, w.length - 1)))}***`;
    };
    const first = (firstName || "").trim().split(/\s+/)[0] || "";
    const last = (lastName || "").trim().split(/\s+/)[0] || "";
    const masked = [part(first, 2), part(last, 1)].filter(Boolean).join(" ");
    return masked || "Yira user";
}

/** Last four digits only, e.g. "•••••• 4321". */
const phoneHint = (phone?: string | null) => {
    const digits = String(phone || "").replace(/\D/g, "");
    return digits.length >= 4 ? `•••••• ${digits.slice(-4)}` : "";
};

const fullName = (u?: User | null) => `${u?.FirstName || ""} ${u?.LastName || ""}`.trim() || "Yira user";

const formatDob = (dob?: string | Date | null) => {
    if (!dob) return null;
    const d = new Date(dob as any);
    return isNaN(d.getTime()) ? null : d.toISOString().split("T")[0];
};

/** The canonical relation name, or null when it isn't one the app offers. */
export function normalizeFamilyRelation(raw: unknown): string | null {
    const value = String(raw ?? "").trim().toLowerCase();
    return FAMILY_RELATIONS.find((r) => r.toLowerCase() === value) ?? null;
}

/** How the other person is related back, from the requester's gender. Display only. */
export function inverseFamilyRelation(relation: string, requesterGender?: string | null): string {
    const g = (requesterGender || "").trim().toLowerCase();
    const male = g.startsWith("m");
    const female = g.startsWith("f");
    switch (relation.trim().toLowerCase()) {
        case "spouse":
            return "Spouse";
        case "father":
        case "mother":
            return male ? "Son" : female ? "Daughter" : "Child";
        case "son":
        case "daughter":
        case "child":
            return male ? "Father" : female ? "Mother" : "Parent";
        case "brother":
        case "sister":
            return male ? "Brother" : female ? "Sister" : "Sibling";
        default:
            return "Other";
    }
}

const codeSecret = () => process.env.FAMILY_CODE_SECRET || process.env.JWT_SECRET || "";

/** The 4-digit code for a seed. Without the server secret the seed says nothing about the code. */
function deriveCode(userId: string, seed: string): string {
    const secret = codeSecret();
    if (!secret) throw new FamilyLinkError("Family codes are not available right now.", 503, "CODE_UNAVAILABLE");
    const mac = crypto.createHmac("sha256", secret).update(`family-code:${userId.trim().toUpperCase()}:${seed}`).digest();
    return String(mac.readUInt32BE(0) % 10000).padStart(4, "0");
}

const codesMatch = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

const minutesUntil = (when: Date, now: Date) => Math.max(1, Math.ceil((when.getTime() - now.getTime()) / 60000));

export class FamilyLinkService {
    private get users() {
        return AppDataSource.getRepository(User);
    }
    private get links() {
        return AppDataSource.getRepository(FamilyLink);
    }
    private get codes() {
        return AppDataSource.getRepository(FamilyCode);
    }
    private get attempts() {
        return AppDataSource.getRepository(FamilyLinkAttempt);
    }

    // ── Who is acting ────────────────────────────────────────────────────────

    /**
     * The account holder family links belong to: the account itself, or for a
     * dependent its parent account (or the primary account on the same phone).
     */
    async resolveAccountHolder(userId: string): Promise<User> {
        const user = await this.users.findOne({ where: { Id: userId, IsDeleted: false } });
        if (!user) throw new FamilyLinkError("We couldn't find your account. Please sign in again.", 401, "SIGN_IN_REQUIRED");
        if (user.ParentUserId) {
            const parent = await this.users.findOne({ where: { Id: user.ParentUserId, IsDeleted: false } });
            if (parent) return parent;
        } else if (user.IsPrimary === false && user.PhoneNumber) {
            const primary = await this.users.findOne({ where: { PhoneNumber: user.PhoneNumber, IsPrimary: true, IsDeleted: false } });
            if (primary) return primary;
        }
        return user;
    }

    /** The account holder (not a dependent) whose mobile number is exactly [phone10]. */
    private async findAccountHolderByPhone(phone10: string): Promise<User | null> {
        const variants = [phone10, `91${phone10}`, `+91${phone10}`, `+91 ${phone10}`, `0${phone10}`];
        const candidates = await this.users
            .createQueryBuilder("u")
            .where("u.IsDeleted = 0")
            .andWhere("u.ParentUserId IS NULL")
            .andWhere("u.PhoneNumber IN (:...variants)", { variants })
            .getMany();
        const active = candidates.filter((u) => u.Status !== false && normalizeFamilyPhone(u.PhoneNumber) === phone10);
        active.sort((a, b) => {
            if (a.IsPrimary !== b.IsPrimary) return a.IsPrimary ? -1 : 1;
            return new Date(a.CreatedAt).getTime() - new Date(b.CreatedAt).getTime();
        });
        return active[0] ?? null;
    }

    // ── Family code ──────────────────────────────────────────────────────────

    private present(code: FamilyCode, userId: string, now = new Date()) {
        return {
            code: deriveCode(userId, code.CodeSeed),
            expiresAt: code.ExpiresAt,
            secondsLeft: Math.max(0, Math.floor((new Date(code.ExpiresAt).getTime() - now.getTime()) / 1000)),
            validitySeconds: FAMILY_CODE_TTL_MS / 1000,
        };
    }

    private async activeCode(userId: string, now = new Date()): Promise<FamilyCode | null> {
        return this.codes
            .createQueryBuilder("c")
            .where("c.UserId = :userId", { userId })
            .andWhere("c.RevokedAt IS NULL")
            .andWhere("c.ExpiresAt > :now", { now })
            .orderBy("c.Id", "DESC")
            .getOne();
    }

    private async issueCode(userId: string) {
        const now = new Date();
        const saved = await this.codes.save(
            this.codes.create({
                UserId: userId,
                CodeSeed: crypto.randomBytes(24).toString("hex"),
                ExpiresAt: new Date(now.getTime() + FAMILY_CODE_TTL_MS),
                FailedAttempts: 0,
                CreatedAt: now,
            }),
        );
        // Only the newest code works; older ones stop now.
        await this.codes
            .createQueryBuilder()
            .update(FamilyCode)
            .set({ RevokedAt: now })
            .where("UserId = :userId AND Id < :id AND RevokedAt IS NULL", { userId, id: saved.Id })
            .execute();
        await this.codes
            .createQueryBuilder()
            .delete()
            .from(FamilyCode)
            .where("UserId = :userId AND ExpiresAt < :cutoff", { userId, cutoff: new Date(now.getTime() - 24 * 60 * 60 * 1000) })
            .execute()
            .catch(() => undefined);
        return this.present(saved, userId, now);
    }

    /** The user's code that works now, issuing one when the last has run out. */
    async getCurrentCode(userId: string) {
        const now = new Date();
        const active = await this.activeCode(userId, now);
        return active ? this.present(active, userId, now) : this.issueCode(userId);
    }

    /** Stops the current code and issues a new one. */
    async refreshCode(userId: string) {
        return this.issueCode(userId);
    }

    // ── Throttling ───────────────────────────────────────────────────────────

    private async recordAttempt(requesterId: string, targetId: string | null, kind: "LOOKUP" | "CODE", success: boolean) {
        const now = new Date();
        try {
            await this.attempts.insert({ RequesterUserId: requesterId, TargetUserId: targetId, Kind: kind, Success: success, CreatedAt: now });
            await this.attempts
                .createQueryBuilder()
                .delete()
                .from(FamilyLinkAttempt)
                .where("RequesterUserId = :requesterId AND CreatedAt < :cutoff", {
                    requesterId,
                    cutoff: new Date(now.getTime() - 24 * 60 * 60 * 1000),
                })
                .execute();
        } catch (error: any) {
            console.error("[FamilyLink] Could not record attempt:", error?.message);
        }
    }

    /** Oldest-first attempts in the window, for the limit and the wait time. */
    private async recentAttempts(by: "RequesterUserId" | "TargetUserId", userId: string, kind: "LOOKUP" | "CODE", failuresOnly: boolean, since: Date) {
        const qb = this.attempts
            .createQueryBuilder("a")
            .where(`a.${by} = :userId`, { userId })
            .andWhere("a.Kind = :kind", { kind })
            .andWhere("a.CreatedAt > :since", { since });
        if (failuresOnly) qb.andWhere("a.Success = 0");
        return qb.orderBy("a.CreatedAt", "ASC").getMany();
    }

    private async assertLookupAllowed(requesterId: string) {
        const now = new Date();
        const recent = await this.recentAttempts("RequesterUserId", requesterId, "LOOKUP", false, new Date(now.getTime() - THROTTLE_WINDOW_MS));
        if (recent.length >= PHONE_LOOKUP_LIMIT) {
            const wait = minutesUntil(new Date(new Date(recent[0]!.CreatedAt).getTime() + THROTTLE_WINDOW_MS), now);
            throw new FamilyLinkError(
                `You've looked up a lot of numbers. Please try again in ${wait} minute${wait === 1 ? "" : "s"}.`,
                429,
                "TOO_MANY_LOOKUPS",
                { retryAfterMinutes: wait },
            );
        }
    }

    private async assertCodeTryAllowed(requesterId: string, targetId: string) {
        const now = new Date();
        const since = new Date(now.getTime() - THROTTLE_WINDOW_MS);
        const mine = await this.recentAttempts("RequesterUserId", requesterId, "CODE", true, since);
        if (mine.length >= CODE_FAIL_LIMIT) {
            const wait = minutesUntil(new Date(new Date(mine[0]!.CreatedAt).getTime() + THROTTLE_WINDOW_MS), now);
            throw new FamilyLinkError(
                `Too many wrong codes. Please try again in ${wait} minute${wait === 1 ? "" : "s"}, or send a request instead.`,
                429,
                "TOO_MANY_CODE_TRIES",
                { retryAfterMinutes: wait },
            );
        }
        const theirs = await this.recentAttempts("TargetUserId", targetId, "CODE", true, since);
        if (theirs.length >= CODE_FAIL_LIMIT) {
            const wait = minutesUntil(new Date(new Date(theirs[0]!.CreatedAt).getTime() + THROTTLE_WINDOW_MS), now);
            throw new FamilyLinkError(
                `Too many wrong codes were tried for this number. Try again in ${wait} minute${wait === 1 ? "" : "s"}, or send a request instead.`,
                429,
                "TARGET_CODE_LOCKED",
                { retryAfterMinutes: wait },
            );
        }
    }

    // ── Lookups and capacity ─────────────────────────────────────────────────

    /** Finds the person behind [rawPhone] for [actor], counting the lookup. */
    private async findTarget(actor: User, rawPhone: unknown): Promise<User> {
        const phone = normalizeFamilyPhone(rawPhone);
        if (!phone) throw new FamilyLinkError("Enter a 10-digit mobile number.", 400, "INVALID_PHONE");
        if (normalizeFamilyPhone(actor.PhoneNumber) === phone) {
            throw new FamilyLinkError("That's your own number. Enter the number of the person you want to link.", 400, "CANNOT_LINK_SELF");
        }
        await this.assertLookupAllowed(actor.Id);
        const target = await this.findAccountHolderByPhone(phone);
        await this.recordAttempt(actor.Id, target?.Id ?? null, "LOOKUP", !!target);
        if (!target) {
            throw new FamilyLinkError(
                "No Yira account uses this number. Check the number, or add them as a family member instead.",
                404,
                "NOT_FOUND",
            );
        }
        if (sameId(target.Id, actor.Id)) {
            throw new FamilyLinkError("That's your own number. Enter the number of the person you want to link.", 400, "CANNOT_LINK_SELF");
        }
        return target;
    }

    private async linksBetween(a: string, b: string, statuses: string[]): Promise<FamilyLink[]> {
        return this.links
            .createQueryBuilder("l")
            .where("l.Status IN (:...statuses)", { statuses })
            .andWhere(
                "((l.RequesterUserId = :a AND l.TargetUserId = :b) OR (l.RequesterUserId = :b AND l.TargetUserId = :a))",
                { a, b },
            )
            .orderBy("l.Id", "DESC")
            .getMany();
    }

    /** Accepted links of [userId] whose other side still has an account. */
    private async acceptedLinks(userId: string): Promise<{ link: FamilyLink; other: User }[]> {
        const rows = await this.links
            .createQueryBuilder("l")
            .where("l.Status = :status", { status: STATUS.ACCEPTED })
            .andWhere("(l.RequesterUserId = :userId OR l.TargetUserId = :userId)", { userId })
            .orderBy("l.Id", "ASC")
            .getMany();
        if (rows.length === 0) return [];
        const otherIds = rows.map((l) => (sameId(l.RequesterUserId, userId) ? l.TargetUserId : l.RequesterUserId));
        const others = await this.users.find({ where: { Id: In(otherIds), IsDeleted: false } });
        const seen = new Set<string>();
        const result: { link: FamilyLink; other: User }[] = [];
        for (const link of rows) {
            const otherId = sameId(link.RequesterUserId, userId) ? link.TargetUserId : link.RequesterUserId;
            const other = others.find((u) => sameId(u.Id, otherId));
            if (!other || seen.has(other.Id.toUpperCase())) continue;
            seen.add(other.Id.toUpperCase());
            result.push({ link, other });
        }
        return result;
    }

    private async dependentsOf(holder: User): Promise<User[]> {
        const where: any[] = [{ ParentUserId: holder.Id, IsDeleted: false }];
        if (holder.PhoneNumber) where.push({ PhoneNumber: holder.PhoneNumber, IsPrimary: false, IsDeleted: false });
        const rows = await this.users.find({ where });
        const seen = new Set<string>();
        return rows.filter((u) => {
            const key = u.Id.toUpperCase();
            if (sameId(u.Id, holder.Id) || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    private async pendingOutgoingCount(userId: string, now = new Date()): Promise<number> {
        return this.links
            .createQueryBuilder("l")
            .where("l.RequesterUserId = :userId", { userId })
            .andWhere("l.Status = :status", { status: STATUS.PENDING })
            .andWhere("l.ExpiresAt > :now", { now })
            .getCount();
    }

    /** Dependents plus linked accounts: what the "You can add N more" limit counts. */
    private async memberCount(holder: User): Promise<number> {
        const [dependents, linked] = await Promise.all([this.dependentsOf(holder), this.acceptedLinks(holder.Id)]);
        return dependents.length + linked.length;
    }

    private async assertRoomFor(actor: User, target: User, countPendingOfActor: boolean) {
        const actorUsed = (await this.memberCount(actor)) + (countPendingOfActor ? await this.pendingOutgoingCount(actor.Id) : 0);
        if (actorUsed >= MAX_FAMILY_MEMBERS) {
            throw new FamilyLinkError(
                `Your family already has ${MAX_FAMILY_MEMBERS} members${countPendingOfActor ? " or open requests" : ""}. Remove someone first to link a new person.`,
                409,
                "FAMILY_LIMIT_REACHED",
            );
        }
        if ((await this.memberCount(target)) >= MAX_FAMILY_MEMBERS) {
            throw new FamilyLinkError(
                `Their family already has ${MAX_FAMILY_MEMBERS} members, so they can't be linked right now.`,
                409,
                "TARGET_FAMILY_FULL",
            );
        }
    }

    /**
     * For add-dependent: true when the account holder's dependents plus linked
     * accounts already fill the family. False when links can't be read.
     */
    async familyLimitReached(parentUserId: string | undefined, rawPhone: string): Promise<boolean> {
        try {
            let holder: User | null = null;
            if (parentUserId && isUuid(parentUserId)) {
                holder = await this.users.findOne({ where: { Id: parentUserId.trim(), IsDeleted: false } });
            }
            const phone = normalizeFamilyPhone(rawPhone);
            if (!holder && phone) holder = await this.findAccountHolderByPhone(phone);
            if (!holder) return false;
            if (holder.ParentUserId) holder = (await this.users.findOne({ where: { Id: holder.ParentUserId, IsDeleted: false } })) ?? holder;
            const linked = (await this.acceptedLinks(holder.Id)).length;
            if (linked === 0) return false;
            return (await this.dependentsOf(holder)).length + linked >= MAX_FAMILY_MEMBERS;
        } catch (error: any) {
            console.error("[FamilyLink] Family limit check failed:", error?.message);
            return false;
        }
    }

    // ── Patient account lookups by phone (accounts-by-phone) ─────────────────

    /** True when any of [userIds] works at a hospital (a non-patient role or a doctor profile). */
    async isStaffAccount(userIds: string[]): Promise<boolean> {
        const ids = userIds.filter(isUuid).map((id) => id.trim());
        if (ids.length === 0) return false;
        const roles = await AppDataSource.getRepository(UserRole)
            .createQueryBuilder("ur")
            .where("ur.UserId IN (:...ids)", { ids })
            .andWhere("ur.IsDeleted = 0")
            .andWhere("UPPER(CAST(ur.RoleId AS NVARCHAR(36))) <> :patientRoleId", { patientRoleId: PATIENT_ROLE_ID })
            .getCount();
        if (roles > 0) return true;
        const providers = await AppDataSource.getRepository(HealthcareProvider).count({ where: { UserId: In(ids), IsDeleted: false } });
        return providers > 0;
    }

    /** Last 10 digits of the numbers of [userIds] and of their parent accounts. */
    async ownFamilyPhones(userIds: string[]): Promise<Set<string>> {
        const phones = new Set<string>();
        const ids = userIds.filter(isUuid).map((id) => id.trim());
        if (ids.length === 0) return phones;
        const users = await this.users.find({ where: { Id: In(ids), IsDeleted: false } });
        const parentIds = users.map((u) => u.ParentUserId).filter((id): id is string => !!id && isUuid(id));
        const parents = parentIds.length ? await this.users.find({ where: { Id: In(parentIds), IsDeleted: false } }) : [];
        for (const u of [...users, ...parents]) {
            const digits = String(u.PhoneNumber || "").replace(/\D/g, "");
            if (digits.length >= 10) phones.add(digits.slice(-10));
        }
        return phones;
    }

    // ── Views ────────────────────────────────────────────────────────────────

    private relationFor(link: FamilyLink, viewerId: string): string {
        if (sameId(link.RequesterUserId, viewerId)) return link.Relation;
        return link.TargetRelation || "Family";
    }

    private linkedMember(link: FamilyLink, other: User, viewerId: string) {
        return {
            id: other.Id,
            userId: other.Id,
            type: "LINKED",
            linkId: link.Id,
            name: fullName(other),
            firstName: other.FirstName || "",
            lastName: other.LastName || "",
            relation: this.relationFor(link, viewerId),
            gender: other.Gender || null,
            dob: formatDob(other.DateOfBirth),
            phoneNumber: other.PhoneNumber || null,
            imagePath: other.ImagePath || null,
            linkedAt: link.LinkedAt || null,
            method: link.Method,
        };
    }

    /** Linked accounts in the shape of the login's profiles list, for the profile switcher. */
    async linkedProfilesFor(holderId: string): Promise<any[]> {
        const linked = await this.acceptedLinks(holderId);
        return linked.map(({ link, other }) => ({
            id: other.Id,
            firstName: other.FirstName ?? null,
            lastName: other.LastName ?? null,
            name: fullName(other),
            phoneNumber: other.PhoneNumber,
            relation: this.relationFor(link, holderId),
            isPrimary: false,
            gender: other.Gender ?? null,
            dob: formatDob(other.DateOfBirth),
            accountType: "Linked",
            isLinked: true,
            linkId: link.Id,
            imagePath: other.ImagePath || null,
            profileImageUrl: other.ImagePath || null,
        }));
    }

    /** Everyone in the holder's family: dependents and linked accounts, with the limit. */
    async listMembers(holder: User) {
        const [dependents, linked, pending] = await Promise.all([
            this.dependentsOf(holder),
            this.acceptedLinks(holder.Id),
            this.pendingOutgoingCount(holder.Id),
        ]);
        const members = [
            ...dependents.map((u) => ({
                id: u.Id,
                userId: u.Id,
                type: "DEPENDENT",
                linkId: null,
                name: fullName(u),
                firstName: u.FirstName || "",
                lastName: u.LastName || "",
                relation: u.Relation && u.Relation.toLowerCase() !== "self" ? u.Relation : "Dependent",
                gender: u.Gender || null,
                dob: formatDob(u.DateOfBirth),
                phoneNumber: u.PhoneNumber || null,
                imagePath: u.ImagePath || null,
                linkedAt: null,
                method: null,
            })),
            ...linked.map(({ link, other }) => this.linkedMember(link, other, holder.Id)),
        ];
        const used = members.length;
        return {
            members,
            limit: MAX_FAMILY_MEMBERS,
            used,
            remaining: Math.max(0, MAX_FAMILY_MEMBERS - used),
            pendingOutgoing: pending,
        };
    }

    private async expireOldRequests(userId: string, now = new Date()) {
        await this.links
            .createQueryBuilder()
            .update(FamilyLink)
            .set({ Status: STATUS.EXPIRED, UpdatedAt: now })
            .where("Status = :pending AND ExpiresAt <= :now AND (RequesterUserId = :userId OR TargetUserId = :userId)", {
                pending: STATUS.PENDING,
                now,
                userId,
            })
            .execute()
            .catch(() => undefined);
    }

    /** Requests waiting on the holder (incoming) and ones the holder sent (outgoing). */
    async listRequests(holder: User) {
        const now = new Date();
        await this.expireOldRequests(holder.Id, now);
        const rows = await this.links
            .createQueryBuilder("l")
            .where("l.Status = :status", { status: STATUS.PENDING })
            .andWhere("l.ExpiresAt > :now", { now })
            .andWhere("(l.RequesterUserId = :userId OR l.TargetUserId = :userId)", { userId: holder.Id })
            .orderBy("l.Id", "DESC")
            .getMany();
        const otherIds = rows.map((l) => (sameId(l.RequesterUserId, holder.Id) ? l.TargetUserId : l.RequesterUserId));
        const others = otherIds.length ? await this.users.find({ where: { Id: In(otherIds), IsDeleted: false } }) : [];
        const find = (id: string) => others.find((u) => sameId(u.Id, id));

        const incoming = [];
        const outgoing = [];
        for (const l of rows) {
            if (sameId(l.TargetUserId, holder.Id)) {
                const from = find(l.RequesterUserId);
                if (!from) continue;
                incoming.push({
                    id: l.Id,
                    fromUserId: from.Id,
                    name: fullName(from),
                    phoneHint: phoneHint(from.PhoneNumber),
                    // How they describe you, and the relation suggested for them.
                    relation: l.Relation,
                    suggestedRelation: l.TargetRelation || inverseFamilyRelation(l.Relation, from.Gender),
                    createdAt: l.CreatedAt,
                    expiresAt: l.ExpiresAt,
                });
            } else {
                const to = find(l.TargetUserId);
                if (!to) continue;
                // Until they accept, the sender sees only the masked name.
                outgoing.push({
                    id: l.Id,
                    maskedName: maskFamilyName(to.FirstName, to.LastName),
                    phoneHint: phoneHint(to.PhoneNumber),
                    relation: l.Relation,
                    createdAt: l.CreatedAt,
                    expiresAt: l.ExpiresAt,
                });
            }
        }
        return { incoming, outgoing };
    }

    // ── Linking ──────────────────────────────────────────────────────────────

    /** Found / not found, with only a masked name. */
    async lookup(actor: User, rawPhone: unknown) {
        let target: User;
        try {
            target = await this.findTarget(actor, rawPhone);
        } catch (error) {
            if (error instanceof FamilyLinkError && error.code === "NOT_FOUND") return { found: false };
            throw error;
        }
        const [linked, pending] = await Promise.all([
            this.linksBetween(actor.Id, target.Id, [STATUS.ACCEPTED]),
            this.linksBetween(actor.Id, target.Id, [STATUS.PENDING]),
        ]);
        const now = new Date();
        const open = pending.filter((l) => l.ExpiresAt && new Date(l.ExpiresAt) > now);
        return {
            found: true,
            maskedName: maskFamilyName(target.FirstName, target.LastName),
            alreadyLinked: linked.length > 0,
            requestSent: open.some((l) => sameId(l.RequesterUserId, actor.Id)),
            requestReceived: open.some((l) => sameId(l.TargetUserId, actor.Id)),
        };
    }

    private async assertNotLinked(actor: User, target: User) {
        if ((await this.linksBetween(actor.Id, target.Id, [STATUS.ACCEPTED])).length > 0) {
            throw new FamilyLinkError(`${maskFamilyName(target.FirstName, target.LastName)} is already in your family.`, 409, "ALREADY_LINKED");
        }
    }

    /** Links at once with the target's current family code: sharing the code is their consent. */
    async linkWithCode(actor: User, rawPhone: unknown, rawCode: unknown, rawRelation: unknown) {
        const relation = normalizeFamilyRelation(rawRelation);
        if (!relation) throw new FamilyLinkError("Choose how they are related to you.", 400, "INVALID_RELATION");
        const code = String(rawCode ?? "").replace(/\D/g, "");
        if (!/^\d{4}$/.test(code)) throw new FamilyLinkError("Enter the 4-digit family code shown in their app.", 400, "INVALID_CODE");

        const target = await this.findTarget(actor, rawPhone);
        await this.assertNotLinked(actor, target);
        await this.assertCodeTryAllowed(actor.Id, target.Id);

        const now = new Date();
        const current = await this.activeCode(target.Id, now);
        const ok = !!current && codesMatch(deriveCode(target.Id, current.CodeSeed), code);
        await this.recordAttempt(actor.Id, target.Id, "CODE", ok);

        if (!ok) {
            if (current) {
                current.FailedAttempts = (current.FailedAttempts ?? 0) + 1;
                // A code that has been guessed at too often stops working.
                if (current.FailedAttempts >= CODE_FAIL_LIMIT) current.RevokedAt = now;
                await this.codes.save(current).catch(() => undefined);
            }
            const lastShown = await this.codes
                .createQueryBuilder("c")
                .where("c.UserId = :userId", { userId: target.Id })
                .orderBy("c.Id", "DESC")
                .getOne();
            const expired = !current && !!lastShown;
            throw new FamilyLinkError(
                expired
                    ? "This code has expired. Ask them to open My Family and share the new code."
                    : "That code doesn't match. Check the 4 digits in their app and try again.",
                400,
                expired ? "CODE_EXPIRED" : "WRONG_CODE",
            );
        }

        await this.assertRoomFor(actor, target, false);

        // The code is single use.
        current!.RevokedAt = now;
        await this.codes.save(current!);

        // Any open request between the two is settled by this link.
        const open = await this.linksBetween(actor.Id, target.Id, [STATUS.PENDING]);
        for (const l of open) {
            l.Status = STATUS.CANCELLED;
            l.UpdatedAt = now;
        }
        if (open.length) await this.links.save(open);

        const link = await this.links.save(
            this.links.create({
                RequesterUserId: actor.Id,
                TargetUserId: target.Id,
                Relation: relation,
                TargetRelation: inverseFamilyRelation(relation, actor.Gender),
                Status: STATUS.ACCEPTED,
                Method: "CODE",
                ExpiresAt: null,
                RespondedAt: now,
                LinkedAt: now,
                CreatedAt: now,
                UpdatedAt: now,
            }),
        );

        await this.notify({
            userId: target.Id,
            senderId: actor.Id,
            title: "Linked to your family",
            body: `${fullName(actor)} used your family code and is now linked to your family on Yira. If this wasn't you, remove them in My Family.`,
            type: "FAMILY_LINKED",
            linkId: link.Id,
        });

        return { member: this.linkedMember(link, target, actor.Id) };
    }

    /** Sends a request the other person accepts or declines in My Family. */
    async sendRequest(actor: User, rawPhone: unknown, rawRelation: unknown) {
        const relation = normalizeFamilyRelation(rawRelation);
        if (!relation) throw new FamilyLinkError("Choose how they are related to you.", 400, "INVALID_RELATION");

        const target = await this.findTarget(actor, rawPhone);
        await this.assertNotLinked(actor, target);

        const now = new Date();
        const open = (await this.linksBetween(actor.Id, target.Id, [STATUS.PENDING])).filter(
            (l) => l.ExpiresAt && new Date(l.ExpiresAt) > now,
        );
        const mine = open.find((l) => sameId(l.RequesterUserId, actor.Id));
        if (mine) {
            throw new FamilyLinkError(
                `You've already sent ${maskFamilyName(target.FirstName, target.LastName)} a request. They can accept it in My Family.`,
                409,
                "REQUEST_ALREADY_SENT",
                { requestId: mine.Id },
            );
        }

        // They already asked to link with you: asking back is accepting.
        const theirs = open.find((l) => sameId(l.RequesterUserId, target.Id));
        if (theirs) {
            const accepted = await this.acceptRequest(actor, theirs.Id, relation);
            return { status: STATUS.ACCEPTED, ...accepted };
        }

        await this.assertRoomFor(actor, target, true);

        const link = await this.links.save(
            this.links.create({
                RequesterUserId: actor.Id,
                TargetUserId: target.Id,
                Relation: relation,
                TargetRelation: inverseFamilyRelation(relation, actor.Gender),
                Status: STATUS.PENDING,
                Method: "REQUEST",
                ExpiresAt: new Date(now.getTime() + FAMILY_REQUEST_TTL_MS),
                CreatedAt: now,
                UpdatedAt: now,
            }),
        );

        await this.notify({
            userId: target.Id,
            senderId: actor.Id,
            title: "Family link request",
            body: `${fullName(actor)} wants to add you to their family on Yira as their ${relation.toLowerCase()}. Open My Family to accept or decline.`,
            type: "FAMILY_LINK_REQUEST",
            linkId: link.Id,
        });

        return {
            status: STATUS.PENDING,
            request: {
                id: link.Id,
                maskedName: maskFamilyName(target.FirstName, target.LastName),
                phoneHint: phoneHint(target.PhoneNumber),
                relation,
                createdAt: link.CreatedAt,
                expiresAt: link.ExpiresAt,
            },
        };
    }

    private async pendingRequest(id: number): Promise<FamilyLink> {
        const link = Number.isInteger(id) && id > 0 ? await this.links.findOne({ where: { Id: id } }) : null;
        if (!link) throw new FamilyLinkError("This request no longer exists.", 404, "REQUEST_NOT_FOUND");
        if (link.Status === STATUS.PENDING && link.ExpiresAt && new Date(link.ExpiresAt) <= new Date()) {
            link.Status = STATUS.EXPIRED;
            link.UpdatedAt = new Date();
            await this.links.save(link).catch(() => undefined);
        }
        if (link.Status === STATUS.EXPIRED) throw new FamilyLinkError("This request has expired. Ask them to send a new one.", 410, "REQUEST_EXPIRED");
        if (link.Status !== STATUS.PENDING) throw new FamilyLinkError("This request has already been answered.", 409, "REQUEST_CLOSED");
        return link;
    }

    async acceptRequest(actor: User, id: number, rawRelation?: unknown) {
        const link = await this.pendingRequest(id);
        if (!sameId(link.TargetUserId, actor.Id)) throw new FamilyLinkError("This request no longer exists.", 404, "REQUEST_NOT_FOUND");
        const requester = await this.users.findOne({ where: { Id: link.RequesterUserId, IsDeleted: false } });
        if (!requester) throw new FamilyLinkError("The person who sent this request no longer has a Yira account.", 410, "REQUEST_EXPIRED");

        await this.assertNotLinked(actor, requester);
        await this.assertRoomFor(actor, requester, false);

        const chosen = rawRelation === undefined || rawRelation === null || rawRelation === "" ? null : normalizeFamilyRelation(rawRelation);
        if (rawRelation && !chosen) throw new FamilyLinkError("Choose how they are related to you.", 400, "INVALID_RELATION");

        const now = new Date();
        link.Status = STATUS.ACCEPTED;
        link.TargetRelation = chosen || link.TargetRelation || inverseFamilyRelation(link.Relation, requester.Gender);
        link.RespondedAt = now;
        link.LinkedAt = now;
        link.UpdatedAt = now;
        await this.links.save(link);

        await this.notify({
            userId: requester.Id,
            senderId: actor.Id,
            title: "Family link accepted",
            body: `${fullName(actor)} accepted your request and is now in your family on Yira.`,
            type: "FAMILY_LINK_ACCEPTED",
            linkId: link.Id,
        });

        return { member: this.linkedMember(link, requester, actor.Id) };
    }

    async declineRequest(actor: User, id: number) {
        const link = await this.pendingRequest(id);
        if (!sameId(link.TargetUserId, actor.Id)) throw new FamilyLinkError("This request no longer exists.", 404, "REQUEST_NOT_FOUND");
        const now = new Date();
        link.Status = STATUS.DECLINED;
        link.RespondedAt = now;
        link.UpdatedAt = now;
        await this.links.save(link);
        return { id: link.Id, status: link.Status };
    }

    async cancelRequest(actor: User, id: number) {
        const link = await this.pendingRequest(id);
        if (!sameId(link.RequesterUserId, actor.Id)) throw new FamilyLinkError("This request no longer exists.", 404, "REQUEST_NOT_FOUND");
        link.Status = STATUS.CANCELLED;
        link.UpdatedAt = new Date();
        await this.links.save(link);
        return { id: link.Id, status: link.Status };
    }

    /** Either side can end an accepted link. */
    async removeLink(actor: User, id: number) {
        const link = Number.isInteger(id) && id > 0 ? await this.links.findOne({ where: { Id: id } }) : null;
        const mine = !!link && (sameId(link.RequesterUserId, actor.Id) || sameId(link.TargetUserId, actor.Id));
        if (!link || !mine || link.Status !== STATUS.ACCEPTED) {
            throw new FamilyLinkError("This person is no longer linked to your family.", 404, "LINK_NOT_FOUND");
        }
        const now = new Date();
        link.Status = STATUS.REMOVED;
        link.RemovedAt = now;
        link.RemovedByUserId = actor.Id;
        link.UpdatedAt = now;
        await this.links.save(link);
        return { id: link.Id, status: link.Status };
    }

    private async notify(params: { userId: string; senderId: string; title: string; body: string; type: string; linkId: number }) {
        try {
            await pushNotificationService.sendNotification({
                userId: params.userId,
                senderId: params.senderId,
                title: params.title,
                body: params.body,
                type: params.type,
                referenceId: String(params.linkId),
                route: FAMILY_ROUTE,
                additionalData: { linkId: String(params.linkId), fromUserId: params.senderId },
            });
        } catch (error: any) {
            console.error(`[FamilyLink] ${params.type} notification failed:`, error?.message);
        }
    }
}

export const familyLinkService = new FamilyLinkService();
