// Process every call of the last N days that is missing from Notion or marked Error.
// Usage: npm run backfill -- [days=7] [--dry-run]
import { loadEnv, run } from "./_env.mjs";
loadEnv();
const { listMeetings, claim, processMeeting } = await import("../lib/core.js");

await run(async () => {
  const days = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a))) || 7;
  const meetings = (await listMeetings(new Date(Date.now() - days * 86400e3).toISOString())).reverse();
  console.log(`${meetings.length} meetings in the last ${days} days`);
  if (process.argv.includes("--dry-run")) { meetings.forEach((m) => console.log(m.recording_id, m.created_at, m.title)); return; }
  for (const m of meetings) {
    const pageId = await claim(m);
    if (!pageId) { console.log("skip", m.recording_id, m.title); continue; }
    try { console.log("ok", JSON.stringify(await processMeeting(m, pageId))); }
    catch (e) { console.log("ERR", m.recording_id, String(e).slice(0, 300)); }
  }
});
