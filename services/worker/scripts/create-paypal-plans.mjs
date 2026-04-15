const BASE = process.env.PAYPAL_API_BASE || "https://api-m.paypal.com";

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const SECRET = process.env.PAYPAL_SECRET;

if (!CLIENT_ID || !SECRET) {
  throw new Error("PAYPAL_CLIENT_ID or PAYPAL_SECRET is missing");
}

async function readJsonSafe(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON response (${res.status}): ${text}`);
  }
}

async function getAccessToken() {
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization:
        "Basic " + Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = await readJsonSafe(res);

  if (!res.ok) {
    throw new Error(
      `PayPal token request failed (${res.status}): ${JSON.stringify(data)}`
    );
  }

  if (!data.access_token) {
    throw new Error(`PayPal token missing in response: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

async function createProduct(token, name) {
  const res = await fetch(`${BASE}/v1/catalogs/products`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      name,
      type: "SERVICE",
      category: "SOFTWARE",
      description: `${name} subscription plan`,
    }),
  });

  const data = await readJsonSafe(res);

  if (!res.ok) {
    throw new Error(
      `Create product failed for "${name}" (${res.status}): ${JSON.stringify(data)}`
    );
  }

  console.log(`Product ${name}: ${data.id}`);
  return data.id;
}

async function createPlan(token, productId, name, price, currency) {
  const res = await fetch(`${BASE}/v1/billing/plans`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      product_id: productId,
      name,
      description: `${name} monthly subscription`,
      status: "ACTIVE",
      billing_cycles: [
        {
          frequency: {
            interval_unit: "MONTH",
            interval_count: 1,
          },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: {
              value: String(price),
              currency_code: currency,
            },
          },
        },
      ],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee: {
          value: "0",
          currency_code: currency,
        },
        setup_fee_failure_action: "CONTINUE",
        payment_failure_threshold: 3,
      },
    }),
  });

  const data = await readJsonSafe(res);

  if (!res.ok) {
    throw new Error(
      `Create plan failed for "${name}" (${res.status}): ${JSON.stringify(data)}`
    );
  }

  console.log(`Plan ${name}: ${data.id}`);
  return data.id;
}

async function run() {
  console.log("Getting PayPal access token...");
  const token = await getAccessToken();

  console.log("Creating products...");
  const proProduct = await createProduct(token, "PROOVRA Pro");
  const teamProduct = await createProduct(token, "PROOVRA Team");

  console.log("Creating plans...");
  const PRO_EUR = await createPlan(token, proProduct, "PRO EUR", 19, "EUR");
  const PRO_USD = await createPlan(token, proProduct, "PRO USD", 19, "USD");
  const TEAM_EUR = await createPlan(token, teamProduct, "TEAM EUR", 79, "EUR");
  const TEAM_USD = await createPlan(token, teamProduct, "TEAM USD", 79, "USD");

  console.log("\nCOPY THESE INTO YOUR .env:\n");
  console.log(`PAYPAL_PRO_PLAN_ID_EUR=${PRO_EUR}`);
  console.log(`PAYPAL_PRO_PLAN_ID_USD=${PRO_USD}`);
  console.log(`PAYPAL_TEAM_PLAN_ID_EUR=${TEAM_EUR}`);
  console.log(`PAYPAL_TEAM_PLAN_ID_USD=${TEAM_USD}`);
}

run().catch((err) => {
  console.error("\nFAILED:\n", err);
  process.exit(1);
});