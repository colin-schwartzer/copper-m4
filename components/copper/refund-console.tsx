"use client";

// The Refund Console (Module 4): where a person sets the auto-refund limit and
// approves or rejects the refunds that are over it. It reads the same store
// the Refund agent writes to (lib/copper/refunds.ts) and refreshes every few
// seconds, so a refund the chat just asked for shows up on its own.
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatUsd } from "@/lib/copper/catalog";
import {
  type ConsoleState,
  decide,
  getConsoleState,
  resetDemo,
  updateLimit,
} from "@/lib/copper/refund-actions";

const REFRESH_MS = 2000;

export function RefundConsole() {
  const [state, setState] = useState<ConsoleState | null>(null);
  const [limit, setLimit] = useState("");
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    try {
      setState(await getConsoleState());
    } catch {
      setMessage("Couldn't reach the server. Retrying…");
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);

  // Show the real limit until the person starts typing a new one.
  const shownLimit = editing ? limit : String(state?.limitUsd ?? "");

  async function saveLimit() {
    const value = Number(limit);
    if (limit.trim() === "" || !Number.isFinite(value) || value < 0) {
      setMessage("Enter a limit of $0 or more.");
      return;
    }
    const result = await updateLimit(value);
    setMessage(
      result.ok
        ? `Limit saved: ${formatUsd(result.limitUsd)}.`
        : "That limit isn't allowed.",
    );
    setEditing(false);
    await refresh();
  }

  async function choose(id: string, decision: "approve" | "reject") {
    const result = await decide(id, decision);
    setMessage(
      result.ok
        ? `${id} ${decision === "approve" ? "approved" : "rejected"}.`
        : result.message,
    );
    await refresh();
  }

  if (!state)
    return <p className="text-muted-foreground mt-6 text-sm">Loading…</p>;

  return (
    <div className="mt-6 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Auto-refund limit</CardTitle>
          <CardDescription>
            Refunds at or under this amount go through on their own. Anything
            over it waits here for a person. $0 means every refund waits.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <label htmlFor="limit" className="text-sm font-medium">
            Limit (USD)
          </label>
          <Input
            id="limit"
            inputMode="decimal"
            className="w-28"
            value={shownLimit}
            onChange={(event) => {
              setEditing(true);
              setLimit(event.target.value);
            }}
          />
          <Button onClick={saveLimit} disabled={!editing}>
            Save limit
          </Button>
          <span className="text-muted-foreground text-sm">
            Now: {formatUsd(state.limitUsd)}
          </span>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Waiting for approval{" "}
            <Badge variant="secondary">{state.pending.length}</Badge>
          </CardTitle>
          <CardDescription>
            The Refund agent paused on these. Your click decides, and the agent
            tells the customer.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3" data-testid="pending-refunds">
          {state.pending.length === 0 && (
            <p className="text-muted-foreground text-sm">Nothing is waiting.</p>
          )}
          {state.pending.map((refund) => (
            <div
              key={refund.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-semibold">
                  {refund.id}: {formatUsd(refund.amountUsd)} for{" "}
                  {refund.order.item}
                </p>
                <p className="text-muted-foreground">
                  {refund.order.customer}, {refund.orderId}. Reason:{" "}
                  {refund.reason}
                </p>
              </div>
              <Button size="sm" onClick={() => choose(refund.id, "approve")}>
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => choose(refund.id, "reject")}
              >
                Reject
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Orders</CardTitle>
          <CardDescription>
            Customers can ask Copper for a refund using an order number.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Refund</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.orders.map((order) => (
                <TableRow key={order.id}>
                  <TableCell className="font-mono">{order.id}</TableCell>
                  <TableCell>{order.customer}</TableCell>
                  <TableCell>{order.item}</TableCell>
                  <TableCell className="text-right">
                    {formatUsd(order.amountUsd)}
                  </TableCell>
                  <TableCell>
                    {order.refund ? (
                      <RefundBadge refund={order.refund} />
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            await resetDemo();
            setMessage(
              "Demo reset: all refunds cleared, limit back to default.",
            );
            await refresh();
          }}
        >
          Reset demo
        </Button>
        <p role="status" className="text-muted-foreground text-sm">
          {message}
        </p>
      </div>
    </div>
  );
}

function RefundBadge({
  refund,
}: {
  refund: ConsoleState["orders"][0]["refund"];
}) {
  if (!refund) return null;
  const how =
    refund.status === "pending"
      ? "waiting"
      : refund.decidedBy === "auto"
        ? "auto"
        : "by a person";
  return (
    <Badge
      variant={
        refund.status === "refunded"
          ? "default"
          : refund.status === "rejected"
            ? "destructive"
            : "secondary"
      }
    >
      {refund.id} {refund.status} ({how})
    </Badge>
  );
}
