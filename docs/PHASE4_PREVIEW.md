# Phase 4: Mobile & Admin Features - Preview & Planning

**Status**: 📋 PLANNING  
**Target Duration**: 4-6 hours  
**Dependencies**: Phase 3 complete ✅

---

## 1. Phase 4 Objectives

Phase 4 focuses on extending the enhanced UX to mobile and adding admin capabilities:

### 1.1 Mobile App Enhancement
- Apply Toast/Skeleton/EmptyState patterns to mobile
- Add loading states to mobile pages
- Implement mobile-specific error handling
- Add mobile-specific Sentry tracking

### 1.2 Admin Dashboard
- Create admin-only page with analytics
- Display user statistics
- Show evidence metrics
- Display subscription/billing metrics
- Real-time activity feed

### 1.3 API Error Improvements
- Add detailed error codes
- Improve error messages for debugging
- Add request tracing IDs
- Better error context logging

---

## 2. Mobile App Enhancement (2-3 hours)

### 2.1 Current State
**File**: `apps/mobile/src/api.ts`, `apps/mobile/App.tsx`, page files

Current structure:
- Expo-based React Native app
- Custom hooks for API calls
- Error handling via try-catch
- No Toast notifications
- No loading state indicators

### 2.2 Required Changes

#### 2.2.1 Create Mobile Toast System
**File**: `apps/mobile/src/toast-context.tsx` (NEW)

```tsx
import React, { createContext, useContext, useState, useCallback } from "react";
import { Animated, View } from "react-native";

interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "info" | "warning";
  duration?: number;
}

interface ToastContextType {
  toasts: Toast[];
  addToast: (message: string, type: Toast["type"], duration?: number) => void;
  removeToast: (id: string) => void;
}

export const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, type: Toast["type"], duration = 3000) => {
    const id = Date.now().toString();
    const toast: Toast = { id, message, type, duration };
    
    setToasts(prev => [...prev, toast]);

    if (duration > 0) {
      setTimeout(() => removeToast(id), duration);
    }
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <ToastOverlay toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within ToastProvider");
  return context;
}

function ToastOverlay({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <View style={{ position: "absolute", bottom: 20, left: 20, right: 20 }}>
      {toasts.map(toast => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onDismiss={() => onDismiss(toast.id)}
        />
      ))}
    </View>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const backgroundColor = {
    success: "#1F9D55",
    error: "#D64545",
    info: "#0B7BE5",
    warning: "#F59E0B"
  }[toast.type];

  return (
    <View
      style={{
        backgroundColor,
        padding: 12,
        borderRadius: 8,
        marginBottom: 8,
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center"
      }}
    >
      <Text style={{ color: "#fff", flex: 1 }}>{toast.message}</Text>
    </View>
  );
}
```

#### 2.2.2 Enhance Mobile API Calls
**File**: `apps/mobile/src/api.ts` (MODIFY)

Add Toast integration:
```tsx
export async function apiFetch(path: string, options?: RequestInit) {
  const { addToast } = useToast();
  
  try {
    addToast("Loading...", "info");
    const response = await fetch(url, options);
    
    if (!response.ok) {
      const error = await response.json();
      addToast(error.message || "Request failed", "error");
      throw new Error(error.message);
    }
    
    const data = await response.json();
    return data;
  } catch (err) {
    addToast(err.message, "error");
    throw err;
  }
}
```

#### 2.2.3 Add Loading States to Mobile Pages
**Files**: 
- `apps/mobile/app/index.tsx` (capture)
- `apps/mobile/app/verify.tsx` (verify)
- `apps/mobile/app/(stack)/_layout.tsx` (evidence detail)

Pattern:
```tsx
const [loading, setLoading] = useState(false);

const handleCapture = async () => {
  setLoading(true);
  try {
    addToast("Processing...", "info");
    // API call
    addToast("Success!", "success");
  } catch (err) {
    addToast(err.message, "error");
  } finally {
    setLoading(false);
  }
};
```

### 2.3 Mobile Pages to Enhance
| Page | File | Changes |
|------|------|---------|
| Capture | `app/index.tsx` | Add Toast + loading state |
| Verify | `app/verify.tsx` | Add Toast + loading state |
| Evidence Detail | `app/(stack)/_layout.tsx` | Add Toast on actions |
| Settings | `app/(stack)/settings.tsx` | Add Toast on logout |

**Estimated effort**: 2-3 hours

---

## 3. Admin Dashboard (1.5-2 hours)

### 3.1 Admin Page Structure
**File**: `apps/web/app/(app)/admin/page.tsx` (NEW)

```tsx
"use client";

export default function AdminPage() {
  return (
    <div className="admin-page">
      <h1>Admin Dashboard</h1>
      
      {/* Stats Grid */}
      <div className="stats-grid">
        <StatCard title="Total Users" value={12345} />
        <StatCard title="Active Users (30d)" value={2345} />
        <StatCard title="Total Evidence" value={45678} />
        <StatCard title="Reports Generated" value={8234} />
      </div>

      {/* Subscription Stats */}
      <Card>
        <h2>Subscription Overview</h2>
        <SubscriptionChart />
        <ul>
          <li>Free: 8,234 users</li>
          <li>Pay-Per-Evidence: 2,456 users</li>
          <li>Pro: 1,234 users</li>
          <li>Team: 234 users</li>
        </ul>
      </Card>

      {/* Activity Feed */}
      <Card>
        <h2>Recent Activity</h2>
        <ActivityFeed events={recentEvents} />
      </Card>

      {/* Evidence Analytics */}
      <Card>
        <h2>Evidence Analytics</h2>
        <EvidenceChart />
        <ul>
          <li>Video: 32,456 (71%)</li>
          <li>Photos: 8,234 (18%)</li>
          <li>Audio: 3,456 (8%)</li>
          <li>Documents: 1,234 (3%)</li>
        </ul>
      </Card>
    </div>
  );
}
```

### 3.2 Admin-Only Route Protection
**File**: `apps/web/app/providers.tsx` (MODIFY)

```tsx
function AdminGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  
  if (!user?.isAdmin) {
    return <div>Access denied</div>;
  }
  
  return <>{children}</>;
}
```

### 3.3 Admin API Endpoints
**Note**: These should be implemented on backend (Phase 5)

Required endpoints:
- `GET /v1/admin/stats/overview` → Total stats
- `GET /v1/admin/stats/users` → User metrics
- `GET /v1/admin/stats/subscriptions` → Subscription breakdown
- `GET /v1/admin/stats/evidence` → Evidence metrics
- `GET /v1/admin/activity/feed?limit=50` → Activity log

### 3.4 Admin Components
Create new components:
- `components/admin/stat-card.tsx` - Display single metric
- `components/admin/subscription-chart.tsx` - Pie chart of plans
- `components/admin/evidence-chart.tsx` - Bar chart by type
- `components/admin/activity-feed.tsx` - Timeline of events

**Estimated effort**: 1.5-2 hours (depends on chart library)

---

## 4. API Error Improvements (1-1.5 hours)

### 4.1 Error Code System
Add standardized error codes to all API responses:

```tsx
// Current format
{ error: "User not found" }

// Improved format
{
  error: {
    code: "USER_NOT_FOUND",
    message: "User not found",
    details: "User with ID xyz was not found",
    requestId: "req_12345"
  }
}
```

### 4.2 Error Categories
```tsx
// Client errors (4xx)
const errors = {
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429
};

// Server errors (5xx)
const errors = {
  INTERNAL_ERROR: 500,
  UNAVAILABLE: 503,
  TIMEOUT: 504
};
```

### 4.3 Request Tracing
Add request IDs to all responses:

```tsx
// Server-side (add to middleware)
const requestId = generateId();
res.setHeader("X-Request-ID", requestId);

// Client-side (log with Toast)
try {
  const response = await fetch(url);
  const requestId = response.headers.get("X-Request-ID");
  
  if (!response.ok) {
    captureException(err, {
      requestId,
      feature: "api_call",
      method: "POST",
      path: "/v1/evidence"
    });
  }
} catch (err) {
  // ...
}
```

**Estimated effort**: 1-1.5 hours (backend + client updates)

---

## 5. Implementation Order

**Recommended sequence**:

1. **Mobile Toast System** (30-40 min)
   - Create toast-context.tsx
   - Integrate into App.tsx
   - Add useToast hook

2. **Mobile Page Enhancements** (1-1.5 hours)
   - Update capture page
   - Update verify page
   - Update evidence detail page
   - Test Toast display

3. **Admin Dashboard Structure** (1 hour)
   - Create admin page
   - Create stat components
   - Design layout
   - Add admin guard

4. **Admin API Integration** (30-45 min)
   - Fetch stats from API
   - Handle errors
   - Add Toast feedback
   - Add loading states

5. **API Error Improvements** (45-60 min)
   - Update error response format
   - Add request tracing
   - Update error codes
   - Update client error handling

---

## 6. Testing Strategy

### Mobile Testing
- ✅ Toast displays on iOS/Android emulator
- ✅ Loading states block user interaction
- ✅ Error messages show details
- ✅ Navigation works with loading states

### Admin Testing
- ✅ Only admins can access /admin
- ✅ Stats load and display correctly
- ✅ Charts render without errors
- ✅ Activity feed updates in real-time

### Error Testing
- ✅ 400 errors show input validation messages
- ✅ 401 errors redirect to login
- ✅ 403 errors show permission denied
- ✅ 5xx errors show "try again" option
- ✅ Request IDs logged with Sentry

---

## 7. Dependencies & Libraries

### New Dependencies
- **Mobile Charts**: `react-native-chart-kit` (optional)
- **Web Charts**: `recharts` or `chart.js` (optional)

### Existing Dependencies
- All existing libraries sufficient for implementation

---

## 8. Files to Create/Modify

### Create (6 files)
```
apps/mobile/src/toast-context.tsx (NEW)
apps/web/app/(app)/admin/page.tsx (NEW)
apps/web/components/admin/stat-card.tsx (NEW)
apps/web/components/admin/subscription-chart.tsx (NEW)
apps/web/components/admin/evidence-chart.tsx (NEW)
apps/web/components/admin/activity-feed.tsx (NEW)
```

### Modify (6 files)
```
apps/mobile/App.tsx (Add ToastProvider)
apps/mobile/src/api.ts (Add Toast integration)
apps/mobile/app/index.tsx (Add Toast + loading)
apps/mobile/app/verify.tsx (Add Toast + loading)
apps/web/app/providers.tsx (Add AdminGuard)
services/api/src/index.ts (Update error format)
```

---

## 9. Acceptance Criteria

### Mobile Enhancement ✅
- [ ] Mobile app shows Toasts on all actions
- [ ] Loading states prevent double-submission
- [ ] Error messages clear and actionable
- [ ] Sentry logs mobile errors properly
- [ ] Tested on iOS and Android

### Admin Dashboard ✅
- [ ] Only admins can access /admin page
- [ ] Stats load and display correctly
- [ ] Charts update in real-time
- [ ] Activity feed shows recent actions
- [ ] All admin pages have error handling

### API Errors ✅
- [ ] All errors have unique codes
- [ ] Request IDs included in responses
- [ ] Error messages actionable
- [ ] 401/403 errors handled specially
- [ ] Sentry receives full error context

---

## 10. Estimated Timeline

| Task | Duration | Start | End |
|------|----------|-------|-----|
| Mobile Toast System | 40 min | 0h | 0:40h |
| Mobile Page Updates | 1.5h | 0:40h | 2:10h |
| Admin Dashboard UI | 1h | 2:10h | 3:10h |
| Admin API Integration | 45 min | 3:10h | 3:55h |
| API Error Improvements | 1h | 3:55h | 4:55h |
| Testing & Documentation | 1h | 4:55h | 5:55h |
| **TOTAL** | **~6h** | | |

---

## 11. Success Metrics

✅ **Mobile**: Zero Toast display errors, 100% action feedback  
✅ **Admin**: <1s load time for stats, real-time activity  
✅ **Errors**: <500ms error logging, 100% request tracing  
✅ **Code**: 0 TypeScript errors, 100% error handling  
✅ **UX**: <300ms Toast display, smooth animations  

---

## 12. Next Phases Overview

### Phase 5 (Backend Enhancement - 4-6h)
- Email notifications
- Webhook system
- Advanced search
- Database optimization

### Phase 6 (AI Features - 6-8h)
- Case suggestion
- Anomaly detection
- Smart tagging
- Predictive analytics

### Phase 7 (Enterprise - 6-8h)
- SSO/SAML
- Audit logs
- Custom branding
- API keys & webhooks

### Phase 8 (Polish & Scale - 4-6h)
- Performance optimization
- CDN caching
- Load testing
- Global deployment

---

## 13. Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|-----------|
| Mobile Toast library incompatible | Low | Medium | Use native Toast API |
| Admin stats slow to load | Medium | Medium | Add caching layer |
| Chart rendering performance | Low | Low | Lazy load charts |
| Error codes breaking existing clients | High | High | Versioned API endpoints |
| Admin access control bypass | Low | High | Unit tests for guards |

---

## 14. Conclusion

Phase 4 extends the Phase 3 enhancements to mobile and admin areas, while improving API error handling for better debugging. With ~6 hours of focused work, all goals are achievable.

**Next action**: Proceed with Phase 4 implementation when Phase 3 testing is complete.

---

**Phase 4 Preview Complete ✅**  
**Ready for Phase 4 Start 🚀**
