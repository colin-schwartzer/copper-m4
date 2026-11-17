"use server";

// The server action the Ask Copper chat calls. It streams the conversation to
// the model through callStream (lib/ai/call.ts), with or without the tools,
// and sends back each step as it happens, so the panel can show Copper
// thinking and using its tools.
// Module 4: when Copper calls hand_off_to_refund_agent, the same chat carries
// straight on with the Refund agent (its own instructions and tools), and the
// panel keeps sending `agent: "refund"` until the customer starts over.
import { hasToolCall, stepCountIs } from "ai";
import { callStream, THOUGHT_SUMMARIES } from "@/lib/ai/call";
import { createLive, type Live } from "@/lib/ai/live";
import { COPPER_INSTRUCTIONS } from "@/lib/copper/assistant/instructions";
import type {
  Agent,
  Progress,
  ToolStep,
} from "@/lib/copper/assistant/progress";
import {
  REFUND_INSTRUCTIONS,
  refundTools,
} from "@/lib/copper/assistant/refund-agent";
import { copperTools, HAND_OFF_TOOL } from "@/lib/copper/assistant/tools";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AskCopperRequest = {
  messages: ChatMessage[];
  useTools: boolean;
  /** Who has the chat. Defaults to Copper. */
  agent?: Agent;
};

export type AskCopperResult = { progress: Live<Progress> };

/** At most this many model steps (tool calls plus the reply) per question. */
const MAX_STEPS = 5;

const SORRY = "Sorry, something went wrong on my end. Please try again.";

export async function askCopper({
  messages,
  useTools,
  agent: startAgent = "copper",
}: AskCopperRequest): Promise<AskCopperResult> {
  const { live, update, done } = createLive<Progress>();
  // Without tools there is no Refund agent either: Copper answers alone.
  const startsWith: Agent = useTools ? startAgent : "copper";
  const progress: Progress = {
    steps: [],
    reply: "",
    status: "working",
    agent: startsWith,
  };
  // A fresh copy each time, so earlier updates never change underneath the
  // panel.
  const snapshot = (): Progress => ({
    ...progress,
    steps: progress.steps.map((step) => ({ ...step })),
  });
  const toolStep = (id: string) =>
    progress.steps.find(
      (step): step is ToolStep => step.type === "tool" && step.id === id,
    );

  // Without tools, send no instructions either: "always use your tools" with
  // no tools makes the model answer with nothing.
  const startStream = (who: Agent) =>
    who === "refund"
      ? callStream(
          { module: 4, feature: "refund-agent" },
          {
            messages,
            providerOptions: THOUGHT_SUMMARIES,
            instructions: REFUND_INSTRUCTIONS,
            tools: refundTools,
            stopWhen: stepCountIs(MAX_STEPS),
          },
        )
      : callStream(
          { module: 2, feature: "ask-copper" },
          {
            messages,
            providerOptions: THOUGHT_SUMMARIES,
            ...(useTools && {
              instructions: COPPER_INSTRUCTIONS,
              tools: copperTools,
              // Stop as soon as Copper hands off: the Refund agent answers.
              stopWhen: [stepCountIs(MAX_STEPS), hasToolCall(HAND_OFF_TOOL)],
            }),
          },
        );

  /** Reads one agent's stream into `progress`. True if it handed off. */
  async function consume(result: ReturnType<typeof startStream>) {
    let handedOff = false;
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "reasoning-delta": {
          const last = progress.steps.at(-1);
          if (last?.type === "thinking") last.text += part.text;
          else progress.steps.push({ type: "thinking", text: part.text });
          break;
        }
        case "tool-input-start":
          progress.steps.push({
            type: "tool",
            id: part.id,
            name: part.toolName,
            state: "calling",
          });
          break;
        case "tool-call": {
          const step = toolStep(part.toolCallId);
          if (step) step.input = part.input;
          else
            progress.steps.push({
              type: "tool",
              id: part.toolCallId,
              name: part.toolName,
              state: "calling",
              input: part.input,
            });
          break;
        }
        case "tool-result": {
          const step = toolStep(part.toolCallId);
          if (step) Object.assign(step, { output: part.output, state: "done" });
          if (part.toolName === HAND_OFF_TOOL) handedOff = true;
          break;
        }
        case "tool-error": {
          const step = toolStep(part.toolCallId);
          const message =
            part.error instanceof Error
              ? part.error.message
              : String(part.error);
          if (step) Object.assign(step, { output: message, state: "error" });
          break;
        }
        case "text-delta":
          progress.reply += part.text;
          break;
        case "error":
          throw part.error;
        default:
          continue;
      }
      update(snapshot());
    }
    return handedOff;
  }

  /**
   * Runs one agent. If the model call fails before it has said anything (the
   * model service can have a bad moment), it tries once more.
   */
  async function run(who: Agent) {
    for (let attempt = 1; ; attempt++) {
      const stepsBefore = progress.steps.length;
      try {
        return await consume(startStream(who));
      } catch (error) {
        console.error(
          `[askCopper] ${who} agent failed (try ${attempt}):`,
          error,
        );
        if (attempt >= 2 || progress.reply.trim()) throw error;
        // Drop the half-finished steps of the failed try, then try again.
        progress.steps.length = stepsBefore;
        update(snapshot());
      }
    }
  }

  // Read the stream in the background, so the panel gets the first update now.
  void (async () => {
    try {
      const handedOff = await run(startsWith);
      if (handedOff && startsWith === "copper") {
        // The Refund agent takes over; Copper's own words are dropped so the
        // customer hears from one agent at a time.
        progress.agent = "refund";
        progress.reply = "";
        update(snapshot());
        await run("refund");
      }
      progress.status = "done";
      if (!progress.reply.trim()) progress.reply = SORRY;
    } catch {
      progress.status = "error";
      if (!progress.reply.trim()) progress.reply = SORRY;
    }
    done(snapshot());
  })();

  return { progress: live };
}
