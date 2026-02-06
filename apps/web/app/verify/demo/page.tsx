import { redirect } from "next/navigation";

export default function VerifyDemoPage() {
  const token = process.env.NEXT_PUBLIC_VERIFY_DEMO_TOKEN;
  if (!token) {
    return (
      <div style={{ padding: 32 }}>
        Demo verify token is not configured. Set NEXT_PUBLIC_VERIFY_DEMO_TOKEN.
      </div>
    );
  }
  redirect(`/verify/${token}`);
}
