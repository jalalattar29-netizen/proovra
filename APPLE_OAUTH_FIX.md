# FIX: Apple OAuth Invalid Redirect URI Error

## Problem Found
```
Error: invalid_request - Invalid web redirect url
Caused by: Apple OAuth rejecting http://localhost:3000/auth/callback
Reason: This URL is not registered in Apple Developer Console
```

## Current Status
- ✅ Web env `.env.local` is correct: `NEXT_PUBLIC_APPLE_REDIRECT_URI=http://localhost:3000/auth/callback`
- ❌ Apple Developer Console only has: `https://www.proovra.com/auth/callback` registered
- ❌ Cannot test with localhost without adding it to Apple Developer Console

## Solution Options

### Option A: Use Hosts File Mapping (Recommended for Dev Testing)

**Steps**:
1. Open Notepad as Administrator
2. Go to: `C:\Windows\System32\drivers\etc\hosts`
3. Add these lines at the end:
   ```
   127.0.0.1 www.proovra.com
   127.0.0.1 app.proovra.com
   127.0.0.1 api.proovra.com
   ```
4. Save the file
5. Restart browser and test with: https://www.proovra.com:3000/login
6. Apple will accept because domain is registered, but traffic routes to localhost

**Verification**:
```bash
ping www.proovra.com  # Should resolve to 127.0.0.1
```

### Option B: Register localhost in Apple Developer Console (Proper Way)

**Steps**:
1. Go to: https://developer.apple.com/account
2. Navigate to: Certificates, Identifiers & Profiles → Identifiers
3. Select: com.proovra.web (your Apple ID app)
4. In "Configure" tab, under "Web Configuration":
   - Add Registered Web Domains: `localhost`
   - Add Return URLs:
     - `http://localhost:3000/auth/callback`
     - `http://localhost:8081/auth/callback` (if needed)
5. Save and wait for changes to propagate (can take 5-15 minutes)
6. Test with: http://localhost:3000/login

**Pros**: Clean, official way
**Cons**: Requires Apple Developer account access, propagation delay

---

## Recommended: Use Option A (Hosts File)

This lets you test immediately using the production-registered domain while keeping everything local.

### MANUAL STEPS TO ADD HOSTS:

1. **Open Notepad as Administrator**:
   - Click Start menu
   - Type "Notepad"
   - Right-click "Notepad" → "Run as administrator"

2. **Open hosts file**:
   - File → Open
   - Path: `C:\Windows\System32\drivers\etc\hosts`
   - Select "All Files" in file type filter

3. **Add these lines at the very end** (new line):
   ```
   127.0.0.1 www.proovra.com
   127.0.0.1 app.proovra.com
   127.0.0.1 api.proovra.com
   ```

4. **Save** (Ctrl+S)

5. **Verify** in PowerShell:
   ```powershell
   ping www.proovra.com
   # Should show: Reply from 127.0.0.1
   ```

6. **Clear browser DNS cache** (Chrome):
   - Go to: chrome://net-internals/#dns
   - Click "Clear host cache"

7. **Test Apple OAuth again**:
   - Open: https://www.proovra.com:3000/login (or http://www.proovra.com:3000 then navigate to /login)
   - Click "Sign in with Apple"
   - Should now accept (Apple sees registered domain, traffic routes to localhost)

---

## TC1 Retry Plan

After hosts file mapping is done:

1. ✅ API running on http://localhost:8081 
2. ✅ Web dev server running on http://localhost:3000
3. ✅ Hosts file: www.proovra.com → 127.0.0.1
4. ✅ Next.js env: NEXT_PUBLIC_APPLE_REDIRECT_URI=http://localhost:3000/auth/callback (but wait, this won't work with hosts mapping!)

**WAIT**: If we use hosts file, we need to update .env.local to use https://www.proovra.com:3000/auth/callback instead!

Actually, let me reconsider. The better approach:

### Revised Solution: Update .env.local for Hosts Mapping

Since we'll use hosts file to map www.proovra.com to 127.0.0.1, we need to adjust:

1. Next.js dev server still runs on 3000
2. But we access it via https://www.proovra.com:3000
3. OAuth redirect needs to point to: https://www.proovra.com:3000/auth/callback
4. This matches Apple's registered: https://www.proovra.com/auth/callback (domain matches, Apple doesn't care about :3000 port in domain validation typically)

Actually, that's wrong. Apple registers the FULL URL including port.

**Cleaner approach**: Keep localhost for web dev, use production OAuth only for production deployment.

For local testing: **Skip Apple OAuth, mock it**, OR **add localhost to Apple Developer Console**.

The quickest path forward:

