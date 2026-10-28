import * as Crypto from "expo-crypto";
import * as WebBrowser from "expo-web-browser";

import { apiFetch } from "../api/client";
import {
  asciiBytes,
  base64UrlEncode,
  buildAuthorizeUrl,
  EntraSignInError,
  parseAuthorizationResponse,
  tokenEndpoint,
  tokenRequestBody,
  type EntraMobileConfig,
} from "./entraPkce";

// Registered on the ERIS *mobile* app registration (Mobile and desktop
// applications platform). The scheme is the app's bundle identifier, which is
// declared in app.json so only this app receives the redirect.
export const ENTRA_REDIRECT_URI =
  process.env.EXPO_PUBLIC_ENTRA_REDIRECT_URI?.trim() || "com.juancampos.eris.mobile://auth/entra";

/**
 * Sign in through Caltrans Entra in the system browser and return an ERIS
 * session token. The system browser shares the device's Entra sign-in, so
 * Conditional Access and MFA apply exactly as they do on the web.
 *
 * The Entra access token is used once, to prove the identity to ERIS, and
 * then dropped; the app keeps only the ERIS session, which ERIS can revoke.
 */
export async function signInWithEntra(config: EntraMobileConfig): Promise<string> {
  const verifier = base64UrlEncode(Crypto.getRandomBytes(32));
  const challenge = base64UrlEncode(
    new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, asciiBytes(verifier))),
  );
  const state = base64UrlEncode(Crypto.getRandomBytes(16));

  const result = await WebBrowser.openAuthSessionAsync(
    buildAuthorizeUrl(config, ENTRA_REDIRECT_URI, state, challenge),
    ENTRA_REDIRECT_URI,
  );
  if (result.type !== "success") throw new EntraSignInError("Caltrans sign-in was not completed.", "cancelled");
  const code = parseAuthorizationResponse(result.url, ENTRA_REDIRECT_URI, state);

  const tokenResponse = await fetch(tokenEndpoint(config), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenRequestBody(config, ENTRA_REDIRECT_URI, code, verifier),
  });
  const tokens = (await tokenResponse.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenResponse.ok || !tokens.access_token) {
    throw new EntraSignInError("Caltrans sign-in could not be completed.", "failed");
  }

  try {
    const session = await apiFetch<{ access_token: string }>("/auth/entra/native", {
      method: "POST",
      body: { access_token: tokens.access_token },
    });
    return session.access_token;
  } catch (error: any) {
    if (String(error?.message ?? "").startsWith("403")) {
      throw new EntraSignInError("Your Caltrans account is not linked to an active ERIS account. Ask an ERIS administrator for access.", "failed");
    }
    throw new EntraSignInError("ERIS could not verify the Caltrans sign-in. Try again.", "failed");
  }
}
