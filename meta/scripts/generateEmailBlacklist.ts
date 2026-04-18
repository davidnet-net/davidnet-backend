const url =
	"https://raw.githubusercontent.com/doodad-labs/disposable-email-domains/main/data/domains.txt";
const filePath = "src/core/constants/domains.txt";

const updateList = async () => {
	// Check if file exists
	const file = Bun.file(filePath);
	const exists = await file.exists();

	if (exists) {
		console.log("File already exists. Skipping update.");
		return;
	}

	console.log("Updating disposable email list...");
	const response = await fetch(url);
	const text = await response.text();

	// Clean and filter the domains
	const domains = text
		.split("\n")
		.map((d) => d.trim().toLowerCase())
		.filter((d) => d.length > 0 && !d.startsWith("#"));

	// Join back into a simple newline-separated string
	const content = domains.join("\n");

	// Write to file
	await Bun.write(filePath, content);
	console.log(`Finished! Processed ${domains.length} domains to domains.txt.`);
};

updateList();
