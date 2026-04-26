/**
 * Validates a string to ensure it matches the UUIDv4 format.
 * * @param token - The string to validate.
 * @returns True if the token is a valid UUIDv4.
 */
export const isValidUuidV4 = (token: string): boolean => {
	const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidV4Regex.test(token);
};
