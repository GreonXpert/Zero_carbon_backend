// utils/emailQueue.js
const Queue = require('bull');
const { sendMail } = require('./mail');

const emailQueue = new Queue('email', {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    removeOnComplete: true,
    removeOnFail: false
  }
});



// Process consultant notifications
emailQueue.process('notifyConsultant', async (job) => {
  const { consultantId, clientId, companyName, contactPersonName, email, mobileNumber } = job.data;
  
  const consultant = await User.findById(consultantId).select('email').lean();
  if (!consultant) return;
  
  const subject = "New Lead Assigned";
  const message = `
    A new lead has been assigned to you:
    
    Client ID: ${clientId}
    Company: ${companyName}
    Contact Person: ${contactPersonName}
    Email: ${email}
    Mobile: ${mobileNumber}
    
    Please follow up with the client.
  `;
  
  await sendMail(consultant.email, subject, message);
});

// Process deletion emails
emailQueue.process('sendDeletionEmails', async (job) => {
  const { recipients, deletedUser, deletedBy, details } = job.data;
  
  const subject = `ZeroCarbon - Account Deletion Notice`;
  let message = `
    Dear ${deletedUser.userName},
    
    Your ZeroCarbon account has been deleted by ${deletedBy.userName} (${deletedBy.userType.replace(/_/g, ' ')}).
    
    Account Details:
    - Username: ${deletedUser.userName}
    - Email: ${deletedUser.email}
    - User Type: ${deletedUser.userType.replace(/_/g, ' ')}
    - Deleted On: ${new Date().toLocaleString()}
  `;
  
  if (details.reassignedTo) {
    message += `\n\nYour assigned clients have been reassigned to: ${details.reassignedTo}`;
  }
  
  message += `\n\nIf you believe this is an error, please contact your administrator.
    
Best regards,
ZeroCarbon Team`;
  
  // Send emails in parallel
  await Promise.all(
    recipients.map(recipient => sendMail(recipient, subject, message))
  );
});

// Process proposal emails
emailQueue.process('sendProposalEmail', async (job) => {
  const { 
    clientEmail, 
    proposalNumber, 
    validUntil, 
    totalAmount, 
    totalDataIntegrationPoints,
    consolidatedData 
  } = job.data;
  
  const subject = "ZeroCarbon - Service Proposal";
  const message = `
    Dear Valued Client,
    
    We are pleased to present our comprehensive carbon footprint management proposal.
    
    Proposal Details:
    - Proposal Number: ${proposalNumber}
    - Valid Until: ${validUntil}
    - Total Amount: ₹${totalAmount}
    - Data Integration Points: ${totalDataIntegrationPoints}
    
    Our solution covers:
    • ${consolidatedData.scope1.category} (${consolidatedData.scope1.totalDataPoints} data points)
    • ${consolidatedData.scope2.category} (${consolidatedData.scope2.totalDataPoints} data points)
    • ${consolidatedData.scope3.category} (${consolidatedData.scope3.totalDataPoints} data points)
    
    Please review the proposal and let us know if you have any questions.
    
    Best regards,
    ZeroCarbon Team
  `;
  
  await sendMail(clientEmail, subject, message);
});
// Lead Action Email Template
emailQueue.process('leadActionEmail', async (job) => {
  const { to, subject, action, client, performedBy, performedByType, reason } = job.data;
  
  const actionText = {
    created: 'created',
    updated: 'updated',
    deleted: 'deleted'
  }[action];
  
  let message = `
Dear Super Admin,

A lead has been ${actionText} in the ZeroCarbon system.

Action Details:
• Action: Lead ${actionText}
• Performed by: ${performedBy} (${performedByType})
• Date: ${new Date().toLocaleString()}

Lead Information:
• Lead ID: ${client.clientId}
• Company Name: ${client.companyName}
• Contact Person: ${client.contactPersonName}
• Email: ${client.email}
• Mobile: ${client.mobileNumber}
`;

  if (action === 'deleted' && reason) {
    message += `\nDeletion Reason: ${reason}`;
  }

  message += `

Please review this action in the admin dashboard.

Best regards,
ZeroCarbon System
  `.trim();

  await sendMail(to, subject, message);
});

// Data Submission Email Template
emailQueue.process('dataSubmissionEmail', async (job) => {
  const { to, subject, clientId, companyName, submittedBy, dataCompleteness } = job.data;
  
  const message = `
Dear Super Admin,

Client data has been successfully submitted in the ZeroCarbon system.

Submission Details:
• Client ID: ${clientId}
• Company Name: ${companyName}
• Submitted by: ${submittedBy}
• Data Completeness: ${dataCompleteness}%
• Submission Date: ${new Date().toLocaleString()}

The client is now ready for the proposal stage.

Best regards,
ZeroCarbon System
  `.trim();

  await sendMail(to, subject, message);
});

// Proposal Action Email Template
emailQueue.process('proposalActionEmail', async (job) => {
  const { 
    to, 
    subject, 
    action, 
    clientId, 
    companyName, 
    performedBy,
    proposalNumber,
    totalAmount,
    totalDataIntegrationPoints,
    reason 
  } = job.data;
  
  const actionMessages = {
    moved: 'has been moved to the proposal stage',
    created: 'has received a new proposal',
    accepted: 'has accepted the proposal',
    rejected: 'has rejected the proposal'
  };
  
  let message = `
Dear Super Admin,

Client ${clientId} ${actionMessages[action]}.

Action Details:
• Action: Proposal ${action}
• Performed by: ${performedBy}
• Client: ${companyName}
• Date: ${new Date().toLocaleString()}
`;

  if (action === 'created' && proposalNumber) {
    message += `
    
Proposal Details:
• Proposal Number: ${proposalNumber}
• Total Amount: ₹${totalAmount || 0}
• Data Integration Points: ${totalDataIntegrationPoints || 0}
`;
  }

  if (action === 'rejected' && reason) {
    message += `\nRejection Reason: ${reason}`;
  }

  message += `

Please review this action in the admin dashboard.

Best regards,
ZeroCarbon System
  `.trim();

  await sendMail(to, subject, message);
});

// Consultant Assignment Email Template
emailQueue.process('consultantAssignmentEmail', async (job) => {
  const { 
    to, 
    subject, 
    consultantName,
    clientId,
    companyName,
    contactPersonName,
    clientEmail,
    clientMobile,
    currentStage,
    assignedBy
  } = job.data;
  
  const message = `
Dear ${consultantName},

You have been assigned to a new client by ${assignedBy}.

Client Details:
• Client ID: ${clientId}
• Company Name: ${companyName}
• Contact Person: ${contactPersonName}
• Email: ${clientEmail}
• Mobile: ${clientMobile}
• Current Stage: ${currentStage}

Next Steps:
1. Review the client information in your dashboard
2. Contact the client to understand their requirements
3. Guide them through the data submission process
4. Update the client status as you progress

Please ensure timely follow-up with the client.

Best regards,
ZeroCarbon Team
  `.trim();

  await sendMail(to, subject, message);
});

// Process welcome emails
emailQueue.process('sendWelcomeEmail', async (job) => {
  const { to, subject, userName, password, userType } = job.data;
  
  const message = `
Dear ${userName},

Welcome to ZeroCarbon! Your ${userType.replace(/_/g, ' ')} account has been created successfully.

Login Credentials:
• Username: ${userName}
• Email: ${to}
• Password: ${password}

Important: Please change your password after your first login for security.

You can access the platform at: ${process.env.FRONTEND_URL || 'https://zerotohero.ebhoom.com'}

Best regards,
ZeroCarbon Team
  `.trim();
  
  await sendMail(to, subject, message);
});

// Process client welcome emails
emailQueue.process('clientWelcomeEmail', async (job) => {
  const { to, contactName, clientId, password, subscriptionEndDate } = job.data;
  
  const message = `
Dear ${contactName},

Welcome to ZeroCarbon! Your account has been activated successfully.

Login Credentials:
• Client ID: ${clientId}
• Email: ${to}
• Password: ${password}

Your subscription is valid until: ${moment(subscriptionEndDate).format('DD/MM/YYYY')}

Important: Please change your password after your first login.

Best regards,
ZeroCarbon Team
  `.trim();
  
  await sendMail(to, subject, message);
});

// Process notification emails
emailQueue.process('notificationEmail', async (job) => {
  const { to, subject, title, message: notificationMessage, priority } = job.data;
  
  const priorityEmoji = {
    low: '🔵',
    medium: '🟡',
    high: '🔴',
    urgent: '🚨'
  }[priority] || '📢';
  
  const message = `
${priorityEmoji} ${title}

${notificationMessage}

This is an automated notification from ZeroCarbon.
To manage your notification preferences, please log in to your account.

Best regards,
ZeroCarbon System
  `.trim();
  
  await sendMail(to, subject, message);
});

// Process data submission stage email
emailQueue.process('dataSubmissionStageEmail', async (job) => {
  const { to, contactPersonName, clientId } = job.data;
  
  const message = `
Dear ${contactPersonName},

Thank you for your interest in ZeroCarbon services.

To proceed with your carbon footprint assessment, we need some additional information about your company.

Your Client ID: ${clientId}

Our consultant will contact you shortly to guide you through the data submission process.

Best regards,
ZeroCarbon Team
  `.trim();
  
  await sendMail(to, 'ZeroCarbon - Please Submit Your Company Data', message);
});

// Error handling for the queue
emailQueue.on('failed', (job, err) => {
  console.error(`Email job ${job.id} failed:`, err);
  console.error('Job data:', job.data);
});

emailQueue.on('completed', (job) => {
  console.log(`Email job ${job.id} completed successfully`);
});

// Clean old jobs periodically
setInterval(async () => {
  try {
    await emailQueue.clean(24 * 60 * 60 * 1000); // Clean jobs older than 24 hours
  } catch (error) {
    console.error('Error cleaning email queue:', error);
  }
}, 60 * 60 * 1000); // Run every hour



module.exports = { emailQueue };