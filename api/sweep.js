// Daily safety net (Vercel cron): picks up any recent call the webhook missed or that errored,
// then posts any task that was created or moved in Notion since the last run.
import { listMeetings, claim, processMeeting } from "../lib/core.js";
import { discordEnabled } from "../lib/settings.js";

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return new Response("setup problem: Missing environment variable CRON_SECRET", { status: 500 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return new Response("unauthorised", { status: 401 });
  try {
    const started = Date.now();
    const meetings = await listMeetings(new Date(Date.now() - 3 * 86400e3).toISOString());
    const done = [];
    for (const m of meetings) {
      if (Date.now() - started > 200e3) break;
      const pageId = await claim(m);
      if (!pageId) continue;
      try { done.push(await processMeeting(m, pageId)); } catch (e) { done.push({ id: m.recording_id, error: String(e) }); }
    }
    let relay = "discord not configured";
    if (discordEnabled() && Date.now() - started < 200e3) {
      const { relayConfig } = await import("../lib/relay/config.js");
      const { syncBoards } = await import("../lib/relay/sync.js");
      const out = await syncBoards(relayConfig(), { mode: "live" });
      relay = { rows: out.length, errors: out.filter((r) => r.error).length };
    }
    return Response.json({ checked: meetings.length, processed: done, relay });
  } catch (e) {
    console.error("sweep failed", e);
    return new Response(e.name === "SetupError" ? `setup problem: ${e.message}` : `error: ${String(e.message || e).slice(0, 300)}`, { status: 500 });
  }
}
