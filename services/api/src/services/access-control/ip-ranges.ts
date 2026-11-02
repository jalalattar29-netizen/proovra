/**
 * WHETHER AN ADDRESS IS IN A LIST OF NETWORKS (IDENT-017, IDENT-021).
 *
 * One parsed comparison for every network control. An entry is a CIDR block or a
 * single address. A string prefix is not a network: `1.2.3.4` also matched
 * `1.2.3.45`.
 */
import { BlockList, isIP } from "node:net";

type Family = "ipv4" | "ipv6";

function familyOf(ip: string): Family | null {
  const version = isIP(ip);
  return version === 4 ? "ipv4" : version === 6 ? "ipv6" : null;
}

/** An IPv4 client seen through a dual-stack socket reads as `::ffff:a.b.c.d`. */
function unmapped(ip: string): string {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return match ? match[1]! : ip;
}

export function isValidIpRange(entry: string): boolean {
  const [address, prefix, ...rest] = entry.trim().split("/");
  if (!address || rest.length > 0) return false;
  const family = familyOf(address);
  if (!family) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === "ipv4" ? 32 : 128);
}

export function ipInRanges(ip: string | null | undefined, ranges: readonly string[]): boolean {
  if (!ip) return false;
  const client = unmapped(ip.trim());
  const family = familyOf(client);
  if (!family) return false;
  const list = new BlockList();
  for (const raw of ranges) {
    const entry = raw.trim();
    if (!isValidIpRange(entry)) continue;
    const [address, prefix] = entry.split("/") as [string, string | undefined];
    const entryFamily = familyOf(address) as Family;
    if (prefix === undefined) list.addAddress(address, entryFamily);
    else list.addSubnet(address, Number(prefix), entryFamily);
  }
  return list.check(client, family);
}
