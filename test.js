import { sendBrevoEmail } from "./services/email/brevo.js";

export async function sendOtpEmail(toEmail, otp) {
  const subject = "Your TSCS OTP Code";
  const text = `Your OTP is: 123456. It expires in 10 minutes.`;
  const html = `<p>Your OTP is: <b>123456</b></p><p>It expires in 10 minutes.</p>`;

  return await sendBrevoEmail({
    to: toEmail,
    subject,
    html,
    tags: ["tscs", "otp"],
  });
}
