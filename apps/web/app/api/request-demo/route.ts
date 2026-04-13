import { NextResponse } from "next/server";

function readApiBase() {
  const apiBase =
    process.env.NEXT_PUBLIC_API_BASE ??
    process.env.API_BASE_URL ??
    "http://localhost:8081";

  return apiBase.replace(/\/+$/, "");
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

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
        "x-demo-source-path": "/request-demo",
      },
      body: JSON.stringify({
        ...body,
        referrer: body?.referrer ?? referer ?? null,
        source: body?.source ?? "website",
        sourcePath: body?.sourcePath ?? "/request-demo",
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
              error: "Failed to submit demo request.",
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
        error: "Unable to submit demo request right now.",
      },
      { status: 500 }
    );
  }
}