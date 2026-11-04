/**
 * PRO-061 / BILLING-02, PRO-064 / BILLING-05, PRO-067 / BILLING-08 — the one
 * outbound URL policy, driven.
 *
 * Every bypass named in the three findings is refused at create by all three
 * webhook stacks (lifecycle, automation, integration), with a public literal
 * as the positive control. The send half is driven against loopback sockets
 * this file opens itself: the address resolution happens inside the
 * connection (an injected resolver answering a refused address leaves the
 * listener untouched), a redirect is not followed, and no body comes back.
 *
 * No DNS query leaves the process: every hostname is answered by an injected
 * resolver, and every other URL is a literal address.
 */
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { validateWebhookUrl } from "@proovra/shared";
import {
  LIFECYCLE_WEBHOOK_OUTBOUND_POLICY,
  OutboundAddressRefusedError,
  checkOutboundUrlResolved,
  checkOutboundUrlStatic,
  classifyOutboundAddress,
  createGuardedLookup,
  resolveLocalAllowance,
  sendOutboundRequest,
  type OutboundResolver,
} from "@proovra/shared-runtime/outbound";

import {
  validateDestinationUrlStatic,
  validateDestinationUrlWithDns,
} from "../src/services/automation/automation-webhook.service.js";
import { createWebhookEndpoint } from "../src/services/packaging/webhooks/webhook-platform.service.js";
import { webhookAllowPrivateNetworks } from "../src/services/integrations/webhooks.service.js";

/** Every form the findings reproduced, plus the neighbours of each. */
const REFUSED_DESTINATIONS = [
  // PRO-061 (lifecycle): all of these were 201 and fetched by the worker.
  "https://127.0.0.1:9/x",
  "https://169.254.169.254/latest/meta-data/",
  "https://localhost./x",
  "https://[::1]/x",
  "https://10.0.0.5/internal",
  // PRO-064 (automation): IPv4-mapped hex form, unspecified, NAT64.
  "https://[::ffff:127.0.0.1]/hook",
  "https://[::ffff:7f00:1]/hook",
  "https://[::ffff:169.254.169.254]/hook",
  "https://[::ffff:a9fe:a9fe]/hook",
  "https://[::]/hook",
  "https://[64:ff9b::a9fe:a9fe]/hook",
  // PRO-067 (integration): trailing-dot localhost and the rest of 0.0.0.0/8.
  "https://localhost./hook",
  "https://0.0.0.1/hook",
  "https://a.localhost/hook",
  // Neighbours: other spellings of loopback, link-local, CGNAT, ULA,
  // IPv4-compatible, 6to4 and Teredo wrappers.
  "https://2130706433/hook",
  "https://0x7f.1/hook",
  "https://172.16.0.1/hook",
  "https://192.168.1.1/hook",
  "https://100.64.0.1/hook",
  "https://[fe80::1]/hook",
  "https://[fc00::1]/hook",
  "https://[::127.0.0.1]/hook",
  "https://[2002:7f00:1::]/hook",
  "https://[2001:0:4136:e378::1]/hook",
];

const PUBLIC_LITERAL = "https://203.0.113.10/hook";

const noDns: OutboundResolver = async (hostname) => {
  throw Object.assign(new Error(`unexpected DNS lookup for ${hostname}`), { code: "ENOTFOUND" });
};

function resolverAnswering(map: Record<string, string[]>): OutboundResolver & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (hostname: string) => {
    calls.push(hostname);
    const answers = map[hostname];
    if (!answers) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return answers.map((address) => ({ address, family: net.isIP(address) }));
  }) as OutboundResolver & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe("the address classifier is by bytes", () => {
  it("refuses the hex form WHATWG URL produces for an IPv4-mapped address", () => {
    expect(new URL("https://[::ffff:127.0.0.1]/").hostname).toBe("[::ffff:7f00:1]");
    expect(classifyOutboundAddress("::ffff:7f00:1")).toBe("loopback_ip");
    expect(classifyOutboundAddress("::ffff:a9fe:a9fe")).toBe("metadata_service_ip");
  });

  it("answers public for a public address in every wrapper that keeps it public", () => {
    expect(classifyOutboundAddress("203.0.113.10")).toBeNull();
    expect(classifyOutboundAddress("::ffff:cb00:710a")).toBeNull();
    expect(classifyOutboundAddress("64:ff9b::808:808")).toBeNull();
    expect(classifyOutboundAddress("2606:4700:4700::1111")).toBeNull();
  });

  it("refuses a string that is not an address", () => {
    expect(classifyOutboundAddress("example.com")).toBe("invalid_url");
    expect(classifyOutboundAddress("1:2:3:4::5:6:7:8")).toBe("invalid_url");
  });
});

describe("create: every stack refuses every bypass and admits a public literal", () => {
  it.each(REFUSED_DESTINATIONS)("refuses %s", async (url) => {
    // Lifecycle (PRO-061): refused before the database is touched.
    const prismaNeverCalled = new Proxy(
      {},
      {
        get() {
          throw new Error("the database must not be reached for a refused URL");
        },
      },
    );
    await expect(
      createWebhookEndpoint({
        prisma: prismaNeverCalled as never,
        teamId: "00000000-0000-4000-8000-000000000001",
        url,
        subscribedEvents: ["evidence.created" as never],
        createdByUserId: "00000000-0000-4000-8000-000000000002",
      }),
    ).rejects.toMatchObject({ code: "WEBHOOK_ENDPOINT_URL_INVALID" });

    // Automation (PRO-064), static and with resolution.
    expect(validateDestinationUrlStatic(url).ok).toBe(false);
    expect((await validateDestinationUrlWithDns(url, noDns)).ok).toBe(false);

    // Integration (PRO-067).
    expect(validateWebhookUrl(url).ok).toBe(false);

    // The shared policy itself, as the lifecycle stack applies it.
    expect(checkOutboundUrlStatic(url, LIFECYCLE_WEBHOOK_OUTBOUND_POLICY).ok).toBe(false);
  });

  it("admits a public literal on all three stacks (positive control)", async () => {
    expect(validateDestinationUrlStatic(PUBLIC_LITERAL).ok).toBe(true);
    expect((await validateDestinationUrlWithDns(PUBLIC_LITERAL, noDns)).ok).toBe(true);
    expect(validateWebhookUrl(PUBLIC_LITERAL).ok).toBe(true);
    expect(checkOutboundUrlStatic(PUBLIC_LITERAL, LIFECYCLE_WEBHOOK_OUTBOUND_POLICY).ok).toBe(true);
  });

  it("keeps the scheme refusal (http) on all three stacks", () => {
    expect(validateDestinationUrlStatic("http://203.0.113.10/hook").ok).toBe(false);
    expect(validateWebhookUrl("http://203.0.113.10/hook").ok).toBe(false);
    expect(checkOutboundUrlStatic("http://203.0.113.10/hook", LIFECYCLE_WEBHOOK_OUTBOUND_POLICY).ok).toBe(false);
  });
});

describe("resolution: every answer must be allowed", () => {
  it("refuses a name that resolves to loopback, metadata or a mix", async () => {
    const resolver = resolverAnswering({
      "hook.example.test": ["127.0.0.1"],
      "meta.example.test": ["169.254.169.254"],
      "mixed.example.test": ["203.0.113.10", "10.0.0.1"],
      "mapped.example.test": ["::ffff:7f00:1"],
      "fine.example.test": ["203.0.113.10"],
    });
    for (const [host, reason] of [
      ["hook.example.test", "loopback_ip"],
      ["meta.example.test", "metadata_service_ip"],
      ["mixed.example.test", "private_ip"],
      ["mapped.example.test", "loopback_ip"],
    ] as const) {
      const v = await validateDestinationUrlWithDns(`https://${host}/x`, resolver);
      expect(v, host).toEqual({ ok: false, reason });
    }
    expect((await validateDestinationUrlWithDns("https://fine.example.test/x", resolver)).ok).toBe(true);
    // A trailing-dot name is resolved as the canonical name.
    expect((await checkOutboundUrlResolved("https://fine.example.test./x", LIFECYCLE_WEBHOOK_OUTBOUND_POLICY, resolver)).ok).toBe(true);
    expect(resolver.calls).toContain("fine.example.test");
  });
});

describe("send: the connection is made to the address that was checked", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()!();
  });

  async function tcpListener(): Promise<{ port: number; connections: () => number }> {
    let count = 0;
    const server = net.createServer((socket) => {
      count += 1;
      socket.destroy();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    return { port: (server.address() as AddressInfo).port, connections: () => count };
  }

  it("the guarded lookup refuses a refused answer, so the socket never connects", async () => {
    const listener = await tcpListener();
    const lookup = createGuardedLookup("none", resolverAnswering({ "rebind.example.test": ["127.0.0.1"] }));
    const error = await new Promise<unknown>((resolve) => {
      const s = net.connect({ host: "rebind.example.test", port: listener.port, lookup: lookup as never });
      s.on("connect", () => resolve(null));
      s.on("error", resolve);
    });
    expect(error).toBeInstanceOf(OutboundAddressRefusedError);
    expect((error as OutboundAddressRefusedError).reason).toBe("loopback_ip");
    expect(listener.connections()).toBe(0);
  });

  it("the same lookup connects when the allowance admits the answer (the address used is the one checked)", async () => {
    const listener = await tcpListener();
    const lookup = createGuardedLookup("loopback", resolverAnswering({ "local.example.test": ["127.0.0.1"] }));
    await new Promise<void>((resolve, reject) => {
      const s = net.connect({ host: "local.example.test", port: listener.port, lookup: lookup as never });
      s.on("connect", () => {
        s.destroy();
        resolve();
      });
      s.on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(listener.connections()).toBe(1);
  });

  it("sendOutboundRequest refuses a name that resolves to the metadata service, before any connection", async () => {
    const resolver = resolverAnswering({ "hooks.example.test": ["169.254.169.254"] });
    const result = await sendOutboundRequest({
      url: "https://hooks.example.test/x",
      headers: {},
      body: "{}",
      timeoutMs: 2_000,
      policy: LIFECYCLE_WEBHOOK_OUTBOUND_POLICY,
      resolver,
    });
    expect(result).toEqual({ kind: "refused", reason: "metadata_service_ip" });
    expect(resolver.calls).toEqual(["hooks.example.test"]);
  });

  it("sendOutboundRequest connects to exactly the address it resolved and checked", async () => {
    // A plain TCP listener: the TLS handshake cannot complete, but the
    // listener counting a connection shows where the socket went.
    const listener = await tcpListener();
    const resolver = resolverAnswering({ "pinned.example.test": ["127.0.0.1"] });
    const result = await sendOutboundRequest({
      url: `https://pinned.example.test:${listener.port}/x`,
      headers: {},
      body: "{}",
      timeoutMs: 2_000,
      policy: { requireDefaultPort: false, localAllowance: "loopback" },
      resolver,
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.requestWritten).toBe(false);
    expect(listener.connections()).toBe(1);
    // Resolved once: there is no second lookup a rebinding answer could use.
    expect(resolver.calls).toEqual(["pinned.example.test"]);
  });

  it("refuses a stored row's URL again at send, with no resolution at all", async () => {
    const result = await sendOutboundRequest({
      url: "https://localhost./x",
      headers: {},
      timeoutMs: 1_000,
      policy: LIFECYCLE_WEBHOOK_OUTBOUND_POLICY,
      resolver: noDns,
    });
    expect(result).toEqual({ kind: "refused", reason: "localhost" });
  });

  it("does not follow a redirect to the metadata service and does not return the body", async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits += 1;
      req.resume();
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end("secret-looking body");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as AddressInfo).port;
    const result = await sendOutboundRequest({
      url: `http://127.0.0.1:${port}/hook`,
      headers: { "content-type": "application/json" },
      body: "{}",
      timeoutMs: 2_000,
      // A local test receiver: the loopback allowance, which production cannot get.
      policy: { requireDefaultPort: false, localAllowance: "loopback" },
    });
    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      expect(result.status).toBe(302);
      expect(result.body).toBeUndefined();
      expect(result.responseBytes).toBeGreaterThan(0);
    }
    expect(hits).toBe(1);
  });

  it("the same loopback receiver is refused under the production policy", async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as AddressInfo).port;
    const result = await sendOutboundRequest({
      url: `https://127.0.0.1:${port}/hook`,
      headers: {},
      timeoutMs: 1_000,
      policy: LIFECYCLE_WEBHOOK_OUTBOUND_POLICY,
    });
    expect(result).toEqual({ kind: "refused", reason: "loopback_ip" });
    expect(hits).toBe(0);
  });
});

describe("local-development allowances fail closed in production", () => {
  const prior = { env: process.env.NODE_ENV, flag: process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS };
  afterEach(() => {
    if (prior.env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior.env;
    if (prior.flag === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS;
    else process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS = prior.flag;
  });

  it("resolveLocalAllowance answers none outside the named environments", () => {
    for (const nodeEnv of ["production", "staging", undefined, ""]) {
      expect(
        resolveLocalAllowance({
          requested: "private",
          flagEnabled: true,
          nodeEnv,
          permittedEnvironments: ["development", "test"],
        }),
        String(nodeEnv),
      ).toBe("none");
    }
    expect(
      resolveLocalAllowance({ requested: "private", flagEnabled: true, nodeEnv: "development", permittedEnvironments: ["development"] }),
    ).toBe("private");
  });

  it("WEBHOOK_ALLOW_PRIVATE_NETWORKS=true is ignored with NODE_ENV=production", () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS = "true";
    process.env.NODE_ENV = "production";
    expect(webhookAllowPrivateNetworks()).toBe(false);
    delete process.env.NODE_ENV;
    expect(webhookAllowPrivateNetworks()).toBe(false);
    process.env.NODE_ENV = "development";
    expect(webhookAllowPrivateNetworks()).toBe(true);
  });

  it("even the widest allowance refuses link-local and the metadata service", () => {
    expect(validateWebhookUrl("https://169.254.169.254/x", { allowPrivateNetworks: true }).ok).toBe(false);
    expect(validateWebhookUrl("https://[fe80::1]/x", { allowPrivateNetworks: true }).ok).toBe(false);
    expect(validateWebhookUrl("https://10.0.0.5/x", { allowPrivateNetworks: true }).ok).toBe(true);
  });
});
