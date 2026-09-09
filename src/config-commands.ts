import { ConfigMutationError, type ConfigMutation, type ConfigScope, type ServerConfig } from "./config.js";

export const ADD_USAGE = "Usage: /mcp add --scope global|project [--replace] [--transport http|stdio] [--header 'Name: value'] [--env KEY=value] [--oauth] [--oauth-client-id ID] [--oauth-scope SCOPE] [--oauth-callback-port PORT] <server> <url> OR <server> -- <command> [args...]. Put options before the server name.";
export const REMOVE_USAGE = "Usage: /mcp remove --scope global|project <server>. Credentials are retained; log out first if you want to remove them.";

/** Shell-like quoting only: no variable, command, glob, or shell expansion. */
export function commandWords(input: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
    } else if (char === "\\") {
      const next = input[index + 1];
      if (next === undefined) throw new ConfigMutationError("Unfinished escape in MCP command.");
      // Preserve Windows path separators and shell escapes inside secret commands.
      if (next === "\\" || next === '"' || (!quote && (next === "'" || /\s/u.test(next)))) {
        word += next;
        index++;
      } else word += char;
      started = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new ConfigMutationError("Unclosed quote in MCP command.");
  if (started) words.push(word);
  return words;
}

export function parseConfigCommand(input: string): Extract<ConfigMutation, { action: "add" | "remove" }> | undefined {
  const action = input.trimStart().split(/\s/u, 1)[0];
  if (action !== "add" && action !== "remove") return undefined;
  const words = commandWords(input);
  const usage = action === "add" ? ADD_USAGE : REMOVE_USAGE;
  const fail = (): never => { throw new ConfigMutationError(usage); };
  let scope: ConfigScope | undefined;
  let replace = false;
  let transport: "http" | "stdio" | undefined;
  const definition: ServerConfig = {};
  const seen = new Set<string>();
  let index = 1;
  while (words[index]?.startsWith("--")) {
    const flag = words[index++];
    if (seen.has(flag) && flag !== "--header" && flag !== "--env" && flag !== "--oauth-scope") fail();
    seen.add(flag);
    if (flag === "--replace" && action === "add") { replace = true; continue; }
    if (flag === "--oauth" && action === "add") { definition.oauth = true; continue; }
    const value = words[index++];
    if (value === undefined || value.startsWith("--")) fail();
    if (flag === "--scope") {
      if (value !== "global" && value !== "project") fail();
      scope = value as ConfigScope;
    } else if (action !== "add") fail();
    else if (flag === "--transport") {
      if (value !== "http" && value !== "stdio") fail();
      transport = value as "http" | "stdio";
    } else if (flag === "--oauth-client-id") {
      definition.oauthClientId = value;
    } else if (flag === "--oauth-scope") {
      definition.oauthScopes = [...(definition.oauthScopes ?? []), value];
    } else if (flag === "--oauth-callback-port") {
      if (!/^[0-9]+$/u.test(value) || Number(value) < 1 || Number(value) > 65535) fail();
      definition.oauthCallbackPort = Number(value);
    } else if (flag === "--env") {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su.exec(value);
      if (!match || Object.hasOwn(definition.env ?? {}, match[1])) fail();
      definition.env = { ...definition.env, [match![1]]: match![2] };
    } else if (flag === "--header") {
      const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/su.exec(value);
      if (!match || /[\r\n]/u.test(match[2]) ||
          Object.keys(definition.headers ?? {}).some((name) => name.toLowerCase() === match[1].toLowerCase())) fail();
      definition.headers = { ...definition.headers, [match![1]]: match![2] };
    } else fail();
  }
  const server = words[index++];
  if (!scope || !server || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(server)) fail();
  if (action === "remove") {
    if (index !== words.length) fail();
    return { action, scope: scope!, server };
  }
  if (words[index] === "--") {
    if (transport === "http") fail();
    definition.command = words[++index];
    definition.args = words.slice(index + 1);
    if (!definition.command || definition.oauth || definition.oauthClientId || definition.oauthScopes || definition.oauthCallbackPort || definition.headers) fail();
  } else {
    if (transport === "stdio" || index + 1 !== words.length || definition.env) fail();
    definition.url = words[index];
    if (!definition.url) fail();
  }
  return { action, scope: scope!, server, definition, replace };
}

/** Complete only command syntax and server names; never connection values. */
export function configCommandCompletions(input: string, servers: string[]) {
  const match = /^(add|remove)\s+(.*)$/su.exec(input.trimStart());
  if (!match) return undefined;
  const [, action, rest] = match;
  const choices = ["--scope global", "--scope project"];
  if (!/^--scope\s+(global|project)\s/u.test(rest)) {
    return choices.filter((choice) => choice.startsWith(rest)).map((choice) => ({
      value: `${action} ${choice}`, label: choice,
    }));
  }
  const args = /^--scope\s+(global|project)\s+([^\s]*)$/u.exec(rest);
  if (!args) return [];
  const [, scope, partial] = args;
  const values = action === "remove" ? servers.sort() : ["--replace", "--transport", "--header", "--env", "--oauth", "--oauth-client-id", "--oauth-scope", "--oauth-callback-port"];
  return values.filter((value) => value.startsWith(partial)).map((value) => ({
    value: `${action} --scope ${scope} ${value}`, label: value,
  }));
}
