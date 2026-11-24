// Creates the three Notion databases (task board, Call Library, Discord sync ledger) with the exact
// schema the pipeline needs, links the board to the library, and saves their ids to .env.local.
// Usage:
//   npm run setup:notion -- <link to an empty Notion page shared with your integration>
//   npm run setup:notion -- <link> --dry-run     show what would be created, change nothing
//   npm run notion:users                         list workspace members and their Notion user ids
import fs from "node:fs";
import { loadEnv, run, envFilePath } from "./_env.mjs";
loadEnv();
const { env } = await import("../lib/settings.js");
const { notion } = await import("../lib/core.js");
const { TASKS_SCHEMA, CALLS_SCHEMA, LEDGER_SCHEMA, pageIdFrom } = await import("../lib/schema.js");

const title = (s) => [{ type: "text", text: { content: s } }];
const KEYS = ["NOTION_TASKS_DB", "NOTION_CALLS_DB", "NOTION_LEDGER_DB"];

function saveIds(ids) {
  const file = envFilePath();
  let body = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const [k, v] of Object.entries(ids)) {
    const line = `${k}=${v}`;
    body = new RegExp(`^${k}=.*$`, "m").test(body) ? body.replace(new RegExp(`^${k}=.*$`, "m"), line) : body + (body && !body.endsWith("\n") ? "\n" : "") + line + "\n";
  }
  fs.writeFileSync(file, body, { mode: 0o600 });
}

await run(async () => {
  const args = process.argv.slice(2);
  if (args.includes("--users")) {
    env("NOTION_API_KEY");
    let cursor = null;
    console.log("Notion user id                         | type   | name (email)");
    do {
      const d = await notion("GET", `/users?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
      for (const u of d.results) console.log(`${u.id} | ${String(u.type).padEnd(6)} | ${u.name || "(no name)"}${u.person?.email ? ` (${u.person.email})` : ""}`);
      cursor = d.has_more ? d.next_cursor : null;
    } while (cursor);
    console.log('\nCopy a person\'s id into "notion_user_id" in config.json. If this list is empty or fails with 403, give the integration the "Read user information" capability in Notion.');
    return;
  }

  const dry = args.includes("--dry-run");
  const force = args.includes("--force");
  const parent = pageIdFrom(args.find((a) => !a.startsWith("--")) || process.env.NOTION_PARENT_PAGE);
  if (!parent) {
    throw new Error("Give the link to the Notion page the databases should live in, for example:\n  npm run setup:notion -- 'https://www.notion.so/Your-page-name-and-its-32-character-id'\nCreate an empty page first and connect your integration to it (page menu > Connections).");
  }
  const already = KEYS.filter((k) => process.env[k]);
  if (already.length && !force && !dry) {
    throw new Error(`${already.join(", ")} already set in .env.local, so the databases seem to exist. Running this again would create a second set. Add --force if that is what you want.`);
  }

  if (dry) {
    console.log(`DRY RUN. Would create under page ${parent}:`);
    for (const [name, schema] of [["Tasks", TASKS_SCHEMA], ["Call Library", CALLS_SCHEMA], ["Discord Sync Ledger", LEDGER_SCHEMA]]) {
      console.log(`\n${name}`);
      for (const [prop, def] of Object.entries(schema)) {
        const type = Object.keys(def)[0];
        const options = def.select?.options?.map((o) => o.name).join(", ");
        console.log(`  ${prop.padEnd(18)} ${type}${options ? `: ${options}` : ""}`);
      }
    }
    console.log('\nPlus a two-way relation: "Tasks" on the Call Library, "Call" on the task board.');
    return;
  }

  env("NOTION_API_KEY");
  const make = (name, emoji, properties) => notion("POST", "/databases", {
    parent: { type: "page_id", page_id: parent }, icon: { type: "emoji", emoji }, title: title(name), properties,
  });
  const tasks = await make("Tasks", "✅", TASKS_SCHEMA);
  console.log(`Created Tasks                ${tasks.url || tasks.id}`);
  const calls = await make("Call Library", "📞", CALLS_SCHEMA);
  console.log(`Created Call Library         ${calls.url || calls.id}`);

  // Two-way link. Notion names the mirrored property itself, so find it on the task board and rename it to "Call".
  await notion("PATCH", `/databases/${calls.id}`, { properties: { Tasks: { relation: { database_id: tasks.id, type: "dual_property", dual_property: {} } } } });
  const fresh = await notion("GET", `/databases/${tasks.id}`);
  const same = (a, b) => String(a).replace(/-/g, "") === String(b).replace(/-/g, "");
  const mirrored = Object.entries(fresh.properties).find(([, v]) => v.type === "relation" && same(v.relation?.database_id, calls.id))?.[0];
  if (!mirrored) throw new Error('The databases were created but the mirrored relation did not appear on the task board. In Notion add a Relation property named "Call" on Tasks that points at the Call Library, then run "npm run check -- --live".');
  if (mirrored !== "Call") await notion("PATCH", `/databases/${tasks.id}`, { properties: { [mirrored]: { name: "Call" } } });
  console.log('Linked them                  "Tasks" on the Call Library <-> "Call" on the task board');

  const ledger = await make("Discord Sync Ledger", "🔗", LEDGER_SCHEMA);
  console.log(`Created Discord Sync Ledger  ${ledger.url || ledger.id}  (machine-owned: do not edit its rows)`);

  saveIds({ NOTION_TASKS_DB: tasks.id, NOTION_CALLS_DB: calls.id, NOTION_LEDGER_DB: ledger.id });
  console.log("\nSaved NOTION_TASKS_DB, NOTION_CALLS_DB and NOTION_LEDGER_DB to .env.local.");
  console.log("NEXT: add the same three values to the Vercel project's environment variables.");
});
