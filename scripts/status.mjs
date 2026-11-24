// Shows each recent Fathom recording and whether it reached the Notion Call Library.
// Usage: npm run status -- [days=3]
import { loadEnv, run } from "./_env.mjs";
loadEnv();
const { listMeetings, findCallPage } = await import("../lib/core.js");

await run(async () => {
  const days = Number(process.argv[2]) || 3;
  const meetings = await listMeetings(new Date(Date.now() - days * 86400e3).toISOString());
  if (!meetings.length) console.log(`No Fathom recordings in the last ${days} days.`);
  for (const m of meetings) {
    const page = await findCallPage(m.recording_id);
    const pr = page?.properties;
    const state = page
      ? `${pr.Status?.select?.name || "?"} | tasks ${pr["Tasks Created"]?.number ?? "-"} | ${page.url}`
      : "NOT IN NOTION (run: npm run one -- " + m.recording_id + ")";
    console.log([String(m.created_at || "").slice(0, 16), m.recording_id, String(m.title || "").slice(0, 40), state].join(" | "));
  }
});
