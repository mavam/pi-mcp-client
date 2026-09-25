import { computeScopeUnion } from "@modelcontextprotocol/client";
import { OAuthProvider, type OAuthIdentity, type OAuthOptions, type SecretStore } from "./auth.js";
import { failure } from "./diagnostics.js";

/** Server scope names are data, not instructions. Keep their size and rendering bounded. */
export function parseScopes(value: string | undefined): string[] | undefined {
  if (!value || value.length > 25_699) return undefined;
  const scopes = [...new Set(value.split(" "))];
  if (scopes.length > 100 || scopes.some(scope => scope.length > 256 || !/^[\x21\x23-\x5b\x5d-\x7e]+$/u.test(scope))) return undefined;
  return scopes;
}

export function authorizationOptions(
  identity: OAuthIdentity, store: SecretStore, options: OAuthOptions, required: string[],
): OAuthOptions {
  const granted = new OAuthProvider(identity, store).tokens()?.scope;
  const scope = computeScopeUnion(options.oauthScopes?.join(" "), granted, required.join(" "));
  const scopes = parseScopes(scope);
  if (!scopes) throw failure("oauth_scope_rejected", { operation: "auth" });
  return { ...options, oauthScopes: scopes };
}

export interface ScopeChallenge {
  scopes: string[];
  identity: string;
  expires: number;
}
