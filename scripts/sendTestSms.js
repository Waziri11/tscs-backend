const dotenv = require('dotenv');
const { sendBrevoSms } = require('../services/sms/brevo');

dotenv.config();

const DEFAULT_RECIPIENT = '+255676907776';
const DEFAULT_MESSAGE = 'TSCS test SMS. Reply STOP to unsubscribe.';

async function main() {
  const recipient = process.argv[2] || DEFAULT_RECIPIENT;
  const content = process.argv[3] || DEFAULT_MESSAGE;

  console.log(`Sending Brevo SMS to ${recipient}...`);
  const result = await sendBrevoSms({ recipient, content });
  console.log('SMS send response:', result);
}

main().catch((error) => {
  console.error('Failed to send SMS:', error.message || error);
  process.exitCode = 1;
});
