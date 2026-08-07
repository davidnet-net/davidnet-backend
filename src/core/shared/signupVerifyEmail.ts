import { signupVerificationTemplate } from "../../emailTemplates/signupVerification";
import { sendEmail } from "../utils/emails";

export async function sendSignupVerifyEmail(emailVerificationToken: string, email: string) {
	const verifyUrl =
		(Bun.env.NODE_ENV === "production" ? "https://account.davidnet.net" : "http://localhost:5173") +
		"/signup/verify/email/confirm/" +
		emailVerificationToken;

	const htmlContent = signupVerificationTemplate.replaceAll("{{verifyemail_url}}", verifyUrl);

	await sendEmail(email, "Davidnet - Email Verification", htmlContent);
}
