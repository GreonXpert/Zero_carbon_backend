const Bull = require('bull');
const { sendMail } = require('../utils/mail');

// Create a Redis-based queue for emails (optional - can work without Redis)
class EmailQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.retryAttempts = 3;
    this.retryDelay = 5000; // 5 seconds
    this.rateLimit = {
      maxEmails: 10,
      perMinutes: 1
    };
    this.sentEmails = [];
  }

  /**
   * Add email to queue
   * @param {String} to - Recipient email
   * @param {String} subject - Email subject
   * @param {String} message - Email body
   * @param {Object} options - Additional options
   */
  async addToQueue(to, subject, message, options = {}) {
    const emailJob = {
      id: Date.now() + Math.random(),
      to,
      subject,
      message,
      options,
      attempts: 0,
      createdAt: new Date()
    };

    this.queue.push(emailJob);
    
    // Start processing if not already running
    if (!this.processing) {
      this.processQueue();
    }

    return emailJob.id;
  }

  /**
   * Process email queue
   */
  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      // Check rate limit
      if (this.isRateLimited()) {
        console.log('Email rate limit reached, waiting...');
        await this.sleep(60000); // Wait 1 minute
        continue;
      }

      const emailJob = this.queue.shift();
      
      try {
        await this.sendEmail(emailJob);
        this.recordSentEmail();
        console.log(`Email sent successfully: ${emailJob.subject}`);
      } catch (error) {
        console.error(`Failed to send email: ${emailJob.subject}`, error);
        
        // Retry logic
        emailJob.attempts++;
        if (emailJob.attempts < this.retryAttempts) {
          console.log(`Retrying email (attempt ${emailJob.attempts + 1}/${this.retryAttempts})`);
          await this.sleep(this.retryDelay * emailJob.attempts);
          this.queue.unshift(emailJob); // Add back to front of queue
        } else {
          console.error(`Email failed after ${this.retryAttempts} attempts: ${emailJob.subject}`);
          // Could store failed emails in database for manual review
        }
      }

      // Small delay between emails to avoid overwhelming the server
      await this.sleep(1000);
    }

    this.processing = false;
  }

  /**
   * Send individual email
   */
  async sendEmail(emailJob) {
    const { to, subject, message, options } = emailJob;
    
    // Add queue metadata to email
    const enhancedMessage = `${message}\n\n---\nEmail ID: ${emailJob.id}\nQueued at: ${emailJob.createdAt.toLocaleString()}`;
    
    return await sendMail(to, subject, enhancedMessage);
  }

  /**
   * Check if rate limited
   */
  isRateLimited() {
    const now = Date.now();
    const windowStart = now - (this.rateLimit.perMinutes * 60 * 1000);
    
    // Remove old entries
    this.sentEmails = this.sentEmails.filter(timestamp => timestamp > windowStart);
    
    return this.sentEmails.length >= this.rateLimit.maxEmails;
  }

  /**
   * Record sent email for rate limiting
   */
  recordSentEmail() {
    this.sentEmails.push(Date.now());
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get queue status
   */
  getStatus() {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      sentInWindow: this.sentEmails.length,
      rateLimit: this.rateLimit
    };
  }

  /**
   * Clear queue
   */
  clearQueue() {
    this.queue = [];
    console.log('Email queue cleared');
  }
}

// Create singleton instance
const emailQueue = new EmailQueue();

// Enhanced email sending function with queue
const queueEmail = async (to, subject, message, options = {}) => {
  // For high priority emails, send directly
  if (options.priority === 'high' || options.immediate) {
    try {
      await sendMail(to, subject, message);
      console.log(`High priority email sent immediately: ${subject}`);
    } catch (error) {
      console.error(`Failed to send high priority email: ${subject}`, error);
      // Fall back to queue
      return emailQueue.addToQueue(to, subject, message, options);
    }
  } else {
    // Add to queue for normal emails
    return emailQueue.addToQueue(to, subject, message, options);
  }
};

// Batch email sending
const sendBatchEmails = async (recipients, subject, messageTemplate, variables = {}) => {
  const emailPromises = recipients.map(recipient => {
    // Personalize message for each recipient
    let personalizedMessage = messageTemplate;
    
    if (recipient.name) {
      personalizedMessage = personalizedMessage.replace(/{{name}}/g, recipient.name);
    }
    if (recipient.email) {
      personalizedMessage = personalizedMessage.replace(/{{email}}/g, recipient.email);
    }
    
    // Replace any additional variables
    Object.keys(variables).forEach(key => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      personalizedMessage = personalizedMessage.replace(regex, variables[key]);
    });
    
    return queueEmail(
      recipient.email || recipient,
      subject,
      personalizedMessage,
      { batch: true }
    );
  });
  
  return Promise.all(emailPromises);
};

// Email templates
const emailTemplates = {
  welcomeUser: (userName, userType, credentials) => ({
    subject: 'Welcome to ZeroCarbon',
    message: `
Dear ${userName},

Welcome to ZeroCarbon! Your ${userType.replace(/_/g, ' ')} account has been created successfully.

Login Credentials:
• Username: ${credentials.userName}
• Email: ${credentials.email}
• Password: ${credentials.password}

Important:
• Please change your password after your first login
• Keep your credentials secure and do not share them
• If you have any issues logging in, please contact your administrator

Best regards,
ZeroCarbon Team
    `.trim()
  }),

  passwordReset: (userName, resetLink) => ({
    subject: 'Password Reset Request - ZeroCarbon',
    message: `
Dear ${userName},

We received a request to reset your password for your ZeroCarbon account.

Please click on the link below to reset your password:
${resetLink}

This link will expire in 15 minutes for security reasons.

If you did not request this password reset, please ignore this email and your password will remain unchanged.

Best regards,
ZeroCarbon Security Team
    `.trim()
  }),

  subscriptionReminder: (companyName, daysRemaining, expiryDate) => ({
    subject: `Subscription Reminder - ${daysRemaining} Days Remaining`,
    message: `
Dear ${companyName} Team,

This is a reminder that your ZeroCarbon subscription will expire in ${daysRemaining} days.

Subscription Details:
• Expiry Date: ${expiryDate}
• Days Remaining: ${daysRemaining}

To ensure uninterrupted service, please contact your consultant to renew your subscription.

Best regards,
ZeroCarbon Team
    `.trim()
  })
};

module.exports = {
  emailQueue,
  queueEmail,
  sendBatchEmails,
  emailTemplates
};