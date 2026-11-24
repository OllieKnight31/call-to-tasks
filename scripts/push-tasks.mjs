// Push a hand-extracted task file to the task board, log the call in the Call Library and link the two.
// Safe to run twice: a task whose Sync Key already exists is skipped.
//   npm run -s push -- tasks.json [--dry-run] [--no-discord]
// The file format is shown in sample/tasks.example.json.
import fs from "node:fs";
import crypto from "node:crypto";
import { loadEnv, run } from "./_env.mjs";
loadEnv();
const { notion, rt, secs, tasksDb, callsDb, findCallPage } = await import("../lib/core.js");
const { loadConfig, discordEnabled } = await import("../lib/settings.js");
const { memberFor } = await import("../lib/team.js");

const sha = (s, n) => crypto.createHash("sha1").update(s).digest("hex").slice(0, n);
const para = (s) => ({ object: "block", type: "paragraph", paragraph: { rich_text: rt(s) } });

/** tasks.json -> the Notion pages to create. Pure, so it can be tested without Notion. */
export function planManual(data, cfg) {
  const call = data.call || {};
  if (!call.title || !/^\d{4}-\d{2}-\d{2}$/.test(call.date || "")) throw new Error('tasks.json needs call.title and call.date ("YYYY-MM-DD").');
  if (!Array.isArray(data.tasks)) throw new Error('tasks.json needs a "tasks" list.');
  const share = String(call.share_url || "").split("?")[0] || null;
  const source = call.recording_id ? String(call.recording_id) : `paste-${sha(`${call.title}${call.date}`, 8)}`;
  const tasks = data.tasks.map((t, i) => {
    if (!t.task) throw new Error(`tasks[${i}] has no "task" title.`);
    const ts = t.timestamp || "";
    let note = `From the ${call.date} call${ts ? ` at ${ts}` : ""}. ${t.summary || ""}`;
    if (t.done_evidence) note += ` | Done: ${t.done_evidence}`;
    if (t.needs_check) note += ` | CHECK: ${t.notes || ""}`;
    else if (t.notes) note += ` | ${t.notes}`;
    const owners = String(t.owner || cfg.default_owner).split(/,|&/).map((s) => s.trim()).filter(Boolean);
    const people = [...new Set(owners.map((name) => memberFor({ name }, cfg)?.notion_user_id).filter(Boolean))];
    const properties = {
      Task: { title: rt(String(t.task).slice(0, 200)) },
      Status: { select: { name: t.status || "Not Started" } },
      Urgency: { select: { name: t.urgency || cfg.tasks.default_urgency } },
      Owner: { rich_text: rt(owners.join(" & ")) },
      Source: { select: { name: "Fathom call" } },
      Notes: { rich_text: rt(note) },
      "Sync Key": { rich_text: rt(`${source}:${sha(t.task, 10)}`) },
      ...(t.area ? { Area: { select: { name: t.area } } } : {}),
      ...(people.length ? { Assignee: { people: people.map((id) => ({ id })) } } : {}),
      ...(data.client ? { Client: { select: { name: String(data.client).replace(/,/g, "") } } } : {}),
      ...(share ? { "Call Link": { url: ts ? `${share}?timestamp=${secs(ts)}` : share } } : {}),
      ...(t.due ? { "Due Date": { date: { start: t.due } } } : {}),
    };
    const children = [para(t.summary || t.task)];
    if (t.checklist?.length) {
      children.push({ object: "block", type: "heading_3", heading_3: { rich_text: rt("Checklist") } });
      for (const c of t.checklist.slice(0, 40)) children.push({ object: "block", type: "to_do", to_do: { rich_text: rt(c), checked: t.status === "Done" } });
    }
    if (t.quote) children.push({ object: "block", type: "quote", quote: { rich_text: rt(t.quote) } });
    return { key: `${source}:${sha(t.task, 10)}`, title: t.task, owner: owners.join(" & "), status: t.status || "Not Started", properties, children };
  });
  return { source, share, tasks };
}

if (process.argv[1] && process.argv[1].endsWith("push-tasks.mjs")) {
  await run(async () => {
    const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
    if (!file) throw new Error("Give the path to tasks.json.");
    const dry = process.argv.includes("--dry-run");
    const cfg = loadConfig();
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const plan = planManual(data, cfg);
    if (dry) {
      for (const t of plan.tasks) console.log(`[DRY] ${t.status.padEnd(11)} ${t.owner.padEnd(14)} ${t.title}`);
      console.log(`would create up to ${plan.tasks.length} tasks (source ${plan.source}); nothing was sent`);
      return;
    }
    const call = data.call;

    // 1. The call row: reuse the one the webhook made for this recording, otherwise create it.
    let page = call.recording_id ? await findCallPage(call.recording_id) : null;
    if (!page && !call.recording_id) {
      page = (await notion("POST", `/databases/${callsDb()}/query`, { filter: { property: "Call", title: { equals: call.title } }, page_size: 1 })).results[0] || null;
    }
    if (!page) {
      page = await notion("POST", "/pages", {
        parent: { database_id: callsDb() }, icon: { type: "emoji", emoji: "📞" },
        properties: {
          Call: { title: rt(call.title) }, Date: { date: { start: call.date } }, Attendees: { rich_text: rt(call.participants) },
          Status: { select: { name: "Done" } },
          ...(call.recording_id ? { "Recording ID": { number: Number(call.recording_id) } } : {}),
          ...(plan.share ? { Recording: { url: plan.share } } : {}),
          ...(data.client ? { Client: { select: { name: String(data.client).replace(/,/g, "") } } } : {}),
        },
      });
    }

    // 2. Tasks.
    const existing = (await notion("POST", `/databases/${tasksDb()}/query`, { filter: { property: "Sync Key", rich_text: { starts_with: `${plan.source}:` } }, page_size: 100 })).results;
    const have = new Set(existing.map((p) => (p.properties["Sync Key"]?.rich_text || []).map((x) => x.plain_text).join("")));
    const created = [];
    let skipped = 0;
    for (const t of plan.tasks) {
      if (have.has(t.key)) { skipped++; continue; }
      const made = await notion("POST", "/pages", { parent: { database_id: tasksDb() }, properties: { ...t.properties, Call: { relation: [{ id: page.id }] } }, children: t.children });
      created.push(made.id);
      console.log(`+ ${t.title}`);
    }

    // 3. Notes appended to tasks that already existed.
    for (const u of data.updates || []) {
      const pg = await notion("GET", `/pages/${u.existing_id}`);
      const old = (pg.properties.Notes?.rich_text || []).map((x) => x.plain_text).join("");
      const stamp = ` | ${call.date} call: ${u.append_note}`;
      if (old.includes(stamp)) continue;
      await notion("PATCH", `/pages/${u.existing_id}`, { properties: { Notes: { rich_text: rt((old + stamp).slice(0, 2000)) } } });
      console.log(`~ updated: ${u.existing_title || u.existing_id}`);
    }
    await notion("PATCH", `/pages/${page.id}`, { properties: { "Tasks Created": { number: existing.length + created.length } } });

    let pinged = "Discord off";
    if (created.length && discordEnabled() && !process.argv.includes("--no-discord")) {
      const { notifyTasks } = await import("../lib/notify.js");
      const d = await notifyTasks(created);
      pinged = `${d.posted} Discord card(s) posted${d.errors.length ? `, ${d.errors.length} failed: ${d.errors[0]}` : ""}`;
    }
    console.log(`created ${created.length} tasks, skipped ${skipped} already on the board, ${(data.updates || []).length} update(s), call page ${page.url || page.id}. ${pinged}`);
  });
}
