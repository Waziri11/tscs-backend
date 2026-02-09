const dotenv = require('dotenv');
const smsService = require('../services/smsService');

dotenv.config();

const DEFAULT_RECIPIENT = '+255676907776';
const DEFAULT_MESSAGE = 'SMS SENDING USING eGA CONFIGURATION WORKS NOW......';

async function main() {
  const recipient = process.argv[2] || DEFAULT_RECIPIENT;
  const message = process.argv[3] || DEFAULT_MESSAGE;

  console.log(`Sending SMS to ${recipient} using ${smsService.apiUrl} ...`);
  const result = await smsService.sendSMS(recipient, message);
  if (!result.success) {
    throw new Error(result.message || 'SMS send failed');
  }
  console.log('SMS send response:', result.data || result);
}

main().catch((error) => {
  console.error('Failed to send SMS:', error.message || error);
  process.exitCode = 1;
});
