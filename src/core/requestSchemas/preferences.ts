import { type } from "arktype";

export const updatePreferencesSchema = type({
	"theme?": "'dark' | 'light' | 'contrast' | 'system'",
	"language?": "string",
	"timezone?": "string",
	"firstDayOfWeek?": "string",
	"dateFormat?": "string"
});
