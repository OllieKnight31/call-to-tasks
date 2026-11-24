// Fetch one Fathom call as readable text (summary, action items, transcript), or list recent calls.
//   npm run -s fathom -- <recording_id | Fathom share link> [--out file.txt] [--days 60]
//   npm run -s fathom -- --latest [N]
// Only calls on the Fathom account that owns FATHOM_API_KEY can be fetched.
import fs from "node:fs";
import { loadEnv, run } from "./_env.mjs";
loadEnv();
const { listMeetings } = await import("../lib/core.js");

await run(async () => {
  const args = process.argv.slice(2);
  if (!args.length) throw new Error("Give a recording id or share link, or --latest.");
  const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const since = (days) => new Date(Date.now() - days * 86400e3).toISOString();

  if (args[0] === "--latest") {
    const n = Number(args[1]) || 10;
    const recent = (await listMeetings(since(30))).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    for (const m of recent.slice(0, n)) {
      const names = (m.calendar_invitees || []).map((i) => i.name || i.email).join(", ");
      console.log([m.recording_id, String(m.created_at).slice(0, 16), m.title, names, m.share_url].join(" | "));
    }
    return;
  }

  const target = args[0].split("?")[0];
  const days = Number(opt("--days", 60)) || 60;
  const all = await listMeetings(since(days), { include_transcript: "true", include_summary: "true", include_action_items: "true" });
  const m = all.find((x) => String(x.recording_id) === target || String(x.share_url || "").split("?")[0] === target || String(x.url || "").split("?")[0] === target);
  if (!m) throw new Error(`Not found in the last ${days} days of this Fathom account. If a teammate recorded it, ask for the transcript as text instead.`);

  const lines = [
    `# ${m.title} | ${String(m.created_at).slice(0, 10)} | recording ${m.recording_id} | share ${m.share_url}`,
    "Speakers: " + [...new Set((m.transcript || []).map((t) => t.speaker?.display_name).filter(Boolean))].sort().join(", "),
    "", "## Fathom summary", m.default_summary?.markdown_formatted || "",
    "", "## Fathom action items",
    ...(m.action_items || []).map((a) => `- ${a.description} (${a.assignee?.name || "unassigned"}) @${a.recording_timestamp}`),
    "", "## Transcript",
    ...(m.transcript || []).map((t) => `[${t.timestamp}] ${t.speaker?.display_name || "Unknown"}: ${t.text}`),
  ];
  const out = opt("--out", null);
  if (out) { fs.writeFileSync(out, lines.join("\n")); console.log(`wrote ${out} (${(m.transcript || []).length} transcript lines)`); }
  else console.log(lines.join("\n"));
});
