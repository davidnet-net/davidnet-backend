import { boss } from "../queue/boss";
import { QUEUE } from "../queue/jobs";

// Callers leave this unawaited (fire-and-forget) - that was already true before the queue existed.
// What the queue adds is durability: previously, a process crash between the DB write and the SMTP
// send meant the email silently never went out; a pg-boss job survives that.
export async function sendSignupVerifyEmail(emailVerificationToken: string, email: string) {
	await boss.send(QUEUE.SIGNUP_VERIFY_EMAIL, { email, emailVerificationToken });
}
