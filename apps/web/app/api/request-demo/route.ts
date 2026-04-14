import { NextResponse } from "next/server";

function readApiBase() {
  const apiBase =
    process.env.NEXT_PUBLIC_API_BASE ??
    process.env.API_BASE_URL ??
    "http://localhost:8081";

  return apiBase.replace(/\/+$/, "");
}

function jsonError(message: string, status: number) {
  return NextResponse.json(
    {
      ok: false,
      error: {
        message,
      },
    },
    { status }
  );
}

export async function POST(req: Request) {
  try {
    let body: Record<string, unknown> | null = null;

    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return jsonError("Invalid request payload.", 400);
    }

    if (!body || typeof body !== "object") {
      return jsonError("Invalid request payload.", 400);
    }

    const apiBase = readApiBase();
    const upstreamUrl = `${apiBase}/v1/demo-requests`;

    const forwardedFor =
      req.headers.get("x-forwarded-for") ??
      req.headers.get("cf-connecting-ip") ??
      "";

    const userAgent = req.headers.get("user-agent") ?? "";
    const referer = req.headers.get("referer") ?? "";

    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": userAgent,
        "x-forwarded-for": forwardedFor,
        "x-demo-source": "website",
        "x-demo-source-path":
          typeof body.sourcePath === "string" && body.sourcePath.trim()
            ? body.sourcePath
            : "/request-demo",
      },
      body: JSON.stringify({
        ...body,
        referrer:
          typeof body.referrer === "string" && body.referrer.trim()
            ? body.referrer
            : referer || null,
        source:
          typeof body.source === "string" && body.source.trim()
            ? body.source
            : "website",
        sourcePath:
          typeof body.sourcePath === "string" && body.sourcePath.trim()
            ? body.sourcePath
            : "/request-demo",
      }),
      cache: "no-store",
    });

    const text = await upstream.text();

    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!upstream.ok) {
      return NextResponse.json(
        parsed && typeof parsed === "object"
          ? parsed
          : {
              ok: false,
              error: {
                message: "Failed to submit demo request.",
              },
            },
        { status: upstream.status }
      );
    }

    return NextResponse.json(
      parsed && typeof parsed === "object"
        ? parsed
        : {
            ok: true,
            message: "Demo request received.",
          },
      { status: upstream.status }
    );
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          message: "Unable to submit demo request right now.",
        },
      },
      { status: 500 }
    );
  }
}