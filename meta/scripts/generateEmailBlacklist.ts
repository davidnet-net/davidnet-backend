const url =
	"https://raw.githubusercontent.com/doodad-labs/disposable-email-domains/main/data/domains.txt";

const updateList = async () => {
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

	// Write to a pure .txt file instead of .ts
	await Bun.write("src/core/constants/domains.txt", content);
	console.log(`Finished! Processed ${domains.length} domains to domains.txt.`);
};

updateList();
