import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import { boolean, integer, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authSchema, users } from "./auth";
import { teams, workspaces } from "./workspaces";

// --- ENUMS ---
export const questionTypeEnum = authSchema.enum("question_type", [
	"quiz", // Standard multiple choice
	"true_false", // True or false
	"slider", // Sliding number scale
	"puzzle", // Order/sequence arrangement
	"type_answer", // Short text input with exact match
	"poll", // feedback (no correct answer)
	"word_cloud", // Open text word aggregation
	"scale", // Rating scale (1-10)
	"information" // Info
]);

export const sessionStatusEnum = authSchema.enum("session_status", [
	"lobby",
	"question_active",
	"showing_leaderboard",
	"finished"
]);

// --- TABLES ---
export const quizzes = authSchema.table("quizzes", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	workspaceId: uuid("workspace_id")
		.notNull()
		.references(() => workspaces.id, { onDelete: "cascade" }),
	teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	state: text("state"), // Stores the base64-encoded Yjs document state vector for persistence
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

// --- QUIZ COLLABORATORS ---
export const quizCollaborators = authSchema.table("quiz_collaborators", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	quizId: uuid("quiz_id")
		.notNull()
		.references(() => quizzes.id, { onDelete: "cascade" }),
	userId: uuid("user_id")
		.notNull()
		.references(() => users.userId, { onDelete: "cascade" }),
	role: text("role").notNull(), // e.g., "editor", "viewer"
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const questions = authSchema.table("questions", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	quizId: uuid("quiz_id")
		.notNull()
		.references(() => quizzes.id, { onDelete: "cascade" }),
	text: text("text").notNull(),
	mediaUrl: text("media_url"),
	type: questionTypeEnum("type").default("quiz").notNull(),
	position: integer("position").notNull(),
	timeLimit: integer("time_limit").default(20).notNull(), // Countdown in seconds
	pointsMultiplier: integer("points_multiplier").default(1).notNull() // 1x for scored quizzes, 0 for polls
});

export const quizOptions = authSchema.table("quiz_options", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	questionId: uuid("question_id")
		.notNull()
		.references(() => questions.id, { onDelete: "cascade" }),
	text: text("text").notNull(),
	isCorrect: boolean("is_correct").default(false).notNull(), // False for office feedback polls
	color: text("color").notNull(), // Kahoot-style color buttons ("red", "blue", "yellow", "green")
	position: integer("position").notNull()
});

export const quizSessions = authSchema.table("quiz_sessions", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	quizId: uuid("quiz_id")
		.notNull()
		.references(() => quizzes.id, { onDelete: "cascade" }),
	pinCode: text("pin_code").notNull().unique(), // The 6-digit game PIN players type in
	status: sessionStatusEnum("status").default("lobby").notNull(),
	locked: boolean("locked").default(false),
	currentQuestionIndex: integer("current_question_index").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

// Participants do NOT link to the users table; they are purely temporary guest entries per session.
export const sessionParticipants = authSchema.table("session_participants", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	sessionId: uuid("session_id")
		.notNull()
		.references(() => quizSessions.id, { onDelete: "cascade" }),
	nickname: text("nickname").notNull(), // User-submitted display name for the session
	score: integer("score").default(0).notNull(), // Tracks total points for competitive mode
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const sessionResponses = authSchema.table("session_responses", {
	id: uuid("id")
		.primaryKey()
		.default(sql`uuidv7()`),
	sessionId: uuid("session_id")
		.notNull()
		.references(() => quizSessions.id, { onDelete: "cascade" }),
	questionId: uuid("question_id")
		.notNull()
		.references(() => questions.id, { onDelete: "cascade" }),
	participantId: uuid("participant_id")
		.notNull()
		.references(() => sessionParticipants.id, { onDelete: "cascade" }),
	selectedOptionId: uuid("selected_option_id").references(() => quizOptions.id, {
		onDelete: "set null"
	}), // Nullable for open text
	textResponse: text("text_response"), // Used if question type is "open_text"
	answerTimeMs: integer("answer_time_ms").notNull(), // Used for speed-based scoring
	pointsEarned: integer("points_earned").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

// --- TYPE EXPORTS ---
export type Quiz = InferSelectModel<typeof quizzes>;
export type NewQuiz = InferInsertModel<typeof quizzes>;

export type QuizCollaborator = InferSelectModel<typeof quizCollaborators>;
export type NewQuizCollaborator = InferInsertModel<typeof quizCollaborators>;

export type Question = InferSelectModel<typeof questions>;
export type NewQuestion = InferInsertModel<typeof questions>;

export type QuizOption = InferSelectModel<typeof quizOptions>;
export type NewQuizOption = InferInsertModel<typeof quizOptions>;

export type QuizSession = InferSelectModel<typeof quizSessions>;
export type NewQuizSession = InferInsertModel<typeof quizSessions>;

export type SessionParticipant = InferSelectModel<typeof sessionParticipants>;
export type NewSessionParticipant = InferInsertModel<typeof sessionParticipants>;

export type SessionResponse = InferSelectModel<typeof sessionResponses>;
export type NewSessionResponse = InferInsertModel<typeof sessionResponses>;
