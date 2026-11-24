// Offline tests: npm test
// Everything runs against in-memory fakes of Fathom, Notion and Discord. No account, key or
// internet connection is needed, and a call to any other address fails the run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { startOffline, waitFor, ROOT, HERE, IDS, FAKE_SECRET } from "./harness.mjs";

if (!fs.existsSync(path.join(ROOT, "node_modules", "@vercel", "functions"))) {
  console.error('Run "npm install" in this folder first (one small package), then "npm test" again.');
  process.exit(1);
}

const HEX32 = "0123456789abcdef".repeat(2);   // an obviously invented Notion id
const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log(`ok    ${name} (${Date.now() - t0} ms)`); }
  catch (e) { results.push({ name, ok: false }); console.log(`FAIL  ${name}\n      ${String(e.stack || e).split("\n").slice(0, 6).join("\n      ")}`); }
}

const sample = () => JSON.parse(fs.readFileSync(path.join(ROOT, "sample", "fathom-webhook-payload.json"), "utf8"));
const settings = await import("../lib/settings.js");
const team = await import("../lib/team.js");
const core = await import("../lib/core.js");
const schema = await import("../lib/schema.js");
const cfg = settings.validateConfig(JSON.parse(fs.readFileSync(path.join(HERE, "config.test.json"), "utf8")));
const richTexts = (blocks) => blocks.flatMap((b) => [...(b[b.type].rich_text || []), ...richTexts(b[b.type].children || [])]);

// ---------------------------------------------------------------- configuration
await test("a missing environment variable is named in the error", () => {
  delete process.env.NOTION_CALLS_DB;
  assert.throws(() => core.callsDb(), (e) => e.name === "SetupError" && /NOTION_CALLS_DB/.test(e.message) && /\.env\.example/.test(e.message));
  process.env.NOTION_CALLS_DB = "not-an-id";
  assert.throws(() => core.callsDb(), (e) => e.name === "SetupError" && /not a Notion id/.test(e.message));
  delete process.env.NOTION_CALLS_DB;
});

await test("config.example.json is rejected until the placeholders are replaced", () => {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  assert.throws(() => settings.validateConfig(example), (e) => e.name === "SetupError" && /placeholder/.test(e.message));
});

await test("config.json problems are all listed at once", () => {
  assert.throws(() => settings.validateConfig({ team: [{ name: "Sam", discord_user_id: "abc" }], default_owner: "Nobody", tasks: { other_people: "maybe" } }),
    (e) => /discord_user_id/.test(e.message) && /default_owner/.test(e.message) && /other_people/.test(e.message));
  assert.throws(() => settings.validateConfig({}), /at least one person/);
});

await test("a missing config.json stops with instructions", () => {
  const before = process.env.CALL_TO_TASKS_CONFIG;
  process.env.CALL_TO_TASKS_CONFIG = path.join(os.tmpdir(), "call-to-tasks-no-such-config.json");
  settings.resetConfigCache();
  assert.throws(() => settings.loadConfig(), (e) => e.name === "SetupError" && /config\.example\.json/.test(e.message));
  if (before) process.env.CALL_TO_TASKS_CONFIG = before; else delete process.env.CALL_TO_TASKS_CONFIG;
  settings.resetConfigCache();
});

// ---------------------------------------------------------------- choosing the assignee
await test("assignee: matched by email, by alias, unassigned, client, and a client who shares a first name", () => {
  assert.equal(team.ownerOf({ name: "S. Carter", email: "SAM@example.com" }, cfg).name, "Sam");
  assert.equal(team.ownerOf({ name: "Priya Shah" }, cfg).name, "Priya");
  assert.equal(team.ownerOf({ name: "samuel" }, cfg).name, "Sam");
  assert.equal(team.ownerOf(null, cfg).name, "Sam", "nobody named goes to the default owner");
  assert.equal(team.ownerOf({ name: "Jordan Reyes", email: "jordan@example.com" }, cfg), null, "a client's item is not put on the board");
  assert.equal(team.ownerOf({ name: "Sam Whitlock", email: "sam.w@example.org" }, cfg), null, "same first name, different known email");
  assert.equal(team.ownerOf({ name: "Samantha" }, cfg), null, "a longer name is not a match for Sam");
  const lenient = { ...cfg, tasks: { ...cfg.tasks, other_people: "default_owner" } };
  assert.equal(team.ownerOf({ name: "Jordan Reyes" }, lenient).name, "Sam");
});

// ---------------------------------------------------------------- webhook signature
await test("signature: accepts a correctly signed body, rejects tampering, old timestamps and missing headers", async () => {
  process.env.FATHOM_WEBHOOK_SECRET = FAKE_SECRET;
  const { buildSampleRequest } = await import("../scripts/send-sample.mjs");
  const req = buildSampleRequest(FAKE_SECRET);
  const h = (o) => new Headers(o);
  assert.equal(core.verifyFathomSignature(h(req.headers), req.body), true);
  assert.equal(core.verifyFathomSignature(h(req.headers), req.body + " "), false);
  assert.equal(core.verifyFathomSignature(h({ ...req.headers, "webhook-signature": "v1,AAAA" }), req.body), false);
  assert.equal(core.verifyFathomSignature(h({ "webhook-id": "x" }), req.body), false);
  const old = buildSampleRequest(FAKE_SECRET, Date.now() - 3600e3);
  assert.equal(core.verifyFathomSignature(h(old.headers), old.body), false);
  delete process.env.FATHOM_WEBHOOK_SECRET;
  assert.throws(() => core.verifyFathomSignature(h(req.headers), req.body), /FATHOM_WEBHOOK_SECRET/);
});

// ---------------------------------------------------------------- pure logic
await test("helpers: timestamps, list parsing with apostrophes, shortening, markdown stripping", () => {
  assert.equal(core.secs("00:18:30"), 1110);
  assert.equal(core.secs("5:07"), 307);
  assert.equal(core.secs(undefined), 0);
  assert.deepEqual(core.parseList([{ name: "A" }]), [{ name: "A" }]);
  assert.deepEqual(core.parseList("[{'name': 'Dana', 'ok': True, 'x': None}]"), [{ name: "Dana", ok: true, x: null }]);
  assert.deepEqual(core.parseList('[{"name": "Niamh O\'Brien"}]'), [{ name: "Niamh O'Brien" }]);
  assert.deepEqual(core.parseList("[{'name': 'Niamh O'Brien'}]"), [], "unparseable input degrades to an empty list instead of throwing");
  assert.equal(core.shorten("short", 70), "short");
  assert.equal(core.shorten("x".repeat(100), 70).length, 71);
  assert.equal(core.shorten("agree the scope, and then some more words", 16), "agree the scope…");
  assert.equal(core.plain("  - [**Scope agreed:** all good](https://example.com/x?timestamp=1)"), "Scope agreed: all good");
});

await test("summary markdown becomes Notion blocks with nesting, links and bold", () => {
  const blocks = core.mdBlocks(sample().default_summary.markdown_formatted);
  const types = blocks.map((b) => b.type);
  assert.deepEqual(types.slice(0, 4), ["heading_2", "paragraph", "heading_2", "bulleted_list_item"]);
  assert.ok(types.includes("heading_3") && types.includes("numbered_list_item"));
  const nested = blocks.find((b) => b.bulleted_list_item?.children);
  assert.equal(nested.bulleted_list_item.children.length, 1, "an indented bullet nests under its parent");
  const first = blocks[1].paragraph.rich_text[0];
  assert.match(first.text.link.url, /^https:\/\/fathom\.video\/share\//);
  assert.ok(blocks[3].bulleted_list_item.rich_text.some((t) => t.annotations.bold && t.text.content === "Scope agreed:"));
});

await test("a long transcript turn is split so no Notion text object exceeds 2000 characters", () => {
  const merged = core.mergeTranscript([
    { speaker: { display_name: "A" }, timestamp: "00:00:01", text: "word ".repeat(900) },
    { speaker: { display_name: "A" }, timestamp: "00:03:00", text: "more" },
    { speaker: { display_name: "B" }, timestamp: "00:03:05", text: "" },
    { speaker: null, timestamp: "00:03:09" },
  ]);
  const blocks = core.transcriptBlocks(merged);
  assert.ok(blocks.length >= 3);
  for (const t of richTexts(blocks)) assert.ok(t.text.content.length <= 2000);
  assert.equal(blocks[0].paragraph.rich_text[0].text.content, "[00:00:01] A: ");
});

await test("briefing built from the sample payload: title, client, call type, next steps, action items, transcript", () => {
  const m = sample();
  const b = core.buildBriefing(m, m.transcript, cfg);
  assert.equal(b.title, "Northwind Studio discovery call");
  assert.equal(b.client, "Jordan Reyes");
  assert.equal(b.callType, "Sales / Discovery");
  assert.equal(b.properties["Duration (min)"].number, 26);
  assert.equal(b.properties.Attendees.rich_text[0].text.content, "Sam Carter, Priya Shah, Jordan Reyes");
  assert.match(b.properties.Briefing.rich_text[0].text.content, /^To agree the scope[\s\S]*• Scope agreed:/);
  assert.equal(b.properties["Next Steps"].rich_text[0].text.content.split("\n").length, 3);
  assert.equal(b.blocks[0].type, "callout");
  assert.equal(b.blocks.filter((x) => x.type === "to_do").length, 4, "all four action items are listed on the call page");
  assert.equal(b.blocks.at(-1).heading_2.is_toggleable, true);
  assert.equal(b.transcriptBlocks.length, 9);
  for (const t of richTexts([...b.blocks, ...b.transcriptBlocks])) assert.ok(t.text.content.length <= 2000);
});

await test("a generic meeting title is replaced by client and purpose; an internal call is labelled Internal", () => {
  const m = { ...sample(), title: "Impromptu Google Meet Meeting", meeting_title: "Impromptu Google Meet Meeting" };
  assert.match(core.buildBriefing(m, m.transcript, cfg).title, /^Jordan Reyes - agree the scope/);
  const internal = { ...sample(), calendar_invitees: sample().calendar_invitees.slice(0, 2), transcript: sample().transcript.filter((l) => l.speaker.display_name !== "Jordan Reyes") };
  const b = core.buildBriefing(internal, internal.transcript, cfg);
  assert.equal(b.client, "Internal");
  assert.equal(b.callType, "Internal / Team");
});

await test("a recording with no summary, no transcript and no link still builds a valid page", () => {
  const b = core.buildBriefing({ recording_id: 5, title: "Call" }, [], cfg);
  assert.equal(b.blocks[0].type, "paragraph");
  assert.equal(b.transcriptBlocks.length, 1);
  assert.deepEqual(core.planTasks({ recording_id: 5 }, "Call", "", [{ description: "Do it" }], cfg)[0].properties["Call Link"], undefined);
});

await test("tasks planned from action items: right owner, stable key, recording link at the timestamp, client item skipped", () => {
  const m = sample();
  const plan = core.planTasks(m, "Northwind Studio discovery call", "Jordan Reyes", m.action_items, cfg);
  assert.deepEqual(plan.map((t) => t.owner), ["Sam", "Priya", "Sam"]);
  assert.equal(plan[0].properties.Assignee.people[0].id, "00000000-0000-0000-0000-000000000000");
  assert.equal(plan[1].properties.Assignee, undefined, "no Notion user id configured, so only Owner is written");
  assert.match(plan[0].properties["Call Link"].url, /\?timestamp=1110$/);
  assert.match(plan[0].key, /^900000001:auto-[0-9a-f]{10}$/);
  assert.deepEqual(plan.map((t) => t.key), core.planTasks(m, "x", "y", m.action_items, cfg).map((t) => t.key), "keys do not change between runs");
  assert.equal(core.planTasks(m, "t", "c", [...m.action_items, m.action_items[0]], cfg).length, 3, "a repeated item is not planned twice");
  assert.equal(core.wantsTasks("Weekly sync", { tasks: { only_for_titles_matching: "discovery|sales" } }), false);
  assert.equal(core.wantsTasks("Sales call", { tasks: { only_for_titles_matching: "discovery|sales" } }), true);
});

// ---------------------------------------------------------------- Notion schema and setup script
await test("setup script creates the three databases, links them and saves the ids (against the fake Notion)", async () => {
  const backend = await startOffline();
  const envFile = path.join(os.tmpdir(), `call-to-tasks-test-${process.pid}.env`);
  fs.writeFileSync(envFile, "NOTION_API_KEY=offline\n");
  for (const k of ["NOTION_TASKS_DB", "NOTION_CALLS_DB", "NOTION_LEDGER_DB"]) delete process.env[k];
  process.env.CALL_TO_TASKS_ENV_FILE = envFile;
  const argv = process.argv;
  try {
    process.argv = ["node", "setup-notion.mjs", `https://www.notion.so/Workspace-${HEX32}?pvs=4`];
    await import("../scripts/setup-notion.mjs?run=1");
    const saved = Object.fromEntries(fs.readFileSync(envFile, "utf8").trim().split("\n").map((l) => l.split("=")));
    for (const k of ["NOTION_TASKS_DB", "NOTION_CALLS_DB", "NOTION_LEDGER_DB"]) {
      const db = backend.state.databases.get(saved[k].replace(/-/g, ""));
      assert.deepEqual(schema.schemaProblems(k, db), [], `${k} matches the schema the code writes to`);
    }
    assert.equal(saved.NOTION_API_KEY, "offline", "existing lines in the env file are kept");
    const creates = backend.state.calls.filter((c) => c.method === "POST" && c.path === "/databases");
    assert.equal(creates.length, 3);
    assert.ok(creates.every((c) => c.body.parent.page_id === HEX32));
  } finally {
    process.argv = argv;
    delete process.env.CALL_TO_TASKS_ENV_FILE;
    fs.rmSync(envFile, { force: true });
    backend.restore();
  }
});

await test("register script sends the webhook request and stores the signing secret without printing it", async () => {
  const backend = await startOffline();
  const envFile = path.join(os.tmpdir(), `call-to-tasks-test-${process.pid}.env`);
  fs.writeFileSync(envFile, "FATHOM_WEBHOOK_SECRET=old\nOTHER=kept\n");
  process.env.CALL_TO_TASKS_ENV_FILE = envFile;
  const argv = process.argv, log = console.log, printed = [];
  try {
    process.argv = ["node", "register-webhook.mjs", "https://example.com/api/fathom-webhook"];
    console.log = (...a) => printed.push(a.join(" "));
    await import("../scripts/register-webhook.mjs?run=1");
    console.log = log;
    const sent = backend.state.fathomWebhooks[0];
    assert.equal(sent.destination_url, "https://example.com/api/fathom-webhook");
    assert.deepEqual(sent.triggered_for, ["my_recordings", "shared_external_recordings"]);
    assert.ok(sent.include_transcript && sent.include_summary && sent.include_action_items);
    const saved = fs.readFileSync(envFile, "utf8");
    assert.match(saved, /^FATHOM_WEBHOOK_SECRET=whsec_.+$/m);
    assert.match(saved, /^OTHER=kept$/m);
    assert.equal(saved.match(/FATHOM_WEBHOOK_SECRET=/g).length, 1, "the old secret is replaced, not duplicated");
    assert.doesNotMatch(printed.join("\n"), /whsec_/);
  } finally {
    console.log = log;
    process.argv = argv;
    delete process.env.CALL_TO_TASKS_ENV_FILE;
    fs.rmSync(envFile, { force: true });
    backend.restore();
  }
});

await test("schema check reports a renamed or mistyped property", () => {
  const db = { properties: { ...Object.fromEntries(Object.entries(schema.REQUIRED.NOTION_TASKS_DB).map(([k, type]) => [k, { type }])) } };
  assert.deepEqual(schema.schemaProblems("NOTION_TASKS_DB", db), []);
  delete db.properties["Sync Key"];
  db.properties.Owner = { type: "people" };
  db.properties.Status = { type: "status" };
  assert.deepEqual(schema.schemaProblems("NOTION_TASKS_DB", db), ['property "Owner" is people, expected rich_text', 'property "Sync Key" (rich_text) is missing']);
  assert.equal(schema.pageIdFrom(`https://www.notion.so/x/My-Page-${HEX32.toUpperCase()}?v=1`), HEX32);
  assert.equal(schema.pageIdFrom("nothing here"), null);
});

// ---------------------------------------------------------------- the whole pipeline
const { POST: fathomWebhook } = await import("../api/fathom-webhook.js");
const { buildSampleRequest } = await import("../scripts/send-sample.mjs");
const post = (req) => fathomWebhook(new Request("https://offline.test/api/fathom-webhook", { method: "POST", headers: req.headers, body: req.body }));
const callPage = (backend) => backend.pagesIn(process.env.NOTION_CALLS_DB)[0];
const done = (backend) => waitFor(() => ["Done", "Error"].includes(callPage(backend)?.properties.Status?.select?.name) && callPage(backend));

await test("END TO END: signed webhook -> call page -> three linked tasks -> three Discord pings", async () => {
  const backend = await startOffline();
  try {
    const req = buildSampleRequest(FAKE_SECRET);
    const res = await post(req);
    assert.equal(res.status, 202);
    const page = await done(backend);
    assert.equal(page.properties.Status.select.name, "Done", backend.text(page, "Error"));
    assert.equal(backend.text(page, "Call"), "Northwind Studio discovery call");
    assert.equal(page.properties["Recording ID"].number, req.recordingId);
    assert.equal(page.properties.Client.select.name, "Jordan Reyes");
    assert.equal(page.properties["Tasks Created"].number, 3);
    assert.equal(backend.text(page, "Error"), "");

    const body = backend.blocksOf(page.id);
    assert.equal(body[0].type, "callout");
    assert.equal(body.filter((b) => b.type === "to_do").length, 4);
    const toggle = body.at(-1);
    assert.equal(toggle.type, "heading_2");
    assert.equal(backend.blocksOf(toggle.id).length, 9, "the transcript sits inside the toggle");

    const tasks = backend.pagesIn(process.env.NOTION_TASKS_DB);
    assert.deepEqual(tasks.map((t) => backend.text(t, "Owner")).sort(), ["Priya", "Sam", "Sam"]);
    assert.ok(tasks.every((t) => t.properties.Call.relation[0].id === page.id), "every task links back to the call");
    assert.ok(tasks.every((t) => t.properties.Status.select.name === "Not Started"));

    const d = backend.state.discord;
    assert.equal(d.messages.length, 3);
    assert.ok(d.messages.every((m) => m.channel_id === IDS.channel));
    assert.deepEqual(d.messages.map((m) => m.content).sort(), [`<@${IDS.sam}>`, `<@${IDS.sam}>`, `<@${IDS.priya}>`].sort());
    assert.ok(d.messages.every((m) => m.allowed_mentions.parse.includes("users")), "the mention really notifies");
    assert.equal(d.messages[0].embeds[0].author.name, "📋 NEW TASK · Tasks");
    assert.ok(d.messages[0].components[0].components.some((c) => c.label === "Call recording" && /timestamp=/.test(c.url)));
    assert.equal(d.threads.length, 3);
    const ledger = backend.pagesIn(process.env.NOTION_LEDGER_DB);
    assert.equal(ledger.length, 3);
    assert.ok(ledger.every((r) => backend.text(r, "Message ID") && backend.text(r, "Lock") === ""), "ledger rows recorded and unlocked");

    // The same delivery again (Fathom retries) must change nothing.
    const again = await post(buildSampleRequest(FAKE_SECRET));
    assert.equal(again.status, 202, "a different recording id is a new call");
    await waitFor(() => backend.pagesIn(process.env.NOTION_CALLS_DB).every((p) => p.properties.Status.select.name === "Done") && backend.pagesIn(process.env.NOTION_CALLS_DB).length === 2);
    const replay = await post(req);
    assert.equal(replay.status, 200);
    assert.equal(await replay.text(), "already handled");
    assert.equal(backend.pagesIn(process.env.NOTION_TASKS_DB).length, 6);
    assert.ok(backend.state.calls.every((c) => ["notion", "fathom", "discord"].includes(c.service)));
  } finally { backend.restore(); }
});

await test("webhook with a bad signature is refused before anything is written", async () => {
  const backend = await startOffline();
  try {
    const req = buildSampleRequest("whsec_" + Buffer.from("someone-else").toString("base64"));
    const res = await post(req);
    assert.equal(res.status, 401);
    assert.equal(backend.state.calls.length, 0);
  } finally { backend.restore(); }
});

await test("webhook with a setup problem answers 500 naming the variable, and writes nothing", async () => {
  const backend = await startOffline();
  try {
    delete process.env.NOTION_TASKS_DB;
    const res = await post(buildSampleRequest(FAKE_SECRET));
    assert.equal(res.status, 500);
    assert.match(await res.text(), /setup problem: Missing environment variable NOTION_TASKS_DB/);
    assert.equal(backend.state.pages.size, 0);
  } finally { backend.restore(); }
});

await test("rebuilding a call marked Error does not duplicate its tasks or its Discord cards", async () => {
  const backend = await startOffline();
  try {
    const m = sample();
    const id = await core.claim(m);
    await core.processMeeting(m, id);
    assert.equal(backend.pagesIn(process.env.NOTION_TASKS_DB).length, 3);
    assert.equal(await core.claim(m), null, "a Done call is skipped");
    callPage(backend).properties.Status = { type: "select", select: { name: "Error" } };
    const again = await core.claim(m);
    assert.equal(again, id);
    assert.equal(backend.blocksOf(id).length, 0, "the old page body is cleared before the rebuild");
    const r = await core.processMeeting(m, again);
    assert.equal(r.tasks, 3);
    assert.equal(r.newTasks, 0);
    assert.equal(backend.pagesIn(process.env.NOTION_TASKS_DB).length, 3);
    assert.equal(backend.state.discord.messages.length, 3);
  } finally { backend.restore(); }
});

await test("Discord failing does not lose the call: page is Done, tasks exist, the problem is written on the page", async () => {
  const backend = await startOffline();
  try {
    backend.state.fail.discord = 403;
    const m = sample();
    const r = await core.processMeeting(m, await core.claim(m));
    assert.equal(r.tasks, 3);
    assert.equal(r.discordErrors.length, 3);
    const page = callPage(backend);
    assert.equal(page.properties.Status.select.name, "Done");
    assert.match(backend.text(page, "Error"), /Discord failed for 3 task\(s\).*403.*permission/);
  } finally { backend.restore(); }
});

await test("Discord switched off: Notion is filled and Discord is never contacted", async () => {
  const backend = await startOffline({ discord: false });
  try {
    const m = sample();
    const r = await core.processMeeting(m, await core.claim(m));
    assert.equal(r.tasks, 3);
    assert.equal(backend.state.calls.filter((c) => c.service === "discord").length, 0);
    const { relayConfig } = await import("../lib/relay/config.js");
    assert.throws(() => relayConfig(), (e) => e.name === "SetupError" && /DISCORD_BOT_TOKEN/.test(e.message));
  } finally { backend.restore(); }
});

await test("a summary that is not ready yet marks the page Error so the sweep retries it", async () => {
  const backend = await startOffline();
  try {
    const m = { ...sample(), default_summary: null };
    const id = await core.claim(m);
    await assert.rejects(core.processMeeting(m, id), /summary not ready/);
    assert.equal(callPage(backend).properties.Status.select.name, "Error");
    assert.match(backend.text(callPage(backend), "Error"), /summary not ready/);
  } finally { backend.restore(); }
});

await test("the webhook payload is topped up from the Fathom API when it arrives without summary or transcript", async () => {
  const full = sample();
  const backend = await startOffline({ meetings: [full] });
  try {
    const thin = { recording_id: full.recording_id, title: full.title, created_at: full.created_at, share_url: full.share_url };
    const r = await core.processMeeting(thin, await core.claim(thin));
    assert.equal(r.tasks, 3);
    assert.equal(backend.blocksOf(backend.blocksOf(r.pageId).at(-1).id).length, 9);
    const noDate = { recording_id: full.recording_id + 1, title: "No date" };
    const bare = await core.processMeeting(noDate, await core.claim(noDate));
    assert.equal(bare.tasks, 0, "a payload with no created_at and nothing said still files a page instead of crashing on the date");
  } finally { backend.restore(); }
});

// ---------------------------------------------------------------- relay: status moves
await test("relay: Blocked pings the assignee and the escalation role in the thread; Done pings nobody and closes it", async () => {
  const backend = await startOffline();
  try {
    const m = { ...sample(), action_items: sample().action_items.slice(1, 2) };
    await core.processMeeting(m, await core.claim(m));
    const { relayConfig } = await import("../lib/relay/config.js");
    const { handlePage } = await import("../lib/relay/relay.js");
    const task = backend.pagesIn(process.env.NOTION_TASKS_DB)[0];
    const move = (name) => { task.properties.Status = { type: "select", select: { name } }; return handlePage(relayConfig(), task.id, { mode: "live" }); };

    const same = await handlePage(relayConfig(), task.id, { mode: "live" });
    assert.equal(same.action, "no-change", "a later Notion webhook for the same task does not post a second card");
    assert.equal(backend.state.discord.messages.length, 1);

    const blocked = await move("Blocked");
    assert.equal(blocked.action, "moved");
    const note = backend.state.discord.messages.at(-1);
    assert.equal(note.channel_id, backend.state.discord.threads[0].id, "the move is posted in the task's thread");
    assert.equal(note.content, `<@&${IDS.role}> <@${IDS.priya}>`);
    assert.match(note.embeds[0].description, /`Not Started` → `Blocked`/);

    const finished = await move("Done");
    assert.equal(finished.to, "Done");
    assert.equal(backend.state.discord.messages.at(-1).content, undefined);
    assert.equal(backend.state.discord.threads[0].archived, true);
  } finally { backend.restore(); }
});

await test("relay: the Owner name is used for the ping when the Notion Assignee name maps to nobody", async () => {
  const backend = await startOffline();
  try {
    const m = { ...sample(), action_items: sample().action_items.slice(0, 1) };
    await core.processMeeting(m, await core.claim(m));
    const task = backend.pagesIn(process.env.NOTION_TASKS_DB)[0];
    assert.equal(task.properties.Assignee.people[0].name, "Samuel J Carter", "Notion returns a profile name that is not an alias");
    assert.equal(backend.state.discord.messages[0].content, `<@${IDS.sam}>`);
  } finally { backend.restore(); }
});

// ---------------------------------------------------------------- the other endpoints
await test("sweep: refuses without the cron secret, then processes a missed call and syncs the board", async () => {
  const backend = await startOffline({ meetings: [sample()] });
  try {
    const { GET } = await import("../api/sweep.js");
    const call = (auth) => GET(new Request("https://offline.test/api/sweep", { headers: auth ? { authorization: auth } : {} }));
    assert.equal((await call()).status, 401);
    assert.equal((await call("Bearer undefined")).status, 401);
    const res = await call("Bearer offline-cron-secret");
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.checked, 1);
    assert.equal(out.processed[0].tasks, 3);
    assert.deepEqual(out.relay, { rows: 3, errors: 0 });
    assert.equal(backend.state.discord.messages.length, 3, "the sync that follows does not post the cards twice");
    delete process.env.CRON_SECRET;
    const unset = await call("Bearer undefined");
    assert.equal(unset.status, 500);
    assert.match(await unset.text(), /CRON_SECRET/);
  } finally { backend.restore(); }
});

await test("Notion webhook endpoint: verification token, signature check, unwatched database skipped, health shows no values", async () => {
  const backend = await startOffline();
  try {
    const { default: handler, signatureOk } = await import("../api/notion.js");
    const { Readable } = await import("node:stream");
    const call = async (method, url, body, headers = {}) => {
      const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
      Object.assign(req, { method, url, headers });
      let status = 0, data = null;
      const res = { status(s) { status = s; return this; }, json(d) { data = d; return this; } };
      await handler(req, res);
      return { status, data };
    };
    assert.equal((await call("GET", "/api/notion?action=verify_token")).status, 403);
    assert.equal((await call("POST", "/api/notion", { verification_token: "tok_123" })).status, 200);
    assert.equal((await call("GET", "/api/notion?action=verify_token&key=offline-admin-key")).data.token, "tok_123");
    const health = (await call("GET", "/api/notion?action=health")).data;
    assert.equal(health.notion_key, true);
    assert.ok(Object.values(health).every((v) => typeof v === "boolean"), "health reports only true or false");
    const event = { type: "page.created", entity: { id: "x", type: "page" }, data: { parent: { id: (await import("node:crypto")).randomUUID() } } };
    assert.equal((await call("POST", "/api/notion", event)).data.skipped, "not a watched database");
    process.env.NOTION_WEBHOOK_SECRET = "s3cret";
    assert.equal((await call("POST", "/api/notion", event)).status, 401);
    const crypto = await import("node:crypto");
    const raw = Buffer.from(JSON.stringify(event));
    assert.equal(signatureOk(raw, "sha256=" + crypto.createHmac("sha256", "s3cret").update(raw).digest("hex")), true);
    assert.equal(signatureOk(raw, "sha256=00"), false);
    assert.equal(backend.state.calls.length, 0);
  } finally { delete process.env.NOTION_WEBHOOK_SECRET; backend.restore(); }
});

// ---------------------------------------------------------------- manual transcript flow and commands
await test("manual task file: planned with owners, keys, checklist and due date", async () => {
  const { planManual } = await import("../scripts/push-tasks.mjs");
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "sample", "tasks.example.json"), "utf8"));
  const plan = planManual(data, cfg);
  assert.match(plan.source, /^paste-[0-9a-f]{8}$/);
  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.tasks[0].properties.Assignee.people[0].id, "00000000-0000-0000-0000-000000000000");
  assert.equal(plan.tasks[0].properties["Due Date"].date.start, "2030-01-18");
  assert.equal(plan.tasks[0].children.filter((b) => b.type === "to_do").length, 3);
  assert.match(plan.tasks[1].properties.Notes.rich_text[0].text.content, /CHECK: Confirm which CRM/);
  assert.throws(() => planManual({ call: { title: "x" }, tasks: [] }, cfg), /call\.date/);
});

const NO_CONFIG = path.join(os.tmpdir(), "call-to-tasks-no-such-config.json");
const TEST_CONFIG = path.join(HERE, "config.test.json");
const PRELOAD = path.join(HERE, "preload-offline.mjs");
// Each command runs as its own process, exactly as "npm run" starts it. It never reads your .env.local.
const cli = (script, args, env, { offline = false } = {}) => spawnSync(process.execPath, [...(offline ? ["--import", PRELOAD] : []), path.join(ROOT, "scripts", script), ...args], {
  encoding: "utf8", cwd: ROOT,
  env: { PATH: process.env.PATH, CALL_TO_TASKS_NO_ENV_FILE: "1", CALL_TO_TASKS_CONFIG: NO_CONFIG, ...env },
});

await test("npm run check: fails with a list when nothing is configured, passes with a complete setup, prints no values", () => {
  const empty = cli("check.mjs", [], {});
  assert.equal(empty.status, 1);
  assert.match(empty.stdout, /FAIL  config\.json: config\.json not found/);
  assert.match(empty.stdout, /FAIL  FATHOM_API_KEY: Missing environment variable FATHOM_API_KEY/);
  const full = cli("check.mjs", [], {
    CALL_TO_TASKS_CONFIG: TEST_CONFIG, FATHOM_API_KEY: "SECRETVALUE1", NOTION_API_KEY: "SECRETVALUE2", CRON_SECRET: "SECRETVALUE3",
    FATHOM_WEBHOOK_SECRET: "SECRETVALUE4", NOTION_CALLS_DB: HEX32, NOTION_TASKS_DB: HEX32.replace(/f$/, "e"),
    NOTION_LEDGER_DB: HEX32.replace(/f$/, "d"), DISCORD_BOT_TOKEN: "SECRETVALUE5", DISCORD_GUILD_ID: IDS.guild, DISCORD_TASK_CHANNEL_ID: IDS.channel,
  });
  assert.equal(full.status, 0, full.stdout + full.stderr);
  assert.match(full.stdout, /All checks passed/);
  assert.doesNotMatch(full.stdout + full.stderr, /SECRETVALUE/);
  const half = cli("check.mjs", [], { CALL_TO_TASKS_CONFIG: TEST_CONFIG, DISCORD_GUILD_ID: IDS.guild });
  assert.match(half.stdout, /FAIL  DISCORD_GUILD_ID set but DISCORD_BOT_TOKEN is empty/);
});

await test("commands stop with one clear line, not a stack trace, when setup is incomplete", () => {
  for (const [script, args] of [["status.mjs", []], ["backfill.mjs", ["3"]], ["one.mjs", ["123"]], ["board.mjs", []], ["relay.mjs", ["sync"]], ["fathom-fetch.mjs", ["--latest"]],
    ["register-webhook.mjs", ["https://example.com/api/fathom-webhook"]], ["send-sample.mjs", ["https://example.com/api/fathom-webhook"]], ["setup-notion.mjs", [HEX32]]]) {
    const r = cli(script, args, {});
    assert.equal(r.status, 1, script);
    assert.match(r.stderr, /SETUP PROBLEM: (Missing environment variable|config\.json not found|Discord is not configured)/, `${script}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /\n\s+at /, `${script} printed a stack trace`);
  }
  const usage = cli("register-webhook.mjs", ["not-a-url"], { FATHOM_API_KEY: "x" });
  assert.match(usage.stderr, /FAILED: Give the full address/);
  const dry = cli("setup-notion.mjs", [HEX32, "--dry-run"], {});
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /Sync Key\s+rich_text/);
});

await test("every command works end to end as its own process against the fake services", () => {
  const ok = (r, label) => { assert.equal(r.status, 0, `${label}\n${r.stdout}\n${r.stderr}`); return r.stdout; };
  const env = { CALL_TO_TASKS_CONFIG: TEST_CONFIG };
  const live = ok(cli("check.mjs", ["--live"], env, { offline: true }), "check --live");
  assert.match(live, /PASS  Notion NOTION_TASKS_DB: reachable, all 13 properties present/);
  assert.match(live, /PASS  Notion NOTION_CALLS_DB: reachable, all 15 properties present/);
  assert.match(live, /PASS  Notion NOTION_LEDGER_DB: reachable, all 11 properties present/);
  assert.match(live, /PASS  Fathom API key: accepted \(1 recording/);
  assert.match(live, /PASS  Discord task channel: reachable and in the right server/);

  assert.match(ok(cli("status.mjs", ["3"], env, { offline: true }), "status"), /900000001 \| Northwind Studio discovery call \| NOT IN NOTION/);
  assert.match(ok(cli("backfill.mjs", ["3", "--dry-run"], env, { offline: true }), "backfill dry"), /1 meetings in the last 3 days\n900000001/);
  const one = ok(cli("one.mjs", ["900000001"], env, { offline: true }), "one");
  assert.match(one, /"tasks":3,"newTasks":3,"discordPosted":3,"discordErrors":\[\]/);
  assert.match(ok(cli("backfill.mjs", ["3"], env, { offline: true }), "backfill"), /ok \{"pageId"/);
  assert.match(ok(cli("fathom-fetch.mjs", ["900000001"], env, { offline: true }), "fathom"), /## Fathom action items\n- Send the proposal[\s\S]*## Transcript\n\[00:00:05\] Sam Carter:/);
  assert.match(ok(cli("fathom-fetch.mjs", ["--latest", "5"], env, { offline: true }), "fathom latest"), /^900000001 \| 2030-01-15T10:30 \| Northwind Studio discovery call/);
  assert.match(ok(cli("board.mjs", [], env, { offline: true }), "board"), /AREA OPTIONS: \["Sales","Marketing","Operations","Client","Content","Other"\]\nTASKS \(0\):/);
  assert.match(ok(cli("relay.mjs", ["sync"], env, { offline: true }), "relay sync"), /live complete: 0 rows processed/);

  const example = path.join(ROOT, "sample", "tasks.example.json");
  assert.match(ok(cli("push-tasks.mjs", [example, "--dry-run"], env), "push dry"), /would create up to 2 tasks \(source paste-[0-9a-f]{8}\); nothing was sent/);
  const push = ok(cli("push-tasks.mjs", [example], env, { offline: true }), "push");
  assert.match(push, /created 2 tasks, skipped 0 already on the board, 0 update\(s\), call page https:\/\/notion\.test\/page\/.+ 2 Discord card\(s\) posted/);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`);
process.exit(failed.length ? 1 : 0);
