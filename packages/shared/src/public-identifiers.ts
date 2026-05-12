export function maskPublicEmail(value: string | null | undefined): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || !raw.includes("@")) return "Not recorded";

  const [local, domain] = raw.split("@");
  if (!local || !domain) return "Not recorded";

  const visible = local.length <= 3 ? local : local.slice(0, 3);
  return `${visible}***@${domain}`;
}

export function maskPublicEmailsInText(value: string | null | undefined): string {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return raw;

  return raw.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    (match) => maskPublicEmail(match)
  );
}
