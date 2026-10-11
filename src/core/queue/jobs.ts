// Shared queue-name constants and payload types, imported by both the producer side (route
// handlers, via boss.send) and the consumer side (worker.ts, via boss.work) so the two can never
// drift on what a job's data shape is.
export const QUEUE = {
	PASSWORD_RESET_EMAIL: "email.password-reset",
	SIGNUP_VERIFY_EMAIL: "email.signup-verify",
	AUDIT_LOG_EMAIL: "email.audit-log",
	VIDEO_DURATION_PROBE: "video.duration-probe"
} as const;

export type PasswordResetEmailJob = {
	email: string;
	resetPasswordUrl: string;
};

export type SignupVerifyEmailJob = {
	email: string;
	emailVerificationToken: string;
};

// Carries only the userId, not the email address - the worker looks the email up at job-run time
// (not enqueue time) so a since-deleted user just no-ops the job instead of retrying forever on a
// now-meaningless payload.
export type AuditLogEmailJob = {
	userId: string;
	message: string;
};

export type VideoDurationProbeJob = {
	shortId: string;
	bucket: string;
	key: string;
};
