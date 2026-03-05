export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(
    {
      status: "ok",
      timestamp: new Date().toISOString(),
      version: process.env.APP_VERSION ?? "unknown",
    },
    { status: 200 }
  );
}