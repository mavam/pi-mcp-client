import { DpopSession, generateDpopKeyPair } from "@modelcontextprotocol/client";
import { calculateJwkThumbprint, exportJWK, importJWK, type JWK } from "jose";

export interface StoredDpopKey {
  issuer: string;
  clientId: string;
  privateJwk: JWK;
}

/** Persistence only; proof construction and nonce handling stay in the SDK. */
export async function createDpopKey(issuer: string, clientId: string): Promise<StoredDpopKey> {
  const pair = await generateDpopKeyPair({ alg: "ES256", extractable: true });
  return { issuer, clientId, privateJwk: await exportJWK(pair.privateKey) };
}

export async function restoreDpopSession(stored: StoredDpopKey): Promise<DpopSession> {
  const jwk = stored.privateJwk;
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" ||
      ![jwk.x, jwk.y, jwk.d].every(value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value)))
    throw new Error("Invalid DPoP key");
  // Only public fields enter proofs. Imported signing keys are non-extractable.
  const publicJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  const privateKey = await importJWK({ ...publicJwk, d: jwk.d }, "ES256", { extractable: false });
  const publicKey = await importJWK(publicJwk, "ES256");
  if (privateKey instanceof Uint8Array || publicKey instanceof Uint8Array) throw new Error("Invalid DPoP key");
  return DpopSession.create({ keyPair: { privateKey, publicKey, publicJwk,
    thumbprint: await calculateJwkThumbprint(publicJwk), alg: "ES256" } });
}
