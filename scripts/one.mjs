// Process one call again. Calls already marked Done are skipped: set the page's Status to Error in Notion first to force a rebuild.
// Usage: npm run one -- <recording_id> [days-back=60]
import { loadEnv, run } from "./_env.mjs";
loadEnv();
const { listMeetings, claim, processMeeting } = await import("../lib/core.js");

await run(async () => {
  const id = process.argv[2];
  if (!/^\d+$/.test(id || "")) throw new Error("Give the Fathom recording id, for example: npm run one -- 123456789");
  const days = Number(process.argv[3]) || 60;
  const m = (await listMeetings(new Date(Date.now() - days * 86400e3).toISOString())).find((x) => String(x.recording_id) === id);
  if (!m) throw new Error(`Recording ${id} was not found in the last ${days} days of this Fathom account.`);
  const pageId = await claim(m);
  console.log(pageId ? JSON.stringify(await processMeeting(m, pageId)) : "already done (set the page's Status to Error in Notion to rebuild it)");
});
