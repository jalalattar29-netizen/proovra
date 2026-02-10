# Component Library Quick Reference
**Location**: `apps/web/components/ui.tsx`  
**CSS**: `apps/web/app/globals.css`  
**Premium Quality**: Stripe/Notion-like styling + animations

---

## 🎯 Quick Start

### Wrap Root with ToastProvider
In `apps/web/app/layout.tsx`:
```tsx
import { ToastProvider } from "@/components/ui";

export default function RootLayout({ children }) {
  return (
    <ToastProvider>
      {children}
    </ToastProvider>
  );
}
```

---

## 📋 Components

### 1️⃣ Toast (User Feedback)
```tsx
import { useToast } from "@/components/ui";

const { addToast } = useToast();

// Success
addToast("Copied!", "success", 3000);

// Error
addToast("Failed to upload", "error");

// Info
addToast("Processing...", "info");

// Warning
addToast("Large file detected", "warning");
```

**Variants**: `success` (green), `error` (red), `info` (blue), `warning` (orange)  
**Duration**: Optional, defaults to 4000ms. Set to 0 for permanent.  
**Positioning**: Fixed top-right, responsive on mobile

---

### 2️⃣ Modal (Dialogs)
```tsx
const [isOpen, setIsOpen] = useState(false);

<Modal
  isOpen={isOpen}
  onClose={() => setIsOpen(false)}
  title="Delete Evidence?"
  actions={
    <div style={{ display: "flex", gap: 8 }}>
      <Button variant="secondary" onClick={() => setIsOpen(false)}>
        Cancel
      </Button>
      <Button onClick={handleDelete}>Delete</Button>
    </div>
  }
>
  This action cannot be undone.
</Modal>
```

**Features**: Centered, overlay, smooth animation, dismissible

---

### 3️⃣ Skeleton (Loading State)
```tsx
// Single line
<Skeleton width="100%" height="16px" />

// Multiple lines
<SkeletonText lines={3} />

// In a list
{loading ? (
  <SkeletonText lines={5} />
) : (
  <div>{content}</div>
)}
```

**Features**: Pulse animation, customizable width/height

---

### 4️⃣ EmptyState (No Data)
```tsx
import { Icons } from "@/components/icons";

<EmptyState
  icon={<Icons.Evidence />}
  title="No evidence captured yet"
  subtitle="Start by uploading a photo, video, or document"
  action={() => router.push("/capture")}
  actionLabel="Start Capturing"
/>
```

**Features**: Icon, title, subtitle, CTA button, centered layout

---

### 5️⃣ Input (Text Field)
```tsx
const [name, setName] = useState("");
const [error, setError] = useState("");

<Input
  placeholder="Enter your name"
  value={name}
  onChange={setName}
  type="text"
  error={error}
  disabled={false}
/>
```

**Types**: `text`, `password`, `email`, `number`, `date`, etc.  
**Features**: Focus ring, error message, disabled state

---

### 6️⃣ Select (Dropdown)
```tsx
const [plan, setPlan] = useState("");

<Select
  label="Choose your plan"
  options={[
    { value: "free", label: "Free ($0)" },
    { value: "pro", label: "Pro ($19/mo)" },
    { value: "team", label: "Team ($79/mo)" }
  ]}
  value={plan}
  onChange={setPlan}
  disabled={false}
/>
```

**Features**: Label, options array, disabled state

---

### 7️⃣ Button (Existing, Already Good)
```tsx
<Button onClick={() => {}}>Primary</Button>
<Button variant="secondary">Secondary</Button>
<Button disabled>Disabled</Button>
<Button className="custom-class">Custom</Button>
```

---

### 8️⃣ Card (Content Container)
```tsx
<Card>
  <h3>Title</h3>
  <p>Content</p>
</Card>

<Card className="custom-class">Content</Card>
```

---

### 9️⃣ Badge (Status Indicator)
```tsx
<Badge tone="signed">SIGNED</Badge>
<Badge tone="processing">PROCESSING</Badge>
<Badge tone="ready">READY</Badge>
```

**Tones**: `signed` (green), `processing` (yellow), `ready` (blue)

---

### 🔟 ListRow (Evidence List Item)
```tsx
<ListRow
  title="photo.jpg"
  subtitle="Feb 10, 2025"
  badge={<Badge tone="signed">SIGNED</Badge>}
/>
```

---

## 🎨 Colors (Design Tokens)

All components use CSS variables:
- `--color-primary` → Dark navy (#0B1F2A)
- `--color-bg` → Light gray (#F7F9FB)
- `--color-text` → Dark text (#0E1116)
- `--color-muted` → Gray (#5B6672)
- `--color-border` → Light border (#D9E2EA)

**Success**: #1F9D55 (green)  
**Error**: #D64545 (red)  
**Info**: #0B7BE5 (blue)  
**Warning**: #C98A10 (orange)

---

## ⚡ Common Patterns

### Upload with Toast
```tsx
const { addToast } = useToast();

const handleUpload = async (file) => {
  try {
    const res = await fetch("/v1/evidence", { method: "POST" });
    addToast("Upload started!", "info");
    // Handle response...
    addToast("Upload complete!", "success");
  } catch (err) {
    addToast("Upload failed: " + err.message, "error");
  }
};
```

### Loading with Skeleton
```tsx
const [data, setData] = useState(null);
const [loading, setLoading] = useState(true);

useEffect(() => {
  fetch("/api/data")
    .then(r => r.json())
    .then(setData)
    .finally(() => setLoading(false));
}, []);

return loading ? <SkeletonText lines={3} /> : <div>{data}</div>;
```

### Confirm Delete with Modal
```tsx
const [deleteId, setDeleteId] = useState(null);

<Modal
  isOpen={!!deleteId}
  onClose={() => setDeleteId(null)}
  title="Delete This?"
  actions={
    <>
      <Button variant="secondary" onClick={() => setDeleteId(null)}>
        Cancel
      </Button>
      <Button
        onClick={async () => {
          await fetch(`/api/evidence/${deleteId}`, { method: "DELETE" });
          addToast("Deleted!", "success");
          setDeleteId(null);
        }}
      >
        Delete
      </Button>
    </>
  }
>
  This action cannot be undone.
</Modal>
```

---

## 🧪 Testing

### Verify Toast Works
1. Visit any page with ToastProvider
2. In browser console: `localStorage.setItem("__test__", "1");`
3. Trigger any async action that calls `addToast()`
4. Toast should appear top-right with correct color

### Verify Modal Works
1. Set state: `<Button onClick={() => setOpen(true)}>Open</Button>`
2. Click → modal should slide up
3. Click overlay or close button → should close

### Verify Skeleton Works
1. Toggle loading state
2. Skeleton should pulse smoothly
3. No layout shift when content loads

---

## 📦 Export List

From `apps/web/components/ui.tsx`:
```tsx
export { ToastProvider, useToast }  // Toast
export { Modal }                    // Modal
export { Skeleton, SkeletonText }  // Skeleton
export { EmptyState }              // Empty State
export { Input }                   // Input
export { Select }                  // Select
export { Button }                  // Button
export { Card }                    // Card
export { Badge }                   // Badge
export { ListRow }                 // List Row
export { TopBar }                  // Top Bar
export { TimelineBlock }           // Timeline
export { Tabs }                    // Tabs
export { StatusPill }              // Status Pill
export { BottomNav }               // Bottom Nav
```

---

## 🎯 Usage in Pages

### Example: /capture Page
```tsx
"use client";
import { useState } from "react";
import { Input, Button, EmptyState, useToast, SkeletonText, Modal } from "@/components/ui";
import { Icons } from "@/components/icons";

export default function CapturePage() {
  const { addToast } = useToast();
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);

  const handleUpload = async () => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file!);
      
      const res = await fetch("/v1/evidence", {
        method: "POST",
        body: form
      });
      
      if (!res.ok) throw new Error("Upload failed");
      
      addToast("Uploaded successfully!", "success");
      setFile(null);
    } catch (err) {
      addToast((err as Error).message, "error");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      {uploading ? (
        <SkeletonText lines={3} />
      ) : (
        <>
          <h1>Capture Evidence</h1>
          <Input
            placeholder="Select a file..."
            value={file?.name || ""}
            onChange={() => {}}
            type="file"
          />
          <Button onClick={handleUpload} disabled={!file}>
            Upload
          </Button>
        </>
      )}
    </div>
  );
}
```

---

## 🚀 Next Steps

1. **Integrate ToastProvider** in root layout
2. **Use Toast** in all async actions (upload, save, delete)
3. **Add Skeleton** to pages that load data
4. **Create /capture** page with upload flow + Toast feedback
5. **Create /evidence/[id]** page with EmptyState for no data
6. **Add language switcher** to header

---

**Last Updated**: Feb 10, 2026  
**Version**: 1.0  
**Quality**: Production-ready, Stripe/Notion standard

