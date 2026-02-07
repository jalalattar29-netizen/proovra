type PayPalToken = { access_token: string };

function must(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function apiBase() {
  return process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com";
}

export async function getPayPalAccessToken(): Promise<string> {
  const clientId = must("PAYPAL_CLIENT_ID");
  const secret = must("PAYPAL_SECRET");
  const creds = Buffer.from(`${clientId}:${secret}`).toString("base64");
  const res = await fetch(`${apiBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal token error: ${text}`);
  }
  const data = (await res.json()) as PayPalToken;
  return data.access_token;
}

export async function paypalRequest(path: string, body: Record<string, unknown>) {
  const token = await getPayPalAccessToken();
  const res = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal error: ${text}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function verifyPayPalWebhook(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string
) {
  const headerValue = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;
  const token = await getPayPalAccessToken();
  const res = await fetch(`${apiBase()}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      auth_algo: headerValue(headers["paypal-auth-algo"]),
      cert_url: headerValue(headers["paypal-cert-url"]),
      transmission_id: headerValue(headers["paypal-transmission-id"]),
      transmission_sig: headerValue(headers["paypal-transmission-sig"]),
      transmission_time: headerValue(headers["paypal-transmission-time"]),
      webhook_id: must("PAYPAL_WEBHOOK_ID"),
      webhook_event: JSON.parse(rawBody)
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal verify error: ${text}`);
  }
  return (await res.json()) as { verification_status: string };
}
