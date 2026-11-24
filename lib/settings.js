// Every value that is personal to you lives in two places:
//   .env.local / Vercel environment variables  -> keys, secrets and ids (see .env.example)
//   config.json                                -> your team and the task rules (see config.example.json)
// Nothing is hard-coded. A missing or malformed value stops with a message that says what to fix.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = "SetupError";
  }
}

const NOTION_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const DISCORD_ID = /^\d{15,22}$/;
const WHERE = "Set it in .env.local for local commands and in the Vercel project (Settings > Environment Variables) for the live app. See .env.example.";

export function env(name, { optional = false } = {}) {
  const v = String(process.env[name] ?? "").trim();
  if (v) return v;
  if (optional) return null;
  throw new SetupError(`Missing environment variable ${name}. ${WHERE}`);
}

export function notionId(name, opts) {
  const v = env(name, opts);
  if (v && !NOTION_ID.test(v)) {
    throw new SetupError(`${name} is not a Notion id (expected 32 hex characters, with or without hyphens). Run "npm run setup:notion" to create the databases and print the right ids.`);
  }
  return v;
}

export function discordId(name, opts) {
  const v = env(name, opts);
  if (v && !DISCORD_ID.test(v)) {
    throw new SetupError(`${name} is not a Discord id (expected 15 to 22 digits). In Discord turn on Developer Mode, right-click the server, channel or role and choose Copy ID.`);
  }
  return v;
}

/** Discord is optional. It switches on as soon as DISCORD_BOT_TOKEN is set. */
export const discordEnabled = () => Boolean(env("DISCORD_BOT_TOKEN", { optional: true }));

// ---------- config.json ----------
let cached = null;

export function configPath() {
  // CALL_TO_TASKS_CONFIG (used by the tests and the demo) replaces the normal lookup entirely.
  const candidates = process.env.CALL_TO_TASKS_CONFIG
    ? [process.env.CALL_TO_TASKS_CONFIG]
    : [path.join(ROOT, "config.json"), path.join(process.cwd(), "config.json")];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export function validateConfig(raw) {
  const problems = [];
  const cfg = raw && typeof raw === "object" ? raw : {};
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

  if (!Array.isArray(cfg.team) || !cfg.team.length) problems.push('"team" must list at least one person.');
  const team = (Array.isArray(cfg.team) ? cfg.team : []).map((m, i) => {
    const name = String(m?.name ?? "").trim();
    if (!name) problems.push(`team[${i}].name is empty.`);
    if (/^(your name|teammate name|change me)$/i.test(name)) problems.push(`team[${i}].name is still the placeholder "${name}". Put the real first name in.`);
    const notion = String(m?.notion_user_id ?? "").trim();
    const discord = String(m?.discord_user_id ?? "").trim();
    if (notion && !NOTION_ID.test(notion)) problems.push(`team[${i}].notion_user_id is not a Notion user id. Run "npm run notion:users" to list them, or leave it empty.`);
    if (discord && !DISCORD_ID.test(discord)) problems.push(`team[${i}].discord_user_id is not a Discord user id (15 to 22 digits). Leave it empty if this person should not be pinged.`);
    return { name, aliases: list(m?.aliases), emails: list(m?.emails).map((e) => e.toLowerCase()), notion_user_id: notion || null, discord_user_id: discord || null };
  });
  const names = team.map((m) => m.name.toLowerCase());
  if (new Set(names).size !== names.length) problems.push("Two people in team have the same name.");

  const defaultOwner = String(cfg.default_owner ?? "").trim();
  if (!defaultOwner) problems.push('"default_owner" is empty. Put the name of the person who gets action items nobody was named for.');
  else if (!names.includes(defaultOwner.toLowerCase())) problems.push(`"default_owner" is "${defaultOwner}", which is not the name of anyone in team.`);

  const t = cfg.tasks ?? {};
  const otherPeople = t.other_people ?? "skip";
  if (!["skip", "default_owner"].includes(otherPeople)) problems.push('tasks.other_people must be "skip" or "default_owner".');
  const pattern = String(t.only_for_titles_matching ?? "").trim();
  if (pattern) {
    try { new RegExp(pattern, "i"); } catch { problems.push("tasks.only_for_titles_matching is not a valid regular expression."); }
  }
  const d = cfg.discord ?? {};
  const role = String(d.escalation_role_id ?? "").trim();
  if (role && !DISCORD_ID.test(role)) problems.push("discord.escalation_role_id is not a Discord role id (15 to 22 digits). Leave it empty for no role ping.");

  if (problems.length) throw new SetupError(`config.json needs fixing:\n - ${problems.join("\n - ")}`);
  return {
    team,
    default_owner: team.find((m) => m.name.toLowerCase() === defaultOwner.toLowerCase()).name,
    tasks: {
      other_people: otherPeople,
      default_urgency: String(t.default_urgency ?? "📌 P2").trim() || "📌 P2",
      only_for_titles_matching: pattern,
    },
    discord: { escalation_role_id: role || null, label: String(d.label ?? "Tasks").trim() || "Tasks" },
  };
}

export function loadConfig() {
  if (cached) return cached;
  const file = configPath();
  if (!file) {
    throw new SetupError(`config.json not found (looked in ${ROOT}). Copy config.example.json to config.json and put your team in it, then deploy again.`);
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { throw new SetupError(`config.json is not valid JSON: ${e.message}`); }
  cached = validateConfig(raw);
  return cached;
}

/** Tests swap the config between cases. */
export function resetConfigCache() { cached = null; }
