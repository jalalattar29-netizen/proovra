import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    // OPS-015 — the deploy record names the web build beside the API and worker.
    revision: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  });
}