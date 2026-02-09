const DEFAULT_SMS_API_URL = 'http://41.59.251.163:5012/api/sms/send';

class SMSService {
  constructor() {
    this.apiUrl = process.env.SMS_API_URL || DEFAULT_SMS_API_URL;
    this.serviceId = process.env.SMS_SERVICE_ID || '2243';
    this.systemId = process.env.SMS_SYSTEM_ID || 'SI-B1A33EC5';
  }

  normalizeRecipient(phone) {
    if (!phone) return '';
    return phone.toString().replace(/\D/g, '');
  }

  async sendSMS(recipient, message) {
    const normalizedRecipient = this.normalizeRecipient(recipient);
    if (!normalizedRecipient) {
      return { success: false, message: 'No recipient phone number provided' };
    }

    const trimmedMessage = (message || '').toString().trim();
    if (!trimmedMessage) {
      return { success: false, message: 'No SMS message content provided' };
    }

    const payload = {
      recipients: normalizedRecipient,
      message: trimmedMessage,
      serviceId: this.serviceId,
      systemId: this.systemId
    };

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        return {
          success: false,
          message: data?.message || `SMS API request failed with status ${response.status}`,
          data
        };
      }

      return { success: true, data };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }
}

module.exports = new SMSService();
