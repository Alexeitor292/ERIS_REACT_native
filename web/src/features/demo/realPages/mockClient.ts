import { MockRefusal, mockDatabase } from "./mockDatabase";
export class ApiError extends Error { constructor(message: string, readonly status: number, readonly detail: unknown) { super(message); } }
export const apiUrl = (path: string) => `/demo/__mock_api__${path}`;
export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  try { return await mockDatabase.request(path, init) as T; }
  catch (error) { if (error instanceof MockRefusal) throw new ApiError(error.message, error.status, error.message); throw error; }
}
