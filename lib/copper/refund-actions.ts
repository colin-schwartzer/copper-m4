"use server";

// What the Refund Console and the chat call from the browser. Each one is a
// thin wrapper over lib/copper/refunds.ts, where the rules live.
import {
  decideRefund,
  getLimit,
  getRefund,
  listOrders,
  listRefunds,
  resetRefunds,
  setLimit,
  type Order,
  type Refund,
} from "@/lib/copper/refunds";

export type ConsoleState = {
  limitUsd: number;
  orders: (Order & { refund: Refund | null })[];
  pending: (Refund & { order: Order })[];
};

export async function getConsoleState(): Promise<ConsoleState> {
  const orders = listOrders();
  const [refunds, limitUsd] = await Promise.all([listRefunds(), getLimit()]);
  return {
    limitUsd,
    orders: orders.map((o) => ({
      ...o,
      refund: refunds.find((r) => r.orderId === o.id) ?? null,
    })),
    pending: refunds
      .filter((r) => r.status === "pending")
      .map((r) => ({ ...r, order: orders.find((o) => o.id === r.orderId)! })),
  };
}

export async function updateLimit(limitUsd: number) {
  return setLimit(Number(limitUsd));
}

export async function decide(refundId: string, decision: "approve" | "reject") {
  if (decision !== "approve" && decision !== "reject")
    return { ok: false as const, message: "Unknown decision." };
  return decideRefund(String(refundId), decision);
}

export async function refundStatus(refundId: string) {
  return (await getRefund(String(refundId)))?.status ?? null;
}

export async function resetDemo() {
  await resetRefunds();
}
