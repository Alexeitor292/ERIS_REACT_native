import assert from "node:assert/strict";
import test from "node:test";

import { shouldStartSingleSignOn, type SingleSignOnInputs } from "./loginModel.ts";

const ssoOnly: SingleSignOnInputs = {
  methodsKnown: true,
  entraEnabled: true,
  localLoginEnabled: false,
  signedIn: false,
  isInitializing: false,
  entraReason: null,
  signedOut: false,
};

test("an SSO-only deployment goes straight to Entra", () => {
  assert.equal(shouldStartSingleSignOn(ssoOnly), true);
});

test("an expired session goes straight back to Entra (usually silent)", () => {
  assert.equal(shouldStartSingleSignOn({ ...ssoOnly }), true);
});

test("a failed or refused Entra attempt shows the page instead of looping", () => {
  for (const entraReason of ["failed", "not_linked", "cancelled", "unavailable"]) {
    assert.equal(shouldStartSingleSignOn({ ...ssoOnly, entraReason }), false);
  }
});

test("signing out shows the page instead of signing straight back in", () => {
  assert.equal(shouldStartSingleSignOn({ ...ssoOnly, signedOut: true }), false);
});

test("waits for the API's answer and for the session check", () => {
  assert.equal(shouldStartSingleSignOn({ ...ssoOnly, methodsKnown: false }), false);
  assert.equal(shouldStartSingleSignOn({ ...ssoOnly, isInitializing: true }), false);
  assert.equal(shouldStartSingleSignOn({ ...ssoOnly, signedIn: true }), false);
});

test("a deployment that still offers passwords shows the page", () => {
  assert.equal(shouldStartSingleSignOn({ ...ssoOnly, localLoginEnabled: true }), false);
  assert.equal(shouldStartSingleSignOn({ ...ssoOnly, entraEnabled: false }), false);
});
