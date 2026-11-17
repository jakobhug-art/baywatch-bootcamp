import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { drawScratchValues, drawWheelSlot, wheel } from "../_shared/wheel.mjs";
import { isPushEndpoint } from "../_shared/push-endpoint.ts";

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
const isoDay = /^\d{4}-\d{2}-\d{2}$/;
const voiceFiles = admin.storage.from("bootcamp-voice");
const workoutFiles = admin.storage.from("bootcamp-workouts");
type SeasonFile = { bucket: string; path: string; filename: string };
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

function jpegBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length > 213336 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const photo = Uint8Array.from(atob(value), byte => byte.charCodeAt(0));
    return photo.length <= 160000 && photo[0] === 255 && photo[1] === 216 && photo[2] === 255
      && photo.at(-2) === 255 && photo.at(-1) === 217 ? photo : null;
  } catch { return null; }
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
    const gallery = path?.match(/^\/gallery(?:\/(\d{1,16}))?$/);
    const media = path?.match(/^\/admin\/media(?:\/(\d{4}-\d{2}-\d{2}))?$/);
    if ((gallery || media) && request.method === "GET") {
      if (!token) return json({ error: "Bitte melde dich an." }, 401);
      const { data, error } = await auth.auth.getUser(token);
      if (error || !data.user) return json({ error: "Bitte melde dich erneut an." }, 401);
      if (gallery) {
        const member = new URL(request.url).searchParams.get("member");
        if (!gallery[1] && member !== null) {
          if (!uuid.test(member)) return json({ error: "Mitglied nicht gefunden." }, 404);
          return rpc("bootcamp_member_gallery", { p_user: data.user.id, p_member: member });
        }
        const args = { p_user: data.user.id, p_id: gallery[1] ?? null };
        if (!gallery[1]) return rpc("bootcamp_workout_gallery", args);
        const photo = await admin.rpc("bootcamp_workout_gallery", args);
        if (photo.error || !photo.data) return json({ error: "Foto nicht gefunden." }, 404);
        const signed = await workoutFiles.createSignedUrl(photo.data, 600);
        if (signed.error) return json({ error: "Foto nicht verfügbar." }, 404);
        return json({ url: signed.data.signedUrl });
      }
      if (!media?.[1]) return rpc("bootcamp_media_seasons", { p_admin: data.user.id });
      const season = new Date(media[1] + "T00:00:00Z");
      if (!Number.isFinite(season.getTime()) || season.toISOString().slice(0, 10) !== media[1]) {
        return json({ error: "Ungültige Season." }, 400);
      }
      const manifest = await rpc("bootcamp_prepare_media_backup", { p_admin: data.user.id, p_season: media[1] });
      if (!manifest.ok) return manifest;
      const { backupId, files }: { backupId: string; files: SeasonFile[] } = await manifest.json();
      const signedFiles: { filename: string; url: string }[] = [];
      for (const bucket of ["bootcamp-workouts", "bootcamp-voice"]) {
        const group = files.filter(file => file.bucket === bucket);
        for (let start = 0; start < group.length; start += 100) {
          const batch = group.slice(start, start + 100);
          const signed = await admin.storage.from(bucket).createSignedUrls(batch.map(file => file.path), 3600);
          if (signed.error || signed.data.length !== batch.length) return json({ error: "Der Download konnte nicht vorbereitet werden." }, 502);
          const links = new Map(signed.data.map(file => [file.path, file.signedUrl]));
          for (const file of batch) {
            const url = links.get(file.path);
            if (!url) return json({ error: "Eine Datei für den Download fehlt." }, 409);
            signedFiles.push({ filename: file.filename, url });
          }
        }
      }
      return json({ backupId, files: signedFiles });
    }
    if (path === "/state" && request.method === "GET") {
      if (!token) return json({ user: null });
      const { data, error } = await auth.auth.getUser(token);
      if (error || !data.user) return json({ error: "Bitte melde dich erneut an." }, 401);
      const query = new URL(request.url).searchParams;
      if (query.get("birthdays") !== "1") return rpc("bootcamp_training_state", { p_user: data.user.id });
      const stateFunction = query.get("tickets") === "2" ? "bootcamp_member_state_with_tickets" : "bootcamp_member_state";
      return rpc(stateFunction, { p_user: data.user.id, p_birthday_symbols: Array.from({ length: 3 }, () => drawScratchValues(randomInt)) });
    }
    if (path === "/profile" && request.method === "GET") {
      if (!token) return json({ error: "Bitte melde dich an." }, 401);
      const { data, error } = await auth.auth.getUser(token);
      if (error || !data.user) return json({ error: "Bitte melde dich erneut an." }, 401);
      return rpc("bootcamp_profile_settings", { p_user: data.user.id });
    }
    if (path === "/push/key" && request.method === "GET") {
      if (!token) return json({ error: "Bitte melde dich an." }, 401);
      const { data, error } = await auth.auth.getUser(token);
      if (error || !data.user) return json({ error: "Bitte melde dich erneut an." }, 401);
      const publicKey = Deno.env.get("BOOTCAMP_VAPID_PUBLIC_KEY");
      return publicKey ? json({ publicKey }) : json({ error: "Push ist gerade nicht verfügbar." }, 503);
    }
    if (path === "/wheel/activity" && request.method === "GET") {
      if (!token) return json({ error: "Bitte melde dich an." }, 401);
      const { data, error } = await auth.auth.getUser(token);
      if (error || !data.user) return json({ error: "Bitte melde dich erneut an." }, 401);
      return rpc("bootcamp_wheel_activity", { p_user: data.user.id });
    }
    if (path === "/chat" && request.method === "GET") {
      const before = new URL(request.url).searchParams.get("before");
      if (before !== null && !/^\d{1,18}$/.test(before)) return json({ error: "Ungültige Seite." }, 400);
      if (!token) return json({ error: "Bitte melde dich an." }, 401);
      const { data, error } = await auth.auth.getUser(token);
      if (error || !data.user) return json({ error: "Bitte melde dich erneut an." }, 401);
      return rpc("bootcamp_chat", { p_user: data.user.id, p_before: before });
    }
    const pollPhoto = path?.match(/^\/food-polls\/([^/]+)\/photo$/)?.[1];
    if ((path === "/food-polls" || pollPhoto) && request.method === "GET") {
      if (!token) return json({ error: "Bitte melde dich an." }, 401);
      const { data, error } = await auth.auth.getUser(token);
      if (error || !data.user) return json({ error: "Bitte melde dich erneut an." }, 401);
      if (!pollPhoto) return rpc("bootcamp_food_polls", { p_user: data.user.id });
      if (!uuid.test(pollPhoto)) return json({ error: "Foto nicht gefunden." }, 404);
      const photo = await admin.rpc("bootcamp_food_photo", { p_user: data.user.id, p_id: pollPhoto });
      if (photo.error || !photo.data) return json({ error: "Foto nicht gefunden." }, 404);
      return json({ photo: photo.data.replace(/\s/g, "") });
    }
    const member = path?.startsWith("/members/") ? path.slice("/members/".length) : null;
    if (member !== null && request.method === "GET") {
      if (!token) return json({ error: "Bitte melde dich an." }, 401);
      if (!uuid.test(member)) return json({ error: "Mitglied nicht gefunden." }, 404);
      const { data, error } = await auth.auth.getUser(token);
      if (error || !data.user) return json({ error: "Bitte melde dich erneut an." }, 401);
      return rpc("bootcamp_member_summary", { p_user: data.user.id, p_member: member });
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
    const voice = path?.match(/^\/(voice|voice-archive)\/(\d{1,16})$/);
    if ((voice || path === "/voice-archive") && request.method === "GET") {
      if (!token) return json({ error: "Bitte melde dich an." }, 401);
      const { data, error } = await auth.auth.getUser(token);
      if (error || !data.user) return json({ error: "Bitte melde dich erneut an." }, 401);
      if (!voice) {
        const before = new URL(request.url).searchParams.get("before");
        if (before !== null && !/^\d{1,16}$/.test(before)) return json({ error: "Ungültige Seite." }, 400);
        return rpc("bootcamp_voice_archive", { p_user: data.user.id, p_before: before });
      }
      const procedure = voice[1] === "voice" ? "bootcamp_voice_path" : "bootcamp_archived_voice_path";
      const recording = await admin.rpc(procedure, { p_user: data.user.id, p_id: voice[2] });
      if (recording.error?.code === "PT403") return json({ error: recording.error.message }, 403);
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
      if (size > (path === "/coins/buy" ? 810000 : path === "/workout/finish" || path === "/food-polls" ? 220000 : path === "/chat" ? 8192 : 4096)) {
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
      "/wheel/spin", "/wheel/complete", "/wheel/scratch", "/workout/skip", "/food-polls", "/food-polls/vote",
      "/coins/buy", "/coins/respond", "/admin/media/delete", "/admin/challenges", "/admin/members", "/chat", "/chat/pin",
      "/profile", "/profile/password", "/push/device"].includes(path ?? "")) return json({ error: "Seite nicht gefunden." }, 404);
    if (!token) return json({ error: "Bitte melde dich an." }, 401);
    const { data, error } = await auth.auth.getUser(token);
    if (error || !data.user) return json({ error: "Bitte melde dich erneut an." }, 401);
    if (path === "/push/device") {
      const { action, endpoint, keys } = input;
      if (!["enable", "disable", "status", "test", "test-status"].includes(action) || !isPushEndpoint(endpoint)) {
        return json({ error: "Dieses Push-Abo wird nicht unterstützt." }, 400);
      }
      if (action === "enable" && (typeof keys?.p256dh !== "string" || !/^[\w-]{87}=?$/.test(keys.p256dh) ||
          typeof keys?.auth !== "string" || !/^[\w-]{22}(==)?$/.test(keys.auth))) {
        return json({ error: "Die Gerätefreigabe konnte nicht gespeichert werden." }, 400);
      }
      if (action === "test-status") return rpc("bootcamp_push_test_status", { p_user: data.user.id, p_endpoint: endpoint });
      return rpc("bootcamp_push_device", { p_user: data.user.id, p_action: action, p_endpoint: endpoint,
        p_p256dh: action === "enable" ? keys.p256dh : null, p_auth: action === "enable" ? keys.auth : null });
    }
    if (path === "/profile") {
      if (input.birthDate !== null) {
        if (typeof input.birthDate !== "string" || !isoDay.test(input.birthDate)) return json({ error: "Ungültiges Geburtsdatum." }, 400);
        const birth = new Date(input.birthDate + "T00:00:00Z");
        if (!Number.isFinite(birth.getTime()) || birth.toISOString().slice(0, 10) !== input.birthDate) {
          return json({ error: "Ungültiges Geburtsdatum." }, 400);
        }
      }
      if (typeof input.showBirthday !== "boolean" || typeof input.friendNotifications !== "boolean") {
        return json({ error: "Prüfe deine Einstellungen." }, 400);
      }
      if ("morningReminder" in input || "eveningReminder" in input) {
        if (typeof input.morningReminder !== "boolean" || typeof input.eveningReminder !== "boolean") {
          return json({ error: "Prüfe deine Einstellungen." }, 400);
        }
        const settings = { p_user: data.user.id, p_birth: input.birthDate, p_show: input.showBirthday,
          p_morning: input.morningReminder, p_evening: input.eveningReminder, p_friends: input.friendNotifications };
        if ("chatNotifications" in input) {
          if (typeof input.chatNotifications !== "boolean") return json({ error: "Prüfe deine Einstellungen." }, 400);
          return rpc("bootcamp_save_chat_push_profile", { ...settings, p_chat: input.chatNotifications });
        }
        return rpc("bootcamp_save_fixed_push_profile", settings);
      }
      if (typeof input.workoutReminders !== "boolean" || typeof input.reminderTime !== "string"
        || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.reminderTime)) return json({ error: "Prüfe deine Einstellungen." }, 400);
      return rpc("bootcamp_save_profile_settings", { p_user: data.user.id, p_birth: input.birthDate,
        p_show: input.showBirthday, p_reminders: input.workoutReminders, p_friends: input.friendNotifications, p_time: input.reminderTime });
    }
    if (path === "/profile/password") {
      const { currentPassword, newPassword } = input;
      if (!data.user.email || typeof currentPassword !== "string" || currentPassword.length < 10 || currentPassword.length > 128
        || typeof newPassword !== "string" || newPassword.length < 10 || newPassword.length > 128 || newPassword === currentPassword) {
        return json({ error: "Wähle ein neues Passwort mit 10 bis 128 Zeichen." }, 400);
      }
      const email = data.user.email;
      const verified = await auth.auth.signInWithPassword({ email, password: currentPassword });
      if (verified.error?.status === 429) return json({ error: "Zu viele Versuche. Bitte warte kurz." }, 429);
      if (verified.error || verified.data.user?.id !== data.user.id) return json({ error: "Das aktuelle Passwort stimmt nicht." }, 403);
      const changed = await auth.auth.updateUser({ password: newPassword, current_password: currentPassword });
      if (changed.error) return json({ error: "Das Passwort konnte nicht geändert werden." }, 400);
      const signed = await auth.auth.signInWithPassword({ email, password: newPassword });
      if (signed.error || !signed.data.session) return json({ changed: true });
      return sessionResponse(signed.data.session);
    }
    if (path === "/chat") {
      const message = typeof input.body === "string" ? input.body.trim() : "";
      if (!message || [...message].length > 1000 || message.includes("\0") || typeof input.requestId !== "string" || !uuid.test(input.requestId)) {
        return json({ error: "Schreib eine Nachricht mit bis zu 1.000 Zeichen." }, 400);
      }
      return rpc("bootcamp_chat_send", { p_user: data.user.id, p_request: input.requestId, p_body: message });
    }
    if (path === "/chat/pin" && typeof input.id === "string" && /^\d{1,18}$/.test(input.id) && typeof input.pin === "boolean") {
      return rpc("bootcamp_chat_pin", { p_user: data.user.id, p_id: input.id, p_pin: input.pin });
    }
    if (path === "/workout/skip" && typeof input.day === "string" && isoDay.test(input.day) && typeof input.exercise === "string") {
      return rpc("bootcamp_choose_skip", { p_user: data.user.id, p_day: input.day, p_exercise: input.exercise });
    }
    if (path === "/food-polls") {
      if (typeof input.id !== "string" || !uuid.test(input.id) || typeof input.target !== "string" || !uuid.test(input.target)) {
        return json({ error: "Wähle ein Gruppenmitglied." }, 400);
      }
      if (!jpegBytes(input.photo)) return json({ error: "Wähle ein gültiges Beweisfoto." }, 400);
      return rpc("bootcamp_open_food_poll", { p_user: data.user.id, p_id: input.id, p_target: input.target, p_photo: input.photo });
    }
    if (path === "/food-polls/vote" && typeof input.id === "string" && uuid.test(input.id) && typeof input.guilty === "boolean") {
      return rpc("bootcamp_vote_food_poll", { p_user: data.user.id, p_id: input.id, p_guilty: input.guilty });
    }
    if (path === "/admin/media/delete") {
      if (typeof input.backupId !== "string" || !uuid.test(input.backupId)
        || !["photos", "voice", "all"].includes(input.kind) || input.confirm !== true) {
        return json({ error: "Bestätige die heruntergeladene Sicherung." }, 400);
      }
      const selected = input.kind === "photos" ? "bootcamp-workouts" : input.kind === "voice" ? "bootcamp-voice" : null;
      const manifest = await rpc("bootcamp_media_backup_batch", { p_admin: data.user.id, p_backup: input.backupId, p_bucket: selected });
      if (!manifest.ok) return manifest;
      const files: SeasonFile[] = await manifest.json();
      for (const bucket of ["bootcamp-workouts", "bootcamp-voice"]) {
        const paths = files.slice(0, 60).filter(file => file.bucket === bucket).map(file => file.path);
        if (!paths.length) continue;
        const { error } = await admin.storage.from(bucket).remove(paths);
        if (error) return json({ error: "Das Löschen wurde unterbrochen. Versuche es erneut." }, 502);
        const forgotten = await rpc("bootcamp_remove_backed_up_media", {
          p_admin: data.user.id, p_backup: input.backupId, p_bucket: bucket, p_paths: paths,
        });
        if (!forgotten.ok) return forgotten;
      }
      return json({ more: files.length > 60 });
    }
    if (path === "/workout/finish" && typeof input.day === "string") {
      if (!isoDay.test(input.day)) return json({ error: "Ungültiges Workout-Datum." }, 400);
      if (input.confirmNoPhoto === true && input.photo === undefined) {
        return rpc("bootcamp_finish_without_photo", { p_user: data.user.id, p_day: input.day });
      }
      const photo = jpegBytes(input.photo);
      if (!photo) {
        return json({ error: "Das Foto muss ein JPEG mit maximal 160 KB sein." }, 400);
      }
      const objectPath = data.user.id + "/" + input.day + "-" + crypto.randomUUID() + ".jpg";
      const uploaded = await workoutFiles.upload(objectPath, photo, { contentType: "image/jpeg", cacheControl: "300" });
      if (uploaded.error) return json({ error: "Das Foto konnte nicht gespeichert werden." }, 502);
      const result = await admin.rpc("bootcamp_finish_with_photo", { p_user: data.user.id, p_day: input.day, p_path: objectPath });
      if (result.data === false || result.error) {
        const cleanup = await workoutFiles.remove([objectPath]);
        if (cleanup.error) console.error("Workout photo cleanup failed", cleanup.error.message);
      }
      if (!result.error) return json({ ok: true });
      if (/^PT4[0-9]{2}$/.test(result.error.code)) return json({ error: result.error.message }, Number(result.error.code.slice(2)));
      console.error("Workout photo could not be linked", result.error.code);
      return json({ error: "Das Workout konnte nicht abgeschlossen werden." }, 500);
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
      const wheelVersion = input.wheelVersion === 2 ? 2 : input.expandedWheel === true ? 1 : 0;
      const slot = drawWheelSlot(randomInt, wheelVersion);
      return rpc("bootcamp_spin_with_ticket", { p_user: data.user.id, p_day: input.day, p_turn: input.turn,
        p_slot: slot, p_card: wheel[slot], p_values: drawScratchValues(randomInt) });
    }
    if (path === "/wheel/scratch" && typeof input.day === "string" && isoDay.test(input.day)) {
      const birthday = input.birthday === true;
      const ticket = input.ticket ?? 1;
      const args = { p_user: data.user.id, p_day: input.day, p_turn: input.turn };
      if (birthday && [1, 2, 3].includes(input.turn)) return rpc("bootcamp_claim_birthday_ticket", args);
      if (!birthday && [1, 2].includes(input.turn) && [1, 2].includes(ticket)) {
        return rpc("bootcamp_claim_wheel_ticket", { ...args, p_ticket: ticket });
      }
    }
    if (path === "/wheel/complete" && typeof input.day === "string" && [1, 2].includes(input.turn)) {
      return rpc("bootcamp_complete_spin", { p_user: data.user.id, p_day: input.day, p_turn: input.turn });
    }
    if (path === "/coins/respond" && typeof input.day === "string" && Number.isSafeInteger(input.id) && typeof input.action === "string") {
      return rpc("bootcamp_respond", { p_user: data.user.id, p_day: input.day, p_id: input.id, p_action: input.action });
    }
    if (path === "/coins/buy" && typeof input.day === "string" && typeof input.kind === "string"
        && typeof input.requestId === "string" && uuid.test(input.requestId)) {
      if (input.kind === "rest_voucher") {
        return rpc("bootcamp_redeem_rest_voucher", { p_user: data.user.id, p_day: input.day, p_request: input.requestId });
      }
      if (input.kind === "nickname_week" || input.kind === "nickname_season") {
        const detail = typeof input.detail === "string" ? input.detail.trim() : "";
        if ([...detail].length < 2 || [...detail].length > 40 || /\p{C}/u.test(detail)) {
          return json({ error: "Der Namenszusatz muss 2 bis 40 Zeichen lang sein." }, 400);
        }
        const result = await rpc("bootcamp_buy_nickname", {
          p_user: data.user.id, p_day: input.day, p_request: input.requestId,
          p_target: typeof input.target === "string" && uuid.test(input.target) ? input.target : null,
          p_detail: detail, p_duration: input.kind === "nickname_week" ? "week" : "season",
        });
        return result.ok ? json({ ok: true }) : result;
      }
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
