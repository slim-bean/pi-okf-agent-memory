import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { MemoryMaintenanceIssue } from "./maintenance-issue.js";
import { modelDeadline } from "./model-deadline.js";

type Model = NonNullable<ExtensionContext["model"]>;
type Input = Parameters<ExtensionContext["modelRegistry"]["streamSimple"]>[1];
/** Output ceiling shared by the call and the prompt that tells the model its budget. */
export const outputBudget = (model: Model) => Math.min(8192, model.maxTokens, Math.max(256, Math.floor(model.contextWindow / 4)));
/** Codes for calls that ran out of output tokens or wall-clock time. Review extraction answers them by splitting its section. */
export const MODEL_CAPACITY_CODES = ["model-output-limit", "model-timeout"];
/** One provider call, shared by extraction and tool-capable recovery. No new registry/session/auth file. */
export async function maintenanceModel(options: {
  context: ExtensionContext; model: Model; input: Input; signal: AbortSignal; timeoutMs?: number;
  onUsage?: (usage: any) => void; onModelEvent?: (event: any) => void;
}) {
  const { context, model, input, signal } = options;
  const modelKey = `${model.provider}/${model.id}`;
  signal.throwIfAborted();
  if (!context.modelRegistry.hasConfiguredAuth(model)) throw new MemoryMaintenanceIssue("blocked", "model-auth", modelKey, `No configured auth for ${modelKey}`);
  const maxTokens = outputBudget(model);
  if (JSON.stringify(input).length / 2 + maxTokens + 1000 > model.contextWindow) throw new MemoryMaintenanceIssue("deferred", "memory-context-capacity", modelKey, "Maintenance input exceeds model context; evidence was not silently truncated.");
  const local = new AbortController();
  const deadline = modelDeadline([signal, local.signal], options.timeoutMs);
  // Our own deadline is a structured capacity failure; caller cancellation keeps its original cause.
  const failure = (fallback: string) => {
    const { abortReason, timeoutMs, elapsedMs } = deadline.diagnostics();
    return deadline.timedOut() && !signal.aborted
      ? new MemoryMaintenanceIssue("error", "model-timeout", modelKey, abortReason!, { timeoutMs, elapsedMs })
      : new Error(abortReason ?? fallback);
  };
  options.onModelEvent?.({ type: "start", provider: model.provider, model: model.id, systemPrompt: input.systemPrompt,
    messages: input.messages, tools: input.tools, maxTokens, timeoutMs: options.timeoutMs ?? 600_000 });
  const stream = context.modelRegistry.streamSimple(model, input, { signal: deadline.signal, maxTokens, sessionId: randomUUID() });
  try {
    if (options.onModelEvent && Symbol.asyncIterator in stream) for await (const event of stream) {
      if (event.type === "text_delta" || event.type === "thinking_delta") options.onModelEvent({ type: "delta", channel: event.type === "text_delta" ? "text" : "thinking", delta: event.delta });
    }
  } catch (error) {
    local.abort(error);
    const response = await stream.result().catch(() => undefined); // retain lease until actual settlement
    if (response) options.onUsage?.(response.usage);
    throw failure(String(error));
  }
  const response = await stream.result().catch(error => { throw failure(String(error)); });
  options.onUsage?.(response.usage);
  const diagnostics = deadline.diagnostics(response.stopReason, response.errorMessage);
  options.onModelEvent?.({ type: "end", message: response, ...diagnostics });
  if (deadline.signal.aborted) throw failure(response.errorMessage ?? `Maintenance stopped: ${response.stopReason}`);
  if (response.stopReason === "length") {
    const chars = (type: string, field: string) => response.content.filter((b: any) => b.type === type).reduce((n: number, b: any) => n + (b[field]?.length ?? 0), 0);
    const output = response.usage?.output;
    throw new MemoryMaintenanceIssue("error", "model-output-limit", modelKey,
      `Model output reached its ${maxTokens}-token limit before finishing (${typeof output === "number" ? `${output} output tokens; ` : ""}visible thinking ${chars("thinking", "thinking")} chars, answer ${chars("text", "text")} chars).`,
      { stopReason: response.stopReason, maxTokens, outputTokens: output, thinkingChars: chars("thinking", "thinking"), textChars: chars("text", "text"), elapsedMs: diagnostics.elapsedMs });
  }
  if (!["stop", "toolUse"].includes(response.stopReason)) throw new Error(diagnostics.abortReason ?? response.errorMessage ?? `Maintenance stopped: ${response.stopReason}`);
  signal.throwIfAborted();
  return response;
}
