const API_BASE = process.env.PROD_API_BASE ?? "https://api.proovra.com";
const TOKEN = process.env.PROD_AUTH_TOKEN;

if (!TOKEN) {
  console.error("Missing PROD_AUTH_TOKEN env var.");
  process.exit(1);
}

async function api(path, init = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      ...(init.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} -> ${res.status} ${text}`);
  }
  return res.json();
}

async function main() {
  const created = await api("/v1/evidence", {
    method: "POST",
    body: JSON.stringify({ type: "PHOTO", mimeType: "text/plain" })
  });
  console.log("Created evidence", created.id);

  const putRes = await fetch(created.upload.putUrl, {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: "proovra-smoke"
  });
  if (!putRes.ok) {
    throw new Error(`Upload failed: ${putRes.status}`);
  }
  console.log("Uploaded");

  await api(`/v1/evidence/${created.id}/complete`, { method: "POST", body: "{}" });
  console.log("Completed");

  for (let i = 0; i < 20; i += 1) {
    try {
      const report = await api(`/v1/evidence/${created.id}/report/latest`);
      console.log("Report URL", report.url);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
