import assert from "node:assert/strict";
import { test } from "node:test";

import { attachmentContentUrl, attachmentImageSource } from "./attachmentUrls.ts";

const API = "https://eris.example.test/api";

test("the content URL never carries a token", () => {
  assert.equal(attachmentContentUrl(API, 42), `${API}/attachments/42/content`);
  assert.equal(attachmentContentUrl(`${API}/`, 42), `${API}/attachments/42/content`);
  assert.ok(!attachmentContentUrl(API, 42).includes("token"));
});

test("API URLs get the token as an Authorization header", () => {
  assert.deepEqual(attachmentImageSource(`${API}/attachments/42/content`, API, "t0k3n"), {
    uri: `${API}/attachments/42/content`,
    headers: { Authorization: "Bearer t0k3n" },
  });
});

test("presigned storage URLs are left alone: S3 refuses a second auth method", () => {
  const presigned = "https://eris-files.example.test/eris-uploads/a.jpg?X-Amz-Signature=abc";
  assert.deepEqual(attachmentImageSource(presigned, API, "t0k3n"), { uri: presigned });
});

test("local files and a missing token get no header", () => {
  assert.deepEqual(attachmentImageSource("file:///photo.jpg", API, "t0k3n"), { uri: "file:///photo.jpg" });
  assert.deepEqual(attachmentImageSource(`${API}/attachments/1/content`, API, null), {
    uri: `${API}/attachments/1/content`,
  });
});

test("a look-alike host is not treated as the API", () => {
  const lookAlike = "https://eris.example.test/api.evil.example/x";
  assert.deepEqual(attachmentImageSource(lookAlike, API, "t0k3n"), { uri: lookAlike });
});
