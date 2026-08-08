/**
 * Sync Command Code CLI credentials into OpenCode auth.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  readCommandCodeCredentials,
  type CommandCodeCredentials,
} from "./credentials.js";
import { PROVIDER_ID, WHOAMI_ROUTE } from "./constants.js";
import { getApiBaseUrl, log } from "./log.js";

export type CommandCodeAuthTokens = {
  access: string;
  refresh: string;
  expires: number;
  key?: string;
};

function authJsonPath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode", "auth.json");
}

function readAuthFile(): Record<string, unknown> {
  const path = authJsonPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeAuthFile(data: Record<string, unknown>): void {
  const path = authJsonPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function writeCommandCodeAuth(
  tokens: CommandCodeAuthTokens & { key?: string },
): void {
  const existing = readAuthFile();
  const key = tokens.key || tokens.access;
  existing[PROVIDER_ID] = {
    type: "api",
    key,
    // Also keep oauth-shaped fields for hosts that expect them.
    access: key,
    refresh: tokens.refresh,
    expires: tokens.expires,
  };
  writeAuthFile(existing);
}

export function credentialsToTokens(
  creds: CommandCodeCredentials,
): CommandCodeAuthTokens {
  return {
    access: creds.apiKey,
    refresh: `cli-sync-${creds.source}`,
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
    key: creds.apiKey,
  };
}

/**
 * Sync Command Code CLI / env credentials into OpenCode auth.json.
 */
export function syncCommandCodeCredentialsToOpenCode(): CommandCodeAuthTokens | null {
  const creds = readCommandCodeCredentials();
  if (!creds?.apiKey) return null;
  const tokens = credentialsToTokens(creds);
  writeCommandCodeAuth(tokens);
  log.info(
    "[opencode-commandcode] synced Command Code credentials into OpenCode auth",
  );
  return tokens;
}

export async function validateCommandApiKey(
  apiKey: string,
  options?: { baseUrl?: string; fetchFn?: typeof fetch },
): Promise<{ valid: boolean; userName?: string; error?: string }> {
  const fetchFn = options?.fetchFn ?? fetch;
  const baseUrl = (options?.baseUrl ?? getApiBaseUrl()).replace(/\/$/, "");
  try {
    const res = await fetchFn(`${baseUrl}${WHOAMI_ROUTE}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (res.status === 401) {
      return { valid: false, error: "invalid_key" };
    }
    if (!res.ok) {
      return { valid: false, error: `server_error_${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as {
      user?: { userName?: string; name?: string };
      success?: boolean;
    } | null;
    const userName =
      body?.user?.userName || body?.user?.name || undefined;
    return { valid: true, userName };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : "network_error",
    };
  }
}
