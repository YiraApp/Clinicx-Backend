import { AppDataSource } from "../../config/database.js";
import { DietFoodItem } from "../../models/Diet/diet-food-item.model.js";

export class DietFoodService {
    private repo = AppDataSource.getRepository(DietFoodItem);

    /**
     * Search master and organization-specific food items.
     * Scoped: (OrganizationId IS NULL OR OrganizationId = :orgId) AND IsActive = 1
     */
    async searchFoods(params: {
        search?: string;
        category?: string;
        slot?: string;
        foodType?: string;
        organizationId?: number;
        limit?: number;
        page?: number;
    }) {
        const { search, category, slot, foodType, organizationId, limit = 50, page = 1 } = params;
        const skip = (page - 1) * limit;

        const qb = this.repo.createQueryBuilder("food")
            .where("food.IsActive = :isActive", { isActive: 1 });

        // Organization scoping: global items (null) + this organization's custom items
        if (organizationId) {
            qb.andWhere("(food.OrganizationId IS NULL OR food.OrganizationId = :orgId)", { orgId: organizationId });
        } else {
            qb.andWhere("food.OrganizationId IS NULL");
        }

        if (search && search.trim() !== "") {
            const term = `%${search.trim().toLowerCase()}%`;
            qb.andWhere("(LOWER(food.Name) LIKE :term OR LOWER(food.Category) LIKE :term OR LOWER(food.Tags) LIKE :term)", { term });
        }

        if (category && category !== "All") {
            qb.andWhere("food.Category = :category", { category });
        }

        if (slot && slot !== "All") {
            const s = slot.toLowerCase();
            if (s.includes("early")) {
                qb.andWhere("food.Category IN ('Beverage', 'Snack')");
            } else if (s.includes("breakfast")) {
                qb.andWhere("food.Category IN ('Breakfast', 'Beverage', 'Dairy')");
            } else if (s.includes("mid")) {
                qb.andWhere("food.Category IN ('Fruit', 'Beverage', 'Snack')");
            } else if (s.includes("lunch")) {
                qb.andWhere("food.Category IN ('Grain', 'Protein', 'Vegetable', 'Dairy')");
            } else if (s.includes("snack") || s.includes("evening")) {
                qb.andWhere("food.Category IN ('Snack', 'Beverage', 'Fruit')");
            } else if (s.includes("dinner")) {
                qb.andWhere("food.Category IN ('Grain', 'Protein', 'Vegetable', 'Dairy', 'Beverage')");
            } else if (s.includes("bed")) {
                qb.andWhere("food.Category IN ('Dairy', 'Beverage')");
            }
        }

        if (foodType && foodType !== "All") {
            qb.andWhere("food.FoodType = :foodType", { foodType });
        }

        qb.orderBy("food.Category", "ASC")
          .addOrderBy("food.Name", "ASC")
          .skip(skip)
          .take(limit);

        const [items, total] = await qb.getManyAndCount();

        return {
            items,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit)
        };
    }

    /**
     * Get a single food item by ID
     */
    async getFoodById(id: number, organizationId?: number) {
        const qb = this.repo.createQueryBuilder("food")
            .where("food.Id = :id AND food.IsActive = 1", { id });

        if (organizationId) {
            qb.andWhere("(food.OrganizationId IS NULL OR food.OrganizationId = :orgId)", { orgId: organizationId });
        } else {
            qb.andWhere("food.OrganizationId IS NULL");
        }

        return await qb.getOne();
    }

    /**
     * Add a custom food item for an organization
     */
    async createCustomFood(data: Partial<DietFoodItem>, organizationId: number) {
        if (!organizationId) {
            throw new Error("OrganizationId is required to create a custom food item.");
        }

        const food = this.repo.create({
            ...data,
            OrganizationId: organizationId,
            IsActive: true
        });

        return await this.repo.save(food);
    }

    /**
     * Update an organization's custom food item
     */
    async updateCustomFood(id: number, data: Partial<DietFoodItem>, organizationId: number) {
        const existing = await this.repo.findOne({ where: { Id: id, IsActive: true } });
        if (!existing) {
            throw new Error("Food item not found.");
        }

        if (existing.OrganizationId === null || existing.OrganizationId === undefined) {
            throw new Error("Global master food items cannot be modified by organizations.");
        }

        if (existing.OrganizationId !== organizationId) {
            throw new Error("Access denied: You do not have permission to modify this organization's food item.");
        }

        Object.assign(existing, data);
        existing.OrganizationId = organizationId; // Ensure org ID is maintained
        return await this.repo.save(existing);
    }

    /**
     * Soft delete an organization's custom food item
     */
    async deleteCustomFood(id: number, organizationId: number) {
        const existing = await this.repo.findOne({ where: { Id: id, IsActive: true } });
        if (!existing) {
            throw new Error("Food item not found.");
        }

        if (existing.OrganizationId === null || existing.OrganizationId === undefined) {
            throw new Error("Global master food items cannot be deleted.");
        }

        if (existing.OrganizationId !== organizationId) {
            throw new Error("Access denied: You do not have permission to delete this organization's food item.");
        }

        existing.IsActive = false;
        await this.repo.save(existing);
        return { success: true, message: "Custom food item deleted successfully." };
    }

    /**
     * Get distinct food categories for filters
     */
    async getCategories() {
        const categories = await this.repo
            .createQueryBuilder("food")
            .select("DISTINCT food.Category", "Category")
            .where("food.IsActive = 1")
            .orderBy("food.Category", "ASC")
            .getRawMany();

        return categories.map(c => c.Category);
    }

    /**
     * Get clinically-curated recommended foods per meal slot directly from database
     */
    async getSlotRecommendations(params: { organizationId?: number; dietType?: string }) {
        const { organizationId, dietType } = params;

        const qb = this.repo.createQueryBuilder("food")
            .where("food.IsActive = :isActive", { isActive: 1 });

        if (organizationId) {
            qb.andWhere("(food.OrganizationId IS NULL OR food.OrganizationId = :orgId)", { orgId: organizationId });
        } else {
            qb.andWhere("food.OrganizationId IS NULL");
        }

        if (dietType && dietType !== "All") {
            if (dietType === "Veg") {
                qb.andWhere("food.FoodType IN ('Veg', 'Vegan')");
            } else if (dietType === "Vegan") {
                qb.andWhere("food.FoodType = 'Vegan'");
            } else if (dietType === "Eggetarian") {
                qb.andWhere("food.FoodType IN ('Veg', 'Vegan', 'Egg')");
            }
        }

        const allFoods = await qb.orderBy("food.Name", "ASC").getMany();

        const formatItem = (f: DietFoodItem) => ({
            id: f.Id,
            name: f.Name,
            category: f.Category,
            foodType: f.FoodType,
            qty: 1.0,
            unit: f.ServingSize || "serving",
            cal: Math.round(f.CaloriesPerServing || f.CaloriesPer100g || 0),
            p: f.ProteinG,
            c: f.CarbsG,
            f: f.FatG,
            notes: f.Tags || ""
        });

        const hasAny = (str: string, terms: string[]) => terms.some(t => str.includes(t));

        const slots: Record<string, any[]> = {
            "Early Morning": [],
            "Breakfast": [],
            "Mid-Morning": [],
            "Lunch": [],
            "Evening Snack": [],
            "Dinner": [],
            "Bedtime": []
        };

        for (const food of allFoods) {
            const cat = (food.Category || "").toLowerCase();
            const name = (food.Name || "").toLowerCase();
            const item = formatItem(food);

            // Early Morning: warm lemon water, almonds, soaked nuts, green tea, methi water
            if (
                hasAny(name, ["lemon", "methi", "almond", "walnut", "chia", "flax", "coconut water", "green tea"]) ||
                (cat === "beverage" && (hasAny(name, ["water", "tea"])))
            ) {
                slots["Early Morning"].push(item);
            }

            // Breakfast: chilla, idli, dosa, poha, upma, oats, dalia, thepla, eggs, toast
            if (
                cat === "breakfast" ||
                hasAny(name, ["chilla", "idli", "dosa", "poha", "upma", "oats", "dalia", "thepla", "egg", "omelette", "bhurji", "paratha", "toast"])
            ) {
                slots["Breakfast"].push(item);
            }

            // Mid-Morning: fruits, tender coconut water, unsweetened tea
            if (
                cat === "fruit" ||
                hasAny(name, ["apple", "guava", "papaya", "orange", "pomegranate", "kiwi", "watermelon", "coconut water", "green tea"])
            ) {
                slots["Mid-Morning"].push(item);
            }

            // Lunch: roti, rice, dals, paneer, chicken, fish, salad, curd/dahi
            if (
                cat === "grain" ||
                cat === "protein" ||
                cat === "vegetable" ||
                (cat === "dairy" && hasAny(name, ["curd", "dahi", "buttermilk"])) ||
                hasAny(name, ["roti", "phulka", "rice", "dal", "sambar", "salad", "curd", "dahi", "paneer", "chicken", "fish", "sabzi", "curry"])
            ) {
                slots["Lunch"].push(item);
            }

            // Evening Snack: makhana, roasted chana, sprouts, soup, chai, tea
            if (
                cat === "snack" ||
                (cat === "beverage" && hasAny(name, ["tea", "chai", "soup", "coffee"])) ||
                hasAny(name, ["makhana", "chana", "sprout", "dhokla", "corn", "soup", "tea", "chai"])
            ) {
                slots["Evening Snack"].push(item);
            }

            // Dinner: light khichdi, roti, lauki, sabzi, palak paneer, chaas, soup
            if (
                hasAny(name, ["khichdi", "roti", "phulka", "sabzi", "bharta", "lauki", "turai", "paneer", "soup", "chaas", "tofu", "fish", "dal"]) ||
                (cat === "vegetable" && !name.includes("salad"))
            ) {
                slots["Dinner"].push(item);
            }

            // Bedtime: turmeric milk, haldi doodh, warm milk, chamomile tea
            if (
                hasAny(name, ["turmeric", "haldi", "milk", "tea", "chamomile"]) ||
                (cat === "dairy" && name.includes("milk")) ||
                (cat === "beverage" && name.includes("milk"))
            ) {
                slots["Bedtime"].push(item);
            }
        }

        return {
            slots,
            avoidSuggestions: [
                "Refined Sugar",
                "Refined Flour (Maida)",
                "Fried Foods",
                "Carbonated Drinks",
                "High Sodium Pickles",
                "Sweets & Desserts",
                "Processed Meats",
                "Bakery Pastries",
                "Deep-Fried Snacks (Samosa/Pakora)"
            ],
            preferSuggestions: [
                "Sprouts",
                "Green Leafy Vegetables",
                "Salad before Meals",
                "Methi Seeds Water",
                "Oats / Brown Rice",
                "Warm Water with Lemon",
                "Fresh Seasonal Fruits",
                "Tender Coconut Water",
                "Roasted Makhana",
                "Moong Dal Khichdi"
            ]
        };
    }
}

export const dietFoodService = new DietFoodService();

