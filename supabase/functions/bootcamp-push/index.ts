import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import webPush from "npm:web-push@3.6.7";
import { createHash, timingSafeEqual } from "node:crypto";
import { isPushEndpoint } from "../_shared/push-endpoint.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } });
const secret = Deno.env.get("BOOTCAMP_PUSH_CRON_SECRET");
const publicKey = Deno.env.get("BOOTCAMP_VAPID_PUBLIC_KEY");
const privateKey = Deno.env.get("BOOTCAMP_VAPID_PRIVATE_KEY");
const subject = Deno.env.get("BOOTCAMP_ORIGIN") ?? "https://jakobhug-art.github.io";
const digest = (value: string) => createHash("sha256").update(value).digest();

type Job = {
  id: string;
  kind: "reminder" | "friend" | "test";
  body: string;
  attempts: number;
  endpoint: string;
  p256dh: string;
  auth: string;
};

async function send(job: Job) {
  if (!isPushEndpoint(job.endpoint)) return "expired";
  const url = job.kind === "friend" ? "#rangliste" : job.kind === "reminder" ? "#heute" : "#profil";
  try {
    const request = webPush.generateRequestDetails(
      { endpoint: job.endpoint, keys: { p256dh: job.p256dh, auth: job.auth } },
      JSON.stringify({ body: job.body, url, tag: "bootcamp-" + job.id }),
      { vapidDetails: { subject, publicKey: publicKey!, privateKey: privateKey! }, TTL: job.kind === "test" ? 300 : 3600,
        contentEncoding: "aes128gcm", urgency: "high" },
    );
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (name.toLowerCase() !== "content-length") headers.set(name, String(value));
    }
    const response = await fetch(request.endpoint, { method: "POST", headers, redirect: "error",
      body: Uint8Array.from(request.body), signal: AbortSignal.timeout(7000) });
    await response.body?.cancel();
    if (response.ok) return "finished";
    if (response.status === 404 || response.status === 410) return "expired";
    console.warn("Bootcamp push provider status", response.status);
    return response.status === 429 || response.status >= 500 ? "retry" : "finished";
  } catch {
    console.warn("Bootcamp push attempt failed");
    return "retry";
  }
}

Deno.serve(async (request) => {
  const supplied = request.headers.get("x-bootcamp-push-secret");
  if (request.method !== "POST" || !secret || !supplied || !timingSafeEqual(digest(secret), digest(supplied))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!publicKey || !privateKey) return Response.json({ error: "Push unavailable" }, { status: 503 });
  const { data, error } = await admin.rpc("bootcamp_claim_push_jobs");
  if (error) return Response.json({ error: "Queue unavailable" }, { status: 503 });
  const jobs: Job[] = data ?? [];
  const results = await Promise.all(jobs.map(async job => {
    const result = await send(job);
    if (result !== "retry") {
      const { error } = await admin.rpc("bootcamp_finish_push_job", { p_id: job.id, p_attempt: job.attempts, p_result: result });
      if (error) console.warn("Bootcamp push could not mark job", error.code);
    }
    return result;
  }));
  return Response.json({ processed: jobs.length, retries: results.filter(result => result === "retry").length });
});
