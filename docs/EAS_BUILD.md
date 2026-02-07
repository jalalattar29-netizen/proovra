# EAS Build (Proovra Mobile)

## App IDs
- iOS bundle identifier: `com.proovra.app`
- Android applicationId: `com.proovra.app`

## Environment
Set these before builds:
- `EXPO_PUBLIC_API_BASE=https://api.proovra.com`
- `EXPO_PUBLIC_WEB_BASE=https://www.proovra.com`

## Build Steps (summary)
1. `cd apps/mobile`
2. `pnpm install`
3. `eas build --platform ios`
4. `eas build --platform android`

## Store checklist
- Update release notes
- Verify onboarding + auth flows
- Verify capture + upload + report flow
- Verify legal acceptance gating
