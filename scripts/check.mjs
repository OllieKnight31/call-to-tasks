// Checks your setup and says exactly what is missing. It never prints a key or a secret.
//   npm run check             offline: .env.local and config.json only
//   npm run check -- --live   also asks Notion, Discord and Fathom (read-only) whether the keys and ids work
import { loadEnv, ROOT } from "./_env.mjs";
const envFile = loadEnv();
const { loadConfig, env, notionId, discordId, discordEnabled } = await import("../lib/settings.js");
const { REQUIRED, schemaProblems } = await import("../lib/schema.js");

const live = process.argv.includes("--live");
let failed = 0;
const pass = (m) => console.log(`PASS  ${m}`);
const note = (m) => console.log(`NOTE  ${m}`);
const fail = (m) => { failed++; console.log(`FAIL  ${m}`); };
const attempt = async (label, fn) => {
  try { const extra = await fn(); pass(extra ? `${label}: ${extra}` : label); return true; }
  catch (e) { fail(`${label}: ${e.message}`); return false; }
};

const major = Number(process.versions.node.split(".")[0]);
if (major >= 22) pass(`Node ${process.versions.node}`); else fail(`Node ${process.versions.node} is too old. Install Node 22 or newer.`);
if (envFile) pass(`environment file found: ${envFile.replace(ROOT + "/", "")}`);
else note("no .env.local file: using the shell's environment only (copy .env.example to .env.local)");

let cfg = null;
await attempt("config.json", () => { cfg = loadConfig(); return `${cfg.team.length} team member(s), default owner ${cfg.default_owner}`; });
if (cfg) {
  for (const m of cfg.team) {
    if (!m.discord_user_id) note(`${m.name} has no discord_user_id in config.json, so Discord shows the name without pinging`);
    if (!m.notion_user_id) note(`${m.name} has no notion_user_id in config.json, so tasks carry the name in Owner but leave Assignee empty`);
  }
}

for (const k of ["FATHOM_API_KEY", "NOTION_API_KEY", "CRON_SECRET"]) await attempt(k, () => { env(k); return "set"; });
for (const k of ["NOTION_CALLS_DB", "NOTION_TASKS_DB"]) await attempt(k, () => { notionId(k); return "set"; });
if (env("FATHOM_WEBHOOK_SECRET", { optional: true })) pass("FATHOM_WEBHOOK_SECRET: set");
else note('FATHOM_WEBHOOK_SECRET is not set yet. It is created by "npm run register" after the first deploy.');

const discord = discordEnabled();
if (!discord) {
  const strays = ["DISCORD_GUILD_ID", "DISCORD_TASK_CHANNEL_ID"].filter((k) => env(k, { optional: true }));
  if (strays.length) fail(`${strays.join(", ")} set but DISCORD_BOT_TOKEN is empty. Set the token, or clear them to run without Discord.`);
  else note("Discord is off (DISCORD_BOT_TOKEN is empty): calls and tasks still reach Notion, nobody is pinged");
} else {
  pass("DISCORD_BOT_TOKEN: set");
  for (const k of ["DISCORD_GUILD_ID", "DISCORD_TASK_CHANNEL_ID"]) await attempt(k, () => { discordId(k); return "set"; });
  await attempt("NOTION_LEDGER_DB", () => { notionId("NOTION_LEDGER_DB"); return "set"; });
  await attempt("DISCORD_LOG_CHANNEL_ID (optional)", () => (discordId("DISCORD_LOG_CHANNEL_ID", { optional: true }) ? "set" : "not set"));
}
if (!env("ADMIN_KEY", { optional: true })) note("ADMIN_KEY is not set: only needed for the optional Notion webhook and the manual sync address");

if (live && failed) {
  console.log("\nFix the FAIL lines above before the live checks can run.");
} else if (live) {
  console.log("\nLive checks (read-only):");
  const { notion, listMeetings } = await import("../lib/core.js");
  const dbs = ["NOTION_TASKS_DB", "NOTION_CALLS_DB", ...(discord ? ["NOTION_LEDGER_DB"] : [])];
  for (const k of dbs) {
    await attempt(`Notion ${k}`, async () => {
      const db = await notion("GET", `/databases/${notionId(k)}`);
      const problems = schemaProblems(k, db);
      if (problems.length) throw new Error(`schema mismatch: ${problems.join("; ")}`);
      return `reachable, all ${Object.keys(REQUIRED[k]).length} properties present`;
    });
  }
  await attempt("Fathom API key", async () => {
    const recent = await listMeetings(new Date(Date.now() - 86400e3).toISOString());
    return `accepted (${recent.length} recording(s) in the last day)`;
  });
  if (discord) {
    const { discord: call } = await import("../lib/relay/discord.js");
    await attempt("Discord task channel", async () => {
      const ch = await call(`/channels/${discordId("DISCORD_TASK_CHANNEL_ID")}`);
      if (String(ch.guild_id) !== discordId("DISCORD_GUILD_ID")) throw new Error("the channel is not in the server named by DISCORD_GUILD_ID");
      return "reachable and in the right server";
    });
  }
}

console.log(failed ? `\n${failed} problem(s) to fix.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
