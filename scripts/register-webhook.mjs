// Tells Fathom to call your deployed app when a recording is ready. Run it once.
// Usage: npm run register -- https://<your-project>.vercel.app/api/fathom-webhook [--team]
//   --team   also fire for recordings shared inside a Fathom Team plan (Fathom marks these "Team Plans only")
import fs from "node:fs";
import { loadEnv, run, envFilePath } from "./_env.mjs";
loadEnv();
const { env } = await import("../lib/settings.js");

await run(async () => {
  const url = process.argv[2];
  if (!/^https:\/\/.+\/api\/fathom-webhook$/.test(url || "")) {
    throw new Error("Give the full address of your deployed webhook, ending in /api/fathom-webhook (it must start with https://).");
  }
  const r = await fetch("https://api.fathom.ai/external/v1/webhooks", {
    method: "POST",
    headers: { "X-Api-Key": env("FATHOM_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({
      destination_url: url,
      triggered_for: ["my_recordings", "shared_external_recordings", ...(process.argv.includes("--team") ? ["my_shared_with_team_recordings", "shared_team_recordings"] : [])],
      include_transcript: true, include_summary: true, include_action_items: true, include_crm_matches: false,
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Fathom answered ${r.status}: ${text.slice(0, 300)}`);
  const hook = JSON.parse(text);
  if (!hook.secret) throw new Error("Fathom created the webhook but sent no secret back. Open Fathom > Settings > API Access to copy it.");

  // The secret is written to .env.local for you and never shown on screen.
  const file = envFilePath();
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const line = `FATHOM_WEBHOOK_SECRET=${hook.secret}`;
  const after = /^FATHOM_WEBHOOK_SECRET=.*$/m.test(before)
    ? before.replace(/^FATHOM_WEBHOOK_SECRET=.*$/m, line)
    : before + (before && !before.endsWith("\n") ? "\n" : "") + line + "\n";
  fs.writeFileSync(file, after, { mode: 0o600 });
  console.log(`Webhook registered (id ${hook.id}).`);
  console.log("Its signing secret is now in .env.local as FATHOM_WEBHOOK_SECRET.");
  console.log("NEXT: add FATHOM_WEBHOOK_SECRET to the Vercel project's environment variables and redeploy, or every webhook is refused with 401.");
});
