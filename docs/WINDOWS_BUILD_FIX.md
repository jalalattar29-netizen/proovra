# إصلاح أخطاء البناء على Windows (EPERM symlink)

عند تنفيذ `pnpm --filter proovra-web build` على Windows، قد يظهر خطأ:

```
EPERM: operation not permitted, symlink '...' -> '...'
```

هذا يحدث لأن Next.js (`output: "standalone"`) يحاول إنشاء روابط رمزية (symlinks) أثناء نسخ الملفات، و Windows يقيّد إنشاء الروابط الرمزية افتراضياً.

---

## الحل 1: تفعيل وضع المطور (Developer Mode) — الأفضل

1. افتح **الإعدادات** (Settings)
2. اذهب إلى **Privacy & security** → **For developers**
3. فعّل **Developer Mode**
4. أعد تشغيل الجهاز أو على الأقل أعد تشغيل المحرر/الطرفية
5. أعد تشغيل الأمر:

```bash
pnpm --filter proovra-web build
```

---

## الحل 2: التشغيل كمسؤول (Administrator)

1. أغلق Cursor / VS Code
2. انقر بزر الماوس الأيمن على أيقونة Cursor
3. اختر **Run as administrator**
4. افتح المشروع ثم نفّذ:

```bash
pnpm --filter proovra-web build
```

---

## الحل 3: تعطيل standalone على Windows (تحتاج فقط للتحقق من البناء)

إذا كنت تعمل على Windows ولست بحاجة لملف standalone المحلي:

```bash
set NEXT_STANDALONE=false && pnpm --filter proovra-web build
```

أو في PowerShell:

```powershell
$env:NEXT_STANDALONE="false"; pnpm --filter proovra-web build
```

يمكنك إضافة سكريبت في `package.json`:

```json
"build:web:win": "cross-env NEXT_STANDALONE=false pnpm --filter proovra-web build"
```

---

## الحل 4: صلاحيات السياسة المحلية (Local Security Policy)

إذا لم يعمل الحل 1 أو 2:

1. اضغط `Win + R` واكتب `secpol.msc`
2. اذهب إلى **Local Policies** → **User Rights Assignment**
3. ابحث عن **Create symbolic links**
4. أضف حساب المستخدم الخاص بك إن لم يكن مدرجاً

---

## الحل 5: إلغاء حظر البرنامج

إذا كان برنامج مكافحة الفيروسات أو Windows Defender يمنع Cursor/Node:

1. أضف مجلد المشروع إلى الاستثناءات (Exclusions)
2. أو أضف `node.exe` ومسار المشروع إلى الاستثناءات

---

## التحقق من نجاح الإصلاح

بعد تطبيق أحد الحلول:

```bash
cd d:\digital-witness
pnpm --filter proovra-web build
```

يجب أن تظهر رسالة:

```
✓ Generating static pages (26/26)
✓ Finalizing page optimization
```

بدون خطأ EPERM.

---

## ملاحظات

- **التطوير (dev):** الأمر `pnpm dev:web` لا يتأثر عادةً بهذا الخطأ
- **النشر:** عند النشر على Vercel أو Docker (Linux) المشكلة غير موجودة
- **الحل 3** مفيد فقط للتحقق من البناء على Windows؛ للـ production استخدم standalone في بيئة Linux
