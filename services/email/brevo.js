import * as brevo from "@getbrevo/brevo";
import dotenv from "dotenv";

dotenv.config();

// brevoEmail.js
export async function sendBrevoEmail({
  to,            // string or array of strings
  subject,       // string
  html,          // string (optional)
  text,          // string (optional)
  tags,          // array (optional)
  replyTo,       // { email, name } optional
}) {
  if (!process.env.BREVO_API_KEY) throw new Error("BREVO_API_KEY missing");
  if (!process.env.BREVO_SENDER_EMAIL) throw new Error("BREVO_SENDER_EMAIL missing");

  const toList = (Array.isArray(to) ? to : [to]).map((email) => ({ email }));

  // Brevo: use only one of htmlContent/textContent/templateId per request :contentReference[oaicite:3]{index=3}
  const body = {
    sender: {
      email: process.env.BREVO_SENDER_EMAIL,
      name: process.env.BREVO_SENDER_NAME || "TSCS",
    },
    to: toList,
    subject,
    ...(replyTo ? { replyTo } : {}),
    ...(Array.isArray(tags) ? { tags } : {}),
  };

  if (html) body.htmlContent = html;
  else if (text) body.textContent = text;
  else throw new Error("Provide either html or text");

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      "api-key": process.env.BREVO_API_KEY,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // Brevo returns JSON errors; surface them
    const msg = data?.message || JSON.stringify(data) || `HTTP ${res.status}`;
    throw new Error(`Brevo send failed: ${msg}`);
  }

  // Success returns messageId :contentReference[oaicite:5]{index=5}
  return data; // e.g. { messageId: "<...>" }
}