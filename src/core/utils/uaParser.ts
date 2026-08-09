import { UAParser } from "ua-parser-js";

export function parseUA(ua: string) {
	const parser = new UAParser(ua);
	const result = parser.getResult();

	// UAParser leaves device.type undefined for standard desktops/laptops.
	// We map it to your preferred "Computer" fallback.
	let deviceType = "Computer";
	if (result.device.type === "mobile") deviceType = "Mobile";
	if (result.device.type === "tablet") deviceType = "Tablet";
	if (result.device.type === "smarttv") deviceType = "Smart TV";

	// Use the actual vendor/model if available (e.g., "Apple - iPhone"), otherwise fallback to generic type
	const deviceDisplay =
		result.device.vendor && result.device.model
			? `${result.device.vendor} ${result.device.model}`
			: deviceType;

	return {
		device: deviceDisplay,
		os: result.os.name || "Unknown OS",
		browser: result.browser.name || "Unknown Browser",
		version: result.browser.version ? `v${result.browser.version}` : ""
	};
}
