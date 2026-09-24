# /settings

**PWA entry:** `apps/web/app/(app)/settings/page.tsx`
**Native entry:** `apps/mobile/app/(tabs)/settings.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 35 | 2 |
| Elements | 1068 | 100 |
| Interactive elements | 152 | 38 |
| Conditionally-rendered elements | 592 | 24 |
| Style rules resolved | 652 (2480 props) | 80 (95 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/settings/page.tsx` | 26 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/ui/PageShell.tsx` | 15 | `PageShell,PageHeader` |
| 1 | `apps/web/app/(app)/settings/_sections/SettingsNav.tsx` | 15 | `SettingsNav` |
| 2 | `apps/web/components/app-primitives/AppListbox.tsx` | 15 | `AppListbox` |
| 3 | `apps/web/components/app-primitives/AppAnchoredOverlay.tsx` | 1 | `AppAnchoredOverlay` |
| 1 | `apps/web/app/(app)/settings/_sections/SettingsOverview.tsx` | 53 | `SettingsOverview` |
| 2 | `apps/web/app/(app)/settings/_sections/OverviewSection.tsx` | 28 | `OverviewSection` |
| 3 | `apps/web/components/ui-legacy.tsx` | 27 | `Input` |
| 4 | `apps/web/components/feedback/ProovraToast.tsx` | 13 | `ProovraToast` |
| 5 | `apps/web/components/feedback/severity.tsx` | 13 | `FeedbackIcon` |
| 3 | `apps/web/components/ui/Button.tsx` | 5 | `Button` |
| 3 | `apps/web/components/ui/Badge.tsx` | 2 | `Badge` |
| 2 | `apps/web/app/(app)/settings/_sections/PreferencesSection.tsx` | 17 | `PreferencesSection` |
| 1 | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx` | 156 | `PersonalSecuritySections` |
| 2 | `apps/web/components/ui/Card.tsx` | 11 | `Card` |
| 2 | `apps/web/components/app-primitives/AppStatusText.tsx` | 1 | `AppStatusText` |
| 2 | `apps/web/components/ui/EmptyState.tsx` | 15 | `EmptyState` |
| 2 | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx` | 56 | `ContactFactorEnrollmentPanel` |
| 1 | `apps/web/app/(app)/settings/_sections/NotificationsSection.tsx` | 5 | `NotificationsSection` |
| 2 | `apps/web/components/notifications/NotificationPreferencesPanel.tsx` | 107 | `NotificationPreferencesPanel,NotificationScheduleCard` |
| 2 | `apps/web/components/notifications/ContactChannelVerificationCard.tsx` | 48 | `ContactChannelVerificationCard` |
| 1 | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx` | 100 | `PrivacySection` |
| 2 | `apps/web/app/(app)/settings/_sections/LegalAcceptanceStatusCard.tsx` | 26 | `LegalAcceptanceStatusCard` |
| 1 | `apps/web/app/(app)/settings/_sections/AiSection.tsx` | 109 | `AiSection` |
| 2 | `apps/web/app/(app)/settings/_sections/AiReadOnlyView.tsx` | 36 | `AiReadOnlyView` |
| 2 | `apps/web/app/(app)/settings/_sections/AiStatusRow.tsx` | 7 | `AiStatusRow` |
| 2 | `apps/web/lib/platform-context/WorkspaceContextBanner.tsx` | 5 | `WorkspaceContextBanner` |
| 2 | `apps/web/components/ai-copilot/AiCapabilityStatusTable.tsx` | 34 | `AiCapabilityStatusTable` |
| 1 | `apps/web/app/(app)/settings/_sections/RolesSection.tsx` | 45 | `RolesSection` |
| 1 | `apps/web/app/(app)/settings/_sections/BillingSection.tsx` | 15 | `BillingSection` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(tabs)/settings.tsx` | 58 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraShell,ProovraSection,ProovraCard,ProovraText,ProovraFormField,ProovraInput,ProovraButton,ProovraListRow` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 6 | 2 | -4 |
| BUTTON | 72 | 9 | -63 |
| CARD | 26 | 6 | -20 |
| CONTAINER | 297 | 26 | -271 |
| FORM | 6 | 0 | -6 |
| HEADING | 34 | 0 | -34 |
| ICON | 62 | 0 | -62 |
| IMAGE | 1 | 0 | -1 |
| INPUT | 31 | 4 | -27 |
| LINK | 19 | 0 | -19 |
| LIST | 100 | 24 | -76 |
| OTHER | 81 | 2 | -79 |
| STATE_EMPTY | 2 | 0 | -2 |
| STATE_ERROR | 3 | 0 | -3 |
| STATE_LOADING | 1 | 2 | 1 |
| TEXT | 327 | 25 | -302 |

### C.1 Paired (5)

| Role | Label | PWA | Native |
|---|---|---|---|
| INPUT | Display name | `apps/web/app/(app)/settings/_sections/OverviewSection.tsx:230` | `apps/mobile/app/(tabs)/settings.tsx:107` |
| BUTTON | Save | `apps/web/app/(app)/settings/_sections/OverviewSection.tsx:253` | `apps/mobile/app/(tabs)/settings.tsx:111` |
| BUTTON | Cancel | `apps/web/app/(app)/settings/_sections/OverviewSection.tsx:264` | `apps/mobile/app/(tabs)/settings.tsx:112` |
| BUTTON | Sign out | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1773` | `apps/mobile/app/(tabs)/settings.tsx:298` |
| BUTTON | Try again | `apps/web/app/(app)/settings/_sections/RolesSection.tsx:189` | `apps/mobile/src/ui/index.tsx:531` |


### C.2 MISSING in Native (127)

| Role | Label | PWA source |
|---|---|---|
| LINK | Identity &amp; Security | `apps/web/app/(app)/settings/page.tsx:255` |
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| BUTTON | ariaLabel | `apps/web/components/app-primitives/AppListbox.tsx:216` |
| HEADING | Overview | `apps/web/app/(app)/settings/_sections/SettingsOverview.tsx:161` |
| CARD | Workspace | `apps/web/app/(app)/settings/_sections/SettingsOverview.tsx:214` |
| BUTTON | Manage members | `apps/web/app/(app)/settings/_sections/SettingsOverview.tsx:261` |
| LINK | Manage workspace access | `apps/web/app/(app)/settings/_sections/SettingsOverview.tsx:270` |
| CARD | Plan | `apps/web/app/(app)/settings/_sections/SettingsOverview.tsx:281` |
| LINK | View billing | `apps/web/app/(app)/settings/_sections/SettingsOverview.tsx:289` |
| CARD | Security | `apps/web/app/(app)/settings/_sections/SettingsOverview.tsx:300` |
| BUTTON | Review security | `apps/web/app/(app)/settings/_sections/SettingsOverview.tsx:306` |
| HEADING | Preferences | `apps/web/app/(app)/settings/_sections/SettingsOverview.tsx:384` |
| BUTTON | Edit profile | `apps/web/app/(app)/settings/_sections/OverviewSection.tsx:206` |
| BADGE | {security.mfaConfigured ? "Enabled" : "Not configured"} | `apps/web/app/(app)/settings/_sections/OverviewSection.tsx:297` |
| INPUT | {error && <div className="input-error">{error}</div>} | `apps/web/components/ui-legacy.tsx:293` |
| BUTTON | Dismiss notification | `apps/web/components/feedback/ProovraToast.tsx:119` |
| HEADING | Language | `apps/web/app/(app)/settings/_sections/PreferencesSection.tsx:161` |
| HEADING | Account timezone | `apps/web/app/(app)/settings/_sections/PreferencesSection.tsx:196` |
| BUTTON | Use my current timezone | `apps/web/app/(app)/settings/_sections/PreferencesSection.tsx:220` |
| BUTTON | {busy ? "Saving…" : "Save preferences"} | `apps/web/app/(app)/settings/_sections/PreferencesSection.tsx:277` |
| HEADING | Change password | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:419` |
| INPUT | Current password | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:433` |
| INPUT | New password | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:445` |
| INPUT | Confirm new password | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:457` |
| INPUT | Sign out my other sessions after the change | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:477` |
| BUTTON | Change password | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:490` |
| BUTTON | Verify &amp; continue | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:621` |
| BUTTON | Cancel | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:632` |
| BUTTON | Close | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:646` |
| HEADING | Sign-in methods | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:921` |
| BUTTON | Add password | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:977` |
| BUTTON | Connect | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:986` |
| BUTTON | Disconnect | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1004` |
| INPUT | New password (12+ chars, upper- and lower-case, a number) | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1032` |
| BUTTON | {busy ? "Adding…" : "Add password"} | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1043` |
| HEADING | Two-factor authentication | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1333` |
| BUTTON | {busy ? "Starting…" : "Set up two-factor authentication"} | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1348` |
| BADGE | Active | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1386` |
| BUTTON | Remove | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1390` |
| BUTTON | Regenerate recovery codes | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1403` |
| INPUT | 6-digit code from your app | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1469` |
| BUTTON | Verify &amp; enable | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1485` |
| BUTTON | Cancel | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1500` |
| INPUT | I saved these recovery codes in a safe place. | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1553` |
| BUTTON | Done | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1562` |
| BADGE | Current session | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1759` |
| BADGE | Restricted | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1764` |
| HEADING | Your active sessions | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1822` |
| BUTTON | Sign out other sessions | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1828` |
| STATE_EMPTY | Session inventory unavailable | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1848` |
| HEADING | Account &amp; security activity | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1996` |
| STATE_EMPTY | No security events in the recent window | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:2008` |
| BUTTON | View more ( {rows.length - visibleCount} older) | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:2090` |
| HEADING | Verified contact device | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:601` |
| BUTTON | {revokingId === f.factorId ? "Revoking…" : "Revoke"} | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:655` |
| BUTTON | Replace this device | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:675` |
| INPUT | Work handset | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:783` |
| BUTTON | Cancel | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:809` |
| BUTTON | Start over | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:938` |
| INPUT | `${TYPE_LABEL[type]} — ${channel === "IN_APP" ? "in-app" : "email"}` | `apps/web/components/notifications/NotificationPreferencesPanel.tsx:489` |
| INPUT | `${TYPE_LABEL[cat]} mandatory in-app` | `apps/web/components/notifications/NotificationPreferencesPanel.tsx:665` |
| INPUT | `${TYPE_LABEL[cat]} mandatory email` | `apps/web/components/notifications/NotificationPreferencesPanel.tsx:674` |
| BUTTON | Save schedule | `apps/web/components/notifications/NotificationPreferencesPanel.tsx:846` |
| INPUT | notification-timezone-mode | `apps/web/components/notifications/NotificationPreferencesPanel.tsx:896` |
| INPUT | notification-timezone-mode | `apps/web/components/notifications/NotificationPreferencesPanel.tsx:912` |
| INPUT | Enable quiet hours | `apps/web/components/notifications/NotificationPreferencesPanel.tsx:967` |
| INPUT | Quiet hours start | `apps/web/components/notifications/NotificationPreferencesPanel.tsx:983` |
| INPUT | Quiet hours end | `apps/web/components/notifications/NotificationPreferencesPanel.tsx:996` |
| INPUT | Allow critical notifications during quiet hours | `apps/web/components/notifications/NotificationPreferencesPanel.tsx:1011` |
| HEADING | Message a contact | `apps/web/components/notifications/ContactChannelVerificationCard.tsx:325` |
| HEADING | Messaging contact | `apps/web/components/notifications/ContactChannelVerificationCard.tsx:349` |
| INPUT | +44 7700 900000 | `apps/web/components/notifications/ContactChannelVerificationCard.tsx:406` |
| BUTTON | Start over | `apps/web/components/notifications/ContactChannelVerificationCard.tsx:449` |
| BUTTON | {busy === "CHECK" ? "Checking…" : "Confirm code"} | `apps/web/components/notifications/ContactChannelVerificationCard.tsx:485` |
| BUTTON | Use a different number | `apps/web/components/notifications/ContactChannelVerificationCard.tsx:495` |
| BUTTON | {busy === "SAVE_IN" ? "Saving…" : "Allow messages"} | `apps/web/components/notifications/ContactChannelVerificationCard.tsx:525` |
| BUTTON | {busy === "SAVE_OUT" ? "Saving…" : "Do not message"} | `apps/web/components/notifications/ContactChannelVerificationCard.tsx:535` |
| BUTTON | Add another number | `apps/web/components/notifications/ContactChannelVerificationCard.tsx:544` |
| HEADING | Your data | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:254` |
| BUTTON | Download | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:300` |
| BUTTON | {busy ? "Requesting…" : "Request data export"} | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:317` |
| HEADING | Close account | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:554` |
| BUTTON | Cancel closure request | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:597` |
| BUTTON | Close my account… | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:648` |
| BUTTON | Close my account… | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:664` |
| BUTTON | Request account closure | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:692` |
| BUTTON | Keep my account | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:710` |
| BUTTON | View {acceptances.length - FIRST} more | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:842` |
| HEADING | Privacy preferences | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:925` |
| BUTTON | {cookieBusy ? "Opening…" : "Manage cookie preferences"} | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:966` |
| HEADING | Policies &amp; consent | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:981` |
| HEADING | Privacy actions &amp; references | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:1002` |
| LINK | Submit a privacy request | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:1005` |
| LINK | Privacy Policy | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:1010` |
| LINK | Terms of Service | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:1013` |
| LINK | Cookie Policy | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:1016` |
| LINK | Open public Trust Center | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:1022` |
| BUTTON | Check again | `apps/web/app/(app)/settings/_sections/LegalAcceptanceStatusCard.tsx:158` |
| LINK | Read the {labelFor(key)} → | `apps/web/app/(app)/settings/_sections/LegalAcceptanceStatusCard.tsx:193` |
| BUTTON | I have read and accept these | `apps/web/app/(app)/settings/_sections/LegalAcceptanceStatusCard.tsx:212` |
| BUTTON | See plans | `apps/web/app/(app)/settings/_sections/AiSection.tsx:326` |
| BUTTON | Reload latest | `apps/web/app/(app)/settings/_sections/AiSection.tsx:403` |
| HEADING | Monthly usage | `apps/web/app/(app)/settings/_sections/AiSection.tsx:418` |
| HEADING | AI assistance | `apps/web/app/(app)/settings/_sections/AiSection.tsx:505` |
| INPUT | !draft ? "Your AI settings are still loading." : undefined | `apps/web/app/(app)/settings/_sections/AiSection.tsx:515` |
| HEADING | Available features | `apps/web/app/(app)/settings/_sections/AiSection.tsx:538` |
| INPUT | draft && !draft.aiEnabled ? "Turn on AI assistance above to choose features." : undefined | `apps/web/app/(app)/settings/_sections/AiSection.tsx:553` |
| HEADING | How AI uses your data | `apps/web/app/(app)/settings/_sections/AiSection.tsx:583` |
| LINK | Review AI transparency and subprocessors → | `apps/web/app/(app)/settings/_sections/AiSection.tsx:594` |
| BUTTON | Save changes | `apps/web/app/(app)/settings/_sections/AiSection.tsx:610` |
| BUTTON | Reload latest | `apps/web/app/(app)/settings/_sections/AiSection.tsx:715` |
| HEADING | Master AI policy | `apps/web/app/(app)/settings/_sections/AiSection.tsx:730` |
| INPUT | AI capabilities may run in this workspace (per the policy                   below) | `apps/web/app/(app)/settings/_sections/AiSection.tsx:742` |
| BADGE | {draft.aiEnabled ? "Enabled" : "Disabled"} | `apps/web/app/(app)/settings/_sections/AiSection.tsx:756` |
| HEADING | Capabilities &amp; data classes | `apps/web/app/(app)/settings/_sections/AiSection.tsx:765` |
| INPUT | !draft.aiEnabled ? "Turn on AI assistance above to choose this." : undefined | `apps/web/app/(app)/settings/_sections/AiSection.tsx:779` |
| BADGE | {draft[key] ? "Enabled" : "Disabled"} | `apps/web/app/(app)/settings/_sections/AiSection.tsx:805` |
| BUTTON | Save AI policy | `apps/web/app/(app)/settings/_sections/AiSection.tsx:816` |
| HEADING | Usage &amp; governance | `apps/web/app/(app)/settings/_sections/AiSection.tsx:851` |
| LINK | Review AI transparency and subprocessors → | `apps/web/app/(app)/settings/_sections/AiSection.tsx:904` |
| LINK | View AI Use Policy → | `apps/web/app/(app)/settings/_sections/AiReadOnlyView.tsx:226` |
| HEADING | Live AI capability status (this workspace) | `apps/web/components/ai-copilot/AiCapabilityStatusTable.tsx:102` |
| BUTTON | {matrixOpen ? "Hide" : "View"} detailed permission matrix | `apps/web/app/(app)/settings/_sections/RolesSection.tsx:280` |
| BUTTON | Open Billing | `apps/web/app/(app)/settings/_sections/BillingSection.tsx:147` |

### C.3 EXTRA in Native (7)

| Role | Label | Native source |
|---|---|---|
| INPUT | Your name | `apps/mobile/app/(tabs)/settings.tsx:108` |
| BUTTON | Use device | `apps/mobile/app/(tabs)/settings.tsx:127` |
| BADGE | FULL_LOCALES.has(lng) ? lng.toUpperCase() : `${lng.toUpperCase()}·beta` | `apps/mobile/app/(tabs)/settings.tsx:138` |
| INPUT | Crash and reliability reports | `apps/mobile/app/(tabs)/settings.tsx:159` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |

### C.4 SOURCE-UNRESOLVED labels (38)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/app/(app)/settings/page.tsx:243` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/app/(app)/settings/page.tsx:290` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:130` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:247` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/settings/_sections/SettingsNav.tsx:76` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/settings/_sections/SettingsNav.tsx:94` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/settings/_sections/SettingsOverview.tsx:68` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/settings/_sections/SettingsOverview.tsx:338` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui-legacy.tsx:163` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui-legacy.tsx:209` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui-legacy.tsx:263` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui-legacy.tsx:266` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/ui-legacy.tsx:360` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraToast.tsx:100` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraToast.tsx:104` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Button.tsx:261` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:603` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:910` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1332` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1811` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1873` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/security-center/components/PersonalSecuritySections.tsx:1995` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ui/Card.tsx:250` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:719` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:740` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:796` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:856` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:901` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/identity-security/ContactFactorEnrollmentPanel.tsx:917` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/notifications/ContactChannelVerificationCard.tsx:425` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:579` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:624` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/settings/_sections/PrivacySection.tsx:789` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/settings/_sections/RolesSection.tsx:235` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/settings/_sections/RolesSection.tsx:299` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (652 rules, 2480 properties)

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell`

- `--set-panel`: **rgba(255, 255, 255, 0.62)**
- `--set-panel-solid`: **#ffffff**
- `--set-inset`: **rgba(16, 24, 40, 0.022)**
- `--set-line`: **rgba(16, 24, 40, 0.09)**
- `--set-line-strong`: **rgba(16, 24, 40, 0.15)**
- `--set-ink`: **#0F172A**  _(--ink-primary=#0F172A)_
- `--set-ink-2`: **#475467**
- `--set-muted`: **#667085**
- `--set-accent`: **#6D28D9**  _(--accent-600=#6D28D9)_
- `--set-accent-strong`: **#5b21b6**  _(--accent-700→(fallback) #5b21b6)_
- `--set-accent-soft`: **#F2ECFE**  _(--accent-050=#F2ECFE)_
- `--set-ok`: **#15803D**  _(--success-standard=#15803D)_
- `--set-ok-soft`: **rgba(21, 128, 61, 0.08)**
- `--set-warn`: **#EA580C**  _(--orange-500=#EA580C)_
- `--set-warn-soft`: **rgba(194, 65, 12, 0.09)**
- `--set-danger`: **#DC2626**  _(--error=#DC2626)_
- `--set-danger-soft`: **rgba(220, 38, 38, 0.07)**
- `--set-radius`: **14px**
- `--set-radius-sm`: **10px**
- `background`: **transparent**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .ui-card h2`

- `margin`: **0 0 4px !important**
- `font-size`: **1rem !important**
- `font-weight`: **720 !important**
- `letter-spacing`: **-0.005em !important**
- `text-transform`: **none !important**
- `color`: **var(--set-ink) !important**  ⚠ undeclared --set-ink

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .ui-card h3`

- `margin`: **0 0 4px !important**
- `font-size`: **1rem !important**
- `font-weight`: **720 !important**
- `letter-spacing`: **-0.005em !important**
- `text-transform`: **none !important**
- `color`: **var(--set-ink) !important**  ⚠ undeclared --set-ink

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .ops-panel__title`

- `margin`: **0 0 4px !important**
- `font-size`: **1rem !important**
- `font-weight`: **720 !important**
- `letter-spacing`: **-0.005em !important**
- `text-transform`: **none !important**
- `color`: **var(--set-ink) !important**  ⚠ undeclared --set-ink

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .ui-card > p`

- `margin`: **0 0 2px**
- `max-width`: **84ch**
- `font-size`: **0.86rem !important**
- `line-height`: **1.55 !important**
- `color`: **var(--set-ink-2) !important**  ⚠ undeclared --set-ink-2

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .ops-panel > p`

- `margin`: **0 0 2px**
- `max-width`: **84ch**
- `font-size`: **0.86rem !important**
- `line-height`: **1.55 !important**
- `color`: **var(--set-ink-2) !important**  ⚠ undeclared --set-ink-2

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .ops-muted`

- `margin`: **0 0 2px**
- `max-width`: **84ch**
- `font-size`: **0.86rem !important**
- `line-height`: **1.55 !important**
- `color`: **var(--set-ink-2) !important**  ⚠ undeclared --set-ink-2

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .ui-card`

- `display`: **block**
- `padding`: **22px !important**
- `border`: **1px solid var(--set-line) !important**  ⚠ undeclared --set-line
- `border-radius`: **var(--set-radius) !important**  ⚠ undeclared --set-radius
- `background`: **var(--set-panel) !important**  ⚠ undeclared --set-panel
- `box-shadow`: **none !important**
- `margin-bottom`: **0 !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .ops-panel`

- `display`: **block**
- `padding`: **22px !important**
- `border`: **1px solid var(--set-line) !important**  ⚠ undeclared --set-line
- `border-radius`: **var(--set-radius) !important**  ⚠ undeclared --set-radius
- `background`: **var(--set-panel) !important**  ⚠ undeclared --set-panel
- `box-shadow`: **none !important**
- `margin-bottom`: **0 !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .ui-card + .ui-card`

- `margin-top`: **22px !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .ops-panel + .ops-panel`

- `margin-top`: **22px !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .ui-card [style*="background: #f8fafc"]`

- `background`: **transparent !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .ui-card [style*="background:#f8fafc"]`

- `background`: **transparent !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .ui-card [style*="background: #f1f5f9"]`

- `background`: **transparent !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main [style*="rgb(241`

- `background`: **transparent !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .ops-panel > div[style*="background"]`

- `background`: **transparent !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .ui-badge`

- `padding`: **0 !important**
- `border`: **0 !important**
- `border-radius`: **0 !important**
- `background`: **transparent !important**
- `font-weight`: **680 !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main [class*="badge"]`

- `padding`: **0 !important**
- `border`: **0 !important**
- `border-radius`: **0 !important**
- `background`: **transparent !important**
- `font-weight`: **680 !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main input[type="text"]`

- `inline-size`: **100%**
- `min-height`: **42px !important**
- `padding`: **0 14px !important**
- `border`: **1px solid var(--set-line-strong) !important**  ⚠ undeclared --set-line-strong
- `border-radius`: **var(--set-radius-sm) !important**  ⚠ undeclared --set-radius-sm
- `background-color`: **var(--set-panel-solid) !important**  ⚠ undeclared --set-panel-solid
- `color`: **var(--set-ink) !important**  ⚠ undeclared --set-ink
- `font-size`: **0.9rem !important**
- `font-family`: **inherit !important**
- `box-shadow`: **none !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main input[type="email"]`

- `inline-size`: **100%**
- `min-height`: **42px !important**
- `padding`: **0 14px !important**
- `border`: **1px solid var(--set-line-strong) !important**  ⚠ undeclared --set-line-strong
- `border-radius`: **var(--set-radius-sm) !important**  ⚠ undeclared --set-radius-sm
- `background-color`: **var(--set-panel-solid) !important**  ⚠ undeclared --set-panel-solid
- `color`: **var(--set-ink) !important**  ⚠ undeclared --set-ink
- `font-size`: **0.9rem !important**
- `font-family`: **inherit !important**
- `box-shadow`: **none !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main input[type="tel"]`

- `inline-size`: **100%**
- `min-height`: **42px !important**
- `padding`: **0 14px !important**
- `border`: **1px solid var(--set-line-strong) !important**  ⚠ undeclared --set-line-strong
- `border-radius`: **var(--set-radius-sm) !important**  ⚠ undeclared --set-radius-sm
- `background-color`: **var(--set-panel-solid) !important**  ⚠ undeclared --set-panel-solid
- `color`: **var(--set-ink) !important**  ⚠ undeclared --set-ink
- `font-size`: **0.9rem !important**
- `font-family`: **inherit !important**
- `box-shadow`: **none !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main input[type="password"]`

- `inline-size`: **100%**
- `min-height`: **42px !important**
- `padding`: **0 14px !important**
- `border`: **1px solid var(--set-line-strong) !important**  ⚠ undeclared --set-line-strong
- `border-radius`: **var(--set-radius-sm) !important**  ⚠ undeclared --set-radius-sm
- `background-color`: **var(--set-panel-solid) !important**  ⚠ undeclared --set-panel-solid
- `color`: **var(--set-ink) !important**  ⚠ undeclared --set-ink
- `font-size`: **0.9rem !important**
- `font-family`: **inherit !important**
- `box-shadow`: **none !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main input[type="number"]`

- `inline-size`: **100%**
- `min-height`: **42px !important**
- `padding`: **0 14px !important**
- `border`: **1px solid var(--set-line-strong) !important**  ⚠ undeclared --set-line-strong
- `border-radius`: **var(--set-radius-sm) !important**  ⚠ undeclared --set-radius-sm
- `background-color`: **var(--set-panel-solid) !important**  ⚠ undeclared --set-panel-solid
- `color`: **var(--set-ink) !important**  ⚠ undeclared --set-ink
- `font-size`: **0.9rem !important**
- `font-family`: **inherit !important**
- `box-shadow`: **none !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main input[type="time"]`

- `inline-size`: **100%**
- `min-height`: **42px !important**
- `padding`: **0 14px !important**
- `border`: **1px solid var(--set-line-strong) !important**  ⚠ undeclared --set-line-strong
- `border-radius`: **var(--set-radius-sm) !important**  ⚠ undeclared --set-radius-sm
- `background-color`: **var(--set-panel-solid) !important**  ⚠ undeclared --set-panel-solid
- `color`: **var(--set-ink) !important**  ⚠ undeclared --set-ink
- `font-size`: **0.9rem !important**
- `font-family`: **inherit !important**
- `box-shadow`: **none !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main textarea`

- `inline-size`: **100%**
- `min-height`: **42px !important**
- `padding`: **0 14px !important**
- `border`: **1px solid var(--set-line-strong) !important**  ⚠ undeclared --set-line-strong
- `border-radius`: **var(--set-radius-sm) !important**  ⚠ undeclared --set-radius-sm
- `background-color`: **var(--set-panel-solid) !important**  ⚠ undeclared --set-panel-solid
- `color`: **var(--set-ink) !important**  ⚠ undeclared --set-ink
- `font-size`: **0.9rem !important**
- `font-family`: **inherit !important**
- `box-shadow`: **none !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main input::placeholder`

- `color`: **var(--set-muted)**  ⚠ undeclared --set-muted

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main textarea::placeholder`

- `color`: **var(--set-muted)**  ⚠ undeclared --set-muted

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main input:hover:not(:disabled)`

- `border-color`: **rgba(109, 40, 217, 0.34) !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main input:focus-visible`

- `outline`: **none !important**
- `border-color`: **var(--set-accent) !important**  ⚠ undeclared --set-accent
- `box-shadow`: **0 0 0 3px rgba(109, 40, 217, 0.16) !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main textarea:focus-visible`

- `outline`: **none !important**
- `border-color`: **var(--set-accent) !important**  ⚠ undeclared --set-accent
- `box-shadow`: **0 0 0 3px rgba(109, 40, 217, 0.16) !important**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main .app-listbox`

- `max-inline-size`: **360px**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-nav__select`

- `max-inline-size`: **360px**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main td .app-listbox`

- `min-inline-size`: **172px**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main input:disabled`

- `background-color`: **var(--set-inset) !important**  ⚠ undeclared --set-inset
- `color`: **var(--set-muted) !important**  ⚠ undeclared --set-muted
- `cursor`: **not-allowed**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main input[type="checkbox"]`

- `appearance`: **none !important**
- `-webkit-appearance`: **none !important**
- `display`: **inline-grid !important**
- `place-content`: **center !important**
- `inline-size`: **18px !important**
- `block-size`: **18px !important**
- `min-inline-size`: **18px !important**
- `min-height`: **0 !important**
- `margin`: **0 !important**
- `padding`: **0 !important**
- `border`: **1.5px solid var(--set-line-strong) !important**  ⚠ undeclared --set-line-strong
- `background`: **var(--set-panel-solid) !important**  ⚠ undeclared --set-panel-solid
- `cursor`: **pointer**
- `transition`: **background 120ms ease, border-color 120ms ease**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main input[type="radio"]`

- `appearance`: **none !important**
- `-webkit-appearance`: **none !important**
- `display`: **inline-grid !important**
- `place-content`: **center !important**
- `inline-size`: **18px !important**
- `block-size`: **18px !important**
- `min-inline-size`: **18px !important**
- `min-height`: **0 !important**
- `margin`: **0 !important**
- `padding`: **0 !important**
- `border`: **1.5px solid var(--set-line-strong) !important**  ⚠ undeclared --set-line-strong
- `background`: **var(--set-panel-solid) !important**  ⚠ undeclared --set-panel-solid
- `cursor`: **pointer**
- `transition`: **background 120ms ease, border-color 120ms ease**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main input[type="checkbox"]::before`

- `content`: **""**
- `inline-size`: **10px**
- `block-size`: **10px**
- `transform`: **scale(0)**
- `transition`: **transform 110ms ease-in-out**
- `box-shadow`: **inset 1em 1em #ffffff**
- `clip-path`: **polygon(     14% 44%,     0 65%,     50% 100%,     100% 16%,     80% 0%,     43% 62%   )**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main input[type="radio"]::before`

- `content`: **""**
- `inline-size`: **8px**
- `block-size`: **8px**
- `border-radius`: **50%**
- `transform`: **scale(0)**
- `transition`: **transform 110ms ease-in-out**
- `box-shadow`: **inset 1em 1em #ffffff**

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main input[type="checkbox"]:checked`

- `border-color`: **var(--set-accent) !important**  ⚠ undeclared --set-accent
- `background`: **var(--set-accent) !important**  ⚠ undeclared --set-accent

**`.settings-page-shell`** — `apps/web/app/(app)/settings/settings.css` · `.settings-page-shell .set-main input[type="radio"]:checked`

- `border-color`: **var(--set-accent) !important**  ⚠ undeclared --set-accent
- `background`: **var(--set-accent) !important**  ⚠ undeclared --set-accent


**Stock Tailwind utilities used (23).** `apps/web/tailwind.config.ts` declares `theme: { extend: {} }`, so these carry DEFAULT Tailwind values and are not connected to the PROOVRA token set:

- `.flex` → {"kind":"layout","value":"flex"}
- `.items-center` → {"kind":"layout","value":"items-center"}
- `.justify-between` → {"kind":"layout","value":"justify-between"}
- `.gap-4` → {"kind":"gap","value":"16px"}
- `.py-2` → {"kind":"padding","side":"y","value":"8px"}
- `.justify-center` → {"kind":"layout","value":"justify-center"}
- `.rounded-full` → {"kind":"border-radius","value":"9999px"}
- `.font-bold` → {"kind":"font-weight","value":700}
- `.font-semibold` → {"kind":"font-weight","value":600}
- `.mt-4` → {"kind":"margin","side":"t","value":"16px"}
- `.block` → {"kind":"layout","value":"block"}
- `.mt-2` → {"kind":"margin","side":"t","value":"8px"}
- `.mt-3` → {"kind":"margin","side":"t","value":"12px"}
- `.rounded-lg` → {"kind":"border-radius","value":"8px"}
- `.px-3` → {"kind":"padding","side":"x","value":"12px"}
- `.gap-3` → {"kind":"gap","value":"12px"}
- `.mt-5` → {"kind":"margin","side":"t","value":"20px"}
- `.flex-wrap` → {"kind":"layout","value":"flex-wrap"}
- `.gap-2` → {"kind":"gap","value":"8px"}
- `.w-full` → {"kind":"layout","value":"w-full"}
- `.grid` → {"kind":"layout","value":"grid"}
- `.gap-1.5` → {"kind":"gap","value":"6px"}
- `.m-0` → {"kind":"margin","side":"all","value":"0px"}


### D.2 PWA SOURCE-UNRESOLVED (39)

- `["ui-page-header",` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `className].filter(Boolean).join("` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `")` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-section",` at `apps/web/components/ui/PageShell.tsx:228` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-shell",` at `apps/web/components/ui/PageShell.tsx:322` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `set-nav` at `apps/web/app/(app)/settings/_sections/SettingsNav.tsx:47` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `set-nav__group` at `apps/web/app/(app)/settings/_sections/SettingsNav.tsx:89` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-listbox${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppListbox.tsx:212` — className built from a runtime expression
- ``app-anchored-overlay${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppAnchoredOverlay.tsx:162` — className built from a runtime expression
- `set-section` at `apps/web/app/(app)/settings/_sections/SettingsOverview.tsx:383` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[13px]` at `apps/web/app/(app)/settings/_sections/OverviewSection.tsx:71` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `h-12` at `apps/web/app/(app)/settings/_sections/OverviewSection.tsx:179` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `w-12` at `apps/web/app/(app)/settings/_sections/OverviewSection.tsx:179` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border` at `apps/web/app/(app)/settings/_sections/OverviewSection.tsx:179` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border-[rgba(79,70,229,0.16)]` at `apps/web/app/(app)/settings/_sections/OverviewSection.tsx:179` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[linear-gradient(180deg,rgba(243,240,255,0.9)_0%,rgba(255,255,255,0.56)_100%)]` at `apps/web/app/(app)/settings/_sections/OverviewSection.tsx:179` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[1.1rem]` at `apps/web/app/(app)/settings/_sections/OverviewSection.tsx:179` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#6D28D9]` at `apps/web/app/(app)/settings/_sections/OverviewSection.tsx:179` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[1rem]` at `apps/web/app/(app)/settings/_sections/OverviewSection.tsx:191` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tracking-[-0.02em]` at `apps/web/app/(app)/settings/_sections/OverviewSection.tsx:191` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[12px]` at `apps/web/app/(app)/settings/_sections/OverviewSection.tsx:240` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `finalClassName` at `apps/web/components/ui-legacy.tsx:163` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``card ${className ?? ""}`.trim()` at `apps/web/components/ui-legacy.tsx:179` — className built from a runtime expression
- ``input ${error ? "input-has-error" : ""} ${className ?? ""}`.trim()` at `apps/web/components/ui-legacy.tsx:293` — className built from a runtime expression
- ``select ${className ?? ""}`.trim()` at `apps/web/components/ui-legacy.tsx:360` — className built from a runtime expression
- `["ui-button",` at `apps/web/components/ui/Button.tsx:261` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-badge",` at `apps/web/components/ui/Badge.tsx:104` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-card",` at `apps/web/components/ui/Card.tsx:250` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-status-text${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppStatusText.tsx:64` — className built from a runtime expression
- `["ui-empty-state",` at `apps/web/components/ui/EmptyState.tsx:128` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (80 rules, 95 properties)

**`card`** — `apps/mobile/app/(tabs)/settings.tsx`

- `marginBottom`: **16**  _(theme.space.s4)_
- `gap`: **8**  _(theme.space.s2)_

**`gap`** — `apps/mobile/app/(tabs)/settings.tsx`

- `marginTop`: **4**  _(theme.space.s1)_

**`nameActions`** — `apps/mobile/app/(tabs)/settings.tsx`

- `flexDirection`: **row**
- `gap`: **8**  _(theme.space.s2)_

**`langRow`** — `apps/mobile/app/(tabs)/settings.tsx`

- `flexDirection`: **row**
- `flexWrap`: **wrap**
- `gap`: **8**  _(theme.space.s2)_
- `marginTop`: **8**  _(theme.space.s2)_

**`pill`** — `apps/mobile/app/(tabs)/settings.tsx`

- `paddingHorizontal`: **12**  _(theme.space.s3)_
- `paddingVertical`: **8**  _(theme.space.s2)_
- `borderRadius`: **999**  _(theme.radius.pill)_
- `borderWidth`: **1**
- `minHeight`: **36**
- `justifyContent`: **center**

**`switchRow`** — `apps/mobile/app/(tabs)/settings.tsx`

- `flexDirection`: **row**
- `alignItems`: **center**
- `justifyContent`: **space-between**
- `gap`: **12**  _(theme.space.s3)_
- `marginTop`: **8**  _(theme.space.s2)_

**`switchText`** — `apps/mobile/app/(tabs)/settings.tsx`

- `flex`: **1**
- `gap`: **2**

**`logout`** — `apps/mobile/app/(tabs)/settings.tsx`

- `marginTop`: **8**  _(theme.space.s2)_

**`flex`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**

**`screen`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**
- `backgroundColor`: **#F7F8FC**  _(theme.color.surface.app)_

**`screenBody`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**

**`centerColumn`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**
- `width`: **100%**
- `alignItems`: **center**

**`screenPadded`** — `apps/mobile/src/ui/index.tsx`

- `paddingHorizontal`: **16**  _(theme.space.s4)_

**`scrollContent`** — `apps/mobile/src/ui/index.tsx`

- `paddingBottom`: **40**  _(theme.space.s10)_
- `flexGrow`: **1**

**`footer`** — `apps/mobile/src/ui/index.tsx`

- `paddingHorizontal`: **16**  _(theme.space.s4)_
- `paddingVertical`: **12**  _(theme.space.s3)_
- `borderTopWidth`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `borderTopColor`: **rgba(15, 23, 42, 0.09)**  _(theme.color.border.default)_
- `backgroundColor`: **#FFFFFF**  _(theme.color.surface.card)_

**`card`** — `apps/mobile/src/ui/index.tsx`

- `backgroundColor`: **#FFFFFF**  _(theme.color.surface.card)_
- `borderRadius`: **14**  _(theme.radius.card)_
- `padding`: **20**  _(theme.space.s5)_
- `borderWidth`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `borderColor`: **rgba(15, 23, 42, 0.09)**  _(theme.color.border.default)_

**`pressed`** — `apps/mobile/src/ui/index.tsx`

- `opacity`: **0.94**

**`section`** — `apps/mobile/src/ui/index.tsx`

- `marginBottom`: **24**  _(theme.space.s6)_

**`sectionHead`** — `apps/mobile/src/ui/index.tsx`

- `alignItems`: **center**
- `justifyContent`: **space-between**
- `marginBottom`: **12**  _(theme.space.s3)_

**`button`** — `apps/mobile/src/ui/index.tsx`

- `minHeight`: **MIN_TOUCH**  ⚠ non-literal expression
- `paddingVertical`: **12**  _(theme.space.s3)_
- `paddingHorizontal`: **20**  _(theme.space.s5)_
- `borderRadius`: **999**  _(theme.radius.pill)_
- `borderWidth`: **1**
- `alignItems`: **center**
- `justifyContent`: **center**

**`buttonFull`** — `apps/mobile/src/ui/index.tsx`

- `alignSelf`: **stretch**

**`buttonDisabled`** — `apps/mobile/src/ui/index.tsx`

- `opacity`: **0.5**

**`buttonInner`** — `apps/mobile/src/ui/index.tsx`

- `flexDirection`: **row**
- `alignItems`: **center**
- `gap`: **8**  _(theme.space.s2)_

**`buttonLabel`** — `apps/mobile/src/ui/index.tsx`

- `fontSize`: **theme.type.size.body**  _(theme.type.size.body)_  ⚠ token path not found in proovra.generated.ts
- `fontWeight`: **600**

**`badge`** — `apps/mobile/src/ui/index.tsx`

- `flexDirection`: **row**
- `alignItems`: **center**
- `gap`: **8**  _(theme.space.s2)_
- `paddingVertical`: **6**
- `paddingHorizontal`: **12**  _(theme.space.s3)_
- `borderRadius`: **999**  _(theme.radius.pill)_
- `borderWidth`: **1**
- `alignSelf`: **flex-start**

**`badgeDot`** — `apps/mobile/src/ui/index.tsx`

- `width`: **8**
- `height`: **8**
- `borderRadius`: **4**

**`badgeText`** — `apps/mobile/src/ui/index.tsx`

- `fontSize`: **theme.type.size.label**  _(theme.type.size.label)_  ⚠ token path not found in proovra.generated.ts

**`row`** — `apps/mobile/src/ui/index.tsx`

- `minHeight`: **MIN_TOUCH**  ⚠ non-literal expression
- `paddingVertical`: **12**  _(theme.space.s3)_

**`rowInner`** — `apps/mobile/src/ui/index.tsx`

- `alignItems`: **center**
- `gap`: **12**  _(theme.space.s3)_

**`rowText`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**
- `gap`: **2**

**`stateCenter`** — `apps/mobile/src/ui/index.tsx`

- `alignItems`: **center**
- `justifyContent`: **center**
- `paddingVertical`: **40**  _(theme.space.s10)_

**`stateGap`** — `apps/mobile/src/ui/index.tsx`

- `marginTop`: **12**  _(theme.space.s3)_

**`field`** — `apps/mobile/src/ui/index.tsx`

- `gap`: **8**  _(theme.space.s2)_
- `marginBottom`: **16**  _(theme.space.s4)_

**`input`** — `apps/mobile/src/ui/index.tsx`

- `minHeight`: **MIN_TOUCH**  ⚠ non-literal expression
- `borderWidth`: **1**
- `borderRadius`: **8**  _(theme.radius.md)_
- `paddingHorizontal`: **12**  _(theme.space.s3)_
- `paddingVertical`: **12**  _(theme.space.s3)_
- `fontSize`: **theme.type.size.body**  _(theme.type.size.body)_  ⚠ token path not found in proovra.generated.ts
- `color`: **#0F172A**  _(theme.color.ink.primary)_
- `backgroundColor`: **#FFFFFF**  _(theme.color.surface.card)_

**`inputDisabled`** — `apps/mobile/src/ui/index.tsx`

- `opacity`: **0.5**

## K. Coverage counts for this route

| Measure | Count |
|---|---:|
| PWA files inspected (rendered tree) | 35 |
| Native files inspected (rendered tree) | 2 |
| PWA elements identified | 1068 |
| Native elements identified | 100 |
| Pairable PWA elements | 195 |
| Paired | 5 |
| Missing in Native | 127 |
| Extra in Native | 7 |
| Unlabelled (not pairable by label) | 25 |
| SOURCE-UNRESOLVED labels | 38 |
| PWA style properties resolved | 2480 |
| PWA style items SOURCE-UNRESOLVED | 39 |
| Native style properties resolved | 95 |
| PWA interactive elements | 152 |
| Native interactive elements | 38 |
| PWA conditional branches | 592 |
| Native conditional branches | 24 |
