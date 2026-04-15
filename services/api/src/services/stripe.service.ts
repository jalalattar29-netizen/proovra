import crypto from "node:crypto";

type StripeEvent = {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

function must(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function stripeApiBase() {
  return "https://api.stripe.com/v1";
}

export async function stripeRequest(path: string, body: URLSearchParams) {
  const res = await fetch(`${stripeApiBase()}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${must("STRIPE_SECRET_KEY")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stripe error: ${text}`);
  }

  return (await res.json()) as Record<string, unknown>;
}

export async function stripeRequestRaw(
  path: string,
  method: "POST" | "DELETE",
  body?: URLSearchParams
) {
  const res = await fetch(`${stripeApiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${must("STRIPE_SECRET_KEY")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stripe error: ${text}`);
  }

  return (await res.json()) as Record<string, unknown>;
}

export function verifyStripeSignature(rawBody: Buffer, signature: string) {
  const secret = must("STRIPE_WEBHOOK_SECRET");
  const items = signature.split(",");
  const timestamp = items.find((item) => item.startsWith("t="))?.slice(2);
  const sig = items.find((item) => item.startsWith("v1="))?.slice(3);

  if (!timestamp || !sig) {
    throw new Error("Invalid signature header");
  }

  const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
    throw new Error("Invalid webhook signature");
  }

  return true;
}

export function parseStripeEvent(rawBody: Buffer): StripeEvent {
  return JSON.parse(rawBody.toString("utf8")) as StripeEvent;
}

export async function stripeGet(path: string) {
  const res = await fetch(`${stripeApiBase()}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${must("STRIPE_SECRET_KEY")}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stripe error: ${text}`);
  }

  return (await res.json()) as Record<string, unknown>;
}