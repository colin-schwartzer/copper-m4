// The hand-off (Module 4): Copper calls hand_off_to_refund_agent, and the same
// chat carries on with the Refund agent, which has its own instructions and
// tools. A mock model stands in for Gemini, so this needs no AI key.
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalValue } from "@/lib/ai/live";
import { listRefunds, resetRefunds } from "@/lib/copper/refunds";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

const usage = {
  inputTokens: {
    total: 5,
    noCache: 5,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
type Part = Record<string, unknown>;
const finish = (reason: "stop" | "tool-calls") => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage,
});
const calls = (toolName: string, input: unknown): Part[] => [
  { type: "tool-input-start", id: "c1", toolName },
  { type: "tool-input-delta", id: "c1", delta: JSON.stringify(input) },
  { type: "tool-input-end", id: "c1" },
  {
    type: "tool-call",
    toolCallId: "c1",
    toolName,
    input: JSON.stringify(input),
  },
  finish("tool-calls"),
];
const says = (text: string): Part[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];
function modelStreaming(...steps: Part[][]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(
        (steps[step++] ?? says("")) as never[],
      ),
    }),
  });
}
const systemText = (call: { prompt: { role: string; content: unknown }[] }) =>
  call.prompt.find((m) => m.role === "system")?.content as string;

beforeEach(async () => {
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-key");
  vi.spyOn(console, "info").mockImplementation(() => {});
  await resetRefunds();
});

describe("Copper hands refunds to the Refund agent", () => {
  it("hands off, then the Refund agent asks for the refund and the limit holds it", async () => {
    model = modelStreaming(
      calls("hand_off_to_refund_agent", { summary: "wants a refund on #1003" }),
      calls("request_refund", { order_id: "#1003", reason: "not as expected" }),
      says("It is waiting for review."),
    );
    const { askCopper } = await import("@/lib/copper/assistant/ask");
    const result = await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: "Refund order #1003 please" }],
          useTools: true,
        })
      ).progress,
    );

    expect(result.status).toBe("done");
    expect(result.agent).toBe("refund");
    expect(result.reply).toBe("It is waiting for review.");
    const tools = result.steps.flatMap((s) =>
      s.type === "tool" ? [s.name] : [],
    );
    expect(tools).toEqual(["hand_off_to_refund_agent", "request_refund"]);

    // Two different agents: Copper first, then the Refund agent.
    expect(model.doStreamCalls).toHaveLength(3);
    expect(systemText(model.doStreamCalls[0])).toContain("You are Copper");
    expect(systemText(model.doStreamCalls[1])).toContain("Refund agent");
    const refundToolNames = (
      model.doStreamCalls[1].tools as { name: string }[]
    ).map((t) => t.name);
    expect(refundToolNames.sort()).toEqual([
      "check_refund_status",
      "lookup_order",
      "request_refund",
    ]);

    // The rule is code: $129 is over the $100 limit, so it is pending.
    const refunds = await listRefunds();
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ orderId: "#1003", status: "pending" });
  });

  it("once handed off, the next message goes straight to the Refund agent", async () => {
    model = modelStreaming(says("Checking on it."));
    const { askCopper } = await import("@/lib/copper/assistant/ask");
    const result = await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: "Any update?" }],
          useTools: true,
          agent: "refund",
        })
      ).progress,
    );
    expect(result.agent).toBe("refund");
    expect(model.doStreamCalls).toHaveLength(1);
    expect(systemText(model.doStreamCalls[0])).toContain("Refund agent");
  });

  it("with tools off there is no hand-off", async () => {
    model = modelStreaming(says("I can't do that without tools."));
    const { askCopper } = await import("@/lib/copper/assistant/ask");
    const result = await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: "Refund #1001" }],
          useTools: false,
          agent: "refund",
        })
      ).progress,
    );
    expect(result.agent).toBe("copper");
    expect(await listRefunds()).toHaveLength(0);
  });

  it("tries once more when the model has a bad moment", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let tries = 0;
    model = new MockLanguageModelV4({
      doStream: async () => {
        if (tries++ === 0) throw new Error("503 overloaded");
        return {
          stream: convertArrayToReadableStream(
            says("All good now.") as never[],
          ),
        };
      },
    });
    const { askCopper } = await import("@/lib/copper/assistant/ask");
    const result = await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: "Any update?" }],
          useTools: true,
          agent: "refund",
        })
      ).progress,
    );
    expect(result.status).toBe("done");
    expect(result.reply).toBe("All good now.");
    expect(tries).toBe(2);
  });
});
