import { createHash } from "node:crypto";

const API_BASE = process.env.PROD_API_BASE ?? "https://api.proovra.com";
const TOKEN = process.env.PROD_AUTH_TOKEN;

if (!TOKEN) {
  console.error("Missing PROD_AUTH_TOKEN env var.");
  process.exit(1);
}

function sha256Base64FromBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("base64");
}

async function api(path, init = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      ...(init.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path} -> ${res.status} ${text}`);
  }

  return res.json();
}

async function main() {
  const uploadBody = Buffer.from("proovra-smoke", "utf8");
  const checksumSha256Base64 = sha256Base64FromBuffer(uploadBody);

  const created = await api("/v1/evidence", {
    method: "POST",
    body: JSON.stringify({
      type: "PHOTO",
      mimeType: "text/plain",
      checksumSha256Base64,
    }),
  });

  console.log("Created evidence", created.id);

  const putRes = await fetch(created.upload.putUrl, {
    method: "PUT",
    headers: {
      "content-type": "text/plain",
      "x-amz-checksum-sha256": checksumSha256Base64,
    },
    body: uploadBody,
  });

  if (!putRes.ok) {
    const text = await putRes.text().catch(() => "");
    throw new Error(`Upload failed: ${putRes.status} ${text}`);
  }

  console.log("Uploaded");

  await api(`/v1/evidence/${created.id}/complete`, {
    method: "POST",
    body: "{}",
  });

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