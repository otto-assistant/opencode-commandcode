/**
 * Command Code model catalog — Laguna S 2.1 free is the primary target.
 */
import { EFFORT_LEVELS, type CommandEffort, LAGUNA_MODEL_ID } from "./constants.js";

export type CommandModel = {
  id: string;
  name: string;
  resolvedId: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  /** Vision / image input support on the upstream model. */
  vision: boolean;
  /** Free-tier badge. */
  free?: boolean;
};

const LIMIT_256K = { context: 256_000, output: 32_768 } as const;

function model(
  id: string,
  name: string,
  resolvedId: string,
  limit: { context: number; output: number },
  opts?: { vision?: boolean; free?: boolean; reasoning?: boolean },
): CommandModel {
  return {
    id,
    name,
    resolvedId,
    reasoning: opts?.reasoning !== false,
    contextWindow: limit.context,
    maxTokens: limit.output,
    vision: opts?.vision === true,
    free: opts?.free,
  };
}

/**
 * Primary catalog for this plugin. Laguna is the default and exclusive
 * live-test target; aliases keep OpenCode menus short.
 */
export const COMMAND_CODE_MODELS: CommandModel[] = [
  model("laguna-s-2.1-free", "Laguna S 2.1 (free)", LAGUNA_MODEL_ID, LIMIT_256K, {
    free: true,
    vision: false,
  }),
  model("laguna", "Laguna S 2.1 (free)", LAGUNA_MODEL_ID, LIMIT_256K, {
    free: true,
    vision: false,
  }),
  model(
    "poolside/laguna-s-2.1-free",
    "Laguna S 2.1 (free)",
    LAGUNA_MODEL_ID,
    LIMIT_256K,
    { free: true, vision: false },
  ),
];

/** Placeholder so OpenCode keeps the provider visible while logged out. */
export const LOGIN_PLACEHOLDER_MODELS: CommandModel[] = [
  {
    id: "login",
    name: "Sign in to Command Code",
    resolvedId: "login",
    reasoning: false,
    contextWindow: 256_000,
    maxTokens: 8_192,
    vision: false,
  },
];

export const GENERATED_VARIANT_KEYS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export function isLoginPlaceholderModel(id: string): boolean {
  return id === "login";
}

export function getCommandModels(): CommandModel[] {
  // Deduplicate by id while preferring shorter aliases first.
  const seen = new Set<string>();
  const out: CommandModel[] = [];
  for (const m of COMMAND_CODE_MODELS) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

export function resolveCommandModelId(modelId: string): string {
  const cleaned = modelId.replace(/^command-code\//, "").trim();
  const match = COMMAND_CODE_MODELS.find(
    (m) => m.id === cleaned || m.resolvedId === cleaned,
  );
  if (match) return match.resolvedId;
  // Accept short name after last slash.
  if (!cleaned.includes("/")) {
    const bySuffix = COMMAND_CODE_MODELS.find((m) =>
      m.resolvedId.endsWith(`/${cleaned}`),
    );
    if (bySuffix) return bySuffix.resolvedId;
  }
  return cleaned || LAGUNA_MODEL_ID;
}

export function findCommandModel(modelId: string): CommandModel | undefined {
  const resolved = resolveCommandModelId(modelId);
  return (
    COMMAND_CODE_MODELS.find((m) => m.id === modelId || m.resolvedId === resolved) ||
    COMMAND_CODE_MODELS.find((m) => m.resolvedId === resolved)
  );
}

export function buildEffortVariants(
  model: CommandModel,
): Record<string, { effort: CommandEffort } | { disabled: true }> {
  if (!model.reasoning || isLoginPlaceholderModel(model.id)) return {};
  const variants: Record<
    string,
    { effort: CommandEffort } | { disabled: true }
  > = Object.fromEntries(EFFORT_LEVELS.map((effort) => [effort, { effort }]));
  for (const key of GENERATED_VARIANT_KEYS) {
    if (!(key in variants)) variants[key] = { disabled: true };
  }
  return variants;
}

export function buildConfigVariants(
  model: CommandModel,
): Record<string, { effort: CommandEffort } | { disabled: true }> {
  return buildEffortVariants(model);
}
