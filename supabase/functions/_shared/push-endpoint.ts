export function isPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > 2048) return false;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash) return false;
    const host = url.hostname;
    return host === "fcm.googleapis.com" || host.endsWith(".push.apple.com") ||
      host.endsWith(".push.services.mozilla.com") || host.endsWith(".notify.windows.com");
  } catch {
    return false;
  }
}
