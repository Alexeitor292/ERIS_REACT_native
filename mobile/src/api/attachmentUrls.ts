// Attachment URLs never carry the ERIS bearer token. A token in a URL is
// written to TLS gateway and proxy access logs, and the ERIS API
// does not accept `?access_token=` at all.

export type AttachmentImageSource = { uri: string; headers?: Record<string, string> };

/** The API's authenticated content proxy: usable only with an Authorization header. */
export function attachmentContentUrl(apiBaseUrl: string, attachmentId: number): string {
  return `${apiBaseUrl.replace(/\/+$/, "")}/attachments/${attachmentId}/content`;
}

/**
 * An image source for `uri`. Only requests to the ERIS API get the bearer
 * token, as a header. A presigned S3 URL already carries its own signature and
 * S3 refuses a second authentication method, and a local file needs none.
 */
export function attachmentImageSource(
  uri: string,
  apiBaseUrl: string,
  token: string | null | undefined,
): AttachmentImageSource {
  const base = apiBaseUrl.replace(/\/+$/, "");
  if (token && base && uri.startsWith(`${base}/`)) {
    return { uri, headers: { Authorization: `Bearer ${token}` } };
  }
  return { uri };
}
