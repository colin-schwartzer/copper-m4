// Orders and refunds (Module 4). The refund RULES live here, in plain code,
// not in a prompt: the model can ask for a refund, but only requestRefund()
// decides what happens to it. At or under the auto-refund limit the refund
// goes through; over it, it waits for a person in the Refund Console. A
// second request for the same order is refused.
// This is the only file that knows where refunds are kept. They live in
// server memory (they reset when the server restarts); swapping that for a
// database later means changing only `state()`.
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

const g = globalThis as unknown as { __copperRefunds?: Store };

// One store per server process, kept across hot reloads.
function state(): Store {
  return (g.__copperRefunds ??= {
    limitUsd: DEFAULT_LIMIT_USD,
    refunds: [],
    nextId: 1,
  });
}

const cents = (usd: number) => Math.round(usd * 100) / 100;

export function listOrders(): Order[] {
  return structuredClone(data.orders);
}

/** Order ids are matched loosely: " ord-1003 " finds ORD-1003. */
export function getOrder(orderId: string): Order | undefined {
  const wanted = orderId.trim().toUpperCase();
  return listOrders().find((o) => o.id === wanted);
}

export function listRefunds(): Refund[] {
  return structuredClone(state().refunds);
}

export function getRefund(refundId: string): Refund | undefined {
  return listRefunds().find((r) => r.id === refundId.trim().toUpperCase());
}

export function refundForOrder(orderId: string): Refund | undefined {
  const wanted = orderId.trim().toUpperCase();
  return listRefunds().find((r) => r.orderId === wanted);
}

export function getLimit(): number {
  return state().limitUsd;
}

/** Sets the auto-refund limit. 0 means every refund needs a person. */
export function setLimit(limitUsd: number): { ok: boolean; limitUsd: number } {
  if (!Number.isFinite(limitUsd) || limitUsd < 0 || limitUsd > MAX_LIMIT_USD)
    return { ok: false, limitUsd: state().limitUsd };
  state().limitUsd = cents(limitUsd);
  return { ok: true, limitUsd: state().limitUsd };
}

/**
 * Asks for a refund on an order. The amount always comes from the order, never
 * from the caller, and nothing the customer says (a supervisor said yes, a
 * "special exception") changes the rule.
 */
export function requestRefund(orderId: string, reason: string): RequestResult {
  const order = getOrder(orderId);
  if (!order) return { status: "order_not_found", orderId };
  const cleanReason = reason.trim().slice(0, 300);
  if (!cleanReason) return { status: "invalid_reason" };

  // Any earlier refund on this order (paid, waiting, or turned down) blocks a
  // second one. A rejected refund stays rejected.
  const existing = refundForOrder(order.id);
  if (existing) return { status: "duplicate", refund: existing };

  const s = state();
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
  return {
    status: auto ? "refunded" : "pending_approval",
    refund: structuredClone(refund),
  };
}

/** A person approves or rejects a refund that is waiting. Only "pending" ones. */
export function decideRefund(
  refundId: string,
  decision: "approve" | "reject",
): { ok: true; refund: Refund } | { ok: false; message: string } {
  const refund = state().refunds.find(
    (r) => r.id === refundId.trim().toUpperCase(),
  );
  if (!refund) return { ok: false, message: "No such refund." };
  if (refund.status !== "pending")
    return { ok: false, message: "That refund was already decided." };
  refund.status = decision === "approve" ? "refunded" : "rejected";
  refund.decidedBy = "human";
  return { ok: true, refund: structuredClone(refund) };
}

/** Clears every refund and restores the default limit (for demos and tests). */
export function resetRefunds(): void {
  g.__copperRefunds = undefined;
}
