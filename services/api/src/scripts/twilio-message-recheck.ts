#!/usr/bin/env node
/**
 * Twilio message recheck CLI.
 *
 * Production audit found WhatsApp CommunicationMessage rows landing
 * with the REAL Twilio SID (post the providerMessageId fix) but
 * staying QUEUED indefinitely, recipient receiving nothing, no
 * errorCode/errorMessage. The StatusCallback webhook never fires.
 *
 * Likely causes:
 *   • TWILIO_STATUS_CALLBACK_URL not configured (no callback URL was
 *     attached to the original POST /Messages.json, so Twilio has
 *     no place to send the update).
 *   • The callback URL is unreachable from Twilio (NAT, private VPC,
 *     wrong host, port blocked).
 *   • The WhatsApp recipient hasn't joined the sandbox / hasn't
 *     opted in to receive business messages (Twilio sandbox quirk).
 *   • The recipient number isn't WhatsApp-capable.
 *
 * This CLI lets an operator query Twilio's Message Logs API directly
 * by SID, see the live provider state, and persist the result back
 * to the CommunicationMessage row so the UI updates without waiting
 * on the webhook.
 *
 * INVOCATION (developer-mode tsx):
 *
 *   tsx src/scripts/twilio-message-recheck.ts \
 *     --sid SM115fece5755d5022dab681e80d469096 \
 *     --sid SM9d89913344ecf4cdac4fb6469df58bea \
 *     [--write]    # persist status/errorCode back to DB
 *     [--no-redact]  # show full from/to (DEFAULT: masked)
 *
 * INVOCATION (production):
 *
 *   node dist/scripts/twilio-message-recheck.js --sid ... --write
 *
 * Output is JSON-per-SID so it can be piped to jq or stored in a
 * runbook log. NEVER prints the auth token / API secret. From/to
 * phone numbers are masked by default — pass `--no-redact` for
 * authorized incident response only.
 *
 * Exit codes:
 *   0  every SID looked up (with or without write)
 *   1  fatal error (config missing, network failure)
 *   2  partial success (some SIDs failed; others succeeded)
 */

import { PrismaClient } from "@prisma/client";

import {
  readTwilioConfigFromEnv,
  type TwilioProviderConfig,
} from "../services/communications/twilio-provider.js";

type Args = {
  sids: string[];
  write: boolean;
  redact: boolean;
};

function parseArgs(argv: string[]): Args {
  const sids: string[] = [];
  let write = false;
  let redact = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sid") {
      const v = argv[++i];
      if (!v) usageExit("--sid expects a value");
      sids.push(v);
    } else if (a === "--write") {
      write = true;
    } else if (a === "--no-redact") {
      redact = false;
    } else if (a === "--help" || a === "-h") {
      usageExit(null);
    } else {
      usageExit(`unknown arg: ${a}`);
    }
  }
  if (sids.length === 0) usageExit("at least one --sid is required");
  return { sids, write, redact };
}

function usageExit(reason: string | null): never {
  if (reason) process.stderr.write(`error: ${reason}\n\n`);
  process.stderr.write(
    [
      "Twilio message recheck",
      "",
      "Usage:",
      "  twilio-message-recheck --sid <SM...|MM...> [--sid ...] [--write] [--no-redact]",
      "",
      "Flags:",
      "  --sid SID       Twilio Message SID (repeat for multiple)",
      "  --write         Persist status/errorCode/errorMessage back to CommunicationMessage",
      "  --no-redact     Print full from/to numbers (use only for authorized incident response)",
      "",
    ].join("\n"),
  );
  process.exit(reason ? 1 : 0);
}

function maskNumber(n: string | null): string | null {
  if (!n) return null;
  // Strip any "whatsapp:" prefix for masking, then re-add it.
  const prefix = n.startsWith("whatsapp:") ? "whatsapp:" : "";
  const raw = n.replace(/^whatsapp:/, "");
  if (raw.length <= 4) return prefix + raw;
  return `${prefix}${raw.slice(0, 4)}••${raw.slice(-2)}`;
}

type TwilioMessageRecord = {
  sid: string | null;
  status: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  from: string | null;
  to: string | null;
  direction: string | null;
  messagingServiceSid: string | null;
  dateCreated: string | null;
  dateSent: string | null;
  dateUpdated: string | null;
  apiVersion: string | null;
  price: string | null;
  priceUnit: string | null;
};

async function fetchTwilioMessage(
  config: TwilioProviderConfig,
  sid: string,
): Promise<{ ok: true; data: TwilioMessageRecord } | { ok: false; status: number; body: string }> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    config.accountSid,
  )}/Messages/${encodeURIComponent(sid)}.json`;
  // Twilio Messages API auth: Basic (apiKey:apiSecret). We
  // intentionally use API key (not the master auth token) so leaked
  // logs can be rotated without invalidating the account.
  const basic = Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString(
    "base64",
  );
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    return { ok: false, status: res.status, body: await res.text() };
  }
  const raw = (await res.json()) as Record<string, unknown>;
  const pick = (k: string): string | null => {
    const v = raw[k];
    return typeof v === "string" ? v : v == null ? null : String(v);
  };
  return {
    ok: true,
    data: {
      sid: pick("sid"),
      status: pick("status"),
      errorCode: pick("error_code"),
      errorMessage: pick("error_message"),
      from: pick("from"),
      to: pick("to"),
      direction: pick("direction"),
      messagingServiceSid: pick("messaging_service_sid"),
      dateCreated: pick("date_created"),
      dateSent: pick("date_sent"),
      dateUpdated: pick("date_updated"),
      apiVersion: pick("api_version"),
      price: pick("price"),
      priceUnit: pick("price_unit"),
    },
  };
}

/**
 * Map Twilio's wire `status` string to our `CommunicationStatus` enum.
 * Matches the mapping used by parseDeliveryWebhook + sendMessage so
 * a CLI-driven update is indistinguishable from a real webhook.
 */
function mapStatus(
  twilio: string | null,
):
  | "QUEUED"
  | "SENT"
  | "DELIVERED"
  | "FAILED"
  | "UNDELIVERED"
  | null {
  if (!twilio) return null;
  const s = twilio.toLowerCase();
  if (s === "delivered") return "DELIVERED";
  if (s === "sent") return "SENT";
  if (s === "failed") return "FAILED";
  if (s === "undelivered") return "UNDELIVERED";
  if (s === "queued" || s === "accepted" || s === "sending") return "QUEUED";
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { config, reason } = readTwilioConfigFromEnv();
  if (!config) {
    process.stderr.write(
      `Twilio config unavailable (${reason}). Set TWILIO_ACCOUNT_SID + TWILIO_API_KEY + TWILIO_API_SECRET (+ a send target) in the environment.\n`,
    );
    process.exit(1);
  }

  // Surface the StatusCallback URL config so the operator can see at
  // a glance whether webhooks would even fire for new sends.
  const callbackUrl = (process.env.TWILIO_STATUS_CALLBACK_URL ?? "").trim();
  process.stdout.write(
    JSON.stringify({
      meta: {
        accountSidSuffix: config.accountSid.slice(-4),
        statusCallbackUrlConfigured: callbackUrl.length > 0,
        statusCallbackUrl: callbackUrl ? callbackUrl : null,
        writeBack: args.write,
        redacted: args.redact,
        utcNow: new Date().toISOString(),
      },
    }) + "\n",
  );

  const prisma = args.write ? new PrismaClient() : null;
  let okCount = 0;
  let failCount = 0;
  for (const sid of args.sids) {
    const result = await fetchTwilioMessage(config, sid);
    if (!result.ok) {
      failCount += 1;
      process.stdout.write(
        JSON.stringify({
          sid,
          ok: false,
          providerHttpStatus: result.status,
          providerBody: result.body.slice(0, 400),
        }) + "\n",
      );
      continue;
    }
    const data = result.data;
    const mapped = mapStatus(data.status);
    const fromOut = args.redact ? maskNumber(data.from) : data.from;
    const toOut = args.redact ? maskNumber(data.to) : data.to;
    const out: Record<string, unknown> = {
      sid,
      ok: true,
      twilio: {
        sid: data.sid,
        status: data.status,
        errorCode: data.errorCode,
        errorMessage: data.errorMessage,
        from: fromOut,
        to: toOut,
        direction: data.direction,
        messagingServiceSid: data.messagingServiceSid,
        dateCreated: data.dateCreated,
        dateSent: data.dateSent,
        dateUpdated: data.dateUpdated,
        price: data.price,
        priceUnit: data.priceUnit,
      },
      mapped,
      diagnosis: diagnoseStuckStatus(data, callbackUrl),
    };
    if (prisma && mapped) {
      const row = await prisma.communicationMessage.findFirst({
        where: {
          provider: "TWILIO",
          providerMessageId: sid,
        },
        select: { id: true, status: true },
      });
      if (!row) {
        out.dbWrite = {
          ok: false,
          reason: "no_row_with_provider_message_id",
        };
      } else if (row.status === mapped) {
        out.dbWrite = { ok: true, noChange: true, rowId: row.id };
      } else {
        try {
          await prisma.communicationMessage.update({
            where: { id: row.id },
            data: {
              status: mapped,
              deliveredAtUtc:
                mapped === "DELIVERED" && data.dateSent
                  ? new Date(data.dateSent)
                  : undefined,
              failedAtUtc:
                mapped === "FAILED" || mapped === "UNDELIVERED"
                  ? new Date(data.dateUpdated ?? Date.now())
                  : undefined,
              errorCode: data.errorCode ?? undefined,
              errorMessage:
                data.errorMessage
                  ? data.errorMessage.slice(0, 400)
                  : undefined,
            },
          });
          out.dbWrite = {
            ok: true,
            rowId: row.id,
            from: row.status,
            to: mapped,
          };
        } catch (err) {
          out.dbWrite = {
            ok: false,
            reason: "update_failed",
            error: (err as Error).message,
          };
        }
      }
    }
    okCount += 1;
    process.stdout.write(JSON.stringify(out) + "\n");
  }

  if (prisma) await prisma.$disconnect();
  if (failCount > 0 && okCount === 0) process.exit(1);
  if (failCount > 0) process.exit(2);
  process.exit(0);
}

/**
 * Operator-friendly explanation of why a Twilio message might be
 * stuck. Distilled from Twilio's docs + the most common SMB
 * misconfigurations we've seen.
 */
function diagnoseStuckStatus(
  data: TwilioMessageRecord,
  callbackUrl: string,
): { headline: string; checks: string[] } {
  const checks: string[] = [];
  const lowStatus = (data.status ?? "").toLowerCase();
  if (data.errorCode) {
    checks.push(
      `Twilio reported errorCode ${data.errorCode} — look it up at https://www.twilio.com/docs/api/errors/${data.errorCode}`,
    );
  }
  if (lowStatus === "queued" || lowStatus === "accepted") {
    if (!callbackUrl) {
      checks.push(
        "TWILIO_STATUS_CALLBACK_URL was NOT set when this message was sent — no StatusCallback URL went with the API call, so Twilio has nowhere to deliver the eventual delivered/failed status. Persist via this CLI's --write flag, then set the env var for future sends.",
      );
    } else {
      checks.push(
        `TWILIO_STATUS_CALLBACK_URL is set to ${callbackUrl}. Confirm it is reachable from the public internet (Twilio's IP ranges) and returns 2xx within ~15s.`,
      );
    }
  }
  if (data.to?.startsWith("whatsapp:")) {
    checks.push(
      "WhatsApp pre-flight: recipient must (a) have joined the Twilio sandbox by texting the join code to your sandbox number, OR (b) be reachable via a production WhatsApp Business sender (24h business-window or template message).",
    );
    checks.push(
      "WhatsApp template requirement: outside the 24-hour customer window, only HSM-approved templates send. A raw text body will be rejected with errorCode 63016.",
    );
  }
  if (data.messagingServiceSid && !data.from) {
    checks.push(
      "MessagingServiceSid is in use — the actual sender is chosen by the service's pool. Verify the service contains a WhatsApp-capable sender for the destination region.",
    );
  }
  const headline =
    data.errorCode
      ? `${data.status ?? "unknown"} with errorCode ${data.errorCode}`
      : lowStatus === "queued" || lowStatus === "accepted"
        ? "stuck pre-delivery — Twilio holds the job; recipient has not received anything yet"
        : lowStatus === "sent"
          ? "Twilio handed off to the carrier; awaiting DELIVERED confirmation from carrier/WhatsApp"
          : lowStatus === "delivered"
            ? "delivered to recipient device"
            : data.status ?? "unknown";
  return { headline, checks };
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
