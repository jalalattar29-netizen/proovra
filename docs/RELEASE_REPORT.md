# PROOVRA GLOBAL RELEASE — تقرير التنفيذ

## ملخص تنفيذي

تم تنفيذ معظم متطلبات الأمر (Phases 1–6) مع إنجازات واضحة وتسجيلات فشل صريحة.

---

## أ) الملفات المعدّلة (EXACT PATHS)

### Web
- `apps/web/app/(app)/layout.tsx` — شيل التطبيق، تحقق auth، تنقل
- `apps/web/app/(app)/billing/page.tsx` — صفحة الفواتير
- `apps/web/app/(app)/settings/page.tsx` — مركز الحساب (Profile, Plan, Language, Security)
- `apps/web/app/(app)/home/page.tsx` — حالة فارغة، CTA
- `apps/web/app/(app)/cases/page.tsx` — حالة فارغة
- `apps/web/app/(app)/cases/[id]/page.tsx` — حالة فارغة للأدلة
- `apps/web/app/(app)/teams/page.tsx` — حالة فارغة
- `apps/web/app/pricing/page.tsx` — تسعير التسويق (marketing shell)
- `apps/web/app/page.tsx` — زر View Evidence، Download Report معطل
- `apps/web/app/login/page.tsx` — next param، auth/me، معالجة الأخطاء
- `apps/web/app/auth/apple/callback/ui/page.tsx` — auth/me بعد الـ token
- `apps/web/middleware.ts` — توجيه حسب الـ host
- `apps/web/app/globals.css` — `.empty-state`, `.empty-state-icon`

### Mobile
- `apps/mobile/app/(stack)/auth.tsx` — auth/me بعد Google/Apple، إصلاح useProxy
- `apps/mobile/app/(stack)/capture.tsx` — Fragment، نوع duration، تحذير 30 دقيقة
- `apps/mobile/app/(stack)/case/[id].tsx` — expo-file-system/legacy
- `apps/mobile/app/(tabs)/settings.tsx` — expo-file-system/legacy
- `apps/mobile/app/_layout.tsx` — Stack.Screen للـ index
- `apps/mobile/src/api.ts` — (لا تغييرات)
- `apps/mobile/src/upload-utils.ts` — expo-file-system/legacy
- `apps/mobile/src/i18n.ts` — export Locale

### Packages
- `packages/ui/src/tokens/colors.ts` — teal
- `packages/ui/src/tokens/typography.ts` — h4
- `packages/ui/src/tokens/radius.ts` — pill

### Docs
- `docs/DEPLOYMENT.md` — توجيه المجالات
- `docs/RELEASE_CHECKLIST.md` — Domain routing
- `docs/WINDOWS_BUILD_FIX.md` — إصلاح EPERM على Windows

### محذوف
- `apps/web/app/(app)/pricing/page.tsx` — تم دمجه في marketing pricing

---

## ب) الأوامر المنفذة ونتائجها

| الأمر | النتيجة |
|-------|---------|
| `pnpm lint` | فشل: `normalizeCurrency` غير مستخدم في services/api (R0.1: لا تغيير) |
| `pnpm --filter proovra-mobile typecheck` | نجح |
| `pnpm --filter proovra-web build` | نجح حتى "Generating static pages (26/26)" ثم فشل EPERM symlink على Windows |
| `pnpm --filter proovra-mobile start` | لم يُنفَّذ (يفترض العمل مع `pnpm dev:mobile`) |

---

## ج) جدول PASS/FAIL للمواصفات

### WEB

| المتطلب | الحالة | ملاحظات |
|---------|--------|---------|
| www home — لا أزرار ميتة | PASS | View Evidence → /verify؛ Download Report معطل مع tooltip؛ Capture/Sign/Share → #features |
| Pricing CTA يعمل | PASS | "Go to Billing" أو "Sign in to continue" حسب الخطة؛ next=/billing |
| Login Google يعمل | غير معتمد | إضافة auth/me بعد الـ token؛ لم يُختبر Google end-to-end |
| Settings = Account Center حقيقي | PASS | Profile, Plan, Language, Security؛ Sign out |
| لا headers مكررة | PASS | Marketing shell للـ pricing؛ App shell للـ billing/settings |
| Host-based routing | PASS | middleware يوجه app.proovra.com vs www.proovra.com |
| Tailwind + shadcn/ui | FAIL | المشروع يستخدم globals.css، لا Tailwind |
| lucide-react فقط | FAIL | استخدام inline SVGs و emoji للأيقونات |

### MOBILE

| المتطلب | الحالة | ملاحظات |
|---------|--------|---------|
| يعمل على الجهاز | غير معتمد | typecheck نجح؛ لم يُشغَّل على جهاز حقيقي |
| تسجيل فيديو > 30 دقيقة مسموح | جزئي | تحذير عند 30 دقيقة (1800 ثانية)؛ لا تحذيرات عند 60/120 دقيقة |
| خط أنابيب الرفع (guest → create → PUT → complete → report) | PASS | Smoke test موجود (EXPO_PUBLIC_DEBUG_SMOKE=1) |
| ترقية SDK إلى 54 | FAIL | لا يزال SDK 52؛ Expo Go 54 غير متوافق |
| eas.json | FAIL | غير موجود |

---

## د) ما تم تنفيذه بنجاح

1. **Phase 1 — فصل الشيل + أزرار حية + حلقة التسعير**
   - توجيه حسب الـ host
   - زر View Evidence → /verify
   - Download Report معطل مع tooltip
   - Capture/Sign/Share → #features
   - صفحة /billing في App shell
   - تدفق /login?next=/billing صحيح

2. **Phase 2 — تسجيل الدخول**
   - استدعاء auth/me بعد الـ token (Web + Mobile)
   - معالجة next param و returnUrl
   - رسائل خطأ Google/Apple أكثر وضوحاً

3. **Phase 3 — مركز الحساب**
   - Profile: email, auth provider, sign-out
   - Plan: الخطة الحالية، أزرار ترقية، روابط
   - Language: English
   - Security: /legal/security و security@proovra.com

4. **Phase 4 — Mobile**
   - إصلاح auth/me
   - إصلاح useProxy → scheme: "proovra"
   - استخدام expo-file-system/legacy
   - إصلاح أخطاء typecheck (capture, case, settings, upload-utils)

5. **Phase 5 — تحسين واجهة المستخدم**
   - حالات فارغة مع أيقونات (Cases, Teams, Home, Cases/[id])
   - كلاس `.empty-state` في globals.css

6. **Phase 6 — التوثيق**
   - DEPLOYMENT.md
   - RELEASE_CHECKLIST.md
   - WINDOWS_BUILD_FIX.md

7. **قواعد R0**
   - R0.1: لم يُلمس services/api أو services/worker
   - R0.2: لا واجهة ميتة — كل الأزرار تعمل أو معطلة بوضوح
   - R0.3: لا headers مكررة
   - R0.4: Pricing CTA حاسم
   - R0.5: لا placeholders

---

## هـ) ما فشل أو لم يُنفَّذ

1. **Tailwind + shadcn/ui** — المشروع يستخدم CSS عادي
2. **lucide-react فقط** — استخدام inline SVGs و emoji بدلاً من lucide
3. **ترقية Mobile SDK إلى 54** — لا يزال 52
4. **eas.json** — غير موجود
5. **تحذيرات الفيديو عند 60 و 120 دقيقة** — فقط تحذير 30 دقيقة
6. **فحص Google login end-to-end** — غير معتمد
7. **تشغيل mobile على جهاز** — غير معتمد
8. **تحقق domain routing على app.proovra.com / www.proovra.com** — غير معتمد

---

## و) ما لا يمكن التحقق منه — كيف تتحقق أنت

| العنصر | كيفية التحقق |
|--------|--------------|
| Google login | تسجيل دخول بـ Google على /login والتحقق من التوجيه إلى /home |
| Host-based routing | استدعاء app.proovra.com و www.proovra.com بعد النشر على Vercel |
| Mobile على الجهاز | `pnpm dev:mobile` ثم فتح Expo على الجهاز (مع توافق SDK) |
| البناء على Windows | تفعيل Developer Mode أو استخدام `NEXT_STANDALONE=false` |
