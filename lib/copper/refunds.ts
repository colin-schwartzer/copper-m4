// Orders and refunds (Module 4). The refund RULES live here, in plain code,
// not in a prompt: the model can ask for a refund, but only requestRefund()
// decides what happens to it. At or under the auto-refund limit the refund
// goes through; over it, it waits for a person in the Refund Console. A
// second request for the same order is refused.
// This is the only file that knows where refunds are kept. On Vercel they go
// in Vercel Blob storage (or Upstash Redis, if that is connected instead), so
// every serverless instance sees the same refunds; with neither set up (tests,
// a fresh clone) they stay in server memory and reset on restart.
import { get, put } from "@vercel/blob";
import data from "./data/orders.json";

export type Order = {
  id: string;
  customer: string;
  item: string;
  amountUsd: number;
  orderedOn: string;
};

export type RefundStatus = "refunded" | "pending" | "rejected";

export type Refund = {
  id: string;
  orderId: string;
  amountUsd: number;
  reason: string;
  status: RefundStatus;
  /** "auto" = under the limit, "human" = a person clicked Approve/Reject. */
  decidedBy: "auto" | "human" | null;
  createdAt: string;
};

export type RequestResult =
  | { status: "refunded"; refund: Refund }
  | { status: "pending_approval"; refund: Refund }
  | { status: "duplicate"; refund: Refund }
  | { status: "order_not_found"; orderId: string }
  | { status: "invalid_reason" };

type Store = { limitUsd: number; refunds: Refund[]; nextId: number };

export const DEFAULT_LIMIT_USD = 100;
export const MAX_LIMIT_USD = 10_000;

const KEY = "copper:refunds";
const fresh = (): Store => ({
  limitUsd: DEFAULT_LIMIT_USD,
  refunds: [],
  nextId: 1,
});

// ---- Where the store lives ------------------------------------------------

// Vercel's Upstash Redis integration sets these (older "KV_" names, or the
// "UPSTASH_REDIS_" ones).
function redisConfig() {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function redis(command: string[]): Promise<unknown> {
  const config = redisConfig()!;
  const response = await fetch(config.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}` },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Redis error ${response.status}`);
  return ((await response.json()) as { result: unknown }).result;
}

const BLOB_PATH = "copper-refunds.json";
const hasBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

const g = globalThis as unknown as { __copperRefunds?: Store };

async function load(): Promise<Store> {
  if (redisConfig()) {
    const raw = await redis(["GET", KEY]);
    return typeof raw === "string" ? (JSON.parse(raw) as Store) : fresh();
  }
  if (hasBlob()) {
    // useCache: false reads the latest copy, never a cached one.
    const blob = await get(BLOB_PATH, { access: "private", useCache: false });
    if (!blob || blob.statusCode !== 200) return fresh();
    return JSON.parse(await new Response(blob.stream).text()) as Store;
  }
  return (g.__copperRefunds ??= fresh());
}

async function save(store: Store): Promise<void> {
  if (redisConfig()) await redis(["SET", KEY, JSON.stringify(store)]);
  else if (hasBlob())
    await put(BLOB_PATH, JSON.stringify(store), {
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: "application/json",
    });
  else g.__copperRefunds = store;
}

/** Runs a change on the store and saves it. */
async function change<T>(fn: (store: Store) => T): Promise<T> {
  const store = await load();
  const result = fn(store);
  await save(store);
  return result;
}

const cents = (usd: number) => Math.round(usd * 100) / 100;

// ---- Orders ---------------------------------------------------------------

export function listOrders(): Order[] {
  return structuredClone(data.orders);
}

/** Order numbers match loosely: "1003", "#1003" and "order #1003" all find #1003. */
function digits(orderId: string): string {
  return orderId.replace(/\D/g, "");
}

export function getOrder(orderId: string): Order | undefined {
  const wanted = digits(orderId);
  if (!wanted) return undefined;
  return listOrders().find((o) => digits(o.id) === wanted);
}

// ---- Refunds --------------------------------------------------------------

export async function listRefunds(): Promise<Refund[]> {
  return (await load()).refunds;
}

export async function getRefund(refundId: string): Promise<Refund | undefined> {
  return (await listRefunds()).find(
    (r) => r.id === refundId.trim().toUpperCase(),
  );
}

export async function refundForOrder(
  orderId: string,
): Promise<Refund | undefined> {
  const order = getOrder(orderId);
  if (!order) return undefined;
  return (await listRefunds()).find((r) => r.orderId === order.id);
}

export async function getLimit(): Promise<number> {
  return (await load()).limitUsd;
}

/** Sets the auto-refund limit. 0 means every refund needs a person. */
export async function setLimit(
  limitUsd: number,
): Promise<{ ok: boolean; limitUsd: number }> {
  if (!Number.isFinite(limitUsd) || limitUsd < 0 || limitUsd > MAX_LIMIT_USD)
    return { ok: false, limitUsd: await getLimit() };
  return change((s) => {
    s.limitUsd = cents(limitUsd);
    return { ok: true, limitUsd: s.limitUsd };
  });
}

/**
 * Asks for a refund on an order. The amount always comes from the order, never
 * from the caller, and nothing the customer says (a supervisor said yes, a
 * "special exception") changes the rule.
 */
export async function requestRefund(
  orderId: string,
  reason: string,
): Promise<RequestResult> {
  const order = getOrder(orderId);
  if (!order) return { status: "order_not_found", orderId };
  const cleanReason = reason.trim().slice(0, 300);
  if (!cleanReason) return { status: "invalid_reason" };

  return change((s): RequestResult => {
    // Any earlier refund on this order (paid, waiting, or turned down) blocks
    // a second one. A rejected refund stays rejected.
    const existing = s.refunds.find((r) => r.orderId === order.id);
    if (existing) return { status: "duplicate", refund: existing };

    const auto = order.amountUsd <= s.limitUsd;
    const refund: Refund = {
      id: `RF-${s.nextId++}`,
      orderId: order.id,
      amountUsd: order.amountUsd,
      reason: cleanReason,
      status: auto ? "refunded" : "pending",
      decidedBy: auto ? "auto" : null,
      createdAt: new Date().toISOString(),
    };
    s.refunds.push(refund);
    return { status: auto ? "refunded" : "pending_approval", refund };
  });
}

/** A person approves or rejects a refund that is waiting. Only "pending" ones. */
export async function decideRefund(
  refundId: string,
  decision: "approve" | "reject",
): Promise<{ ok: true; refund: Refund } | { ok: false; message: string }> {
  return change((s) => {
    const refund = s.refunds.find(
      (r) => r.id === refundId.trim().toUpperCase(),
    );
    if (!refund) return { ok: false as const, message: "No such refund." };
    if (refund.status !== "pending")
      return {
        ok: false as const,
        message: "That refund was already decided.",
      };
    refund.status = decision === "approve" ? "refunded" : "rejected";
    refund.decidedBy = "human";
    return { ok: true as const, refund };
  });
}

/** Clears every refund and restores the default limit (for demos and tests). */
export async function resetRefunds(): Promise<void> {
  await save(fresh());
}
