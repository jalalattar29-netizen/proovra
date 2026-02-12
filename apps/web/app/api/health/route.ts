import { NextResponse } from "next/server";
import { getBuildInfo } from "../../../lib/build-info";

export async function GET() {
  const info = getBuildInfo();
  return NextResponse.json({
    ok: true,
    buildId: info.buildId,
    commitSha: info.commitSha,
    buildTime: info.buildTime,
    environment: info.environment,
    vercelEnv: info.vercelEnv
  });
}
