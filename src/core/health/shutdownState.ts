// Separate from health.ts to avoid a circular import: index.ts needs to flip this flag before
// anything else runs in its shutdown sequence, and the /health route needs to read it - putting it
// in health.ts itself would mean index.ts importing from the route layer.
let shuttingDown = false;

export function markShuttingDown() {
	shuttingDown = true;
}

export function isShuttingDown() {
	return shuttingDown;
}
