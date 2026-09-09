import { object } from "./config.js";

export const CODEX_FIELDS = new Set([
  "command", "args", "cwd", "env", "env_vars", "url", "http_headers", "env_http_headers",
  "bearer_token_env_var", "enabled", "enabled_tools", "disabled_tools", "scopes",
  "startup_timeout_sec", "startup_timeout_ms", "tool_timeout_sec", "required", "experimental_environment",
]);
const variable = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
const invalid = (): never => { throw new Error("Unsupported Codex server settings."); };

function milliseconds(value: unknown, scale: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return invalid();
  const ms = value * scale;
  const rounded = Math.round(ms);
  if (Math.abs(ms - rounded) > 1e-7 || rounded < 100 || rounded > 600_000) return invalid();
  return rounded;
}

/** Convert Codex settings without resolving credentials or broadening tool filters. */
export function adaptCodexServer(raw: Record<string, unknown>) {
  const definition: Record<string, unknown> = Object.create(null);
  let escapedLiterals = false;
  const literal = (value: string) => {
    const escaped = value.replaceAll("$", () => "$$");
    const result = escaped.startsWith("!") ? `$${escaped}` : escaped;
    escapedLiterals ||= result !== value;
    return result;
  };
  const strings = (value: unknown): Record<string, string> => {
    if (!object(value) || value instanceof Date || !Object.values(value).every((item) => typeof item === "string")) return invalid();
    return value as Record<string, string>;
  };
  for (const field of ["command", "args", "cwd", "url"] as const) {
    if (raw[field] === undefined) continue;
    const value = raw[field];
    // Codex treats these values literally; Pi has no escape for ${VAR} here.
    if ((typeof value === "string" && value.includes("${")) ||
        (Array.isArray(value) && value.some((item) => typeof item === "string" && item.includes("${")))) return invalid();
    definition[field] = value;
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") return invalid();
    definition.disabled = !raw.enabled;
  }
  if (raw.required !== undefined && raw.required !== false) return invalid();
  if (raw.experimental_environment !== undefined && raw.experimental_environment !== "local") return invalid();
  for (const [from, to] of [["enabled_tools", "includeTools"], ["disabled_tools", "excludeTools"]] as const) {
    if (raw[from] === undefined) continue;
    const values = raw[from];
    // Codex filters exact names. A literal * must not become a Pi wildcard.
    if (!Array.isArray(values) || !values.every((item) => typeof item === "string" && !item.includes("*"))) return invalid();
    definition[to] = values;
  }
  if (raw.scopes !== undefined) definition.oauthScopes = raw.scopes;
  if (raw.startup_timeout_sec !== undefined && raw.startup_timeout_ms !== undefined) return invalid();
  definition.startupTimeoutMs = raw.startup_timeout_ms !== undefined
    ? milliseconds(raw.startup_timeout_ms, 1) : milliseconds(raw.startup_timeout_sec ?? 10, 1000);
  definition.toolTimeoutMs = milliseconds(raw.tool_timeout_sec ?? 60, 1000);

  if (raw.env !== undefined || raw.env_vars !== undefined) {
    const env: Record<string, string> = Object.create(null);
    for (const [key, value] of Object.entries(raw.env === undefined ? {} : strings(raw.env))) {
      if (!variable(key)) return invalid();
      env[key] = literal(value);
    }
    if (raw.env_vars !== undefined) {
      if (!Array.isArray(raw.env_vars)) return invalid();
      for (const key of raw.env_vars) {
        if (!variable(key) || Object.hasOwn(env, key)) return invalid();
        env[key] = `\${${key}}`;
      }
    }
    definition.env = env;
  }
  if (raw.http_headers !== undefined || raw.env_http_headers !== undefined || raw.bearer_token_env_var !== undefined) {
    const headers: Record<string, string> = Object.create(null);
    const seen = new Set<string>();
    const add = (name: string, value: string) => {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || /[\r\n]/u.test(value) || seen.has(name.toLowerCase())) return invalid();
      seen.add(name.toLowerCase());
      headers[name] = value;
    };
    for (const [name, value] of Object.entries(raw.http_headers === undefined ? {} : strings(raw.http_headers))) add(name, literal(value));
    for (const [name, key] of Object.entries(raw.env_http_headers === undefined ? {} : strings(raw.env_http_headers))) {
      if (!variable(key)) return invalid();
      add(name, `\${${key}}`);
    }
    if (raw.bearer_token_env_var !== undefined) {
      if (!variable(raw.bearer_token_env_var)) return invalid();
      add("Authorization", `Bearer \${${raw.bearer_token_env_var}}`);
    }
    definition.headers = headers;
  }
  return { definition, escapedLiterals };
}
