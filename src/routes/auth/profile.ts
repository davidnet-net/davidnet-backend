import { eq } from "drizzle-orm";
import { Hono } from "hono";
import countryList from "country-list";

import { database } from "../../core/database/client";
import { users, userPreferences, userPrivacyPreferences } from "../../core/database/schema/schema";
import { requireAuth, type Env } from "../../middlewares/requireAuth";
import { collectAuth } from "../../middlewares/collectAuth";
import { uploadToBucket, getFromBucket } from "../../core/shared/s3";

export const profile = new Hono<Env>();

// --- GET PROFILE ---
profile.get("/", collectAuth, async (c) => {
	const requestedUserId = c.req.query("user");
	const requestingUserId = c.get("user")?.id;

	if (!requestedUserId) {
		return c.json({ error: "Missing 'user' query parameter" }, 400);
	}

	const result = await database
		.select({
			userId: users.userId,
			username: users.username,
			displayName: users.displayName,
			avatarUrl: users.avatarUrl,
			bannerUrl: users.bannerUrl,
			description: users.description,
			countryCode: users.countryCode,

			location: users.location,

			language: userPreferences.language,
			timezone: userPreferences.timezone,
			email: users.email,

			// Privacy rules
			languageVisibility: userPrivacyPreferences.languageVisibility,
			timezoneVisibility: userPrivacyPreferences.timezoneVisibility,
			locationVisibility: userPrivacyPreferences.locationVisibility,
			emailVisibility: userPrivacyPreferences.emailVisibility
		})
		.from(users)
		.leftJoin(userPreferences, eq(users.userId, userPreferences.userId))
		.leftJoin(userPrivacyPreferences, eq(users.userId, userPrivacyPreferences.userId))
		.where(eq(users.userId, requestedUserId))
		.limit(1);

	const targetUser = result[0];

	if (!targetUser) {
		return c.json({ error: "User not found" }, 404);
	}

	const isOwnProfile = requestingUserId === targetUser.userId;

	const canView = (visibility: string | null | undefined) => {
		if (isOwnProfile) return true;
		return visibility === "public";
	};

	const profileResponse = {
		userId: targetUser.userId,
		username: targetUser.username,
		displayName: targetUser.displayName,
		avatarUrl: targetUser.avatarUrl,
		bannerUrl: targetUser.bannerUrl,
		description: targetUser.description,
		countryCode: targetUser.countryCode,
		location: canView(targetUser.locationVisibility) ? targetUser.location : undefined,
		language: canView(targetUser.languageVisibility) ? targetUser.language : undefined,
		timezone: canView(targetUser.timezoneVisibility) ? targetUser.timezone : undefined,
		email: canView(targetUser.emailVisibility) ? targetUser.email : undefined
	};

	return c.json({ success: true, code: "SUCCESS", profileResponse });
});

// --- PATCH PROFILE DETAILS ---
profile.patch("/", requireAuth, async (c) => {
	const userId = c.get("user").id;
	const body = await c.req.json();

	const userUpdates: Record<string, any> = {};
	const preferenceUpdates: Record<string, any> = {};
	const privacyUpdates: Record<string, any> = {};

	// 1. Validate Description length
	if (body.description !== undefined) {
		if (body.description !== null) {
			if (typeof body.description !== "string") {
				return c.json({ success: false, code: "INVALID_DESCRIPTION_TYPE" }, 400);
			}

			if (body.description.length > 800) {
				return c.json({ success: false, code: "DESCRIPTION_TOO_LONG" }, 400);
			}

			userUpdates.description = body.description;
		} else {
			userUpdates.description = null;
		}
	}

	// 2. Validate Country Code
	if (body.countryCode !== undefined) {
		if (body.countryCode !== null && body.countryCode !== "") {
			const isValidCountry =
				countryList.getCode(body.countryCode) !== undefined ||
				countryList.getName(body.countryCode) !== undefined;

			if (!isValidCountry) {
				return c.json({ success: false, code: "INVALID_COUNTRY_CODE" }, 400);
			}
			userUpdates.countryCode = body.countryCode;
		} else {
			userUpdates.countryCode = null;
		}
	}

	// 3. Handle remaining allowed fields safely
	if (body.displayName !== undefined) {
		if (typeof body.displayName === "string" && body.displayName.trim().length > 0) {
			userUpdates.displayName = body.displayName.trim();
		} else {
			return c.json({ success: false, code: "INVALID_DISPLAY_NAME" }, 400);
		}
	}

	if (body.location !== undefined) {
		userUpdates.location = body.location ? body.location : null;
	}

	// Preferences table fields
	if (body.theme !== undefined) preferenceUpdates.theme = body.theme;
	if (body.language !== undefined) preferenceUpdates.language = body.language;
	if (body.timezone !== undefined) preferenceUpdates.timezone = body.timezone;
	if (body.firstDayOfWeek !== undefined) preferenceUpdates.firstDayOfWeek = body.firstDayOfWeek;
	if (body.dateFormat !== undefined) preferenceUpdates.dateFormat = body.dateFormat;

	// Privacy preferences table fields
	const validVisibilities = [
		"private",
		"organizations",
		"connections",
		"organizations_and_connections",
		"public"
	];

	if (body.languageVisibility !== undefined) {
		if (!validVisibilities.includes(body.languageVisibility))
			return c.json({ success: false, code: "INVALID_VISIBILITY_OPTION" }, 400);
		privacyUpdates.languageVisibility = body.languageVisibility;
	}
	if (body.timezoneVisibility !== undefined) {
		if (!validVisibilities.includes(body.timezoneVisibility))
			return c.json({ success: false, code: "INVALID_VISIBILITY_OPTION" }, 400);
		privacyUpdates.timezoneVisibility = body.timezoneVisibility;
	}
	if (body.locationVisibility !== undefined) {
		if (!validVisibilities.includes(body.locationVisibility))
			return c.json({ success: false, code: "INVALID_VISIBILITY_OPTION" }, 400);
		privacyUpdates.locationVisibility = body.locationVisibility;
	}
	if (body.emailVisibility !== undefined) {
		if (!validVisibilities.includes(body.emailVisibility))
			return c.json({ success: false, code: "INVALID_VISIBILITY_OPTION" }, 400);
		privacyUpdates.emailVisibility = body.emailVisibility;
	}

	try {
		if (Object.keys(userUpdates).length > 0) {
			userUpdates.updatedAt = new Date();
			await database.update(users).set(userUpdates).where(eq(users.userId, userId));
		}

		if (Object.keys(preferenceUpdates).length > 0) {
			await database
				.update(userPreferences)
				.set(preferenceUpdates)
				.where(eq(userPreferences.userId, userId));
		}

		if (Object.keys(privacyUpdates).length > 0) {
			await database
				.update(userPrivacyPreferences)
				.set(privacyUpdates)
				.where(eq(userPrivacyPreferences.userId, userId));
		}

		return c.json({ success: true, code: "PROFILE_UPDATED" });
	} catch (error) {
		console.error("Failed to update profile:", error);
		return c.json({ success: false, code: "UPDATE_FAILED" }, 500);
	}
});

// --- HELPER FOR UPLOADS ---
async function handleImageUpload(c: any, type: "avatar" | "banner") {
	const userId = c.get("user").id;
	const body = await c.req.parseBody();
	const file = body["image"];

	if (!file || !(file instanceof File)) {
		return c.json({ success: false, code: "MISSING_IMAGE_FILE" }, 400);
	}

	const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/avif"];
	if (!allowedTypes.includes(file.type)) {
		return c.json({ success: false, code: "INVALID_FILE_TYPE" }, 400);
	}

	if (file.size > 5 * 1024 * 1024) {
		return c.json({ success: false, code: "FILE_TOO_LARGE" }, 400);
	}

	const bucketName = type === "avatar" ? "profile-pictures" : "banner-pictures";
	const fileExt = file.type.split("/")[1] || "jpg";
	const fileName = `${userId}.${fileExt}`;
	const buffer = Buffer.from(await file.arrayBuffer());

	try {
		await uploadToBucket(bucketName, fileName, buffer, file.type);

		// Construct the full absolute URL endpoint path
		const fullUrl = `https://davidnet-backend.davidnet.net/profile/${type}/${fileName}`;

		const updateData =
			type === "avatar"
				? { avatarUrl: fullUrl, updatedAt: new Date() }
				: { bannerUrl: fullUrl, updatedAt: new Date() };

		await database.update(users).set(updateData).where(eq(users.userId, userId));

		return c.json({ success: true, code: `${type.toUpperCase()}_UPDATED`, url: fullUrl });
	} catch (error) {
		console.error(`Failed to upload ${type}:`, error);
		return c.json({ success: false, code: "UPLOAD_FAILED" }, 500);
	}
}

// --- UPLOAD ENDPOINTS ---
profile.put("/avatar", requireAuth, async (c) => handleImageUpload(c, "avatar"));
profile.put("/banner", requireAuth, async (c) => handleImageUpload(c, "banner"));

// --- HELPER FOR RETRIEVAL ---
async function handleImageRetrieval(c: any, type: "avatar" | "banner") {
	const filename = c.req.param("filename");
	if (!filename) {
		return c.json({ error: "Missing filename" }, 400);
	}

	const bucketName = type === "avatar" ? "profile-pictures" : "banner-pictures";

	try {
		const s3Object = await getFromBucket(bucketName, filename);

		if (!s3Object.Body) {
			return c.json({ error: "Image not found" }, 404);
		}

		c.header("Content-Type", s3Object.ContentType || "application/octet-stream");
		c.header("Cache-Control", "public, max-age=86400");

		return c.body(s3Object.Body.transformToWebStream());
	} catch (error) {
		return c.json({ error: "Image not found" }, 404);
	}
}

// --- DELIVERY ENDPOINTS ---
profile.get("/avatar/:filename", async (c) => handleImageRetrieval(c, "avatar"));
profile.get("/banner/:filename", async (c) => handleImageRetrieval(c, "banner"));
