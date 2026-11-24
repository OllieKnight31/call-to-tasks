// Fathom call -> Notion "Call Library" page (summary, takeaways, next steps, recording, transcript)
// -> one task per action item on the Notion task board -> Discord ping for the assignee.
// No AI key is needed: the summary and the action items are Fathom's own.
import crypto from "node:crypto";
import { env, notionId, loadConfig, discordEnabled } from "./settings.js";
import { memberFor, ownerOf } from "./team.js";

export const callsDb = () => notionId("NOTION_CALLS_DB");
export const tasksDb = () => notionId("NOTION_TASKS_DB");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Fathom ----------
async function fathom(path) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch("https://api.fathom.ai/external/v1" + path, {
      headers: { "X-Api-Key": env("FATHOM_API_KEY") },
    }).catch((e) => (i < 3 ? null : Promise.reject(e)));
    if (!r) { await sleep(2000 * 2 ** i); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(2000 * 2 ** i); continue; }
    if (r.status === 401 || r.status === 403) throw new Error(`Fathom refused the API key (${r.status}). Check FATHOM_API_KEY.`);
    if (!r.ok) throw new Error(`Fathom ${r.status} ${path}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  }
  throw new Error(`Fathom retries exhausted ${path}`);
}

export async function listMeetings(createdAfterIso, extra = {}) {
  const out = [];
  let cursor = null;
  do {
    const q = new URLSearchParams({ created_after: createdAfterIso, ...extra });
    if (cursor) q.set("cursor", cursor);
    const d = await fathom(`/meetings?${q}`);
    out.push(...(d.items || []));
    cursor = d.next_cursor;
  } while (cursor);
  return out;
}

async function getTranscript(meeting) {
  if (Array.isArray(meeting.transcript) && meeting.transcript.length) return meeting.transcript;
  const d = await fathom(`/recordings/${meeting.recording_id}/transcript`);
  return d.transcript || [];
}

// Fathom signs webhooks the Svix way: HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`,
// keyed with the base64 part of the secret that follows "whsec_".
export function signFathom(secret, id, ts, rawBody) {
  const key = Buffer.from(String(secret).replace(/^whsec_/, ""), "base64");
  return crypto.createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest();
}

export function verifyFathomSignature(headers, rawBody) {
  const secret = env("FATHOM_WEBHOOK_SECRET");
  const id = headers.get("webhook-id"), ts = headers.get("webhook-timestamp"), sigs = headers.get("webhook-signature");
  if (!id || !ts || !sigs) return false;
  if (!(Math.abs(Date.now() / 1000 - Number(ts)) <= 600)) return false;
  const expected = signFathom(secret, id, ts, rawBody);
  return sigs.split(" ").some((s) => {
    const b = Buffer.from(s.split(",")[1] || "", "base64");
    return b.length === expected.length && crypto.timingSafeEqual(b, expected);
  });
}

// ---------- Notion ----------
export async function notion(method, path, body) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch("https://api.notion.com/v1" + path, {
      method,
      headers: {
        Authorization: "Bearer " + env("NOTION_API_KEY"),
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    }).catch((e) => (i < 4 ? null : Promise.reject(e)));
    if (!r) { await sleep(1000 * 2 ** i); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(1000 * 2 ** i); continue; }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Error("Notion refused the key (401). Check NOTION_API_KEY.");
    if (r.status === 404) throw new Error(`Notion 404 ${path}: the database or page is not shared with your integration. Open it in Notion, choose Connections and add the integration. ${JSON.stringify(j).slice(0, 200)}`);
    if (!r.ok) throw new Error(`Notion ${r.status} ${path}: ${JSON.stringify(j).slice(0, 400)}`);
    return j;
  }
  throw new Error(`Notion retries exhausted ${path}`);
}

export const rt = (s, extra = {}) => {
  const text = String(s ?? "").slice(0, 2000);
  return text ? [{ type: "text", text: { content: text }, ...extra }] : [];
};
const para = (s) => ({ object: "block", type: "paragraph", paragraph: { rich_text: rt(s) } });
const heading = (s) => ({ object: "block", type: "heading_2", heading_2: { rich_text: rt(s) } });

async function appendBlocks(parentId, blocks) {
  for (let i = 0; i < blocks.length; i += 100) {
    await notion("PATCH", `/blocks/${parentId}/children`, { children: blocks.slice(i, i + 100) });
  }
}

export async function findCallPage(recordingId) {
  const d = await notion("POST", `/databases/${callsDb()}/query`, {
    filter: { property: "Recording ID", number: { equals: Number(recordingId) } },
    page_size: 1,
  });
  return d.results[0] || null;
}

async function clearPageBody(pageId) {
  let d;
  do {
    d = await notion("GET", `/blocks/${pageId}/children?page_size=100`);
    for (const b of d.results) await notion("DELETE", `/blocks/${b.id}`);
  } while (d.has_more);
}

// ---------- helpers (pure) ----------
// Old exports hold lists as Python-style strings; the API sends real arrays. Never let a stray quote fail the call.
export function parseList(v) {
  if (typeof v !== "string") return v || [];
  try { return JSON.parse(v); } catch { /* try the Python spelling next */ }
  try { return JSON.parse(v.replace(/'/g, '"').replace(/None/g, "null").replace(/False/g, "false").replace(/True/g, "true")); } catch { return []; }
}
export const secs = (ts) => String(ts || "0:0:0").split(":").reduce((a, x) => a * 60 + (Number(x) || 0), 0);
const minutes = (m) => {
  const a = Date.parse(m.recording_start_time), b = Date.parse(m.recording_end_time);
  return a && b ? Math.round((b - a) / 60000) : null;
};

export function mergeTranscript(lines) {
  const out = [];
  for (const l of lines) {
    const text = String(l?.text ?? "").trim();
    if (!text) continue;
    const who = l.speaker?.display_name || "Unknown";
    const last = out[out.length - 1];
    if (last && last.who === who && last.text.length < 1500) last.text += " " + text;
    else out.push({ who, ts: l.timestamp || "", text });
  }
  return out;
}

export function transcriptBlocks(merged) {
  const blocks = [];
  for (const m of merged) {
    const prefix = `[${m.ts}] ${m.who}: `;
    let text = m.text;
    let first = true;
    while (text.length) {
      const head = first ? prefix : "";
      const room = 1990 - head.length;
      const chunk = text.slice(0, room);
      text = text.slice(room);
      blocks.push({
        object: "block", type: "paragraph",
        paragraph: { rich_text: [...(head ? rt(head, { annotations: { bold: true } }) : []), ...rt(chunk)] },
      });
      first = false;
    }
  }
  return blocks;
}

const GENERIC_TITLE = /impromptu|google meet meeting|zoom meeting|teams meeting|^meeting$|^call$/i;

// The webhook payload may not carry everything; fetch the full meeting (summary, action items, transcript).
async function hydrate(meeting) {
  const created = Date.parse(meeting.created_at) || Date.now();
  const from = new Date(created - 3600e3).toISOString();
  let cursor = null;
  do {
    const q = new URLSearchParams({ created_after: from, include_summary: "true", include_action_items: "true", include_transcript: "true" });
    if (cursor) q.set("cursor", cursor);
    const d = await fathom(`/meetings?${q}`);
    const hit = (d.items || []).find((m) => String(m.recording_id) === String(meeting.recording_id));
    if (hit) return { ...meeting, ...hit };
    cursor = d.next_cursor;
  } while (cursor);
  return meeting;
}

export function sections(md) {
  const out = {};
  let cur = null;
  for (const line of (md || "").split("\n")) {
    const h = line.match(/^## (.+)/);
    if (h) { cur = h[1].trim(); out[cur] = []; continue; }
    if (cur) out[cur].push(line);
  }
  return out;
}

// "[**Bold:** text](url)" -> plain "Bold: text"
export const plain = (s) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*/g, "").replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim();

function mdInline(text) {
  const parts = [];
  const re = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0, m;
  const pushText = (t, link) => {
    t.split(/(\*\*[^*]+\*\*)/).forEach((seg) => {
      if (!seg) return;
      const bold = /^\*\*.*\*\*$/.test(seg);
      const content = bold ? seg.slice(2, -2) : seg;
      for (let i = 0; i < content.length; i += 1900) {
        parts.push({ type: "text", text: { content: content.slice(i, i + 1900), ...(link ? { link: { url: link } } : {}) }, annotations: { bold } });
      }
    });
  };
  while ((m = re.exec(text))) {
    if (m.index > last) pushText(text.slice(last, m.index));
    pushText(m[1], m[2]);
    last = re.lastIndex;
  }
  if (last < text.length) pushText(text.slice(last));
  return parts.slice(0, 100);
}

// Fathom's markdown summary -> Notion blocks (headings, bullets and numbered lists with one level of nesting, paragraphs).
export function mdBlocks(md) {
  const blocks = [];
  let parent = null;
  for (const raw of (md || "").split("\n")) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const line = raw.trim();
    let b;
    if (line.startsWith("### ")) b = { object: "block", type: "heading_3", heading_3: { rich_text: mdInline(line.slice(4)) } };
    else if (line.startsWith("## ")) b = { object: "block", type: "heading_2", heading_2: { rich_text: mdInline(line.slice(3)) } };
    else if (line.startsWith("# ")) b = { object: "block", type: "heading_1", heading_1: { rich_text: mdInline(line.slice(2)) } };
    else if (/^[-*]\s+/.test(line)) b = { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: mdInline(line.replace(/^[-*]\s+/, "")) } };
    else if (/^\d+\.\s+/.test(line)) b = { object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: mdInline(line.replace(/^\d+\.\s+/, "")) } };
    else b = { object: "block", type: "paragraph", paragraph: { rich_text: mdInline(line) } };
    const isList = b.type.endsWith("list_item");
    if (isList && indent >= 4 && parent && (parent[parent.type].children?.length ?? 0) < 100) {
      const body = parent[parent.type];
      (body.children ||= []).push(b);
      continue;
    }
    blocks.push(b);
    parent = isList ? b : null;
  }
  return blocks;
}

export function shorten(s, n) {
  if (s.length <= n) return s;
  const cut = s.lastIndexOf(" ", n);
  return s.slice(0, cut > 0 ? cut : n).replace(/[,;:]$/, "") + "…";
}

/** Who was on the call, who the client is and what kind of call it was. Pure. */
export function classify(meeting, people, md, cfg) {
  const title = meeting.title || meeting.meeting_title || "";
  const others = people.filter((p) => !memberFor(p, cfg));
  const internal = people.length > 0 && others.length === 0;
  const named = others.find((p) => p.name && !p.name.includes("@"))?.name;
  const client = (internal ? "Internal"
    : named || (!GENERIC_TITLE.test(title) && title ? title : (others[0]?.email || "").split("@")[0])
  ).replace(/,/g, "").trim().slice(0, 90);
  const t = `${title} ${plain((sections(md)["Meeting Purpose"] || []).join(" "))}`;
  const callType = /onboard/i.test(t) ? "Onboarding"
    : internal ? "Internal / Team"
    : /discovery|sales|strategy session|intro|consult|qualif|closing|demo/i.test(t) ? "Sales / Discovery"
    : /coach|check[- ]?in|team call|review|feedback/i.test(t) ? "Client Coaching"
    : /podcast|interview|content|record/i.test(t) ? "Content / Interview"
    : "Other";
  return { client, callType, internal };
}

/** Does this call get tasks? Every call does, unless config.json limits it by title. Pure. */
export function wantsTasks(title, cfg) {
  const pattern = cfg.tasks.only_for_titles_matching;
  return !pattern || new RegExp(pattern, "i").test(title || "");
}

/** The Notion task rows for a call's action items (owner resolved, stable Sync Key). Pure. */
export function planTasks(meeting, title, client, items, cfg) {
  const rid = meeting.recording_id;
  const date = String(meeting.recording_start_time || meeting.created_at || "").slice(0, 10);
  const video = meeting.share_url || meeting.url || null;
  const out = [];
  const seen = new Set();
  for (const t of items) {
    const owner = ownerOf(t.assignee, cfg);
    if (!owner) continue;
    const key = `${rid}:auto-${crypto.createHash("sha1").update(t.description).digest("hex").slice(0, 10)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = t.recording_timestamp ? ` at ${t.recording_timestamp}` : "";
    out.push({
      key,
      owner: owner.name,
      properties: {
        Task: { title: rt(t.description.slice(0, 200)) },
        Owner: { rich_text: rt(owner.name) },
        ...(owner.notion_user_id ? { Assignee: { people: [{ id: owner.notion_user_id }] } } : {}),
        Urgency: { select: { name: cfg.tasks.default_urgency } },
        Status: { select: { name: "Not Started" } },
        Source: { select: { name: "Fathom call" } },
        ...(client ? { Client: { select: { name: client } } } : {}),
        ...(video ? { "Call Link": { url: t.recording_timestamp ? `${video}?timestamp=${secs(t.recording_timestamp)}` : video } } : {}),
        Notes: { rich_text: rt(`From the ${date} call "${title}"${at}.`) },
        "Sync Key": { rich_text: rt(key) },
      },
    });
  }
  return out;
}

/** Everything that goes on the call page, worked out from the Fathom meeting alone. Pure. */
export function buildBriefing(meeting, transcript, cfg) {
  const md = meeting.default_summary?.markdown_formatted || "";
  const invitees = parseList(meeting.calendar_invitees);
  const speakers = [...new Set(transcript.map((l) => l.speaker?.display_name).filter(Boolean))];
  const people = [...invitees, ...speakers.filter((n) => !invitees.some((i) => i.name === n || i.matched_speaker_display_name === n)).map((name) => ({ name }))];
  const attendees = [...new Set(people.map((p) => p.name || p.email).filter(Boolean))].join(", ");
  const video = meeting.share_url || meeting.url || null;
  const { client, callType } = classify(meeting, people, md, cfg);

  const sec = sections(md);
  const purpose = plain((sec["Meeting Purpose"] || []).join(" "));
  const takeaways = (sec["Key Takeaways"] || []).filter((l) => l.trim()).map(plain);
  const nextSteps = (sec["Next Steps"] || []).filter((l) => l.trim()).map(plain);
  const briefing = md ? [purpose, ...takeaways.map((t) => `• ${t}`)].filter(Boolean).join("\n") : "Too little was said on this recording to summarise.";
  const baseTitle = meeting.title || meeting.meeting_title || "Call";
  const title = GENERIC_TITLE.test(baseTitle) && purpose
    ? `${client || "Call"} - ${shorten(purpose.replace(/^To /, ""), 70)}`
    : baseTitle;
  const items = (meeting.action_items || []).filter((t) => t?.description);

  const properties = {
    Call: { title: rt(title) },
    "Call Type": { select: { name: callType } },
    Briefing: { rich_text: rt(briefing) },
    "Next Steps": { rich_text: rt(nextSteps.join("\n")) },
    Attendees: { rich_text: rt(attendees) },
    "Duration (min)": { number: minutes(meeting) },
    "Recorded By": { rich_text: rt(parseList(meeting.recorded_by)?.name || "") },
  };
  if (client) properties.Client = { select: { name: client } };

  const blocks = [];
  if (video) {
    blocks.push({
      object: "block", type: "callout",
      callout: { icon: { type: "emoji", emoji: "🎬" }, color: "blue_background", rich_text: [...rt("Watch the recording: "), { type: "text", text: { content: video, link: { url: video } } }] },
    });
  }
  blocks.push(...(md ? mdBlocks(md) : [para(briefing)]));
  if (items.length) {
    blocks.push(heading("Action items"));
    for (const t of items) {
      const stamp = t.recording_timestamp
        ? [{ type: "text", text: { content: `[${t.recording_timestamp}]`, ...(video ? { link: { url: `${video}?timestamp=${secs(t.recording_timestamp)}` } } : {}) } }]
        : [];
      blocks.push({
        object: "block", type: "to_do",
        to_do: {
          checked: !!t.completed,
          rich_text: [...rt(`${t.assignee?.name || "Unassigned"}: `, { annotations: { bold: true } }), ...rt(t.description + " "), ...stamp],
        },
      });
    }
  }
  blocks.push({ object: "block", type: "divider", divider: {} });
  blocks.push({ object: "block", type: "heading_2", heading_2: { rich_text: rt("📝 Full transcript"), is_toggleable: true } });
  const tBlocks = transcriptBlocks(mergeTranscript(transcript));
  return {
    title, client, callType, items, properties, blocks,
    transcriptBlocks: tBlocks.length ? tBlocks : [para("(No transcript returned by Fathom.)")],
  };
}

// ---------- Tasks ----------
async function existingTasksFor(recordingId) {
  const d = await notion("POST", `/databases/${tasksDb()}/query`, {
    filter: { property: "Sync Key", rich_text: { starts_with: `${recordingId}:` } },
    page_size: 100,
  });
  return d.results;
}

const syncKeyOf = (page) => (page.properties?.["Sync Key"]?.rich_text || []).map((x) => x.plain_text ?? x.text?.content ?? "").join("");

/** Creates the missing tasks and links every task of this recording to the call page. Safe to run twice. */
async function pushTasks(pageId, meeting, plan) {
  const existing = await existingTasksFor(meeting.recording_id);
  const have = new Map(existing.map((p) => [syncKeyOf(p), p.id]));
  const created = [];
  for (const t of plan) {
    if (have.has(t.key)) continue;
    const page = await notion("POST", "/pages", {
      parent: { database_id: tasksDb() },
      properties: { ...t.properties, Call: { relation: [{ id: pageId }] } },
    });
    created.push(page.id);
  }
  // Tasks made earlier for this recording (a rerun, or the manual transcript flow) are linked, never duplicated.
  for (const p of existing) {
    const linked = (p.properties?.Call?.relation || []).some((r) => r.id === pageId);
    if (!linked) await notion("PATCH", `/pages/${p.id}`, { properties: { Call: { relation: [{ id: pageId }] } } });
  }
  return { created, total: existing.length + created.length };
}

// ---------- main entry ----------
// Creates the page as "Processing" (the idempotency lock). Returns null when the call should be skipped.
export async function claim(meeting) {
  loadConfig(); // fail before anything is written if config.json is missing or wrong
  tasksDb();
  const rid = meeting.recording_id;
  const found = await findCallPage(rid);
  if (found) {
    const status = found.properties.Status?.select?.name;
    const ageMin = (Date.now() - Date.parse(found.last_edited_time)) / 60000;
    if (status === "Done" || (status === "Processing" && ageMin < 15)) return null;
    await clearPageBody(found.id);
    await notion("PATCH", `/pages/${found.id}`, { properties: { Status: { select: { name: "Processing" } }, Error: { rich_text: [] } } });
    return found.id;
  }
  const start = meeting.recording_start_time || meeting.created_at || new Date().toISOString();
  const page = await notion("POST", "/pages", {
    parent: { database_id: callsDb() },
    icon: { type: "emoji", emoji: "📞" },
    properties: {
      Call: { title: rt(meeting.title || meeting.meeting_title || "Call") },
      "Recording ID": { number: Number(rid) },
      Recording: { url: meeting.share_url || meeting.url || null },
      Date: { date: { start } },
      Status: { select: { name: "Processing" } },
    },
  });
  return page.id;
}

export async function processMeeting(meeting, pageId) {
  try {
    const cfg = loadConfig();
    meeting = await hydrate(meeting);
    const md = meeting.default_summary?.markdown_formatted || "";
    const transcript = await getTranscript(meeting);
    const words = transcript.reduce((n, l) => n + String(l?.text || "").split(/\s+/).length, 0);
    // Fathom sometimes finishes the summary a little after the recording; the daily sweep retries Error pages.
    if (!md && words >= 60) throw new Error("Fathom summary not ready yet - will retry on the next sweep");

    const b = buildBriefing(meeting, transcript, cfg);
    await notion("PATCH", `/pages/${pageId}`, { properties: b.properties });
    await appendBlocks(pageId, b.blocks);

    // The transcript goes inside the toggle heading (the last top-level block).
    const kids = [];
    let cur;
    do {
      const d = await notion("GET", `/blocks/${pageId}/children?page_size=100${cur ? `&start_cursor=${cur}` : ""}`);
      kids.push(...d.results);
      cur = d.has_more ? d.next_cursor : null;
    } while (cur);
    await appendBlocks(kids[kids.length - 1].id, b.transcriptBlocks);

    let tasks = { created: [], total: 0 };
    if (wantsTasks(b.title, cfg)) tasks = await pushTasks(pageId, meeting, planTasks(meeting, b.title, b.client, b.items, cfg));

    // Ping the assignees now, so Discord does not depend on a Notion webhook being set up.
    let discord = { enabled: false, posted: 0, errors: [] };
    if (tasks.created.length && discordEnabled()) {
      const { notifyTasks } = await import("./notify.js");
      discord = await notifyTasks(tasks.created);
    }
    const warning = discord.errors.length ? `Call saved, but Discord failed for ${discord.errors.length} task(s): ${discord.errors[0]}` : "";
    await notion("PATCH", `/pages/${pageId}`, {
      properties: { "Tasks Created": { number: tasks.total }, Status: { select: { name: "Done" } }, Error: { rich_text: rt(warning.slice(0, 1900)) } },
    });
    return { pageId, title: b.title, client: b.client, tasks: tasks.total, newTasks: tasks.created.length, discordPosted: discord.posted, discordErrors: discord.errors };
  } catch (e) {
    await notion("PATCH", `/pages/${pageId}`, {
      properties: { Status: { select: { name: "Error" } }, Error: { rich_text: rt(String(e.stack || e).slice(0, 1900)) } },
    }).catch(() => {});
    throw e;
  }
}
