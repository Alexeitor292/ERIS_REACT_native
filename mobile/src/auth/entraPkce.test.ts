import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import {
  asciiBytes,
  base64UrlEncode,
  buildAuthorizeUrl,
  EntraSignInError,
  parseAuthorizationResponse,
  tokenEndpoint,
  tokenRequestBody,
  type EntraMobileConfig,
} from "./entraPkce.ts";

const config: EntraMobileConfig = {
  authority: "https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111",
  client_id: "55555555-5555-4555-8555-555555555555",
  scopes: ["api://22222222-2222-4222-8222-222222222222/access_as_user"],
};
const REDIRECT = "com.juancampos.eris.mobile://auth/entra";

test("base64url matches node's encoder for every length", () => {
  for (let length = 0; length < 70; length += 1) {
    const bytes = randomBytes(length);
    assert.equal(base64UrlEncode(new Uint8Array(bytes)), bytes.toString("base64url"));
  }
});

test("the S256 challenge is base64url(SHA-256(verifier)) as RFC 7636 requires", () => {
  const verifier = base64UrlEncode(new Uint8Array(randomBytes(32)));
  assert.equal(verifier.length, 43);
  const digest = createHash("sha256").update(Buffer.from(asciiBytes(verifier))).digest();
  assert.equal(base64UrlEncode(new Uint8Array(digest)), createHash("sha256").update(verifier).digest("base64url"));
});

test("the authorize URL is a PKCE code request for the ERIS API scope", () => {
  const url = new URL(buildAuthorizeUrl(config, REDIRECT, "state-1", "challenge-1"));
  assert.equal(url.origin + url.pathname, `${config.authority}/oauth2/v2.0/authorize`);
  assert.equal(url.searchParams.get("client_id"), config.client_id);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-1");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("scope"), `openid profile ${config.scopes[0]}`);
  assert.equal(url.searchParams.get("client_secret"), null);
});

test("only a Microsoft Entra tenant authority is accepted", () => {
  for (const authority of ["https://evil.example/11111111-1111-4111-8111-111111111111",
                           "http://login.microsoftonline.com/11111111-1111-4111-8111-111111111111",
                           "https://login.microsoftonline.com/common"]) {
    assert.throws(() => buildAuthorizeUrl({ ...config, authority }, REDIRECT, "s", "c"));
  }
  assert.equal(tokenEndpoint({ ...config, authority: "https://login.microsoftonline.us/11111111-1111-4111-8111-111111111111/" }),
    "https://login.microsoftonline.us/11111111-1111-4111-8111-111111111111/oauth2/v2.0/token");
});

test("the token request redeems the code with the verifier and no secret", () => {
  const body = new URLSearchParams(tokenRequestBody(config, REDIRECT, "the-code", "the-verifier"));
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "the-code");
  assert.equal(body.get("code_verifier"), "the-verifier");
  assert.equal(body.get("redirect_uri"), REDIRECT);
  assert.equal(body.get("client_secret"), null);
});

test("the redirect yields the code only for our own state", () => {
  assert.equal(parseAuthorizationResponse(`${REDIRECT}?code=abc%2B1&state=s1`, REDIRECT, "s1"), "abc+1");
  assert.throws(() => parseAuthorizationResponse(`${REDIRECT}?code=abc&state=forged`, REDIRECT, "s1"), EntraSignInError);
  assert.throws(() => parseAuthorizationResponse(`${REDIRECT}?state=s1`, REDIRECT, "s1"), EntraSignInError);
  assert.throws(() => parseAuthorizationResponse(`https://evil.example/?code=abc&state=s1`, REDIRECT, "s1"), EntraSignInError);
});

test("an Entra refusal is reported without echoing Entra's text", () => {
  try {
    parseAuthorizationResponse(`${REDIRECT}?error=access_denied&error_description=AADSTS50105%20secret%20detail&state=s1`, REDIRECT, "s1");
    assert.fail("should throw");
  } catch (error) {
    assert.ok(error instanceof EntraSignInError);
    assert.equal(error.reason, "cancelled");
    assert.ok(!error.message.includes("AADSTS"));
  }
});
