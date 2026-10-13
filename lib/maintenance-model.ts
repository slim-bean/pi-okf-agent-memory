import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { MemoryMaintenanceIssue } from "./maintenance-issue.js";
import { modelDeadline } from "./model-deadline.js";

type Model = NonNullable<ExtensionContext["model"]>;
type Input = Parameters<ExtensionContext["modelRegistry"]["streamSimple"]>[1];
/** One provider call, shared by extraction and tool-capable recovery. No new registry/session/auth file. */
export async function maintenanceModel(options: {
  context: ExtensionContext; model: Model; input: Input; signal: AbortSignal; timeoutMs?: number;
  onUsage?: (usage: any) => void; onModelEvent?: (event: any) => void;
}) {
  const { context, model, input, signal } = options;
  signal.throwIfAborted();
  if (!context.modelRegistry.hasConfiguredAuth(model)) throw new MemoryMaintenanceIssue("blocked", "model-auth", `${model.provider}/${model.id}`, `No configured auth for ${model.provider}/${model.id}`);
  const maxTokens = Math.min(8192, model.maxTokens, Math.max(256, Math.floor(model.contextWindow / 4)));
  if (JSON.stringify(input).length / 2 + maxTokens + 1000 > model.contextWindow) throw new MemoryMaintenanceIssue("deferred", "memory-context-capacity", `${model.provider}/${model.id}`, "Maintenance input exceeds model context; evidence was not silently truncated.");
  const local = new AbortController();
  const deadline = modelDeadline([signal, local.signal], options.timeoutMs);
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
    throw new Error(deadline.diagnostics().abortReason ?? String(error));
  }
  const response = await stream.result().catch(error => { throw new Error(deadline.diagnostics().abortReason ?? String(error)); });
  options.onUsage?.(response.usage);
  const diagnostics = deadline.diagnostics(response.stopReason, response.errorMessage);
  options.onModelEvent?.({ type: "end", message: response, ...diagnostics });
  if (deadline.signal.aborted || !["stop", "toolUse"].includes(response.stopReason)) throw new Error(diagnostics.abortReason ?? response.errorMessage ?? `Maintenance stopped: ${response.stopReason}`);
  signal.throwIfAborted();
  return response;
}
