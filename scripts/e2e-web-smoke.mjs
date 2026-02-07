const base = process.env.WEB_BASE ?? "http://localhost:3000";
const routes = ["/", "/home", "/capture", "/cases", "/teams", "/settings", "/pricing"];

const failures = [];

for (const route of routes) {
  const res = await fetch(`${base}${route}`);
  if (!res.ok) {
    failures.push(`${route} -> ${res.status}`);
  }
}

if (failures.length) {
  console.error("E2E smoke failed:");
  for (const item of failures) console.error(item);
  process.exit(1);
}

console.log("E2E smoke passed");
