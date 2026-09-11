import { AppDataSource } from "../src/config/database.js";
import { offerBannerService } from "../src/services/Offers/offer-banner.service.js";
import dotenv from "dotenv";
dotenv.config();

const run = async () => {
    try {
        await AppDataSource.initialize();
        console.log("[SEED] Database connected.");

        // Create Carousel Banner
        const carouselBanner = await offerBannerService.createOffer({
            title: "Executive Health Checkup Package",
            description: "Internal reference: Cardiology & Diabetic screening campaign",
            imageUrl: "https://images.unsplash.com/photo-1505751172876-fa1923c5c528?auto=format&fit=crop&w=1200&q=80",
            placement: "carousel",
            redirectionType: "in_app",
            inAppRoute: "/patientBookAppointment",
            isAllOrganizations: true,
            isActive: true,
            showTitle: false,
            showDescription: false,
            showOfferTag: false,
            displayOrder: 1,
        });
        console.log("[SEED] Created Carousel Banner:", carouselBanner.id);

        // Create Popup Ad
        const popupAd = await offerBannerService.createOffer({
            title: "App Welcome Announcement Popup",
            description: "Internal reference: New user greeting announcement",
            imageUrl: "https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?auto=format&fit=crop&w=800&q=80",
            placement: "popup",
            redirectionType: "browser",
            redirectionUrl: "https://yirahealth.com",
            isAllOrganizations: true,
            isActive: true,
            showTitle: false,
            showDescription: false,
            showOfferTag: false,
            displayOrder: 1,
        });
        console.log("[SEED] Created Popup Ad:", popupAd.id);

        // Test querying
        const activeCarousel = await offerBannerService.getActiveOffers(undefined, "carousel");
        console.log("[SEED] Active carousel banners count:", activeCarousel.length);

        const activePopup = await offerBannerService.getActivePopupAd();
        console.log("[SEED] Active popup ad:", activePopup?.id, activePopup?.title, "Placement:", activePopup?.placement);

        await AppDataSource.destroy();
        process.exit(0);
    } catch (e) {
        console.error("[SEED ERROR]", e);
        process.exit(1);
    }
};

run();
