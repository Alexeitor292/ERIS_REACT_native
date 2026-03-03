import * as SecureStore from "expo-secure-store";

const CHUNK_SIZE = 1800;
const META_SUFFIX = "__meta_v1";
const PART_SUFFIX = "__part_";

type Meta = {
  version: 1;
  parts: number;
};

function metaKey(baseKey: string): string {
  return `${baseKey}${META_SUFFIX}`;
}

function partKey(baseKey: string, idx: number): string {
  return `${baseKey}${PART_SUFFIX}${idx}`;
}

function chunkText(value: string, size: number): string[] {
  if (!value) return [""];
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += size) {
    chunks.push(value.slice(i, i + size));
  }
  return chunks;
}

async function readMeta(baseKey: string): Promise<Meta | null> {
  try {
    const raw = await SecureStore.getItemAsync(metaKey(baseKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || typeof parsed.parts !== "number" || parsed.parts < 0) {
      return null;
    }
    return parsed as Meta;
  } catch {
    return null;
  }
}

async function cleanupParts(baseKey: string, from: number, toExclusive: number): Promise<void> {
  for (let i = from; i < toExclusive; i += 1) {
    try {
      await SecureStore.deleteItemAsync(partKey(baseKey, i));
    } catch {
      // ignore cleanup failures
    }
  }
}

export async function getLargeItemAsync(baseKey: string): Promise<string | null> {
  const meta = await readMeta(baseKey);
  if (meta) {
    const parts: string[] = [];
    for (let i = 0; i < meta.parts; i += 1) {
      const p = await SecureStore.getItemAsync(partKey(baseKey, i));
      if (p == null) return null;
      parts.push(p);
    }
    return parts.join("");
  }
  // Legacy single-value fallback
  return SecureStore.getItemAsync(baseKey);
}

export async function setLargeItemAsync(baseKey: string, value: string): Promise<void> {
  const chunks = chunkText(value, CHUNK_SIZE);
  const prevMeta = await readMeta(baseKey);
  const prevParts = prevMeta?.parts ?? 0;

  for (let i = 0; i < chunks.length; i += 1) {
    await SecureStore.setItemAsync(partKey(baseKey, i), chunks[i]);
  }
  await SecureStore.setItemAsync(metaKey(baseKey), JSON.stringify({ version: 1, parts: chunks.length } satisfies Meta));

  if (prevParts > chunks.length) {
    await cleanupParts(baseKey, chunks.length, prevParts);
  }

  // Remove legacy single-value key to avoid stale fallback.
  try {
    await SecureStore.deleteItemAsync(baseKey);
  } catch {
    // ignore
  }
}

export async function deleteLargeItemAsync(baseKey: string): Promise<void> {
  const meta = await readMeta(baseKey);
  if (meta) {
    await cleanupParts(baseKey, 0, meta.parts);
    try {
      await SecureStore.deleteItemAsync(metaKey(baseKey));
    } catch {
      // ignore
    }
  }
  try {
    await SecureStore.deleteItemAsync(baseKey);
  } catch {
    // ignore
  }
}
