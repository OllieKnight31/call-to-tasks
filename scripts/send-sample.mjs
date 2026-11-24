// First live test: sends the invented sample call to your deployed webhook, signed exactly as Fathom signs.
// A page appears in your Call Library, tasks appear on the board, and Discord is pinged. Nothing real is recorded.
// Usage: npm run send-sample -- https://<your-project>.vercel.app/api/fathom-webhook
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadEnv, run, ROOT } from "./_env.mjs";
loadEnv();
const { env } = await import("../lib/settings.js");
const { signFathom } = await import("../lib/core.js");

export function buildSampleRequest(secret, now = Date.now()) {
  const payload = JSON.parse(fs.readFileSync(path.join(ROOT, "sample", "fathom-webhook-payload.json"), "utf8"));
  // A fresh id and time each run, so every send makes a new page instead of being skipped as a duplicate.
  payload.recording_id = 900000000 + Math.floor(Math.random() * 99999999);
  payload.created_at = new Date(now).toISOString();
  payload.recording_start_time = new Date(now - 26 * 60000).toISOString();
  payload.recording_end_time = new Date(now).toISOString();
  const body = JSON.stringify(payload);
  const id = "msg_" + crypto.randomBytes(8).toString("hex");
  const ts = String(Math.floor(now / 1000));
  return {
    recordingId: payload.recording_id,
    body,
    headers: {
      "Content-Type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": ts,
      "webhook-signature": "v1," + signFathom(secret, id, ts, body).toString("base64"),
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run(async () => {
    const url = process.argv[2];
    if (!/^https?:\/\/.+\/api\/fathom-webhook$/.test(url || "")) throw new Error("Give the full address of your deployed webhook, ending in /api/fathom-webhook");
    const req = buildSampleRequest(env("FATHOM_WEBHOOK_SECRET"));
    const r = await fetch(url, { method: "POST", headers: req.headers, body: req.body });
    const text = await r.text();
    console.log(`${r.status} ${text}`);
    if (r.status === 202) console.log(`Accepted as recording ${req.recordingId}. Give it a minute, then look in the Call Library, the task board and Discord. Delete the sample page and tasks when you have seen them.`);
    else if (r.status === 401) console.log("401 means the FATHOM_WEBHOOK_SECRET on Vercel differs from the one in .env.local. Copy it across and redeploy.");
    else if (r.status === 500) console.log("The app reported a setup problem. The text above names what is missing.");
  });
}
