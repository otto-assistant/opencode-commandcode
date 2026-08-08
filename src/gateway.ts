/**
 * Command Code gateway client — POST /alpha/generate NDJSON stream.
 */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import {
  GENERATE_ROUTE,
  emptyUsage,
  getApiBaseUrl,
  type GenerateBody,
  type StreamEvent,
  type WireMessage,
  type WireTool,
  type WireUsage,
} from "./gateway-types.js";
import { log } from "./log.js";

export type GatewayAuthHeaders = {
  apiKey: string;
  sessionId?: string;
  cliVersion?: string;
  projectSlug?: string;
};

export type GatewayGenerateParams = {
  apiKey: string;
  model: string;
  messages: WireMessage[];
  tools?: WireTool[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  effort?: string;
  permissionMode?: "standard" | "auto-accept" | "plan";
  threadId?: string;
  sessionId?: string;
  signal?: AbortSignal;
  /** Injected for tests. */
  fetchFn?: typeof fetch;
  baseUrl?: string;
  /** Override POST body builder for mocks. */
  postStream?: (
    body: GenerateBody,
    headers: Record<string, string>,
  ) => Promise<ReadableStream<Uint8Array>>;
};

export type GatewayMappedEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool_call";
      id: string;
      name: string;
      arguments: string;
      providerExecuted?: boolean;
    }
  | { kind: "tool_result"; id: string; output: string; isError?: boolean }
  | {
      kind: "finish";
      finishReason: string;
      usage: WireUsage;
      systemPromptTokens?: number;
    }
  | { kind: "error"; text: string }
  | { kind: "ignore" };

export function buildAuthHeaders(auth: GatewayAuthHeaders): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "cli",
    Authorization: `Bearer ${auth.apiKey}`,
    "x-command-code-version": auth.cliVersion || "1.15.0",
    "x-cli-environment": "cli",
    "x-taste-learning": "false",
    "x-co-flag": "false",
  };
  if (auth.sessionId) headers["x-session-id"] = auth.sessionId;
  if (auth.projectSlug) headers["x-project-slug"] = auth.projectSlug;
  return headers;
}

export function buildGenerateBody(
  params: GatewayGenerateParams,
): GenerateBody {
  const cwd = process.env.OPENCODE_COMMANDCODE_CWD || process.cwd();
  let structure: string[] = [];
  try {
    structure = readdirSync(cwd)
      .filter((name) => !name.startsWith("."))
      .sort()
      .slice(0, 200);
  } catch {
    structure = [];
  }

  return {
    config: {
      workingDir: cwd,
      date: new Date().toISOString().slice(0, 10),
      environment: process.platform,
      structure,
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: null,
    permissionMode: params.permissionMode || "auto-accept",
    ...(params.threadId ? { threadId: params.threadId } : {}),
    // Feature mode — must be a gateway feature id, not "default".
    mode: "agent",
    params: {
      model: params.model,
      messages: params.messages,
      tools: params.tools || [],
      ...(params.system ? { system: params.system } : {}),
      max_tokens: params.maxTokens ?? 32_768,
      stream: true,
      ...(typeof params.temperature === "number"
        ? { temperature: params.temperature }
        : {}),
      ...(params.effort ? { reasoning_effort: params.effort } : {}),
    },
  };
}

async function* readNdjsonLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) yield line;
      }
    }
    const tail = buffer.trim();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

export function mapStreamEvent(event: StreamEvent): GatewayMappedEvent {
  switch (event.type) {
    case "text-delta":
      return typeof event.text === "string" && event.text
        ? { kind: "text", text: event.text }
        : { kind: "ignore" };
    case "reasoning-delta":
      return typeof event.text === "string" && event.text
        ? { kind: "reasoning", text: event.text }
        : { kind: "ignore" };
    case "reasoning-start":
    case "reasoning-end":
      return { kind: "ignore" };
    case "tool-call": {
      const id =
        (typeof event.toolCallId === "string" && event.toolCallId) ||
        `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const name =
        (typeof event.toolName === "string" && event.toolName) || "unknown";
      const raw = event.input ?? event.args ?? {};
      let args: string;
      try {
        args =
          typeof raw === "string"
            ? raw
            : JSON.stringify(raw && typeof raw === "object" ? raw : { value: raw });
      } catch {
        args = "{}";
      }
      return {
        kind: "tool_call",
        id,
        name,
        arguments: args,
        providerExecuted: event.providerExecuted === true,
      };
    }
    case "tool-result": {
      const id =
        (typeof event.toolCallId === "string" && event.toolCallId) || "";
      const raw = event.output ?? event.result ?? "";
      let output: string;
      if (typeof raw === "string") output = raw;
      else if (raw && typeof raw === "object" && "value" in (raw as object)) {
        output = String((raw as { value: unknown }).value);
      } else {
        try {
          output = JSON.stringify(raw);
        } catch {
          output = String(raw);
        }
      }
      return {
        kind: "tool_result",
        id,
        output,
        isError: event.isError === true,
      };
    }
    case "finish": {
      const usage = emptyUsage();
      const total = event.totalUsage as
        | {
            inputTokens?: number;
            outputTokens?: number;
            inputTokenDetails?: {
              cacheReadTokens?: number;
              cacheWriteTokens?: number;
            };
          }
        | undefined;
      if (total) {
        usage.inputTokens = total.inputTokens ?? 0;
        usage.outputTokens = total.outputTokens ?? 0;
        usage.cacheReadTokens =
          total.inputTokenDetails?.cacheReadTokens ?? 0;
        usage.cacheWriteTokens =
          total.inputTokenDetails?.cacheWriteTokens ?? 0;
      }
      const finishReason =
        event.finishReason === "tool-calls"
          ? "tool_calls"
          : event.finishReason === "length"
            ? "length"
            : "stop";
      return {
        kind: "finish",
        finishReason,
        usage,
        systemPromptTokens:
          typeof event.systemPromptTokens === "number"
            ? event.systemPromptTokens
            : undefined,
      };
    }
    case "error": {
      const err = event.error;
      const text =
        typeof err === "string"
          ? err
          : err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : "Command Code stream error";
      return { kind: "error", text };
    }
    case "abort":
      return { kind: "error", text: "aborted" };
    default:
      return { kind: "ignore" };
  }
}

/**
 * Stream mapped events from Command Code /alpha/generate.
 */
export async function* streamGenerate(
  params: GatewayGenerateParams,
): AsyncGenerator<GatewayMappedEvent, void, unknown> {
  const body = buildGenerateBody(params);
  const headers = buildAuthHeaders({
    apiKey: params.apiKey,
    sessionId: params.sessionId,
  });

  let stream: ReadableStream<Uint8Array>;
  if (params.postStream) {
    stream = await params.postStream(body, headers);
  } else {
    const fetchFn = params.fetchFn ?? fetch;
    const baseUrl = (params.baseUrl ?? getApiBaseUrl()).replace(/\/$/, "");
    const url = `${baseUrl}${GENERATE_ROUTE}`;
    log.info("[opencode-commandcode] POST /alpha/generate", {
      model: params.model,
      toolCount: params.tools?.length ?? 0,
      messageCount: params.messages.length,
    });
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err) {
      yield {
        kind: "error",
        text:
          err instanceof Error
            ? `network error: ${err.message}`
            : "network error",
      };
      return;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      yield {
        kind: "error",
        text: `POST ${GENERATE_ROUTE} → ${res.status} ${text.slice(0, 500)}`,
      };
      return;
    }
    if (!res.body) {
      yield { kind: "error", text: "empty stream body" };
      return;
    }
    stream = res.body;
  }

  for await (const line of readNdjsonLines(stream)) {
    let parsed: StreamEvent;
    try {
      parsed = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    yield mapStreamEvent(parsed);
  }
}

export function stableCompletionId(seed: string): string {
  return `chatcmpl_${createHash("sha1").update(seed).digest("hex").slice(0, 24)}`;
}
