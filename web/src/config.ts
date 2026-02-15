type AppConfig = {
  apiBaseUrl: string;
  tokenStorageKey: string;
};

export const appConfig: AppConfig = {
  apiBaseUrl:
    import.meta.env.VITE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE ??
    "http://127.0.0.1:8000",
  tokenStorageKey: import.meta.env.VITE_AUTH_TOKEN_STORAGE_KEY ?? "eris_token",
};
