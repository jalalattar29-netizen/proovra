import { getBuildInfo } from "../../lib/build-info";

export const dynamic = "force-dynamic";

export async function GET() {
  const buildInfo = getBuildInfo();
  
  return Response.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    build: buildInfo,
    environment: {
      nodeEnv: process.env.NODE_ENV,
      vercelEnv: process.env.VERCEL_ENV,
      vercelUrl: process.env.VERCEL_URL,
      apiBase: process.env.NEXT_PUBLIC_API_BASE
    }
  });
}
