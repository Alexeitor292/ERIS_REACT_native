import assert from "node:assert/strict";
import test from "node:test";

import { readCsrfToken } from "./token.ts";

test("reads the secure CSRF cookie among others", () => {
  assert.equal(readCsrfToken("theme=dark; __Host-eris_csrf=abc123; other=1"), "abc123");
});

test("reads the development CSRF cookie", () => {
  assert.equal(readCsrfToken("eris_csrf=dev"), "dev");
});

test("ignores look-alike names and missing cookies", () => {
  assert.equal(readCsrfToken("x__Host-eris_csrf=nope; eris_csrf_old=nope"), null);
  assert.equal(readCsrfToken(""), null);
});

test("never mistakes the HttpOnly session cookie for the CSRF token", () => {
  // The session cookie is invisible to scripts; even if a name were listed, only CSRF names count.
  assert.equal(readCsrfToken("__Host-eris_session=secret"), null);
});
