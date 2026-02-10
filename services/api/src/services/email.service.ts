import nodemailer from 'nodemailer';
import { AppError, ErrorCode } from '../errors.js';

// Email template types
export enum EmailType {
  TEAM_INVITATION = 'team_invitation',
  EVIDENCE_SHARED = 'evidence_shared',
  QUOTA_WARNING = 'quota_warning',
  QUOTA_EXCEEDED = 'quota_exceeded',
  BATCH_COMPLETE = 'batch_complete',
  PASSWORD_RESET = 'password_reset',
  WELCOME = 'welcome',
}

// Email configuration from environment
interface EmailConfig {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  fromEmail: string;
  fromName: string;
  appUrl: string;
}

// Email content type
interface EmailContent {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

// Service class
export class EmailService {
  private transporter: nodemailer.Transporter | null = null;
  private config: EmailConfig;

  constructor() {
    // Load configuration from environment
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const fromEmail = process.env.EMAIL_FROM || 'noreply@digitalwitness.com';
    const fromName = process.env.EMAIL_FROM_NAME || 'Digital Witness';
    const appUrl = process.env.APP_URL || 'http://localhost:3000';

    this.config = {
      smtpHost: smtpHost || 'localhost',
      smtpPort,
      smtpUser: smtpUser || '',
      smtpPass: smtpPass || '',
      fromEmail,
      fromName,
      appUrl,
    };

    // Initialize transporter if credentials are provided
    if (smtpUser && smtpPass) {
      this.initializeTransporter();
    }
  }

  private initializeTransporter(): void {
    try {
      this.transporter = nodemailer.createTransport({
        host: this.config.smtpHost,
        port: this.config.smtpPort,
        secure: this.config.smtpPort === 465, // Use TLS for 465, not for 587
        auth: {
          user: this.config.smtpUser,
          pass: this.config.smtpPass,
        },
      });
    } catch (error) {
      console.error('Failed to initialize email transporter:', error);
    }
  }

  /**
   * Check if email service is configured
   */
  isConfigured(): boolean {
    return this.transporter !== null && !!this.config.smtpUser;
  }

  /**
   * Send an email
   */
  async sendEmail(content: EmailContent): Promise<boolean> {
    if (!this.transporter) {
      console.warn('Email service not configured. Skipping email send to:', content.to);
      return false;
    }

    try {
      const result = await this.transporter.sendMail({
        from: `${this.config.fromName} <${this.config.fromEmail}>`,
        to: content.to,
        subject: content.subject,
        html: content.html,
        text: content.text,
      });

      console.log(`Email sent to ${content.to}:`, result.messageId);
      return true;
    } catch (error) {
      console.error(`Failed to send email to ${content.to}:`, error);
      throw new AppError(
        ErrorCode.INTERNAL_SERVER_ERROR,
        'Failed to send email',
        { originalError: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Send team invitation email
   */
  async sendTeamInvitation(
    email: string,
    organizationName: string,
    invitationToken: string,
    invitedByName?: string
  ): Promise<boolean> {
    const acceptUrl = `${this.config.appUrl}/invite/${invitationToken}`;

    const html = `
      <h2>You've been invited to join a team!</h2>
      <p>${invitedByName || 'Someone'} invited you to join <strong>${organizationName}</strong> on Digital Witness.</p>
      
      <p>Click the link below to accept the invitation:</p>
      <p><a href="${acceptUrl}" style="background-color: #0066cc; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">Accept Invitation</a></p>
      
      <p>Or paste this link in your browser:</p>
      <p><code>${acceptUrl}</code></p>
      
      <p style="color: #666; font-size: 12px;">This invitation expires in 7 days.</p>
      <p style="color: #999; font-size: 11px;">Digital Witness - Secure Evidence Platform</p>
    `;

    const text = `
You've been invited to join ${organizationName} on Digital Witness.

Accept the invitation here: ${acceptUrl}

This invitation expires in 7 days.
    `.trim();

    return this.sendEmail({
      to: email,
      subject: `Join ${organizationName} on Digital Witness`,
      html,
      text,
    });
  }

  /**
   * Send evidence shared notification
   */
  async sendEvidenceShared(
    email: string,
    evidenceName: string,
    sharedByName: string,
    organizationName: string,
    evidenceUrl: string
  ): Promise<boolean> {
    const html = `
      <h2>Evidence shared with you</h2>
      <p><strong>${sharedByName}</strong> shared evidence with you in <strong>${organizationName}</strong>.</p>
      
      <p><strong>Evidence:</strong> ${evidenceName}</p>
      
      <p><a href="${evidenceUrl}" style="background-color: #0066cc; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">View Evidence</a></p>
      
      <p style="color: #999; font-size: 11px;">Digital Witness - Secure Evidence Platform</p>
    `;

    return this.sendEmail({
      to: email,
      subject: `Evidence shared: ${evidenceName}`,
      html,
    });
  }

  /**
   * Send quota warning email
   */
  async sendQuotaWarning(
    email: string,
    organizationName: string,
    quotaType: string,
    usagePercent: number,
    limit: number,
    current: number
  ): Promise<boolean> {
    const html = `
      <h2>⚠️ Quota Warning</h2>
      <p>Your <strong>${quotaType}</strong> quota for <strong>${organizationName}</strong> is running low.</p>
      
      <p><strong>Current Usage:</strong> ${current} / ${limit} (${usagePercent}%)</p>
      
      <p>When you reach 100%, you won't be able to ${quotaType === 'analyses' ? 'analyze evidence' : 'use this service'}.</p>
      
      <p>Check your quotas and billing options in your dashboard.</p>
      
      <p style="color: #999; font-size: 11px;">Digital Witness - Secure Evidence Platform</p>
    `;

    return this.sendEmail({
      to: email,
      subject: `⚠️ ${quotaType} quota at ${usagePercent}% for ${organizationName}`,
      html,
    });
  }

  /**
   * Send quota exceeded email
   */
  async sendQuotaExceeded(
    email: string,
    organizationName: string,
    quotaType: string,
    limit: number
  ): Promise<boolean> {
    const html = `
      <h2>❌ Quota Exceeded</h2>
      <p>Your <strong>${quotaType}</strong> quota for <strong>${organizationName}</strong> has been exceeded.</p>
      
      <p><strong>Limit:</strong> ${limit}</p>
      
      <p>You won't be able to ${quotaType === 'analyses' ? 'analyze evidence' : 'use this service'} until the quota resets or you upgrade your plan.</p>
      
      <p>Upgrade your plan to increase your quotas.</p>
      
      <p style="color: #999; font-size: 11px;">Digital Witness - Secure Evidence Platform</p>
    `;

    return this.sendEmail({
      to: email,
      subject: `❌ ${quotaType} quota exceeded for ${organizationName}`,
      html,
    });
  }

  /**
   * Send batch analysis completion notification
   */
  async sendBatchComplete(
    email: string,
    organizationName: string,
    batchName: string,
    itemsProcessed: number,
    itemsFailed: number,
    batchUrl: string
  ): Promise<boolean> {
    const successCount = itemsProcessed - itemsFailed;
    const successRate = itemsProcessed > 0 ? Math.round((successCount / itemsProcessed) * 100) : 0;

    const html = `
      <h2>✅ Batch Analysis Complete</h2>
      <p>Your batch analysis for <strong>${batchName}</strong> in <strong>${organizationName}</strong> is complete.</p>
      
      <p><strong>Results:</strong></p>
      <ul>
        <li>Total items: ${itemsProcessed}</li>
        <li>Successfully analyzed: ${successCount} (${successRate}%)</li>
        <li>Failed: ${itemsFailed}</li>
      </ul>
      
      <p><a href="${batchUrl}" style="background-color: #0066cc; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">View Results</a></p>
      
      <p style="color: #999; font-size: 11px;">Digital Witness - Secure Evidence Platform</p>
    `;

    return this.sendEmail({
      to: email,
      subject: `✅ Batch analysis complete: ${batchName}`,
      html,
    });
  }

  /**
   * Send password reset email
   */
  async sendPasswordReset(
    email: string,
    resetToken: string
  ): Promise<boolean> {
    const resetUrl = `${this.config.appUrl}/auth/reset-password?token=${resetToken}`;

    const html = `
      <h2>Reset your password</h2>
      <p>You requested a password reset for your Digital Witness account.</p>
      
      <p>Click the link below to reset your password:</p>
      <p><a href="${resetUrl}" style="background-color: #0066cc; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">Reset Password</a></p>
      
      <p>Or paste this link in your browser:</p>
      <p><code>${resetUrl}</code></p>
      
      <p style="color: #666; font-size: 12px;">This link expires in 1 hour.</p>
      
      <p style="color: #666; font-size: 12px;">If you didn't request this, you can safely ignore this email.</p>
      
      <p style="color: #999; font-size: 11px;">Digital Witness - Secure Evidence Platform</p>
    `;

    const text = `
Reset your password for Digital Witness.

Click here to reset: ${resetUrl}

This link expires in 1 hour.
    `.trim();

    return this.sendEmail({
      to: email,
      subject: 'Reset your Digital Witness password',
      html,
      text,
    });
  }

  /**
   * Send welcome email
   */
  async sendWelcome(
    email: string,
    userName: string
  ): Promise<boolean> {
    const dashboardUrl = `${this.config.appUrl}/dashboard`;

    const html = `
      <h2>Welcome to Digital Witness! 🎉</h2>
      <p>Hi ${userName},</p>
      
      <p>Your account is ready. Start securely managing your evidence:</p>
      
      <p><a href="${dashboardUrl}" style="background-color: #0066cc; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">Go to Dashboard</a></p>
      
      <p><strong>Getting Started:</strong></p>
      <ul>
        <li>Upload your first piece of evidence</li>
        <li>Invite team members to collaborate</li>
        <li>Generate AI-powered analysis</li>
        <li>Create and manage API keys for integrations</li>
      </ul>
      
      <p>If you have any questions, please reach out to support@digitalwitness.com</p>
      
      <p style="color: #999; font-size: 11px;">Digital Witness - Secure Evidence Platform</p>
    `;

    return this.sendEmail({
      to: email,
      subject: 'Welcome to Digital Witness!',
      html,
    });
  }

  /**
   * Verify SMTP connection (for testing)
   */
  async verifyConnection(): Promise<boolean> {
    if (!this.transporter) {
      return false;
    }

    try {
      await this.transporter.verify();
      console.log('Email service connection verified');
      return true;
    } catch (error) {
      console.error('Email service connection failed:', error);
      return false;
    }
  }
}

// Singleton instance
let emailService: EmailService | null = null;

export function getEmailService(): EmailService {
  if (!emailService) {
    emailService = new EmailService();
  }
  return emailService;
}
