import { In } from "typeorm/index.js";
import { AppDataSource } from "../../config/database.js";
import { LabPackage } from "../../models/LabPackages/lab-package.model.js";
import { LabPackageHospital } from "../../models/LabPackages/lab-package-hospital.model.js";
import { Hospital } from "../../models/Organizations/hospital.model.js";
import { HospitalPaymentConfiguration } from "../../models/Organizations/hospital-payment-configuration.model.js";
import { User } from "../../models/Account/user.model.js";
import { STANDARD_LAB_TESTS } from "../../constants/standard-lab-tests.js";
import { defaultOrganizationRepository } from "../../repositories/Organizations/default-organization.repository.js";

export const roundMoney = (value: number) => Math.round(((Number(value) || 0) + Number.EPSILON) * 100) / 100;

/** Price before GST, the GST on it and the total the patient pays, rounded to paise. */
export function labPackageAmounts(price: number, gstPercentage: number) {
    const base = roundMoney(Math.max(0, Number(price) || 0));
    const pct = roundMoney(Math.max(0, Number(gstPercentage) || 0));
    const gstAmount = roundMoney((base * pct) / 100);
    return { price: base, gstPercentage: pct, gstAmount, totalAmount: roundMoney(base + gstAmount) };
}

/** Icons a "why it is worth it" card can use; the web and the app draw each one */
export const BENEFIT_ICONS = ["lab", "doctor", "report", "dental", "eye", "insurance", "home", "family", "support", "heart", "calendar", "video"] as const;

export interface PackageBenefit {
    icon: typeof BENEFIT_ICONS[number];
    title: string;
    description: string;
    /** What this would cost if booked separately (₹) */
    value: number;
    /** Show the value as "₹300+" */
    valuePlus: boolean;
    /** Draw this card highlighted */
    highlight: boolean;
}

/** "Why it is worth it" cards: up to 12, each with a title; values of 0 or more. */
export function parseBenefits(input: unknown): PackageBenefit[] {
    if (input === null || input === undefined || input === "") return [];
    const list = Array.isArray(input) ? input : (() => { try { return JSON.parse(String(input)); } catch { return []; } })();
    if (!Array.isArray(list)) return [];
    const benefits: PackageBenefit[] = [];
    for (const raw of list) {
        const title = String(raw?.title ?? "").trim().slice(0, 80);
        if (!title) continue;
        const value = Number(raw?.value);
        if (raw?.value !== undefined && raw?.value !== "" && (isNaN(value) || value < 0)) {
            throw new Error(`The value of "${title}" must be 0 or more.`);
        }
        const icon = BENEFIT_ICONS.includes(raw?.icon) ? raw.icon : "lab";
        benefits.push({
            icon,
            title,
            description: String(raw?.description ?? "").trim().slice(0, 200),
            value: isNaN(value) ? 0 : roundMoney(value),
            valuePlus: !!raw?.valuePlus,
            highlight: !!raw?.highlight
        });
    }
    if (benefits.length > 12) throw new Error("A package can show up to 12 \"why it is worth it\" cards.");
    return benefits;
}

/**
 * A test in a package, e.g. "Complete Blood Count with P. Smear" ("Blood health, infection,
 * anaemia") and the parameters it covers (Haemoglobin, Total WBC Count, …). A test with no
 * parameters counts as one.
 */
export interface PackageTest {
    name: string;
    description: string;
    tests: string[];
}

const uniqueNames = (list: unknown[], max: number, length = 200) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of list) {
        const name = String(item ?? "").trim().slice(0, length);
        if (name && !seen.has(name.toLowerCase())) {
            seen.add(name.toLowerCase());
            out.push(name);
        }
    }
    if (out.length > max) throw new Error(`Up to ${max} entries are allowed.`);
    return out;
};

/** Package tests as sent by the admin form: plain names (older form) or {name, description, tests}. */
export function parseTestGroups(input: unknown): PackageTest[] {
    const list = Array.isArray(input) ? input : (() => { try { return JSON.parse(String(input || "[]")); } catch { return []; } })();
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    const groups: PackageTest[] = [];
    for (const raw of list) {
        const isText = typeof raw === "string";
        const name = String(isText ? raw : raw?.name ?? "").trim().slice(0, 200);
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        const subTests = isText ? [] : Array.isArray(raw?.tests) ? raw.tests : String(raw?.tests || "").split(/[\n,;]+/);
        let tests: string[];
        try {
            tests = uniqueNames(subTests, 300);
        } catch {
            throw new Error(`"${name}" can have up to 300 parameters.`);
        }
        groups.push({ name, description: isText ? "" : String(raw?.description ?? "").trim().slice(0, 200), tests });
    }
    if (groups.length > 100) throw new Error("A package can have up to 100 tests.");
    return groups;
}

/** The tests saved on a package or an order; older rows hold a plain list of names. */
export function readTestGroups(value?: string | null): PackageTest[] {
    try {
        return parseTestGroups(JSON.parse(value || "[]"));
    } catch {
        return [];
    }
}

/** Parameters across the tests; a test without parameters counts as one. */
export const parameterCount = (groups: PackageTest[]) => groups.reduce((n, g) => n + Math.max(1, g.tests.length), 0);

export interface LabPackageInput {
    benefits?: unknown;
    name?: string;
    description?: string | null;
    tests?: string[] | string;
    /** Tests with their parameters; takes the place of `tests` */
    testGroups?: unknown;
    sampleType?: string | null;
    preparation?: string | null;
    reportTurnaround?: string | null;
    mrp?: number | string | null;
    price?: number | string;
    gstPercentage?: number | string;
    showInMobileApp?: boolean;
    pincodes?: string[] | string | null;
    isActive?: boolean;
    hospitalIds?: (number | string)[];
}

const clean = (value: unknown, max: number): string | null => {
    const s = String(value ?? "").trim();
    return s ? s.slice(0, max) : null;
};

/** Test names: trimmed, no blanks, no repeats (case-insensitive). */
function parseTests(input: LabPackageInput["tests"]): string[] {
    const raw = Array.isArray(input) ? input : String(input || "").split(/[\n,]/);
    const seen = new Set<string>();
    const tests: string[] = [];
    for (const t of raw) {
        const name = String(t || "").trim().slice(0, 200);
        if (name && !seen.has(name.toLowerCase())) {
            seen.add(name.toLowerCase());
            tests.push(name);
        }
    }
    return tests;
}

/** Pincodes: 6 digits each, no repeats. Anything else is refused so a typo cannot hide a package. */
export function parsePincodes(input: LabPackageInput["pincodes"]): string[] {
    const raw = Array.isArray(input) ? input : String(input || "").split(/[\s,;]+/);
    const pins = Array.from(new Set(raw.map(p => String(p || "").trim()).filter(Boolean)));
    const invalid = pins.filter(p => !/^\d{6}$/.test(p));
    if (invalid.length > 0) throw new Error(`Pincodes must be 6 digits: ${invalid.join(", ")}`);
    return pins;
}


const pincodeList = (value?: string | null) => (value ? value.split(",").map(p => p.trim()).filter(Boolean) : []);

export class LabPackageService {
    private repo = AppDataSource.getRepository(LabPackage);
    private linkRepo = AppDataSource.getRepository(LabPackageHospital);

    toDto(pkg: LabPackage, hospitals: { id: number; name: string }[] = []) {
        return {
            id: pkg.Id,
            name: pkg.Name,
            description: pkg.Description || "",
            ...(() => {
                const testGroups = readTestGroups(pkg.TestsIncluded);
                return { tests: testGroups.map(g => g.name), testGroups, parameterCount: parameterCount(testGroups) };
            })(),
            sampleType: pkg.SampleType || "",
            preparation: pkg.Preparation || "",
            reportTurnaround: pkg.ReportTurnaround || "",
            mrp: pkg.Mrp != null ? Number(pkg.Mrp) : null,
            price: Number(pkg.Price || 0),
            gstPercentage: Number(pkg.GstPercentage || 0),
            gstAmount: Number(pkg.GstAmount || 0),
            totalAmount: Number(pkg.TotalAmount || 0),
            showInMobileApp: !!pkg.ShowInMobileApp,
            // "Why it is worth it": the cards, and what they add up to if booked separately
            ...(() => {
                let benefits: PackageBenefit[] = [];
                try { benefits = parseBenefits(pkg.Benefits); } catch { benefits = []; }
                return {
                    benefits,
                    benefitsValue: roundMoney(benefits.reduce((s, b) => s + b.value, 0)),
                    benefitsValuePlus: benefits.some(b => b.valuePlus)
                };
            })(),
            pincodes: pincodeList(pkg.Pincodes),
            isActive: !!pkg.IsActive,
            hospitals,
            createdAt: pkg.CreatedAt,
            updatedAt: pkg.UpdatedAt || null
        };
    }

    /** Hospital id → name for the hospitals linked to each package. */
    private async hospitalsByPackage(packageIds: number[]): Promise<Map<number, { id: number; name: string }[]>> {
        const map = new Map<number, { id: number; name: string }[]>();
        if (packageIds.length === 0) return map;
        const rows = await this.linkRepo.createQueryBuilder("l")
            .innerJoin(Hospital, "h", "h.Id = l.HospitalId")
            .select(["l.LabPackageId AS packageId", "h.Id AS id", "h.Name AS name"])
            .where("l.LabPackageId IN (:...packageIds)", { packageIds })
            .orderBy("h.Name", "ASC")
            .getRawMany();
        for (const r of rows) {
            const list = map.get(Number(r.packageId)) || [];
            list.push({ id: Number(r.id), name: r.name });
            map.set(Number(r.packageId), list);
        }
        return map;
    }

    async listForAdmin(filters: { search?: string; hospitalId?: number } = {}) {
        const qb = this.repo.createQueryBuilder("p").where("p.IsDeleted = 0");
        if (filters.search?.trim()) {
            qb.andWhere("(p.Name LIKE :s OR p.TestsIncluded LIKE :s)", { s: `%${filters.search.trim()}%` });
        }
        if (filters.hospitalId) {
            qb.andWhere("EXISTS (SELECT 1 FROM LabPackageHospitals l WHERE l.LabPackageId = p.Id AND l.HospitalId = :hid)", { hid: filters.hospitalId });
        }
        const packages = await qb.orderBy("p.CreatedAt", "DESC").getMany();
        const hospitals = await this.hospitalsByPackage(packages.map(p => p.Id));
        return packages.map(p => this.toDto(p, hospitals.get(p.Id) || []));
    }

    async getById(id: number) {
        const pkg = await this.repo.findOne({ where: { Id: id, IsDeleted: false } });
        if (!pkg) throw new Error("Lab package not found.");
        const hospitals = await this.hospitalsByPackage([pkg.Id]);
        return this.toDto(pkg, hospitals.get(pkg.Id) || []);
    }

    private async validate(data: LabPackageInput, existing?: LabPackage) {
        const name = clean(data.name ?? existing?.Name, 200);
        if (!name) throw new Error("Package name is required.");

        const priceInput = data.price ?? existing?.Price;
        if (priceInput === undefined || priceInput === null || String(priceInput).trim() === "" || isNaN(Number(priceInput)) || Number(priceInput) < 0) {
            throw new Error("Enter a price of 0 or more.");
        }
        const gstInput = data.gstPercentage ?? existing?.GstPercentage ?? 0;
        if (isNaN(Number(gstInput)) || Number(gstInput) < 0 || Number(gstInput) > 100) {
            throw new Error("GST % must be between 0 and 100.");
        }
        const amounts = labPackageAmounts(Number(priceInput), Number(gstInput));

        // Mrp is the original price shown struck through next to the offer price (Price). Both are
        // before GST, so the discount compares like with like (₹4,999 → ₹999 is 80% off).
        const mrpInput = data.mrp !== undefined ? data.mrp : existing?.Mrp;
        const mrp = mrpInput === null || mrpInput === undefined || String(mrpInput).trim() === "" ? null : roundMoney(Number(mrpInput));
        if (mrp !== null && (isNaN(mrp) || mrp < 0)) throw new Error("The original price must be 0 or more.");
        if (mrp !== null && mrp > 0 && amounts.price > mrp) {
            throw new Error(`The offer price (₹${amounts.price}) cannot be more than the original price (₹${mrp}).`);
        }

        const tests = data.testGroups !== undefined
            ? parseTestGroups(data.testGroups)
            : data.tests !== undefined
                ? parseTestGroups(parseTests(data.tests))
                : readTestGroups(existing?.TestsIncluded);
        if (tests.length === 0) throw new Error("Add at least one test to the package.");

        const pincodes = data.pincodes !== undefined ? parsePincodes(data.pincodes) : pincodeList(existing?.Pincodes);
        const benefits = data.benefits !== undefined ? parseBenefits(data.benefits) : parseBenefits(existing?.Benefits ?? null);

        let hospitalIds: number[] | null = null;
        if (data.hospitalIds !== undefined || !existing) {
            hospitalIds = Array.from(new Set((data.hospitalIds || []).map(Number).filter(id => id > 0)));
            if (hospitalIds.length === 0) throw new Error("Select at least one hospital that offers this package.");
            const found = await AppDataSource.getRepository(Hospital).count({ where: { Id: In(hospitalIds) } });
            if (found !== hospitalIds.length) throw new Error("One or more selected hospitals were not found.");
        }

        return { name, amounts, mrp, tests, pincodes, hospitalIds, benefits };
    }

    private async saveHospitals(packageId: number, hospitalIds: number[]) {
        await AppDataSource.transaction(async (manager) => {
            await manager.delete(LabPackageHospital, { LabPackageId: packageId });
            for (const hospitalId of hospitalIds) {
                await manager.save(LabPackageHospital, manager.create(LabPackageHospital, { LabPackageId: packageId, HospitalId: hospitalId, CreatedAt: new Date() }));
            }
        });
    }

    async create(data: LabPackageInput, userId?: string) {
        const v = await this.validate(data);
        const pkg = await this.repo.save(this.repo.create({
            Name: v.name!,
            Description: clean(data.description, 4000),
            TestsIncluded: JSON.stringify(v.tests),
            SampleType: clean(data.sampleType, 100),
            Preparation: clean(data.preparation, 500),
            ReportTurnaround: clean(data.reportTurnaround, 100),
            Mrp: v.mrp,
            Price: v.amounts.price,
            GstPercentage: v.amounts.gstPercentage,
            GstAmount: v.amounts.gstAmount,
            TotalAmount: v.amounts.totalAmount,
            ShowInMobileApp: data.showInMobileApp !== false,
            Benefits: v.benefits.length > 0 ? JSON.stringify(v.benefits) : null,
            Pincodes: v.pincodes.join(",") || null,
            IsActive: data.isActive !== false,
            IsDeleted: false,
            CreatedAt: new Date(),
            CreatedBy: userId || null
        }));
        await this.saveHospitals(pkg.Id, v.hospitalIds!);
        return this.getById(pkg.Id);
    }

    async update(id: number, data: LabPackageInput, userId?: string) {
        const existing = await this.repo.findOne({ where: { Id: id, IsDeleted: false } });
        if (!existing) throw new Error("Lab package not found.");
        const v = await this.validate(data, existing);

        await this.repo.update(id, {
            Name: v.name!,
            Description: data.description !== undefined ? clean(data.description, 4000) : existing.Description,
            TestsIncluded: JSON.stringify(v.tests),
            SampleType: data.sampleType !== undefined ? clean(data.sampleType, 100) : existing.SampleType,
            Preparation: data.preparation !== undefined ? clean(data.preparation, 500) : existing.Preparation,
            ReportTurnaround: data.reportTurnaround !== undefined ? clean(data.reportTurnaround, 100) : existing.ReportTurnaround,
            Mrp: v.mrp,
            Price: v.amounts.price,
            GstPercentage: v.amounts.gstPercentage,
            GstAmount: v.amounts.gstAmount,
            TotalAmount: v.amounts.totalAmount,
            ShowInMobileApp: data.showInMobileApp !== undefined ? !!data.showInMobileApp : existing.ShowInMobileApp,
            Benefits: v.benefits.length > 0 ? JSON.stringify(v.benefits) : null,
            Pincodes: v.pincodes.join(",") || null,
            IsActive: data.isActive !== undefined ? !!data.isActive : existing.IsActive,
            UpdatedAt: new Date(),
            UpdatedBy: userId || null
        });
        if (v.hospitalIds) await this.saveHospitals(id, v.hospitalIds);
        return this.getById(id);
    }

    async remove(id: number, userId?: string) {
        const res = await this.repo.update({ Id: id, IsDeleted: false }, { IsDeleted: true, IsActive: false, UpdatedAt: new Date(), UpdatedBy: userId || null });
        if (!res.affected) throw new Error("Lab package not found.");
        return { id };
    }

    testSuggestions(): string[] {
        return Array.from(new Set(STANDARD_LAB_TESTS.map(t => t.name))).sort((a, b) => a.localeCompare(b));
    }

    /**
     * Hospitals that can take a lab package payment: active, with their own Razorpay keys saved in an
     * active payment configuration. Lab package payments never fall back to Yira's keys.
     */
    async payableHospitalIds(hospitalIds: number[]): Promise<Set<number>> {
        if (hospitalIds.length === 0) return new Set();
        const configs = await AppDataSource.getRepository(HospitalPaymentConfiguration).find({
            where: { HospitalId: In(hospitalIds), IsDeleted: false, IsActive: true }
        });
        const withKeys = configs.filter(c => c.RazorpayKeyId && c.RazorpayKeySecret).map(c => Number(c.HospitalId));
        if (withKeys.length === 0) return new Set();
        const hospitals = await AppDataSource.getRepository(Hospital).find({ where: { Id: In(withKeys) } });
        return new Set(hospitals.filter(h => h.IsDeleted !== true && h.Status !== false).map(h => Number(h.Id)));
    }

    /** The patient's saved pincode (permanent address first), used when the app sends none. */
    async savedPincode(userId: string): Promise<string | null> {
        const user = await AppDataSource.getRepository(User).findOne({
            where: { Id: userId },
            relations: ["PermanentAddress", "TemporaryAddress"]
        });
        const pin = user?.PermanentAddress?.Pincode || user?.TemporaryAddress?.Pincode || "";
        const digits = String(pin).replace(/\D/g, "");
        return digits.length === 6 ? digits : null;
    }

    servesPincode(pkg: Pick<LabPackage, "Pincodes">, pincode: string | null) {
        const pins = pincodeList(pkg.Pincodes);
        return pins.length === 0 || (!!pincode && pins.includes(pincode));
    }

    /**
     * The default hospital (the active Default Organizations row, the one new patients are
     * registered to). Its packages are shown, and can be booked there, from any pincode.
     */
    async defaultHospital(): Promise<{ id: number; name: string } | null> {
        const active = await defaultOrganizationRepository.getActiveDefault();
        if (!active?.HospitalId) return null;
        return { id: Number(active.HospitalId), name: active.Hospital?.Name || "" };
    }

    /**
     * Packages the patient app shows: active, flagged for the app, offered in the pincode, and
     * bookable at one or more hospitals that take online payment. When nothing is offered in the
     * pincode, `fallback` holds the default hospital's packages, bookable at that hospital.
     */
    async listForPatient(userId: string, pincodeInput?: string | null) {
        const typed = String(pincodeInput || "").replace(/\D/g, "");
        if (typed && typed.length !== 6) throw new Error("Enter a 6-digit pincode.");
        const pincode = typed || (await this.savedPincode(userId));

        const packages = await this.repo.find({ where: { IsDeleted: false, IsActive: true, ShowInMobileApp: true }, order: { Name: "ASC" } });
        const hospitals = await this.hospitalsByPackage(packages.map(p => p.Id));
        const allHospitalIds = Array.from(new Set(Array.from(hospitals.values()).flat().map(h => h.id)));
        const payable = await this.payableHospitalIds(allHospitalIds);
        const item = (p: LabPackage, bookable: { id: number; name: string }[]) =>
            ({ ...this.toDto(p, bookable), pincodes: undefined, hospitalCount: bookable.length });

        const list = packages
            .filter(p => this.servesPincode(p, pincode))
            .map(p => item(p, (hospitals.get(p.Id) || []).filter(h => payable.has(h.id))))
            .filter(p => p.hospitalCount > 0);

        let fallback: { hospital: { id: number; name: string }; packages: ReturnType<typeof item>[] } | null = null;
        if (list.length === 0) {
            const def = await this.defaultHospital();
            if (def && payable.has(def.id)) {
                const fromDefault = packages
                    .map(p => ({ p, at: (hospitals.get(p.Id) || []).filter(h => h.id === def.id) }))
                    .filter(x => x.at.length > 0)
                    .map(x => item(x.p, x.at));
                if (fromDefault.length > 0) {
                    fallback = { hospital: { id: def.id, name: def.name || fromDefault[0].hospitals[0]?.name || "" }, packages: fromDefault };
                }
            }
        }
        return { pincode, packages: list, fallback };
    }

    /**
     * The package's hospitals that take online payment; those in the patient's pincode first. A
     * package not offered in the pincode is shown only from the default hospital, so only that one.
     */
    async hospitalsForPackage(packageId: number, pincodeInput?: string | null) {
        const pkg = await this.repo.findOne({ where: { Id: packageId, IsDeleted: false, IsActive: true } });
        if (!pkg) throw new Error("This lab package is no longer available.");
        const pincode = String(pincodeInput || "").replace(/\D/g, "") || null;

        let linkedIds = (await this.linkRepo.find({ where: { LabPackageId: packageId } })).map(l => l.HospitalId);
        if (!this.servesPincode(pkg, pincode)) {
            const def = await this.defaultHospital();
            linkedIds = def ? linkedIds.filter(id => Number(id) === def.id) : [];
        }
        const payable = await this.payableHospitalIds(linkedIds);
        if (payable.size === 0) return [];
        const hospitals = await AppDataSource.getRepository(Hospital).find({ where: { Id: In(Array.from(payable)) } });
        return hospitals
            .map(h => ({
                id: h.Id,
                name: h.Name,
                address: h.Address || "",
                city: h.City || "",
                pincode: h.Pincode || "",
                isInPincode: !!pincode && String(h.Pincode || "").trim() === pincode
            }))
            .sort((a, b) => Number(b.isInPincode) - Number(a.isInPincode) || a.name.localeCompare(b.name));
    }
}

export const labPackageService = new LabPackageService();
