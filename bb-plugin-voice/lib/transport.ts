/** Plugin id (package name minus the `bb-plugin-` prefix) — namespaces routes. */
const HTTP_BASE = "/api/v1/plugins/voice";

export function audioDownloadUrl(audioId: string): string {
  return `${HTTP_BASE}/http/audio?id=${encodeURIComponent(audioId)}`;
}

let tokenPromise: Promise<string> | null = null;

/**
 * The upload route takes a raw body, so it uses plugin-token auth (the Tasks
 * plugin's transport pattern); the token itself comes from the local-auth
 * token route once per session.
 */
function pluginToken(): Promise<string> {
  tokenPromise ??= (async () => {
    const response = await fetch(`${HTTP_BASE}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const json: unknown = await response.json().catch(() => null);
    const token =
      json && typeof json === "object" && "token" in json
        ? (json as { token: unknown }).token
        : undefined;
    if (!response.ok || typeof token !== "string") {
      throw new Error(`could not authorize the upload (HTTP ${response.status})`);
    }
    return token;
  })();
  tokenPromise.catch(() => {
    tokenPromise = null;
  });
  return tokenPromise;
}

export async function uploadRecording(input: {
  blob: Blob;
  mimeType: string;
  exchangeId: string;
  controllerId: string;
}): Promise<void> {
  const token = await pluginToken();
  const query = new URLSearchParams({
    exchangeId: input.exchangeId,
    controllerId: input.controllerId,
    mimeType: input.mimeType,
  });
  const response = await fetch(`${HTTP_BASE}/http/audio?${query.toString()}`, {
    method: "POST",
    headers: { "x-bb-plugin-token": token, "content-type": input.mimeType },
    body: input.blob,
  });
  if (response.ok) return;

  const json: unknown = await response.json().catch(() => null);
  throw new Error(
    json && typeof json === "object" && "error" in json
      ? String((json as { error: unknown }).error)
      : `upload failed (HTTP ${response.status})`,
  );
}

export async function fetchAudioChunk(
  audioId: string,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(audioDownloadUrl(audioId), { signal });
  if (!response.ok) {
    const error = new Error(
      `answer audio is unavailable (HTTP ${response.status})`,
    ) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return response.arrayBuffer();
}
