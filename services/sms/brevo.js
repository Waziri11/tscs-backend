const dotenv = require('dotenv');

dotenv.config();

const BREVO_SMS_API_KEY = process.env.BREVO_SMS_API_KEY;
const BREVO_SMS_SENDER = process.env.BREVO_SMS_SENDER || 'TSCS';

function validateConfig() {
  if (!BREVO_SMS_API_KEY) {
    throw new Error('BREVO_SMS_API_KEY is required to send SMS');
  }
}

function formatRecipient(recipient) {
  if (!recipient) return null;
  return recipient.toString().trim();
}

async function sendBrevoSms({ recipient, content, unicode = false }) {
  validateConfig();

  const to = formatRecipient(recipient);
  if (!to) {
    throw new Error('Recipient phone number is required');
  }
  if (!content || !content.toString().trim()) {
    throw new Error('Content is required for SMS');
  }

  const body = {
    sender: BREVO_SMS_SENDER,
    recipient: to,
    content: content.toString(),
    type: 'transactional',
    ...(unicode ? { unicode: true } : {}),
  };

  const res = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'api-key': BREVO_SMS_API_KEY,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.message || JSON.stringify(data) || `HTTP ${res.status}`;
    throw new Error(`Brevo SMS send failed: ${message}`);
  }

  return data;
}

module.exports = { sendBrevoSms };
