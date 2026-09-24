# /forgot-password

**PWA entry:** `apps/web/app/login/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/forgot-password.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 6 | 3 |
| Elements | 180 | 58 |
| Interactive elements | 41 | 11 |
| Conditionally-rendered elements | 74 | 23 |
| Style rules resolved | 57 (222 props) | 70 (81 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/login/page.tsx` | 94 | `(entry)` |
| 1 | `apps/web/components/marketing/MarketingHeader.tsx` | 47 | `MarketingHeader` |
| 2 | `apps/web/components/analytics/PublicPageView.tsx` | 0 | `PublicPageView` |
| 2 | `apps/web/components/marketing/MarketingLanguageSwitcher.tsx` | 8 | `MarketingLanguageSwitcher` |
| 1 | `apps/web/components/auth/PasswordVisibilityToggle.tsx` | 7 | `PasswordVisibilityToggle` |
| 1 | `apps/web/components/marketing/ForgotPasswordModal.tsx` | 24 | `ForgotPasswordModal` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/forgot-password.tsx` | 12 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraSection,ProovraCard,ProovraText,ProovraButton,ProovraFormField,ProovraInput` |
| 1 | `apps/mobile/src/ui/brand.tsx` | 4 | `AuthBrandHeader` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BUTTON | 16 | 7 | -9 |
| CARD | 0 | 1 | 1 |
| CONTAINER | 73 | 24 | -49 |
| DIALOG | 1 | 0 | -1 |
| FORM | 2 | 0 | -2 |
| HEADING | 5 | 0 | -5 |
| ICON | 20 | 0 | -20 |
| IMAGE | 3 | 1 | -2 |
| INPUT | 4 | 3 | -1 |
| LINK | 15 | 0 | -15 |
| LIST | 0 | 1 | 1 |
| OTHER | 17 | 3 | -14 |
| STATE_LOADING | 0 | 2 | 2 |
| TEXT | 24 | 16 | -8 |

### C.1 Paired (4)

| Role | Label | PWA | Native |
|---|---|---|---|
| INPUT | Email | `apps/web/app/login/page.tsx:847` | `apps/mobile/app/(stack)/forgot-password.tsx:51` |
| BUTTON | Back to sign in | `apps/web/components/marketing/ForgotPasswordModal.tsx:227` | `apps/mobile/app/(stack)/forgot-password.tsx:46` |
| BUTTON | Send reset link | `apps/web/components/marketing/ForgotPasswordModal.tsx:331` | `apps/mobile/app/(stack)/forgot-password.tsx:54` |
| LINK → BUTTON ⚠ | Back to sign in | `apps/web/components/marketing/ForgotPasswordModal.tsx:366` | `apps/mobile/app/(stack)/forgot-password.tsx:56` |

**1 paired with a DIFFERENT role** — the same words rendered as a different kind of control. Each is a candidate incorrect substitution.

### C.2 MISSING in Native (22)

| Role | Label | PWA source |
|---|---|---|
| HEADING | Sign in to PROOVRA | `apps/web/app/login/page.tsx:153` |
| HEADING | Return to your     workspace. | `apps/web/app/login/page.tsx:711` |
| HEADING | Sign in | `apps/web/app/login/page.tsx:787` |
| BUTTON | {t("signInApple")} | `apps/web/app/login/page.tsx:812` |
| INPUT | Password | `apps/web/app/login/page.tsx:892` |
| BUTTON | Forgot password? | `apps/web/app/login/page.tsx:935` |
| LINK | Terms of Service | `apps/web/app/login/page.tsx:981` |
| LINK | Privacy Policy | `apps/web/app/login/page.tsx:985` |
| LINK | Cookie Policy | `apps/web/app/login/page.tsx:989` |
| BUTTON | Sign in with Email | `apps/web/app/login/page.tsx:1002` |
| BUTTON | Use a different email | `apps/web/app/login/page.tsx:1087` |
| LINK | {t("register")} | `apps/web/app/login/page.tsx:1172` |
| LINK | MARKETING_COPY.brandName | `apps/web/components/marketing/MarketingHeader.tsx:249` |
| LINK | Request a demo | `apps/web/components/marketing/MarketingHeader.tsx:367` |
| BUTTON | Open menu | `apps/web/components/marketing/MarketingHeader.tsx:376` |
| BUTTON | Close menu | `apps/web/components/marketing/MarketingHeader.tsx:401` |
| LINK | Request a demo | `apps/web/components/marketing/MarketingHeader.tsx:466` |
| BUTTON | Language | `apps/web/components/marketing/MarketingLanguageSwitcher.tsx:81` |
| HEADING | Check your email | `apps/web/components/marketing/ForgotPasswordModal.tsx:213` |
| BUTTON | Send again | `apps/web/components/marketing/ForgotPasswordModal.tsx:244` |
| HEADING | Reset your password | `apps/web/components/marketing/ForgotPasswordModal.tsx:263` |
| BUTTON | Cancel | `apps/web/components/marketing/ForgotPasswordModal.tsx:349` |

### C.3 EXTRA in Native (5)

| Role | Label | Native source |
|---|---|---|
| INPUT | you@example.com | `apps/mobile/app/(stack)/forgot-password.tsx:52` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BUTTON | Try again | `apps/mobile/src/ui/index.tsx:531` |

### C.4 SOURCE-UNRESOLVED labels (10)

| Role | PWA source | Why unpairable |
|---|---|---|
| BUTTON | `apps/web/app/login/page.tsx:1039` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/marketing/MarketingHeader.tsx:275` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:309` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:344` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:359` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:419` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:436` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/marketing/MarketingHeader.tsx:459` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/auth/PasswordVisibilityToggle.tsx:87` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/marketing/ForgotPasswordModal.tsx:285` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (57 rules, 222 properties)

**`.page`** — `apps/web/app/globals.css` · `.page`

- `min-height`: **100vh**
- `display`: **flex**
- `flex-direction`: **column**

**`.auth-card`** — `apps/web/app/globals.css` · `.auth-card`

- `width`: **100%**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium`

- `position`: **relative**
- `overflow`: **hidden**
- `border-radius`: **30px**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium .auth-input-icon`

- `color`: **#446166**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium .auth-divider`

- `color`: **#6c787c**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium .auth-social-btn:not([type="submit"])`

- `background`: **linear-gradient(     180deg,     rgba(62, 96, 99, 0.96) 0%,     rgba(24, 43, 48, 0.98) 100%   )**
- `color`: **#eef3f1**
- `border`: **1px solid rgba(79, 112, 107, 0.28)**
- `box-shadow`: **0 14px 28px rgba(20, 48, 52, 0.16)**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium .auth-link`

- `color`: **#45656a**
- `transition`: **color 0.2s ease**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium .auth-link:hover`

- `color`: **#2e4c50**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium .auth-legal a`

- `color`: **#b79d84 !important**
- `transition`: **color 0.2s ease**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium .auth-legal a:hover`

- `color`: **#d6b89d !important**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium .error-text`

- `color`: **#b42318**
- `background`: **rgba(255, 255, 255, 0.52)**
- `border`: **1px solid rgba(180, 35, 24, 0.12)**
- `border-radius`: **14px**
- `padding`: **10px 12px**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium .auth-status`

- `color`: **#496268**
- `background`: **rgba(255, 255, 255, 0.42)**
- `border`: **1px solid rgba(79, 112, 107, 0.10)**
- `border-radius`: **14px**
- `padding`: **10px 12px**

**`.auth-premium`** — `apps/web/app/globals.css` · `.auth-premium .auth-debug-panel`

- `background`: **rgba(255, 255, 255, 0.42)**
- `border`: **1px solid rgba(79, 112, 107, 0.10)**
- `border-radius`: **16px**
- `padding`: **12px**
- `color`: **#4f5f63**

**`.auth-actions`** — `apps/web/app/globals.css` · `.auth-actions`

- `display`: **grid**
- `gap`: **12px**

**`.auth-social-btn`** — `apps/web/app/globals.css` · `.auth-social-btn`

- `width`: **100%**
- `min-height`: **52px**
- `border-radius`: **16px**
- `padding`: **0 18px**
- `display`: **inline-flex**
- `align-items`: **center**
- `justify-content`: **center**
- `gap`: **10px**
- `font-size`: **0.96rem**
- `font-weight`: **600**
- `cursor`: **pointer**
- `appearance`: **none**
- `-webkit-appearance`: **none**

**`.auth-social-btn`** — `apps/web/app/globals.css` · `.auth-social-btn:disabled`

- `opacity`: **0.7**
- `cursor`: **not-allowed**

**`.auth-social-btn`** — `apps/web/app/globals.css` · `.auth-premium .auth-social-btn:not([type="submit"])`

- `background`: **linear-gradient(     180deg,     rgba(62, 96, 99, 0.96) 0%,     rgba(24, 43, 48, 0.98) 100%   )**
- `color`: **#eef3f1**
- `border`: **1px solid rgba(79, 112, 107, 0.28)**
- `box-shadow`: **0 14px 28px rgba(20, 48, 52, 0.16)**

**`.auth-social-icon`** — `apps/web/app/globals.css` · `.auth-social-icon`

- `display`: **inline-flex**
- `align-items`: **center**
- `justify-content`: **center**
- `line-height`: **1**

**`.auth-divider`** — `apps/web/app/globals.css` · `.auth-divider`

- `position`: **relative**
- `text-align`: **center**
- `font-size`: **0.84rem**
- `color`: **#6c787c**
- `padding`: **6px 0**

**`.auth-divider`** — `apps/web/app/globals.css` · `.auth-divider::before`

- `content`: **""**
- `position`: **absolute**
- `top`: **50%**
- `width`: **calc(50% - 24px)**
- `height`: **1px**
- `background`: **rgba(79, 112, 107, 0.14)**

**`.auth-divider`** — `apps/web/app/globals.css` · `.auth-divider::after`

- `content`: **""**
- `position`: **absolute**
- `top`: **50%**
- `width`: **calc(50% - 24px)**
- `height`: **1px**
- `background`: **rgba(79, 112, 107, 0.14)**

**`.auth-divider`** — `apps/web/app/globals.css` · `.auth-premium .auth-divider`

- `color`: **#6c787c**

**`.auth-input-wrap`** — `apps/web/app/globals.css` · `.auth-input-wrap`

- `position`: **relative**
- `display`: **flex**
- `align-items`: **center**

**`.auth-input-icon`** — `apps/web/app/globals.css` · `.auth-input-icon`

- `position`: **absolute**
- `left`: **14px**
- `top`: **50%**
- `transform`: **translateY(-50%)**
- `z-index`: **2**
- `display`: **inline-flex**
- `align-items`: **center**
- `justify-content`: **center**
- `pointer-events`: **none**
- `color`: **#446166**

**`.auth-input-icon`** — `apps/web/app/globals.css` · `.auth-premium .auth-input-icon`

- `color`: **#446166**

**`.auth-input`** — `apps/web/app/globals.css` · `.auth-input`

- `width`: **100% !important**
- `min-height`: **52px**
- `padding`: **0 16px 0 46px !important**
- `border-radius`: **16px !important**
- `font-size`: **15px !important**
- `line-height`: **1.2 !important**
- `background`: **rgba(255, 255, 255, 0.92) !important**
- `border`: **1px solid rgba(79, 112, 107, 0.16) !important**
- `box-shadow`: **0 12px 28px rgba(6, 16, 22, 0.08) !important**
- `color`: **#102126 !important**
- `outline`: **none**
- `appearance`: **none**
- `-webkit-appearance`: **none**

**`.auth-input`** — `apps/web/app/globals.css` · `.auth-input::placeholder`

- `color`: **#8b989c !important**

**`.auth-input`** — `apps/web/app/globals.css` · `.auth-input:focus`

- `border-color`: **rgba(79, 112, 107, 0.34) !important**
- `box-shadow`: **0 0 0 3px rgba(79, 112, 107, 0.10) !important**

**`.error-text`** — `apps/web/app/globals.css` · `.error-text`

- `color`: **#d64545**
- `font-size`: **12px**
- `margin-top`: **4px**

**`.error-text`** — `apps/web/app/globals.css` · `.auth-premium .error-text`

- `color`: **#b42318**
- `background`: **rgba(255, 255, 255, 0.52)**
- `border`: **1px solid rgba(180, 35, 24, 0.12)**
- `border-radius`: **14px**
- `padding`: **10px 12px**

**`.auth-input--with-trailing-action`** — `apps/web/app/globals.css` · `.auth-input--with-trailing-action`

- `padding-inline-end`: **46px !important**

**`.auth-link`** — `apps/web/app/globals.css` · `.auth-premium .auth-link`

- `color`: **#45656a**
- `transition`: **color 0.2s ease**

**`.auth-link`** — `apps/web/app/globals.css` · `.auth-premium .auth-link:hover`

- `color`: **#2e4c50**

**`.auth-legal-check`** — `apps/web/app/globals.css` · `.auth-legal-check a:hover`

- `color`: **#b79d84 !important**

**`.auth-legal-checkbox`** — `apps/web/app/globals.css` · `.auth-legal-checkbox`

- `appearance`: **none**
- `-webkit-appearance`: **none**
- `width`: **19px**
- `height`: **19px**
- `min-width`: **19px**
- `margin`: **2px 0 0**
- `border-radius`: **6px**
- `border`: **1px solid rgba(79, 112, 107, 0.28)**
- `background`: **linear-gradient(     180deg,     rgba(255, 255, 255, 0.92) 0%,     rgba(240, 244, 241, 0.98) 100%   )**
- `box-shadow`: **inset 0 1px 0 rgba(255, 255, 255, 0.75),     0 4px 10px rgba(15, 23, 42, 0.08)**
- `cursor`: **pointer**
- `position`: **relative**
- `transition`: **border-color 0.2s ease,     box-shadow 0.2s ease,     background 0.2s ease,     transform 0.18s ease**

**`.auth-legal-checkbox`** — `apps/web/app/globals.css` · `.auth-legal-checkbox:hover`

- `border-color`: **rgba(79, 112, 107, 0.42)**
- `box-shadow`: **inset 0 1px 0 rgba(255, 255, 255, 0.78),     0 6px 14px rgba(15, 23, 42, 0.1)**

**`.auth-legal-checkbox`** — `apps/web/app/globals.css` · `.auth-legal-checkbox:focus-visible`

- `outline`: **none**
- `border-color`: **#7c3aed**
- `box-shadow`: **0 0 0 4px rgba(124, 58, 237, 0.32),     inset 0 1px 0 rgba(255, 255, 255, 0.78)**

**`.auth-legal-checkbox`** — `apps/web/app/globals.css` · `.auth-legal-checkbox:checked`

- `border-color`: **#7c3aed !important**
- `background`: **#7c3aed !important**
- `background-image`: **none !important**
- `box-shadow`: **0 8px 18px rgba(124, 58, 237, 0.22),     inset 0 1px 0 rgba(255, 255, 255, 0.18)**

**`.auth-legal-checkbox`** — `apps/web/app/globals.css` · `.auth-legal-checkbox:checked:hover`

- `border-color`: **#6d28d9 !important**
- `background`: **#6d28d9 !important**
- `background-image`: **none !important**

**`.auth-legal-checkbox`** — `apps/web/app/globals.css` · `.auth-legal-checkbox:checked:focus-visible`

- `box-shadow`: **0 0 0 4px rgba(124, 58, 237, 0.32),     inset 0 1px 0 rgba(255, 255, 255, 0.18)**


**Stock Tailwind utilities used (58).** `apps/web/tailwind.config.ts` declares `theme: { extend: {} }`, so these carry DEFAULT Tailwind values and are not connected to the PROOVRA token set:

- `.relative` → {"kind":"layout","value":"relative"}
- `.overflow-hidden` → {"kind":"layout","value":"overflow-hidden"}
- `.absolute` → {"kind":"layout","value":"absolute"}
- `.h-full` → {"kind":"layout","value":"h-full"}
- `.w-full` → {"kind":"layout","value":"w-full"}
- `.flex` → {"kind":"layout","value":"flex"}
- `.flex-col` → {"kind":"layout","value":"flex-col"}
- `.flex-1` → {"kind":"layout","value":"flex-1"}
- `.items-center` → {"kind":"layout","value":"items-center"}
- `.px-6` → {"kind":"padding","side":"x","value":"24px"}
- `.pt-24` → {"kind":"padding","side":"t","value":"96px"}
- `.grid` → {"kind":"layout","value":"grid"}
- `.gap-10` → {"kind":"gap","value":"40px"}
- `.hidden` → {"kind":"layout","value":"hidden"}
- `.inline-flex` → {"kind":"layout","value":"inline-flex"}
- `.gap-2.5` → {"kind":"gap","value":"10px"}
- `.rounded-full` → {"kind":"border-radius","value":"9999px"}
- `.px-4` → {"kind":"padding","side":"x","value":"16px"}
- `.py-2` → {"kind":"padding","side":"y","value":"8px"}
- `.font-semibold` → {"kind":"font-weight","value":600}
- `.mt-5` → {"kind":"margin","side":"t","value":"20px"}
- `.font-medium` → {"kind":"font-weight","value":500}
- `.mt-6` → {"kind":"margin","side":"t","value":"24px"}
- `.flex-wrap` → {"kind":"layout","value":"flex-wrap"}
- `.px-3.5` → {"kind":"padding","side":"x","value":"14px"}


### D.2 PWA SOURCE-UNRESOLVED (120)

- `landing-page` at `apps/web/app/login/page.tsx:675` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `min-h-screen` at `apps/web/app/login/page.tsx:676` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `inset-0` at `apps/web/app/login/page.tsx:677` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `object-cover` at `apps/web/app/login/page.tsx:678` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `object-center` at `apps/web/app/login/page.tsx:678` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-[linear-gradient(90deg,rgba(255,229,207,0.10)_0%,rgba(255,255,255,0.02)_45%,rgba(33,22,45,0.10)_100%)]` at `apps/web/app/login/page.tsx:688` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `z-10` at `apps/web/app/login/page.tsx:690` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `pb-14` at `apps/web/app/login/page.tsx:693` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:px-8` at `apps/web/app/login/page.tsx:693` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:pb-20` at `apps/web/app/login/page.tsx:693` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `md:pt-28` at `apps/web/app/login/page.tsx:693` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `mx-auto` at `apps/web/app/login/page.tsx:694` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-7xl` at `apps/web/app/login/page.tsx:694` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:grid-cols-[0.92fr_0.88fr]` at `apps/web/app/login/page.tsx:695` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:items-start` at `apps/web/app/login/page.tsx:695` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:block` at `apps/web/app/login/page.tsx:702` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `lg:pt-[88px]` at `apps/web/app/login/page.tsx:702` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-[900px]` at `apps/web/app/login/page.tsx:703` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border` at `apps/web/app/login/page.tsx:704` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `border-[rgba(230,72,128,0.22)]` at `apps/web/app/login/page.tsx:704` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `bg-white/70` at `apps/web/app/login/page.tsx:704` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[0.74rem]` at `apps/web/app/login/page.tsx:704` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `uppercase` at `apps/web/app/login/page.tsx:704` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `tracking-[0.2em]` at `apps/web/app/login/page.tsx:704` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[#21162D]` at `apps/web/app/login/page.tsx:704` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `shadow-[0_10px_24px_rgba(33,22,45,0.10)]` at `apps/web/app/login/page.tsx:704` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `backdrop-blur-md` at `apps/web/app/login/page.tsx:704` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `max-w-[760px]` at `apps/web/app/login/page.tsx:711` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `text-[2rem]` at `apps/web/app/login/page.tsx:711` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `leading-[0.98]` at `apps/web/app/login/page.tsx:711` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (70 rules, 81 properties)

**`actions`** — `apps/mobile/app/(stack)/forgot-password.tsx`

- `marginTop`: **12**  _(theme.space.s3)_

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

**`wrap`** — `apps/mobile/src/ui/brand.tsx`

- `alignItems`: **center**
- `marginTop`: **32**  _(theme.space.s8)_
- `marginBottom`: **24**  _(theme.space.s6)_

**`mark`** — `apps/mobile/src/ui/brand.tsx`

- `width`: **72**
- `height`: **81**
- `marginBottom`: **12**  _(theme.space.s3)_

**`word`** — `apps/mobile/src/ui/brand.tsx`

- `letterSpacing`: **2**

**`tag`** — `apps/mobile/src/ui/brand.tsx`

- `marginTop`: **8**  _(theme.space.s2)_

## K. Coverage counts for this route

| Measure | Count |
|---|---:|
| PWA files inspected (rendered tree) | 6 |
| Native files inspected (rendered tree) | 3 |
| PWA elements identified | 180 |
| Native elements identified | 58 |
| Pairable PWA elements | 44 |
| Paired | 3 |
| Missing in Native | 22 |
| Extra in Native | 5 |
| Unlabelled (not pairable by label) | 8 |
| SOURCE-UNRESOLVED labels | 10 |
| PWA style properties resolved | 222 |
| PWA style items SOURCE-UNRESOLVED | 120 |
| Native style properties resolved | 81 |
| PWA interactive elements | 41 |
| Native interactive elements | 11 |
| PWA conditional branches | 74 |
| Native conditional branches | 23 |
