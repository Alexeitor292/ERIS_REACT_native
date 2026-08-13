export function authenticatedRequestHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
