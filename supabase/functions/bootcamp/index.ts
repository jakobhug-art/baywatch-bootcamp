import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { wheel } from "../_shared/wheel.mjs";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const frontend = Deno.env.get("BOOTCAMP_ORIGIN") ?? "https://jakobhug-art.github.io";
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, serviceKey, options);
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const digest = (value: string) => createHash("sha256").update(value).digest();
const loginAddress = (handle: string) => digest(handle.toLowerCase()).toString("hex").slice(0, 48) + "@bootcamp.invalid";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const audioTypes = ["audio/webm", "audio/ogg", "audio/mp4"];
const voiceFiles = admin.storage.from("bootcamp-voice");
const cors = {
  "Access-Control-Allow-Origin": frontend,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Cache-Control": "no-store",
  "Vary": "Origin",
};

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: cors });
}

function sessionResponse(session: { access_token: string; refresh_token: string; expires_at?: number }) {
  return json({ access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at });
}

async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(name, args);
  if (!error) return json(data ?? { ok: true });
  if (/^PT[45][0-9]{2}$/.test(error.code)) return json({ error: error.message }, Number(error.code.slice(2)));
  console.error("Bootcamp RPC failed", name, error.code);
  return json({ error: "Die Anfrage konnte nicht verarbeitet werden." }, 500);
}

Deno.serve(async (request) => {
  if (request.headers.has("origin") && request.headers.get("origin") !== frontend) return json({ error: "Unbekannter Ursprung." }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const path = new URL(request.url).pathname.split("/bootcamp").at(-1);
  const auth = createClient(url, anonKey, options);
  try {
    const token = request.headers.get("authorization")?.match(/^Bearer ([\w.-]+)$/i)?.[1];
    if (path === "/state" && request.method === "GET") {
      if (!token) return json({ user: null });
      const { data, error } = await auth.auth.getUser(token);
      if (error || !data.user) return json({ error: "Bitte melde dich erneut an." }, 401);
      return rpc("bootcamp_training_state", { p_user: data.user.id });
    }
    const portrait = path?.match(/^\/portrait\/([12])$/);
    if (portrait && request.method === "GET") {
      if (!token) return json({ error: "Bitte melde dich an." }, 401);
      const { data, error } = await auth.auth.getUser(token);
      if (error || !data.user) return json({ error: "Bitte melde dich erneut an." }, 401);
      const profile = await admin.rpc("bootcamp_has_profile", { p_user: data.user.id });
      if (profile.error || !profile.data) return json({ error: "Registrierung erforderlich." }, 403);
      const photo = await admin.storage.from("bootcamp-portraits").download(portrait[1] + ".jpg");
      if (photo.error || !photo.data) return json({ error: "Foto nicht gefunden." }, 404);
      return new Response(photo.data, { headers: { ...cors, "Content-Type": "image/jpeg", "X-Content-Type-Options": "nosniff" } });
    }
    if (["/reports", "/admin/challenges"].includes(path ?? "") && request.method === "GET") {
      if (!token) return json({ error: "Bitte melde dich an." }, 401);
      const { data, error } = await auth.auth.getUser(token);
      if (error || !data.user) return json({ error: "Bitte melde dich erneut an." }, 401);
      return rpc(path === "/reports" ? "bootcamp_reports" : "bootcamp_challenges", { p_user: data.user.id });
    }
    const voice = path?.match(/^\/voice\/(\d+)$/);
    if (voice && request.method === "GET") {
      if (!token) return json({ error: "Bitte melde dich an." }, 401);
      const { data, error } = await auth.auth.getUser(token);
      if (error || !data.user) return json({ error: "Bitte melde dich erneut an." }, 401);
      const recording = await admin.rpc("bootcamp_voice_path", { p_user: data.user.id, p_id: voice[1] });
      if (recording.error || !recording.data) return json({ error: "Aufnahme nicht gefunden." }, 404);
      const signed = await voiceFiles.createSignedUrl(recording.data, 60);
      if (signed.error || !signed.data) return json({ error: "Aufnahme nicht verfügbar." }, 404);
      return json({ url: signed.data.signedUrl });
    }
    if (request.method !== "POST") return json({ error: "Seite nicht gefunden." }, 404);
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "Ungültige Anfrage." }, 400);
    const decoder = new TextDecoder();
    let size = 0;
    let raw = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > (path === "/coins/buy" ? 810000 : 4096)) {
        await reader.cancel();
        return json({ error: "Anfrage zu groß." }, 413);
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    let input;
    try { input = JSON.parse(raw); } catch { return json({ error: "Ungültige Anfrage." }, 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) return json({ error: "Ungültige Anfrage." }, 400);

    if (path === "/refresh" && typeof input.refresh_token === "string" && input.refresh_token.length <= 512) {
      const { data, error } = await auth.auth.refreshSession({ refresh_token: input.refresh_token });
      if (error || !data.session) return json({ error: "Bitte melde dich erneut an." }, 401);
      return sessionResponse(data.session);
    }
    if (path === "/logout") {
      if (token) await admin.auth.admin.signOut(token, "local");
      return json({ ok: true });
    }
    if (path === "/register" || path === "/login") {
      const handle = typeof input.handle === "string" ? input.handle.trim().normalize("NFC") : "";
      const password = input.password;
      if (!/^[\p{L}\p{N}_-]{2,24}$/u.test(handle) || typeof password !== "string" || password.length < 10 || password.length > 128) {
        return json({ error: "Name: 2–24 Zeichen. Passwort: 10–128 Zeichen." }, 400);
      }
      const email = loginAddress(handle);
      if (path === "/register") {
        const invite = Deno.env.get("BOOTCAMP_INVITE");
        if (!invite || invite.length < 16 || typeof input.invite !== "string" || !timingSafeEqual(digest(input.invite), digest(invite))) {
          return json({ error: "Der Einladungscode stimmt nicht oder fehlt." }, 403);
        }
        const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
        if (result.error || !result.data.user) return json({ error: "Dieses Konto konnte nicht angelegt werden." }, 409);
        const id = result.data.user.id;
        const profile = await admin.rpc("bootcamp_create_profile", { p_user: id, p_handle: handle });
        if (profile.error) {
          await admin.auth.admin.deleteUser(id);
          return json({ error: "Dieses Konto konnte nicht angelegt werden." }, 409);
        }
      }
      const { data, error } = await auth.auth.signInWithPassword({ email, password });
      if (error || !data.session) return json({ error: "Name oder Passwort stimmt nicht." }, 401);
      return sessionResponse(data.session);
    }

    if (!["/quantity", "/workout/finish", "/mark", "/reports", "/reports/status", "/admin/reset-points",
      "/wheel/spin", "/wheel/complete", "/coins/buy", "/coins/respond", "/admin/challenges", "/admin/members"].includes(path ?? "")) return json({ error: "Seite nicht gefunden." }, 404);
    if (!token) return json({ error: "Bitte melde dich an." }, 401);
    const { data, error } = await auth.auth.getUser(token);
    if (error || !data.user) return json({ error: "Bitte melde dich erneut an." }, 401);
    if (path === "/workout/finish" && typeof input.day === "string") {
      return rpc("bootcamp_finish_workout", { p_user: data.user.id, p_day: input.day });
    }
    if (path === "/admin/challenges") return rpc("bootcamp_save_challenge", { p_user: data.user.id, p_input: input });
    if (path === "/admin/members" && typeof input.member === "string" && uuid.test(input.member)
        && typeof input.requestId === "string" && uuid.test(input.requestId)) {
      const response = await rpc("bootcamp_manage_member", { p_admin: data.user.id, p_member: input.member,
        p_request: input.requestId, p_kind: input.kind, p_delta: Number.isSafeInteger(input.delta) ? input.delta : null,
        p_reason: typeof input.reason === "string" ? input.reason : null });
      if (!response.ok) return response;
      const result = await response.json();
      const paths: string[] = result.audioPaths ?? [];
      let audioCleanupPending = false;
      for (let start = 0; start < paths.length; start += 100) {
        const { error } = await voiceFiles.remove(paths.slice(start, start + 100));
        if (error) audioCleanupPending = true;
      }
      return json({ balance: result.balance, removed: result.removed, audioCleanupPending });
    }
    if (path === "/wheel/spin" && typeof input.day === "string" && [1, 2].includes(input.turn)) {
      const slot = randomInt(wheel.length);
      return rpc("bootcamp_spin", { p_user: data.user.id, p_day: input.day, p_turn: input.turn,
        p_slot: slot, p_card: wheel[slot], p_coins: randomInt(3) === 0 ? randomInt(1, 4) : 0 });
    }
    if (path === "/wheel/complete" && typeof input.day === "string" && [1, 2].includes(input.turn)) {
      return rpc("bootcamp_complete_spin", { p_user: data.user.id, p_day: input.day, p_turn: input.turn });
    }
    if (path === "/coins/respond" && typeof input.day === "string" && Number.isSafeInteger(input.id) && typeof input.action === "string") {
      return rpc("bootcamp_respond", { p_user: data.user.id, p_day: input.day, p_id: input.id, p_action: input.action });
    }
    if (path === "/coins/buy" && typeof input.day === "string" && typeof input.kind === "string"
        && typeof input.requestId === "string" && uuid.test(input.requestId)) {
      let audioPath: string | null = null;
      if (input.kind === "voice") {
        if (!audioTypes.includes(input.detail) || typeof input.audio !== "string" || input.audio.length > 800000
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.audio)) {
          return json({ error: "Die Aufnahme fehlt oder ist zu groß." }, 400);
        }
        let bytes: Uint8Array;
        try { bytes = Uint8Array.from(atob(input.audio), char => char.charCodeAt(0)); }
        catch { return json({ error: "Ungültige Aufnahme." }, 400); }
        audioPath = data.user.id + "/" + crypto.randomUUID();
        const upload = await voiceFiles.upload(audioPath, bytes, { contentType: input.detail });
        if (upload.error) return json({ error: "Die Aufnahme konnte nicht gespeichert werden." }, 500);
      }
      const result = await admin.rpc("bootcamp_buy", {
        p_user: data.user.id, p_day: input.day, p_request: input.requestId, p_kind: input.kind,
        p_target: typeof input.target === "string" && uuid.test(input.target) ? input.target : null,
        p_detail: typeof input.detail === "string" ? input.detail : null,
        p_source: Number.isSafeInteger(input.source) ? input.source : null, p_audio_path: audioPath,
      });
      if (audioPath && (result.data === false || /^PT4[0-9]{2}$/.test(result.error?.code ?? ""))) {
        await voiceFiles.remove([audioPath]);
      }
      if (!result.error) return json({ ok: true });
      if (/^PT4[0-9]{2}$/.test(result.error.code)) return json({ error: result.error.message }, Number(result.error.code.slice(2)));
      console.error("Bootcamp purchase failed", result.error.code);
      return json({ error: "Der Kauf konnte nicht bestätigt werden." }, 500);
    }
    if (path === "/quantity" && typeof input.day === "string" && typeof input.id === "string" && Number.isInteger(input.amount) && input.amount >= 0 && input.amount <= 10000) {
      return rpc("bootcamp_save_quantity_with_voice", { p_user: data.user.id, p_day: input.day, p_exercise: input.id, p_amount: input.amount });
    }
    if (path === "/mark" && typeof input.period === "string" && typeof input.id === "string" && typeof input.done === "boolean") {
      return rpc("bootcamp_save_mark", { p_user: data.user.id, p_week: input.period, p_exercise: input.id, p_done: input.done });
    }
    if (path === "/reports" && typeof input.kind === "string" && typeof input.title === "string" && typeof input.message === "string") {
      return rpc("bootcamp_create_report", { p_user: data.user.id, p_kind: input.kind, p_title: input.title.trim(), p_message: input.message.trim() });
    }
    if (path === "/reports/status" && Number.isSafeInteger(input.id) && typeof input.status === "string") {
      return rpc("bootcamp_report_status", { p_user: data.user.id, p_id: input.id, p_status: input.status });
    }
    if (path === "/admin/reset-points" && input.confirm === "PUNKTE RESETTEN" && typeof input.password === "string" && input.password.length <= 128 && typeof input.day === "string") {
      const profile = await admin.rpc("bootcamp_training_state", { p_user: data.user.id });
      if (profile.error || !profile.data?.user?.admin) return json({ error: "Für diese Aktion brauchst du Adminrechte." }, 403);
      const check = await auth.auth.signInWithPassword({ email: data.user.email!, password: input.password });
      if (check.error?.status === 429) return json({ error: "Zu viele Versuche. Warte einen Moment." }, 429);
      if (check.error || check.data.user?.id !== data.user.id) return json({ error: "Das Passwort stimmt nicht." }, 401);
      await admin.auth.admin.signOut(check.data.session!.access_token, "local");
      return rpc("bootcamp_reset_points", { p_user: data.user.id, p_day: input.day });
    }
    return json({ error: "Ungültige Anfrage." }, 400);
  } catch (error) {
    console.error("Bootcamp request failed", error instanceof Error ? error.name : "unknown");
    return json({ error: "Die Anfrage konnte nicht verarbeitet werden." }, 500);
  }
});
