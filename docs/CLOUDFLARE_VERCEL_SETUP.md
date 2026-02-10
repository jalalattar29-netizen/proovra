# Cloudflare + Vercel Configuration Guide for app.proovra.com

**Last Updated:** February 10, 2026

---

## Overview

This guide explains how to properly configure Cloudflare and Vercel to serve both `www.proovra.com` (marketing) and `app.proovra.com` (app shell) from the same Next.js deployment.

**Common Issue:** "SSL handshake failed" or "Connection refused" when visiting `app.proovra.com`

**Root Causes:**
1. Cloudflare SSL/TLS mode mismatch with Vercel origin certificate
2. Missing domain configuration in Vercel
3. Incorrect DNS records in Cloudflare
4. Environment variables not set for both domains

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    PROOVRA DOMAINS                       │
└──────────────────────┬──────────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
   www.proovra.com  app.proovra.com  (api.proovra.com)
          │            │             │
          └────────────┼─────────────┘
                       │
          ┌────────────▼────────────┐
          │    Cloudflare (DNS)     │
          │  - Proxy settings       │
          │  - SSL/TLS mode         │
          │  - DNS records          │
          └────────────┬────────────┘
                       │
          ┌────────────▼────────────┐
          │   Vercel Deployment     │
          │  - www.proovra.com      │
          │  - app.proovra.com      │
          │  - Middleware routing   │
          └────────────┬────────────┘
                       │
          ┌────────────▼────────────┐
          │  Next.js App (web)      │
          │  - Middleware detects   │
          │    host (www vs app)    │
          │  - Routes accordingly   │
          └─────────────────────────┘
```

---

## Prerequisites

- ✅ Cloudflare account with `proovra.com` zone active
- ✅ Vercel account with project created
- ✅ Access to domain registrar (if not using Cloudflare nameservers)
- ✅ Admin access to both Cloudflare and Vercel

---

## STEP 1: Cloudflare Configuration

### 1.1 Check Nameservers (One-time setup)

If `proovra.com` is not yet on Cloudflare:

1. **In Cloudflare:**
   - Create a Cloudflare account or log in
   - Add `proovra.com` site
   - Copy the 2 Cloudflare nameservers shown

2. **At Your Domain Registrar:**
   - Update nameservers to Cloudflare's
   - Wait 24–48 hours for propagation

**Verification:**
```bash
nslookup -type=NS proovra.com
```
Should return Cloudflare nameservers.

### 1.2 Configure DNS Records (Critical)

In Cloudflare DNS, ensure you have:

| Type | Name | Content | Proxy | TTL |
|------|------|---------|-------|-----|
| **A** | `www.proovra.com` | `<Vercel IP>` | **Proxied** 🟠 | Auto |
| **A** | `app.proovra.com` | `<Vercel IP>` | **Proxied** 🟠 | Auto |
| **A** | `api.proovra.com` | `<API IP>` | **Proxied** 🟠 | Auto |
| **CNAME** | `@` (root) | `www.proovra.com` | **DNS only** ⚪ | Auto |

**Important Notes:**
- `www` and `app` must be **"Proxied"** (orange cloud 🟠), not "DNS only" (grey cloud ⚪)
- **Do NOT proxy the root domain** (`proovra.com` `@` record) through Cloudflare to www; use DNS redirect rule instead
- Proxying means Cloudflare caches, applies WAF, and terminates SSL

**Vercel IP Address:**
- Check in Vercel Dashboard: Settings → Custom Domains
- Typically `76.76.19.132` or similar (check your project)
- Or use CNAME approach (see below)

**Alternative: CNAME Approach** (Simpler)
Instead of A record, use:

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| **CNAME** | `www` | `cname.vercel-dns.com` | Proxied 🟠 |
| **CNAME** | `app` | `cname.vercel-dns.com` | Proxied 🟠 |

(Get exact CNAME from Vercel domain setup UI)

### 1.3 Configure SSL/TLS Mode (Critical)

In Cloudflare:

1. **Navigate to:** SSL/TLS → Overview
2. **Select:** **"Full"** (not "Full (strict)")

**Why Not "Full (Strict)"?**
- "Full (Strict)" requires a valid certificate on Vercel's origin
- Vercel's certificate is for `*.vercel.app`, not `proovra.com`
- This mismatch causes TLS handshake failures
- **"Full"** allows self-signed or mismatched certs from origin

**Recommended Setting:**
```
SSL/TLS Mode: Full
```

### 1.4 Configure Minimum TLS Version

In Cloudflare:

1. **Navigate to:** SSL/TLS → Edge Certificates
2. **Minimum TLS Version:** `TLS 1.2` (or `1.3` if available)
3. **Enable:** Automatic HTTPS Rewrites (optional but recommended)

### 1.5 Configure Page Rules / Rules (Optional)

In Cloudflare:

1. **For root domain redirect:** Create a forwarding rule
   - **If hostname equals** `proovra.com`
   - **Then forward to** `https://www.proovra.com` (301 permanent)

2. **For caching (optional):**
   - Set appropriate Cache Level for assets
   - Usually "Cache Everything" for `/`, "Standard" for API calls

### 1.6 Verify DNS Propagation

Wait 5–15 minutes, then test:

```bash
# Check A records
nslookup www.proovra.com
nslookup app.proovra.com

# Check if Cloudflare is proxying
# (should show Cloudflare IP, not Vercel IP)
dig www.proovra.com

# Test SSL handshake
openssl s_client -connect www.proovra.com:443 -servername www.proovra.com
openssl s_client -connect app.proovra.com:443 -servername app.proovra.com
```

---

## STEP 2: Vercel Configuration

### 2.1 Add Custom Domains in Vercel

1. **In Vercel Dashboard:**
   - Select your Next.js project (proovra-web)
   - Navigate to: Settings → Domains

2. **Add Domain #1: `www.proovra.com`**
   - Enter `www.proovra.com`
   - Click "Add"
   - Vercel will ask for DNS record
   - If using Cloudflare: **Skip verification** (Cloudflare is already proxying)

3. **Add Domain #2: `app.proovra.com`**
   - Enter `app.proovra.com`
   - Click "Add"
   - Same: **Skip verification** (Cloudflare is already proxying)

### 2.2 Verify Domain Status in Vercel

Both domains should show:
- ✅ **Valid Configuration**
- ✅ **SSL Certificate (auto-provisioned by Vercel)**

If showing **"Invalid"** or **"Pending"**:
- Wait 5–10 minutes for Vercel to issue certificate
- Check DNS is pointing correctly (use `nslookup` above)

### 2.3 Set Environment Variables

In Vercel (Settings → Environment Variables), add:

```env
NEXT_PUBLIC_API_BASE=https://api.proovra.com
NEXT_PUBLIC_WEB_BASE=https://www.proovra.com
NEXT_PUBLIC_APP_BASE=https://app.proovra.com
NEXT_PUBLIC_GOOGLE_CLIENT_ID=<your-google-client-id>
NEXT_PUBLIC_GOOGLE_REDIRECT_URI=https://www.proovra.com/auth/callback
NEXT_PUBLIC_APPLE_CLIENT_ID=com.proovra.web
NEXT_PUBLIC_APPLE_REDIRECT_URI=https://www.proovra.com/auth/callback
```

**Important:**
- Set for **Production** and **Preview** environments
- Rebuilding after env var changes: Redeploy the project

### 2.4 Redeploy Project

1. In Vercel: Deployments → Select latest deployment → Click three dots → "Redeploy"
2. Wait for build to complete (2–5 minutes)
3. Test both URLs:
   - `https://www.proovra.com` → should load marketing site
   - `https://app.proovra.com` → should load app shell (redirect to `/home`)

---

## STEP 3: Next.js Middleware Verification

The Next.js middleware (in [apps/web/middleware.ts](../../apps/web/middleware.ts)) handles routing between www and app domains.

**What it does:**
1. Detects request host (`www.proovra.com` vs `app.proovra.com`)
2. For `app.proovra.com/` → redirects to `/home`
3. For `www.proovra.com/home` (or other app routes) → redirects to `app.proovra.com/home`
4. Adds security headers (CSP, X-Frame-Options, etc.)

**To verify middleware is working:**

1. Visit `http://localhost:3000/home` on dev server
   - Should render home page (no redirect since localhost is not app.proovra.com)

2. On production:
   - Visit `https://app.proovra.com/` 
   - Browser URL should change to `https://app.proovra.com/home`
   - Page should load successfully

3. Visit `https://www.proovra.com/home`
   - Should redirect to `https://app.proovra.com/home`

**If middleware not working:**
- Check `NEXT_PUBLIC_APP_BASE` and `NEXT_PUBLIC_WEB_BASE` are set
- Middleware checks for exact env var values to enable routing
- Redeploy after changing env vars

---

## STEP 4: Test Checklist

### Local Testing (Before Production)

- [ ] `pnpm dev` in `apps/web` works without errors
- [ ] Middleware loads (no red error banner)
- [ ] Env var section in dev console shows values (if in dev mode)
- [ ] Can navigate between pages on `localhost:3000`

### Production Testing (After Deployment)

| Test | Expected Result | Pass? |
|------|-----------------|-------|
| **Visit www.proovra.com** | Marketing site loads, no SSL error | [ ] |
| **Visit app.proovra.com** | Redirects to app.proovra.com/home, loads | [ ] |
| **Visit app.proovra.com/** | Redirects to app.proovra.com/home | [ ] |
| **Visit www.proovra.com/home** | Redirects to app.proovra.com/home | [ ] |
| **Visit app.proovra.com/login** | Login page loads | [ ] |
| **Login with Google** | Redirects to app.proovra.com/auth/callback | [ ] |
| **Login with Apple** | Redirects to app.proovra.com/auth/callback | [ ] |
| **Check browser console** | No errors, CSP warnings are normal | [ ] |
| **Check Network tab** | All requests succeed (no 404/500) | [ ] |
| **openssl s_client** (see below) | TLS handshake succeeds | [ ] |

### SSL Verification Command

```bash
# Should complete without "Verify return code: 18 (self signed certificate)" error
openssl s_client -connect app.proovra.com:443 -servername app.proovra.com < /dev/null

# Expected output includes:
# - subject=CN = *.proovra.com
# - issuer=C = US, O = Let's Encrypt, CN = R3
# - Verify return code: 20 (certificate has expired) OR 0 (ok)
```

---

## STEP 5: Troubleshooting

### Issue: "SSL: CERTIFICATE_VERIFY_FAILED"

**Cause:** Cloudflare SSL/TLS mode is "Full (Strict)" but Vercel origin certificate doesn't match.

**Solution:**
1. In Cloudflare: SSL/TLS → Overview
2. Change from "Full (Strict)" to **"Full"**
3. Wait 5 minutes
4. Test: `openssl s_client -connect app.proovra.com:443`

### Issue: "Connection refused" or "ERR_CONNECTION_REFUSED"

**Cause:** DNS not pointing to Vercel, or Vercel doesn't have domain added.

**Solution:**
1. Verify DNS: `nslookup app.proovra.com`
   - Should resolve to Vercel IP or show Cloudflare IP
2. Check Vercel dashboard: Settings → Domains
   - Must have both `www.proovra.com` and `app.proovra.com`
   - Status should be ✅ **Valid**
3. If not valid, wait 10 minutes for certificate issuance

### Issue: "DNS resolution failed"

**Cause:** DNS record not pointing correctly.

**Solution:**
1. In Cloudflare: DNS → Records
   - Verify `www` and `app` A/CNAME records exist
   - Verify they're set to **Proxied** (orange 🟠)
2. Run: `nslookup www.proovra.com`
3. If using CNAME, verify it matches Vercel's provided CNAME

### Issue: "Chrome/Firefox shows 'Your connection is not private'"

**Cause:** Browser sees certificate mismatch (likely due to Cloudflare "Full Strict" mode).

**Solution:**
1. Change Cloudflare to "Full" mode (see STEP 2.3)
2. Clear browser cache and cookies
3. Try in private/incognito mode
4. If still seeing error: Check certificate with `openssl` command above

### Issue: OAuth redirects to wrong domain (e.g., www instead of app)

**Cause:** Environment variables for OAuth redirect URIs not set correctly.

**Solution:**
1. Verify Vercel environment variables:
   - `NEXT_PUBLIC_GOOGLE_REDIRECT_URI=https://www.proovra.com/auth/callback`
   - `NEXT_PUBLIC_APPLE_REDIRECT_URI=https://www.proovra.com/auth/callback`
2. In Google Console: Authorized redirect URIs must include both:
   - `https://www.proovra.com/auth/callback`
   - `https://app.proovra.com/auth/callback`
3. In Apple Developer: Return URLs must include both domains
4. Redeploy Vercel after updating env vars

---

## STEP 6: DNS Propagation Monitoring

Use this to monitor when changes take effect:

```bash
# Watch DNS propagation
# Option 1: Direct nslookup (repeat every 5 min)
watch -n 300 'nslookup www.proovra.com'

# Option 2: Use online tool
# https://www.whatsmydns.net/ (enter www.proovra.com)

# Option 3: Check multiple DNS servers
nslookup www.proovra.com 8.8.8.8           # Google
nslookup www.proovra.com 1.1.1.1           # Cloudflare
nslookup www.proovra.com 208.67.222.222    # OpenDNS
```

Typical timeline:
- **5–15 minutes:** Cloudflare nameservers update
- **15–60 minutes:** Recursive DNS servers cache new records
- **Up to 48 hours:** Full global propagation

---

## STEP 7: Security Best Practices

### Cloudflare Security

1. **WAF Rules:** Enable Cloudflare managed rulesets
2. **DDoS Protection:** Enabled by default (auto)
3. **Rate Limiting:** Configure for `/api/*` endpoints (optional)
4. **Bot Management:** Can reduce bot traffic (paid feature)

### Vercel Security

1. **Domains:** Always use HTTPS-only
2. **Environment Variables:** Mark sensitive ones as "Sensitive" in UI
3. **Team Roles:** Restrict domain access to specific team members
4. **Audit Log:** Check Settings → Audit Log for suspicious activity

### Application Security

1. **CSP Headers:** Already configured in middleware.ts
2. **CORS:** API should only accept requests from `www.proovra.com` and `app.proovra.com`
3. **OAuth Scopes:** Minimize requested permissions in Google/Apple configs

---

## STEP 8: Deployment Checklist

Before marking as "Ready for Production":

- [ ] Cloudflare nameservers active for proovra.com
- [ ] DNS records created (www, app, api)
- [ ] All records set to **Proxied** 🟠
- [ ] Cloudflare SSL/TLS mode: **Full** (not Strict)
- [ ] Vercel domains: www.proovra.com and app.proovra.com added
- [ ] Vercel domains show ✅ **Valid Configuration**
- [ ] Environment variables set in Vercel
- [ ] Redeploy triggered after env var changes
- [ ] SSL certificate issued by Vercel (check in Settings → Domains)
- [ ] All test cases from STEP 4 passing
- [ ] `openssl s_client` TLS handshake succeeds
- [ ] OAuth redirect URIs updated in Google Console and Apple Developer
- [ ] Load testing completed (optional)
- [ ] Monitoring/alerting configured (optional)

---

## Monitoring & Maintenance

### Regular Checks

1. **Weekly:**
   - Spot-check both domains in browser
   - Review Vercel deployment logs
   - Check Cloudflare analytics

2. **Monthly:**
   - Review SSL certificate expiry (Vercel auto-renews)
   - Check Cloudflare WAF block logs
   - Audit DNS records for changes

3. **Quarterly:**
   - Run full test suite (STEP 4)
   - Review security settings
   - Update documentation if needed

### Alerts to Configure

- Vercel: Deployment failures
- Cloudflare: SSL certificate issues, suspicious traffic spikes
- Sentry: JS errors (already integrated in code)

---

## FAQ

**Q: Can I host www and app on different servers?**
A: Not recommended. Middleware assumes same build. Use subfolders or separate Vercel projects if needed.

**Q: What if I want to use a different domain for api?**
A: Update `NEXT_PUBLIC_API_BASE` in Vercel. Add api domain to Cloudflare and Vercel. Same process as www/app.

**Q: How long does DNS propagation take?**
A: Typically 5–15 minutes with Cloudflare. Cache TTL is 3600 seconds (1 hour) for standard records.

**Q: Can I use Cloudflare's "Flexible" SSL mode?**
A: Not recommended. Flexible sends unencrypted traffic from Cloudflare to origin. Use **Full** mode instead.

**Q: Why does the certificate show `*.vercel.app`?**
A: Vercel issues wildcard certs for `*.vercel.app`. Cloudflare's "Full" mode accepts this. For custom certs, use Vercel SSL certificate feature (Enterprise plan).

**Q: What if Cloudflare is blocking my site?**
A: Check Cloudflare: Firewall Rules → Block Rules. Adjust sensitivity or whitelist your IP.

---

## Support

For issues not covered here:

- **Cloudflare:** https://support.cloudflare.com
- **Vercel:** https://vercel.com/support
- **Let's Encrypt (SSL certs):** https://letsencrypt.org/support/
- **This Project:** support@proovra.com

---

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | Feb 10, 2026 | Initial guide: Cloudflare + Vercel setup for app.proovra.com |

