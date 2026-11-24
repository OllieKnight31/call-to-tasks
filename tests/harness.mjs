// Shared set-up for the offline tests and the demo: fake services, throwaway ids, no real credentials.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeBackend } from "./fake-backend.mjs";
import { TASKS_SCHEMA, CALLS_SCHEMA, LEDGER_SCHEMA } from "../lib/schema.js";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
export const FAKE_SECRET = "whsec_" + Buffer.from("offline-test-signing-secret").toString("base64");
export const IDS = { guild: "444444444444444", channel: "555555555555555", sam: "111111111111111", priya: "222222222222222", role: "333333333333333" };

/** Fake services installed over fetch, the three databases created, and every variable the app reads set to a dummy. */
export async function startOffline({ configFile = path.join(HERE, "config.test.json"), discord = true, meetings = [] } = {}) {
  process.env.CALL_TO_TASKS_NO_ENV_FILE = "1";   // never read a real .env.local
  process.env.CALL_TO_TASKS_CONFIG = configFile;
  Object.assign(process.env, {
    FATHOM_API_KEY: "offline-fathom-key", FATHOM_WEBHOOK_SECRET: FAKE_SECRET, NOTION_API_KEY: "offline-notion-key",
    CRON_SECRET: "offline-cron-secret", ADMIN_KEY: "offline-admin-key",
  });
  for (const k of ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_TASK_CHANNEL_ID", "DISCORD_LOG_CHANNEL_ID", "NOTION_WEBHOOK_SECRET"]) delete process.env[k];
  if (discord) Object.assign(process.env, { DISCORD_BOT_TOKEN: "offline-discord-token", DISCORD_GUILD_ID: IDS.guild, DISCORD_TASK_CHANNEL_ID: IDS.channel });

  const backend = createFakeBackend({ meetings, users: { "00000000-0000-0000-0000-000000000000": "Samuel J Carter" } }).install();
  backend.state.guildId = IDS.guild;
  const parent = crypto.randomUUID();
  const make = async (name, properties) => (await (await fetch("https://api.notion.com/v1/databases", {
    method: "POST", body: JSON.stringify({ parent: { type: "page_id", page_id: parent }, title: [{ type: "text", text: { content: name } }], properties }),
  })).json()).id;
  process.env.NOTION_TASKS_DB = await make("Tasks", { ...TASKS_SCHEMA, Call: { relation: {} } });
  process.env.NOTION_CALLS_DB = await make("Call Library", { ...CALLS_SCHEMA, Tasks: { relation: {} } });
  process.env.NOTION_LEDGER_DB = await make("Discord Sync Ledger", LEDGER_SCHEMA);
  backend.state.calls.length = 0;

  const { resetConfigCache } = await import("../lib/settings.js");
  const { resetRelayConfigCache } = await import("../lib/relay/config.js");
  resetConfigCache();
  resetRelayConfigCache();
  return backend;
}

export async function waitFor(fn, { timeoutMs = 60000, everyMs = 100 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
