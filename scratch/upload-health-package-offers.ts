import { AppDataSource } from "../src/config/database.js";
import { offerBannerService } from "../src/services/Offers/offer-banner.service.js";
import { blobService } from "../src/services/Common/blob.service.js";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const IMAGES_DIR = "/Users/office/.gemini/antigravity-ide/brain/df5c5ade-ab53-4ba3-a348-daedfab27856";

const PACKAGES_TO_UPLOAD = [
    {
        filename: "full_body_checkup_banner_1788947323388.jpg",
        blobName: "offers/packages/executive_full_body_checkup.jpg",
        title: "Executive Full Body Health Checkup",
        description: "Comprehensive 65+ essential diagnostic tests including CBC, Lipid Profile, Liver & Kidney Function with Doctor Consultation",
        placement: "carousel",
        redirectionType: "in_app",
        inAppRoute: "/patientBookAppointment",
        inAppParams: { specialty: "General Medicine", package: "Full Body Checkup" },
        isAllOrganizations: true,
        isActive: true,
        showTitle: false,
        showDescription: false,
        showOfferTag: false,
        offerTag: "BEST VALUE",
        displayOrder: 1,
    },
    {
        filename: "cardiac_care_banner_1788947346095.jpg",
        blobName: "offers/packages/cardiac_care_screening.jpg",
        title: "Advanced Cardiac Care & Heart Screening",
        description: "Specialized heart checkup with ECG, 2D Echocardiogram, TMT stress test and expert cardiologist consultation",
        placement: "carousel",
        redirectionType: "in_app",
        inAppRoute: "/patientBookAppointment",
        inAppParams: { specialty: "Cardiology", package: "Heart Screening" },
        isAllOrganizations: true,
        isActive: true,
        showTitle: false,
        showDescription: false,
        showOfferTag: false,
        offerTag: "SPECIALIZED CARE",
        displayOrder: 2,
    },
    {
        filename: "family_wellness_banner_1788947366712.jpg",
        blobName: "offers/packages/family_wellness_package.jpg",
        title: "Complete Family Wellness & Health Package",
        description: "All-in-one health protection for family members: Pediatric screening, adult vitals, dental check and basic lab tests",
        placement: "carousel",
        redirectionType: "in_app",
        inAppRoute: "/patientBookAppointment",
        inAppParams: { specialty: "Pediatrics", package: "Family Wellness" },
        isAllOrganizations: true,
        isActive: true,
        showTitle: false,
        showDescription: false,
        showOfferTag: false,
        offerTag: "FAMILY PLAN",
        displayOrder: 3,
    },
    {
        filename: "popup_package_offer_1788947386459.jpg",
        blobName: "offers/packages/special_health_checkup_popup.jpg",
        title: "Special Health Checkup - Flat 40% OFF",
        description: "Exclusive mobile app offer: 40% off on comprehensive health packages for a limited time",
        placement: "popup",
        redirectionType: "in_app",
        inAppRoute: "/patientBookAppointment",
        inAppParams: { discount: "40%", code: "HEALTH40" },
        isAllOrganizations: true,
        isActive: true,
        showTitle: false,
        showDescription: false,
        showOfferTag: false,
        offerTag: "FLAT 40% OFF",
        displayOrder: 1,
        maxDisplayCount: 5, // Show up to 5 times per device
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // Active for next 30 days
    }
];

const run = async () => {
    try {
        await AppDataSource.initialize();
        console.log("[UPLOAD SCRIPT] Connected to Database.");

        for (const pkg of PACKAGES_TO_UPLOAD) {
            const localFilePath = path.join(IMAGES_DIR, pkg.filename);
            if (!fs.existsSync(localFilePath)) {
                console.warn(`[UPLOAD SCRIPT] File not found: ${localFilePath}`);
                continue;
            }

            console.log(`\n[UPLOAD SCRIPT] Uploading ${pkg.title} to Azure Blob...`);
            const fileBuffer = fs.readFileSync(localFilePath);
            const blobUrl = await blobService.uploadBuffer(
                fileBuffer,
                `${pkg.blobName.replace(".jpg", "")}_${Date.now()}.jpg`,
                "image/jpeg"
            );
            console.log(`[UPLOAD SCRIPT] Uploaded to Blob successfully! URL: ${blobUrl}`);

            console.log(`[UPLOAD SCRIPT] Creating offer banner in database...`);
            const created = await offerBannerService.createOffer({
                title: pkg.title,
                description: pkg.description,
                imageUrl: blobUrl,
                placement: pkg.placement,
                redirectionType: pkg.redirectionType,
                inAppRoute: pkg.inAppRoute,
                inAppParams: pkg.inAppParams,
                isAllOrganizations: pkg.isAllOrganizations,
                isActive: pkg.isActive,
                showTitle: pkg.showTitle,
                showDescription: pkg.showDescription,
                showOfferTag: pkg.showOfferTag,
                offerTag: pkg.offerTag,
                displayOrder: pkg.displayOrder,
                maxDisplayCount: pkg.maxDisplayCount,
                startDate: pkg.startDate,
                endDate: pkg.endDate,
            });

            console.log(`[UPLOAD SCRIPT] Created Offer #${created.id} (${created.placement}) -> ${created.title}`);
        }

        console.log("\n[UPLOAD SCRIPT] Verifying all active banners...");
        const carouselBanners = await offerBannerService.getActiveOffers(undefined, "carousel");
        console.log(`[UPLOAD SCRIPT] Active Carousel Banners count: ${carouselBanners.length}`);
        carouselBanners.forEach(b => console.log(` - [#${b.id}] ${b.title} | Order: ${b.displayOrder} | ${b.imageUrl.slice(0, 60)}...`));

        const popupAd = await offerBannerService.getActivePopupAd();
        console.log(`[UPLOAD SCRIPT] Active Popup Ad: [#${popupAd?.id}] ${popupAd?.title} | MaxCount: ${popupAd?.maxDisplayCount}`);

        await AppDataSource.destroy();
        console.log("[UPLOAD SCRIPT] Finished successfully.");
        process.exit(0);
    } catch (error) {
        console.error("[UPLOAD SCRIPT] Error:", error);
        process.exit(1);
    }
};

run();
