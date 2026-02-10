# Phase 8: Polish & Scale - Project Plan

**Date**: February 10, 2026  
**Status**: 🚀 STARTING  
**Scope**: Final MVP enhancements for production deployment  
**Estimated Duration**: 8-12 hours  

---

## Overview

Phase 8 transforms the MVP from "feature-complete" to "production-grade" by adding:

- **Communication**: Email invites, SMS alerts, push notifications
- **Integration**: Webhooks for third-party systems
- **Operations**: Audit logging, advanced analytics
- **Discovery**: Advanced search, evidence templates
- **Resilience**: Mobile offline support, error recovery

---

## Phase 8 Goals

✅ **Primary**: Enable real-world production workflows  
✅ **Secondary**: Improve user experience with templates and search  
✅ **Tertiary**: Add integration capabilities (webhooks)  
✅ **Optional**: Mobile offline, SMS, push notifications  

---

## Feature Breakdown

### 1️⃣ Email Service Integration (HIGH PRIORITY)

**Why**: Team invitations currently only show tokens. Real deployments need email.

**Features**:
- Team invitation emails with accept links
- Evidence sharing notifications
- Quota alerts (80%, 100% thresholds)
- Password reset emails
- Batch analysis completion notifications
- New comment/activity digests

**Technology**: 
- NodeMailer for SMTP
- OR SendGrid for managed email
- Templates in `/lib/email-templates`

**Files to Create**:
- `services/api/src/services/email.service.ts`
- `services/api/src/lib/email-templates.ts`
- Environment variables: `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`

**Routes to Modify**:
- `team-management.routes.ts` - Send email on invite
- `evidence.routes.ts` - Send email on share
- Batch routes - Send email on completion

---

### 2️⃣ Webhooks API (HIGH PRIORITY)

**Why**: Enable third-party integration and automation platforms (Zapier, etc.)

**Features**:
- Webhook event types (analysis_complete, member_joined, batch_finished, etc.)
- Webhook registration and management
- Retry logic with exponential backoff
- Request signing (HMAC-SHA256)
- Event payload delivery
- Webhook dashboard and logs

**Data Models**:
```typescript
interface Webhook {
  id: string;
  organizationId: string;
  url: string;
  events: string[];
  secret: string;
  isActive: boolean;
  failureCount: number;
  lastTriggeredAt?: Date;
  createdAt: Date;
}

interface WebhookEvent {
  id: string;
  webhookId: string;
  type: string;
  payload: Record<string, any>;
  status: 'pending' | 'delivered' | 'failed';
  attempt: number;
  nextRetryAt?: Date;
  createdAt: Date;
}
```

**Files to Create**:
- `services/api/src/services/webhook.service.ts`
- `services/api/src/routes/webhook.routes.ts`
- Database: webhooks table, webhook_events table

**API Endpoints**:
```
POST   /v1/organizations/:id/webhooks
GET    /v1/organizations/:id/webhooks
GET    /v1/organizations/:id/webhooks/:id
PATCH  /v1/organizations/:id/webhooks/:id
DELETE /v1/organizations/:id/webhooks/:id
GET    /v1/organizations/:id/webhooks/:id/logs
POST   /v1/organizations/:id/webhooks/:id/test
```

---

### 3️⃣ Audit Logging (MEDIUM PRIORITY)

**Why**: Compliance, security, and debugging.

**Features**:
- Track all user actions (create, read, update, delete)
- Track resource changes with before/after
- Track API key usage
- Track admin actions
- Audit log export (CSV, JSON)
- Audit dashboard

**Log Fields**:
- User ID, timestamp, action, resource type, resource ID
- Changes (before/after values)
- IP address, user agent
- Status (success/failure)
- Error details if failed

**Files to Create**:
- `services/api/src/services/audit.service.ts`
- `services/api/src/middleware/audit.middleware.ts`
- `apps/web/app/(app)/dashboard/audit-logs/page.tsx`

**Database**:
```typescript
interface AuditLog {
  id: string;
  userId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  changes?: Record<string, {before: any; after: any}>;
  status: 'success' | 'failure';
  errorMessage?: string;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
}
```

---

### 4️⃣ Advanced Search & Filtering (MEDIUM PRIORITY)

**Why**: Users need to find evidence quickly. Current API lacks filtering.

**Features**:
- Full-text search on evidence name, description, tags
- Date range filtering (uploaded, analyzed, created)
- Status filtering (pending, verified, failed)
- Classification filtering (by AI classes)
- Tag filtering (multi-select)
- Sort options (date, name, confidence, etc.)
- Save search filters

**Implementation**:
- Add filters to `GET /v1/evidence` endpoint
- Create search service with indexing support
- Update web dashboard with filter UI

**Query Examples**:
```
GET /v1/evidence?q=accident&dateFrom=2025-02-01&dateTo=2025-02-10
GET /v1/evidence?status=verified&classifications=accident_scene
GET /v1/evidence?tags=urgent,evidence&sort=date_desc
```

---

### 5️⃣ Evidence Templates (MEDIUM PRIORITY)

**Why**: Accelerate evidence capture with pre-configured templates.

**Features**:
- Create/edit/delete templates per organization
- Template includes: name, description, default tags, custom fields
- Quick capture using template
- Template library (pre-made for common cases)
- Template sharing across team

**Files to Create**:
- `services/api/src/services/template.service.ts`
- `services/api/src/routes/template.routes.ts`
- `apps/web/app/(app)/dashboard/templates/page.tsx`
- `apps/mobile/app/templates.tsx`

**API Endpoints**:
```
POST   /v1/templates
GET    /v1/templates
GET    /v1/templates/:id
PATCH  /v1/templates/:id
DELETE /v1/templates/:id
POST   /v1/evidence/from-template/:templateId
```

---

### 6️⃣ Advanced Analytics Dashboard (LOW PRIORITY)

**Why**: Insights for team leaders and admins.

**Features**:
- Evidence statistics (by type, date, classification)
- AI classification trends over time
- Team activity metrics (users, actions)
- Cost analysis and breakdown
- API usage statistics
- Search/filter functionality
- Export reports

**Files to Create**:
- `apps/web/app/(app)/dashboard/analytics/page.tsx`
- `services/api/src/routes/analytics.routes.ts`
- Charts library (Chart.js or D3)

---

### 7️⃣ SMS Notifications (OPTIONAL)

**Why**: Critical alerts without email delays.

**Features**:
- Critical quota alerts via SMS
- Team member invites (opt-in)
- Batch analysis completion alerts
- Breach notifications
- 2FA codes (future)

**Technology**: Twilio API

**Files to Create**:
- `services/api/src/services/sms.service.ts`

---

### 8️⃣ Mobile Offline Support (OPTIONAL)

**Why**: Work without internet connection.

**Features**:
- Local SQLite database for caching
- Queue uploads when online
- Sync all changes
- Detect online/offline status
- Conflict resolution

**Implementation**:
- SQLite plugin for Expo
- Background sync service
- Conflict resolution logic

---

## Implementation Priority

### Week 1 (Priority 1-3)
1. **Email Service** - Unblock production deployment
2. **Webhooks** - Enable integrations
3. **Audit Logging** - Compliance requirement

### Week 2 (Priority 4-6)
4. **Advanced Search** - User experience
5. **Templates** - Mobile UX improvement
6. **Analytics** - Admin feature

### Week 3 (Priority 7-8, Optional)
7. **SMS Notifications** - Nice to have
8. **Mobile Offline** - Advanced feature

---

## Technology Decisions

### Email Service
- **Option A**: NodeMailer (SMTP, self-hosted)
- **Option B**: SendGrid API (managed service)
- **Decision**: NodeMailer for MVP, SendGrid for scale
- **Config**: Environment variables for SMTP details

### Webhooks
- **Delivery**: HTTP POST with JSON payload
- **Signing**: HMAC-SHA256 of payload
- **Retry**: Exponential backoff (1m, 5m, 15m, 1h)
- **Max Attempts**: 5
- **Storage**: PostgreSQL for events and webhooks

### Audit Logging
- **Scope**: All writes, sensitive reads
- **Retention**: 90 days by default (configurable)
- **Performance**: Async logging to avoid blocking
- **Query**: Support filtering by user, action, resource

### Search
- **Index**: Full-text search on PostgreSQL
- **Library**: pg_trgm extension for trigram search
- **Frontend**: Filter UI in React component

---

## Database Schema Additions

### Webhooks Table
```sql
CREATE TABLE webhooks (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  url VARCHAR NOT NULL,
  events TEXT[] NOT NULL,
  secret VARCHAR NOT NULL,
  is_active BOOLEAN DEFAULT true,
  failure_count INT DEFAULT 0,
  last_triggered_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### Webhook Events Table
```sql
CREATE TABLE webhook_events (
  id UUID PRIMARY KEY,
  webhook_id UUID NOT NULL REFERENCES webhooks(id),
  type VARCHAR NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR NOT NULL,
  attempt INT DEFAULT 1,
  next_retry_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Audit Logs Table
```sql
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  action VARCHAR NOT NULL,
  resource_type VARCHAR NOT NULL,
  resource_id UUID,
  changes JSONB,
  status VARCHAR NOT NULL,
  error_message TEXT,
  ip_address VARCHAR,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Templates Table
```sql
CREATE TABLE templates (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR NOT NULL,
  description TEXT,
  icon VARCHAR,
  default_tags TEXT[],
  custom_fields JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

---

## API Response Examples

### Email Service
```typescript
// Send invitation email
POST /v1/organizations/:id/members/invite
{
  "email": "user@example.com",
  "role": "member",
  "sendEmail": true  // New field
}

Response:
{
  "data": {
    "invitationId": "inv_123",
    "emailSent": true,
    "expiresAt": "2025-02-17T..."
  }
}
```

### Webhooks
```typescript
// Register webhook
POST /v1/organizations/:id/webhooks
{
  "url": "https://example.com/webhooks",
  "events": ["analysis_complete", "member_joined"]
}

Response:
{
  "data": {
    "id": "wh_123",
    "url": "https://example.com/webhooks",
    "events": ["analysis_complete", "member_joined"],
    "secret": "wh_secret_abc123"  // Only shown once
  }
}

// Webhook payload
POST https://example.com/webhooks
Headers: X-Webhook-Signature: sha256=abcd1234
{
  "id": "evt_123",
  "type": "analysis_complete",
  "timestamp": "2025-02-10T...",
  "data": {
    "analysisId": "ana_123",
    "evidenceId": "evi_123",
    "classification": "accident_scene"
  }
}
```

### Audit Logs
```typescript
// Get audit logs
GET /v1/audit-logs?action=create&resourceType=evidence&limit=50

Response:
{
  "data": [
    {
      "id": "log_123",
      "userId": "user_123",
      "action": "create",
      "resourceType": "evidence",
      "resourceId": "evi_123",
      "status": "success",
      "createdAt": "2025-02-10T..."
    }
  ],
  "pagination": {
    "total": 150,
    "page": 1,
    "limit": 50
  }
}
```

### Advanced Search
```typescript
// Search with filters
GET /v1/evidence?q=accident&classifications=accident_scene&status=verified&sort=date_desc

Response:
{
  "data": [
    {
      "id": "evi_123",
      "name": "Car Accident Scene",
      "classification": {
        "primary": "accident_scene",
        "confidence": 0.94
      },
      "status": "verified",
      "uploadedAt": "2025-02-10T..."
    }
  ],
  "facets": {
    "classifications": [
      {"value": "accident_scene", "count": 42},
      {"value": "property_damage", "count": 18}
    ],
    "statuses": [
      {"value": "verified", "count": 40},
      {"value": "pending", "count": 20}
    ]
  }
}
```

---

## Testing Strategy

### Email Service
- Mock SMTP server for tests
- Verify email templates render correctly
- Test retry logic

### Webhooks
- Mock webhook receiver
- Verify signature calculation
- Test retry with failures
- Test event delivery

### Audit Logging
- Verify logs are created for all actions
- Test log filtering and export
- Performance: ensure minimal overhead

### Search
- Test full-text search accuracy
- Test filter combinations
- Performance on large datasets

---

## Security Considerations

### Email
- ✅ Don't log email addresses in plain text
- ✅ Validate email addresses
- ✅ Rate limit email sends
- ✅ Use templates to prevent injection

### Webhooks
- ✅ Sign all webhook payloads
- ✅ Validate webhook URLs (no localhost)
- ✅ Rate limit webhook delivery
- ✅ Timeout on webhook failures
- ✅ Verify HTTPS only in production

### Audit Logs
- ✅ Don't log passwords or secrets
- ✅ Immutable (no update/delete of old logs)
- ✅ Encrypted at rest
- ✅ Access control: admin only

### Search
- ✅ Respect user permissions in search results
- ✅ Don't expose internal IDs in search

---

## Performance Goals

| Feature | Latency |
|---------|---------|
| Email send | <1s (async) |
| Webhook delivery | <5s (with retries) |
| Audit log write | <10ms (async) |
| Search query | <500ms |
| Analytics page load | <2s |

---

## Deployment Checklist

- [ ] Database migrations for new tables
- [ ] Configure email (SMTP or SendGrid)
- [ ] Configure webhooks secret signing
- [ ] Set audit log retention period
- [ ] Configure full-text search indices
- [ ] Add environment variables
- [ ] Test email/webhook delivery
- [ ] Monitor webhook failures
- [ ] Backup audit logs
- [ ] Configure log archival

---

## Success Criteria

✅ **Email Service**:
- Invitations sent and received
- All email types working
- Templates rendering correctly

✅ **Webhooks**:
- Events delivered to external URLs
- Signature verification working
- Retry logic functioning

✅ **Audit Logging**:
- All actions logged
- Logs searchable and exportable
- Performance impact minimal

✅ **Search/Templates**:
- Filters working correctly
- Templates creatable and usable
- UX improved

✅ **Code Quality**:
- 0 TypeScript errors
- All tests passing
- Documentation complete

---

## Git Strategy

- Feature branches for each major component
- Merge to main with reviewed PRs
- Tag releases with version numbers
- Document breaking changes

---

## Estimated Time Breakdown

| Feature | Hours |
|---------|-------|
| Email Service | 2 |
| Webhooks | 3 |
| Audit Logging | 2 |
| Advanced Search | 2 |
| Templates | 2 |
| Analytics | 2 |
| SMS (optional) | 1 |
| Mobile Offline (optional) | 2 |
| Testing & Docs | 2 |
| **Total** | **18 hours** |

**MVP Timeline**: 2-3 days (8-12 hour days)

---

## Next Steps

1. ✅ **Phase 8 Plan** (this document) - DONE
2. 🔄 **Email Service** - Start next
3. **Webhooks**
4. **Audit Logging**
5. **Advanced Search**
6. **Templates**
7. **Analytics**
8. **Documentation**

Ready to build a production-grade platform!
