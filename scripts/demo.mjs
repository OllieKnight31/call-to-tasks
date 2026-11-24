// See the whole pipeline run on the invented sample call, with no accounts and no internet:
//   npm run demo
// Fathom, Notion and Discord are replaced by in-memory fakes, so nothing real is read or written.
// It uses your config.json when you have one, otherwise the test team (Sam and Priya).
import fs from "node:fs";
import path from "node:path";
import { startOffline, waitFor, ROOT, HERE, FAKE_SECRET } from "../tests/harness.mjs";

if (!fs.existsSync(path.join(ROOT, "node_modules", "@vercel", "functions"))) {
  console.error('Run "npm install" in this folder first, then "npm run demo" again.');
  process.exit(1);
}
const own = path.join(ROOT, "config.json");
let configFile = path.join(HERE, "config.test.json");
let why = "you have no config.json yet";
if (fs.existsSync(own)) {
  try {
    const { validateConfig } = await import("../lib/settings.js");
    validateConfig(JSON.parse(fs.readFileSync(own, "utf8")));
    configFile = own;
  } catch { why = "your config.json still has placeholders or errors (npm run check lists them)"; }
}
const backend = await startOffline({ configFile });
const quiet = console.log;
console.log = () => {};
try {
  const { POST } = await import("../api/fathom-webhook.js");
  const { buildSampleRequest } = await import("./send-sample.mjs");
  const req = buildSampleRequest(FAKE_SECRET);
  const res = await POST(new Request("https://offline.test/api/fathom-webhook", { method: "POST", headers: req.headers, body: req.body }));
  if (res.status !== 202) throw new Error(`the webhook answered ${res.status}: ${await res.text()}`);
  const page = await waitFor(() => {
    const p = backend.pagesIn(process.env.NOTION_CALLS_DB)[0];
    return ["Done", "Error"].includes(p?.properties.Status?.select?.name) && p;
  });
  console.log = quiet;
  const say = console.log;
  const t = (p, k) => backend.text(p, k);
  say(`Using the team in ${path.relative(ROOT, configFile)}${configFile === own ? "" : ` because ${why}`}\n`);
  say("1. WEBHOOK      signed sample accepted (202)");
  say(`2. CALL LIBRARY "${t(page, "Call")}"  status ${page.properties.Status.select.name}`);
  if (t(page, "Error")) say(`   problem: ${t(page, "Error")}`);
  say(`   client ${page.properties.Client?.select?.name} | type ${page.properties["Call Type"]?.select?.name} | ${page.properties["Duration (min)"]?.number} min | attendees ${t(page, "Attendees")}`);
  say(`   briefing: ${t(page, "Briefing").split("\n")[0]}`);
  say(`   next steps: ${t(page, "Next Steps").split("\n").length} line(s)`);
  const body = backend.blocksOf(page.id);
  const count = (type) => body.filter((b) => b.type === type).length;
  say(`   page body: recording link, ${count("heading_2") + count("heading_3")} headings, ${count("bulleted_list_item") + count("numbered_list_item")} list items, ${count("to_do")} action items, transcript of ${backend.blocksOf(body.at(-1).id).length} turns inside a toggle`);
  const tasks = backend.pagesIn(process.env.NOTION_TASKS_DB);
  say(`3. TASK BOARD   ${tasks.length} task(s), each linked to the call:`);
  for (const task of tasks) say(`   [${t(task, "Owner")}] ${t(task, "Task")}  (${task.properties["Call Link"]?.url?.split("?")[1] || "no timestamp"})`);
  say(`   action items left on the call page only (named someone outside your team): ${count("to_do") - tasks.length}`);
  say(`4. DISCORD      ${backend.state.discord.messages.length} card(s) posted, ${backend.state.discord.threads.length} thread(s) opened:`);
  for (const m of backend.state.discord.messages) say(`   ${m.content || "(no ping: this person has no discord_user_id)"}  ${m.embeds[0].author.name}: ${m.embeds[0].title}`);
  say("\nNothing left this computer. When your accounts are set up, run the same sample against the real thing with: npm run send-sample -- <your webhook address>");
} catch (e) {
  console.log = quiet;
  console.error(`\n${e.name === "SetupError" ? "SETUP PROBLEM" : "DEMO FAILED"}: ${e.message}\n`);
  process.exitCode = 1;
} finally {
  backend.restore();
}
