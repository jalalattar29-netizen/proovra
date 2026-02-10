import { AppError, ErrorCode } from '../errors.js';

// Audit log actions
export enum AuditAction {
  // Evidence actions
  EVIDENCE_CREATED = 'evidence_created',
  EVIDENCE_UPDATED = 'evidence_updated',
  EVIDENCE_DELETED = 'evidence_deleted',
  EVIDENCE_VERIFIED = 'evidence_verified',
  EVIDENCE_SHARED = 'evidence_shared',

  // Team actions
  MEMBER_INVITED = 'member_invited',
  MEMBER_JOINED = 'member_joined',
  MEMBER_REMOVED = 'member_removed',
  MEMBER_ROLE_CHANGED = 'member_role_changed',
  ORGANIZATION_CREATED = 'organization_created',
  ORGANIZATION_UPDATED = 'organization_updated',

  // API key actions
  API_KEY_GENERATED = 'api_key_generated',
  API_KEY_ROTATED = 'api_key_rotated',
  API_KEY_REVOKED = 'api_key_revoked',

  // Batch actions
  BATCH_CREATED = 'batch_created',
  BATCH_PROCESSED = 'batch_processed',
  BATCH_CANCELLED = 'batch_cancelled',

  // Auth actions
  USER_LOGIN = 'user_login',
  USER_LOGOUT = 'user_logout',
  PASSWORD_CHANGED = 'password_changed',

  // Admin actions
  WEBHOOK_CREATED = 'webhook_created',
  WEBHOOK_DELETED = 'webhook_deleted',
  SETTINGS_CHANGED = 'settings_changed',
}

// Audit log interface
export interface AuditLog {
  id: string;
  userId: string;
  action: AuditAction;
  resourceType: string;
  resourceId?: string;
  organizationId?: string;
  changes?: Record<string, { before: any; after: any }>;
  status: 'success' | 'failure';
  errorMessage?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}

// Audit log filter interface
export interface AuditLogFilter {
  userId?: string;
  action?: AuditAction;
  resourceType?: string;
  resourceId?: string;
  organizationId?: string;
  status?: 'success' | 'failure';
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
  offset?: number;
}

// Service class
export class AuditService {
  // In-memory storage for MVP
  private logs = new Map<string, AuditLog>();
  private retentionDays = 90; // Default 90 day retention

  /**
   * Log an audit event
   */
  logEvent(
    userId: string,
    action: AuditAction,
    resourceType: string,
    options?: {
      resourceId?: string;
      organizationId?: string;
      changes?: Record<string, { before: any; after: any }>;
      ipAddress?: string;
      userAgent?: string;
      metadata?: Record<string, any>;
    }
  ): AuditLog {
    const id = `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const log: AuditLog = {
      id,
      userId,
      action,
      resourceType,
      status: 'success',
      createdAt: new Date(),
      ...options,
    };

    this.logs.set(id, log);
    return log;
  }

  /**
   * Log failure event
   */
  logFailure(
    userId: string,
    action: AuditAction,
    resourceType: string,
    error: Error | string,
    options?: {
      resourceId?: string;
      organizationId?: string;
      ipAddress?: string;
      userAgent?: string;
      metadata?: Record<string, any>;
    }
  ): AuditLog {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const log = this.logEvent(userId, action, resourceType, options);
    log.status = 'failure';
    log.errorMessage = errorMessage;
    this.logs.set(log.id, log);
    return log;
  }

  /**
   * Get audit logs with filtering
   */
  getLogs(filter: AuditLogFilter): {
    logs: AuditLog[];
    total: number;
    limit: number;
    offset: number;
  } {
    let logs = Array.from(this.logs.values());

    // Apply filters
    if (filter.userId) {
      logs = logs.filter((l) => l.userId === filter.userId);
    }
    if (filter.action) {
      logs = logs.filter((l) => l.action === filter.action);
    }
    if (filter.resourceType) {
      logs = logs.filter((l) => l.resourceType === filter.resourceType);
    }
    if (filter.resourceId) {
      logs = logs.filter((l) => l.resourceId === filter.resourceId);
    }
    if (filter.organizationId) {
      logs = logs.filter((l) => l.organizationId === filter.organizationId);
    }
    if (filter.status) {
      logs = logs.filter((l) => l.status === filter.status);
    }
    if (filter.dateFrom) {
      logs = logs.filter((l) => l.createdAt >= filter.dateFrom!);
    }
    if (filter.dateTo) {
      logs = logs.filter((l) => l.createdAt <= filter.dateTo!);
    }

    // Sort by date descending
    logs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Apply pagination
    const limit = filter.limit || 50;
    const offset = filter.offset || 0;
    const total = logs.length;
    const paginated = logs.slice(offset, offset + limit);

    return {
      logs: paginated,
      total,
      limit,
      offset,
    };
  }

  /**
   * Get user activity summary
   */
  getUserActivitySummary(userId: string, days = 7): {
    totalActions: number;
    actionsByType: Record<string, number>;
    successRate: number;
    lastAction?: Date;
  } {
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);

    const logs = this.getLogs({
      userId,
      dateFrom,
      limit: 1000,
    }).logs;

    const actionsByType: Record<string, number> = {};
    let successCount = 0;

    for (const log of logs) {
      actionsByType[log.action] = (actionsByType[log.action] || 0) + 1;
      if (log.status === 'success') {
        successCount += 1;
      }
    }

    return {
      totalActions: logs.length,
      actionsByType,
      successRate: logs.length > 0 ? (successCount / logs.length) * 100 : 0,
      lastAction: logs.length > 0 ? logs[0].createdAt : undefined,
    };
  }

  /**
   * Get organization activity summary
   */
  getOrganizationActivitySummary(organizationId: string): {
    totalActions: number;
    actionsByType: Record<string, number>;
    topUsers: Array<{ userId: string; actionCount: number }>;
    failureRate: number;
  } {
    const logs = this.getLogs({
      organizationId,
      limit: 10000,
    }).logs;

    const actionsByType: Record<string, number> = {};
    const userActions: Record<string, number> = {};
    let failureCount = 0;

    for (const log of logs) {
      actionsByType[log.action] = (actionsByType[log.action] || 0) + 1;
      userActions[log.userId] = (userActions[log.userId] || 0) + 1;
      if (log.status === 'failure') {
        failureCount += 1;
      }
    }

    const topUsers = Object.entries(userActions)
      .map(([userId, count]) => ({ userId, actionCount: count }))
      .sort((a, b) => b.actionCount - a.actionCount)
      .slice(0, 5);

    return {
      totalActions: logs.length,
      actionsByType,
      topUsers,
      failureRate: logs.length > 0 ? (failureCount / logs.length) * 100 : 0,
    };
  }

  /**
   * Export logs as CSV
   */
  exportAsCSV(filter: AuditLogFilter): string {
    const logs = this.getLogs({ ...filter, limit: 10000 }).logs;

    // CSV header
    const headers = [
      'ID',
      'Timestamp',
      'User ID',
      'Action',
      'Resource Type',
      'Resource ID',
      'Status',
      'Error Message',
      'IP Address',
      'User Agent',
    ];

    const rows = logs.map((log) => [
      log.id,
      log.createdAt.toISOString(),
      log.userId,
      log.action,
      log.resourceType,
      log.resourceId || '',
      log.status,
      log.errorMessage || '',
      log.ipAddress || '',
      log.userAgent || '',
    ]);

    // Escape CSV values
    const escapedRows = rows.map((row) =>
      row.map((cell) => {
        if (typeof cell !== 'string') {
          cell = String(cell);
        }
        if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
          return `"${cell.replace(/"/g, '""')}"`;
        }
        return cell;
      })
    );

    return [headers, ...escapedRows].map((row) => row.join(',')).join('\n');
  }

  /**
   * Clean up old logs (call periodically)
   */
  cleanupOldLogs(): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);

    let deletedCount = 0;
    for (const [id, log] of this.logs.entries()) {
      if (log.createdAt < cutoffDate) {
        this.logs.delete(id);
        deletedCount += 1;
      }
    }

    return deletedCount;
  }

  /**
   * Set retention period in days
   */
  setRetentionDays(days: number): void {
    if (days < 1) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'Retention period must be at least 1 day'
      );
    }
    this.retentionDays = days;
  }

  /**
   * Get log statistics
   */
  getStatistics(days = 30): {
    totalLogs: number;
    logsPerDay: Record<string, number>;
    successRate: number;
    topActions: Array<{ action: string; count: number }>;
  } {
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);

    const logs = this.getLogs({
      dateFrom,
      limit: 100000,
    }).logs;

    const logsPerDay: Record<string, number> = {};
    const actionCounts: Record<string, number> = {};
    let successCount = 0;

    for (const log of logs) {
      const day = log.createdAt.toISOString().split('T')[0];
      logsPerDay[day] = (logsPerDay[day] || 0) + 1;
      actionCounts[log.action] = (actionCounts[log.action] || 0) + 1;
      if (log.status === 'success') {
        successCount += 1;
      }
    }

    const topActions = Object.entries(actionCounts)
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalLogs: logs.length,
      logsPerDay,
      successRate: logs.length > 0 ? (successCount / logs.length) * 100 : 0,
      topActions,
    };
  }
}

// Singleton instance
let auditService: AuditService | null = null;

export function getAuditService(): AuditService {
  if (!auditService) {
    auditService = new AuditService();
    // Start periodic cleanup
    setInterval(() => {
      const deleted = auditService?.cleanupOldLogs();
      if (deleted && deleted > 0) {
        console.log(`Cleaned up ${deleted} old audit logs`);
      }
    }, 24 * 60 * 60 * 1000); // Daily cleanup
  }
  return auditService;
}
