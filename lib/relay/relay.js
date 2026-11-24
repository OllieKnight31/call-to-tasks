import crypto from 'node:crypto';
import { notion, getProp, userName, ledgerGet, ledgerPut, dashify, pageBlocks } from './notion.js';
import {
  postMessage, editMessage, deleteMessage, startThread, renameThread, archiveThread, unarchiveThread,
} from './discord.js';
import { renderPeople } from './people.js';
import { withLock } from './lock.js';
import { money, dateWithRelative, overdueDays, waLink, isUrl, blocksToText, clip } from './format.js';

const NOTION_ICON = 'https://www.notion.so/front-static/favicon.ico';
const BODY = '@body';                 // watch_fields token: the text written inside the page
const DELETED = 'Deleted in Notion';  // ledger stage for a trashed row
const shortDate = (v) =>
  v ? new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : null;

/* ------------------------------ board lookup ------------------------------ */

/** Accepts a page, or a bare parent id from a webhook payload (database or data source). */
export function boardFor(config, pageOrParentId) {
  const raw = typeof pageOrParentId === 'string'
    ? pageOrParentId
    : pageOrParentId?.parent?.database_id || pageOrParentId?.parent?.data_source_id || '';
  if (!raw) return null;
  const id = dashify(raw);
  for (const [key, board] of Object.entries(config.boards)) {
    if ([board.database_id, board.data_source_id].some((x) => x && dashify(x) === id)) return { key, board };
  }
  return null;
}

const guildOf = (config, board) => config.guilds[board.guild];
const roleMention = (config, board, name) => {
  const id = guildOf(config, board).roles?.[name];
  return id ? `<@&${id}>` : name;
};

/**
 * Who owns the task: the Assignee people field, else the free-text Owner the call pipeline fills in.
 * When the Assignee is a Notion profile name that maps to nobody in Discord, the Owner is tried too,
 * so a person is still pinged as long as one of the two resolves.
 */
const assigneeOf = (board, page) =>
  (board.assignee_prop && getProp(page, board.assignee_prop)) || (board.owner_prop && getProp(page, board.owner_prop)) || null;
const people = (config, board, value) =>
  renderPeople({ guildId: guildOf(config, board).guild_id, pinned: { ...config.people, ...board.people } }, value);
async function peopleFor(config, board, page) {
  const first = await people(config, board, assigneeOf(board, page));
  if (first.ids.length || !board.owner_prop) return first;
  const owner = await people(config, board, getProp(page, board.owner_prop));
  return owner.ids.length ? owner : first;
}
// Self-tests set this so real people aren't pinged: the mention text still renders, nobody is notified.
const MUTE = () => Boolean(process.env.RELAY_MUTE_PINGS);

const ruleFor = (board, stage) =>
  board.stages[stage] ?? { emoji: '•', headline: String(stage ?? 'Updated').toUpperCase(), color: 0x95a5a6, ping: [] };

function stageRoles(board, page, stage) {
  const rule = board.stages[stage] ?? board.created;
  const names = [...(rule?.ping ?? [])];
  if (board.escalate) {
    const v = getProp(page, board.escalate.prop);
    names.push(...(board.escalate.values?.[v] ?? []));
  }
  return [...new Set(names)];
}

/** Which department feed this row belongs to, from its Area. Null when unrouted. */
function deptFor(board, page) {
  const d = board.departments;
  if (!d) return null;
  const area = getProp(page, d.prop);
  const feed = d.feeds[d.routes[area]];
  return feed ? { area, ...feed } : null;
}

const needsBody = (board) =>
  String(board.brief?.source ?? '').split('+').includes('body') || (board.watch_fields ?? []).includes(BODY);

/* --------------------------------- content -------------------------------- */

/** The text written inside the Notion page: the part the first build threw away. */
function buildBrief(board, page, body) {
  const cfg = board.brief;
  if (!cfg) return null;
  const chunks = [];
  for (const src of String(cfg.source).split('+')) {
    const v = src === 'body' ? body : getProp(page, src);
    if (v) chunks.push(String(v));
  }
  return clip(chunks.join('\n\n'), cfg.limit ?? 600);
}

function computedValues(board, page) {
  const out = {};
  for (const c of board.computed ?? []) {
    if (c.minus) {
      const [a, b] = c.minus.map((p) => getProp(page, p));
      if (a == null) continue;
      const v = Number(a) - Number(b ?? 0);
      out[c.label] = c.money ? money(v) : String(v);
    }
  }
  return out;
}

async function buildFields(ctx, roles) {
  const { config, board, page, stage, dept } = ctx;
  const computed = computedValues(board, page);
  const fields = [];
  for (const f of board.fields ?? []) {
    if (f.stages && !f.stages.includes(stage)) continue;
    let value = null;

    if (f.prop === '@assignee') {
      value = (await peopleFor(config, board, page)).text;
    } else if (f.prop === '@needs') {
      const names = [...new Set([...roles, ...(dept ? [dept.role] : [])])];
      value = names.map((n) => roleMention(config, board, n)).join(' ') || null;
    } else if (f.prop.startsWith('@computed:')) {
      value = computed[f.prop.slice('@computed:'.length)] ?? null;
    } else {
      const raw = getProp(page, f.prop);
      if (raw == null || raw === '') continue;
      value = f.money ? money(raw)
        : f.relative ? dateWithRelative(raw)
        : isUrl(raw) ? `[open](${raw})`
        : String(raw);
    }
    if (value == null || value === '') continue;
    fields.push({ name: f.label, value: String(value).slice(0, 1024), inline: true });
  }
  return fields;
}

/** What this stage needs and hasn't got. Silence here is a promise that nothing is missing. */
function buildBlockers(ctx, brief) {
  const { board, page, stage, title, dept } = ctx;
  const out = [];
  if (!title) out.push('No title: give it a name in Notion.');
  for (const rule of board.blockers?.[stage] ?? []) {
    const empty = rule.empty === '@body' ? !brief : !getProp(page, rule.empty);
    if (empty) out.push(rule.message);
  }
  if (board.stages[stage]?.close) return out;
  if (board.departments && !dept) out.push(board.departments.unrouted?.message ?? 'No department set.');
  if (board.due_prop) {
    const due = getProp(page, board.due_prop);
    const late = overdueDays(due);
    if (late) out.push(`Due ${shortDate(due)}: ${late} day${late > 1 ? 's' : ''} overdue.`);
  }
  return out;
}

function buildButtons(board, page) {
  const row = [];
  for (const b of board.buttons ?? []) {
    let url = null;
    if (b.page) {
      url = page.url;
    } else {
      const v = getProp(page, b.prop);
      if (!v) continue;
      if (b.scheme === 'wa') url = waLink(v);
      else if (b.scheme === 'gmail') url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(v)}`;
      else if (isUrl(v)) url = v;
    }
    if (!url) continue;
    row.push({ type: 2, style: 5, label: b.label, url });
    if (row.length === 5) break;
  }
  return row.length ? [{ type: 1, components: row }] : [];
}

/** Department cards carry a jump link to the thread on the main board, where the history lives. */
function deptButtons(ctx, threadId) {
  const rows = buildButtons(ctx.board, ctx.page);
  if (!threadId) return rows;
  const link = { type: 2, style: 5, label: 'Discussion', url: `https://discord.com/channels/${guildOf(ctx.config, ctx.board).guild_id}/${threadId}` };
  if (!rows.length) return [{ type: 1, components: [link] }];
  if (rows[0].components.length < 5) rows[0].components.push(link);
  return rows;
}

async function provenance(page, actorId) {
  const named = (v) => (v && !/^[0-9a-f-]{32,36}$/i.test(v) ? v : null);   // an id, not a name, means the key can't read users
  const createdBy = named(getProp(page, 'Created by'));
  const createdAt = shortDate(getProp(page, 'Created time') ?? page.created_time);
  const changedBy = named(actorId ? await userName(actorId) : getProp(page, 'Last edited by'));
  const bits = [];
  if (createdBy) bits.push(`Created by ${createdBy}${createdAt ? ` · ${createdAt}` : ''}`);
  if (changedBy) bits.push(`Last change by ${changedBy}`);
  return bits.join('   ·   ') || null;
}

/* --------------------------------- embeds --------------------------------- */

/**
 * One builder for every surface: the card that lives in the channel and always shows
 * current state, the note posted into the thread when something moves, and the department copy.
 */
async function buildEmbed(ctx, { rule, roles = [], from = null }) {
  const { board, page, stage, title, body, actorId } = ctx;
  const brief = buildBrief(board, page, body);
  const fields = await buildFields(ctx, roles);
  const blockers = buildBlockers(ctx, brief);

  const lines = [];
  lines.push(from ? `\`${from}\` → \`${stage}\`` : `Stage: \`${stage ?? '-'}\``);
  if (brief) {
    lines.push('', `**${board.brief?.label ?? 'Details'}**`, brief.split('\n').map((l) => `> ${l}`).join('\n'));
  }

  if (blockers.length) {
    fields.push({
      name: '⚠️ Needs attention',
      value: blockers.map((b) => `• ${b}`).join('\n').slice(0, 1024),
      inline: false,
    });
  }

  return {
    author: { name: `${rule.emoji} ${rule.headline} · ${board.label}`, icon_url: NOTION_ICON },
    title: (title || 'Untitled').slice(0, 250),
    url: page.url,
    color: rule.color,
    description: lines.join('\n').slice(0, 4000),
    fields: fields.slice(0, 25),
    footer: { text: (await provenance(page, actorId)) ?? board.label },
    timestamp: new Date().toISOString(),
  };
}

const showValue = (v) =>
  v == null || v === '' ? '-' : String(v).replace(/\s*\n\s*/g, ' ').replace(/`/g, "'").slice(0, 300);

/** A compact note for edits that aren't stage moves. */
function editEmbed(board, changes, actor) {
  return {
    author: { name: `✏️ Updated · ${board.label}`, icon_url: NOTION_ICON },
    color: 0x5865f2,
    description: changes
      .map(({ field, before, after }) =>
        `**${field === BODY ? 'Page content' : field}**\n\`${showValue(before)}\` → \`${showValue(after)}\``)
      .join('\n\n')
      .slice(0, 4000),
    footer: { text: actor ? `Changed by ${actor}` : board.label },
    timestamp: new Date().toISOString(),
  };
}

/* -------------------------------- snapshots ------------------------------- */

/** Long values are stored as a preview plus a hash, so a change anywhere still registers. */
function snapValue(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  if (s.length <= 160) return s;
  const hash = crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
  return `${s.slice(0, 120).replace(/\s+\S*$/, '')}… #${hash}`;
}

const snapshotOf = (board, page, body) =>
  JSON.stringify(Object.fromEntries(
    (board.watch_fields ?? []).map((p) => [p, snapValue(p === BODY ? body : getProp(page, p))]),
  ));

function diffSnapshot(before, after) {
  let a = {}; let b = {};
  try { a = JSON.parse(before || '{}'); } catch { /* first run */ }
  try { b = JSON.parse(after || '{}'); } catch { /* nothing to compare */ }
  const known = Object.keys(a).length > 0;
  const changes = [];
  for (const key of Object.keys(b)) {
    if (known && !(key in a)) continue; // field newly added to watch_fields: not an edit
    if (String(a[key] ?? '') !== String(b[key] ?? '')) {
      changes.push({ field: key, before: a[key], after: b[key] });
    }
  }
  return changes;
}

/* --------------------------------- posting -------------------------------- */

async function pingLine(ctx, roles) {
  const { config, board, page } = ctx;
  const { ids } = await peopleFor(config, board, page);
  return [...roles.map((n) => roleMention(config, board, n)), ...ids.map((i) => `<@${i}>`)].join(' ');
}

/** The card on the main board, plus the thread that holds the item's whole history. */
async function postCard(ctx, { rule, roles, from = null, ping }) {
  const { board, page, title } = ctx;
  const content = ping ? await pingLine(ctx, roles) : '';
  const msg = await postMessage(board.channel_id, {
    content: content || undefined,
    embeds: [await buildEmbed(ctx, { rule, roles, from })],
    components: buildButtons(board, page),
    allowed_mentions: { parse: content && !MUTE() ? ['roles', 'users'] : [] },
  });
  const thread = await startThread(board.channel_id, msg.id, `${rule.emoji} ${title || 'Untitled'}`);
  return { messageId: msg.id, threadId: thread.id };
}

/** Department copy: one card per live task, reposted to the bottom when it moves. */
async function postDeptCard(ctx, { rule, roles, from = null, threadId, ping }) {
  const roleId = guildOf(ctx.config, ctx.board).roles?.[ctx.dept.role];
  const pinging = Boolean(ping && roleId);
  return postMessage(ctx.dept.channel_id, {
    content: pinging ? `<@&${roleId}>` : undefined,
    embeds: [await buildEmbed(ctx, { rule, roles, from })],
    components: deptButtons(ctx, threadId),
    allowed_mentions: { parse: [], roles: pinging ? [roleId] : [] },
  });
}

async function postEdit(ctx, threadId, changes, actor) {
  const { config, board } = ctx;
  let added = [];
  const who = board.assignee_prop && changes.find((c) => c.field === board.assignee_prop);
  if (who) {
    const [before, after] = await Promise.all([people(config, board, who.before), people(config, board, who.after)]);
    added = after.ids.filter((id) => !before.ids.includes(id));
  }
  await postMessage(threadId, {
    content: added.length ? `${added.map((i) => `<@${i}>`).join(' ')}: you've been assigned this.` : undefined,
    embeds: [editEmbed(board, changes, actor)],
    allowed_mentions: { parse: [], users: added },
  });
}

/* ------------------------------- entry point ------------------------------ */

/**
 * Process one Notion page.
 *   mode 'live'    : post to Discord and record in the ledger (under the page lock)
 *   mode 'baseline': record in the ledger only, post nothing
 */
export async function handlePage(config, pageId, { mode = 'live', actorId = null, lock = true, since = 0 } = {}) {
  const page = await notion(`/pages/${dashify(pageId)}`);
  if (!boardFor(config, page)) return { skipped: 'not a watched database' };
  if (page.archived || page.in_trash) {
    const ledger = await ledgerGet(config.notion.ledger_db, page.id);
    if (!ledger?.messageId || ledger.lastStage === DELETED) return { skipped: 'archived' };
  }
  if (mode !== 'live' || !lock) return processPage(config, page, { mode, actorId });
  // Re-read inside the lock: whoever held it may have been working from older state.
  return withLock(config.notion.ledger_db, page.id, async () =>
    processPage(config, await notion(`/pages/${page.id}`), { mode, actorId }), { since });
}

async function processPage(config, page, { mode, actorId }) {
  const db = config.notion.ledger_db;
  const { key: boardKey, board } = boardFor(config, page);
  const ledger = await ledgerGet(db, page.id);

  if (page.archived || page.in_trash) return removed(config, board, boardKey, page, ledger, { mode, actorId });

  const title = getProp(page, board.title_prop);
  const stage = getProp(page, board.stage_prop);
  const body = needsBody(board) ? blocksToText(await pageBlocks(page.id)) : null;
  const snapshot = snapshotOf(board, page, body);
  const ctx = { config, board, page, title, stage, body, dept: deptFor(board, page), actorId };
  const summary = { board: boardKey, title: title || 'Untitled', stage };
  const record = (extra = {}) => ledgerPut(db, {
    ...ledger, key: page.id, item: title || 'Untitled', board: board.label, lastStage: stage, snapshot, ...extra,
  });

  if (mode === 'baseline') {
    await record();
    return { action: 'baselined', ...summary };
  }

  // A lock claim row has neither snapshot nor card: it counts as never seen.
  const fresh = !ledger || (!ledger.snapshot && !ledger.messageId);
  const moved = !fresh && ledger.lastStage !== stage;
  const changes = fresh ? [] : diffSnapshot(ledger.snapshot, snapshot);
  const roles = stageRoles(board, page, stage);
  const closed = Boolean(board.stages[stage]?.close);
  const from = moved ? ledger.lastStage : null;

  /* ---- no card yet: a new row, or one recorded silently that has now done something ---- */
  if (!ledger?.messageId) {
    if (!fresh && !moved && !changes.length) {
      await record();
      return { action: 'no-change', ...summary };
    }
    const rule = fresh ? { ...board.created, color: board.stages[stage]?.color ?? board.created.color } : ruleFor(board, stage);
    const unrouted = board.departments && !ctx.dept ? board.departments.unrouted?.ping ?? [] : [];
    const pingRoles = fresh ? [...new Set([...(board.created.ping ?? []), ...roles, ...unrouted])] : roles;
    const ping = (fresh || moved) && !closed;

    const card = await postCard(ctx, { rule, roles: pingRoles, from, ping });
    if (changes.length && !moved) await postEdit(ctx, card.threadId, changes, getProp(page, 'Last edited by'));
    const deptMsg = ctx.dept ? await postDeptCard(ctx, { rule, roles, from, threadId: card.threadId, ping }) : null;
    if (closed) await archiveThread(card.threadId).catch(() => {});

    await record({
      messageId: card.messageId, threadId: card.threadId,
      deptChannel: ctx.dept?.channel_id ?? null, deptMessageId: deptMsg?.id ?? null,
    });
    return { action: fresh ? 'created' : moved ? 'moved' : 'edited', ...summary, dept: ctx.dept?.area ?? null };
  }

  /* ---------------- known row with a card ---------------- */
  const rule = ruleFor(board, stage);
  const actor = actorId ? await userName(actorId) : getProp(page, 'Last edited by');

  // The card in the channel always reflects current state, moved or not.
  await editMessage(board.channel_id, ledger.messageId, {
    embeds: [await buildEmbed(ctx, { rule, roles })],
    components: buildButtons(board, page),
  }).catch(() => {});

  if (ledger.threadId && (moved || changes.length)) {
    await unarchiveThread(ledger.threadId).catch(() => {});
    if (changes.some((c) => c.field === board.title_prop)) {
      await renameThread(ledger.threadId, `${rule.emoji} ${title || 'Untitled'}`).catch(() => {});
    }
    if (moved) {
      const content = closed ? '' : await pingLine(ctx, roles);
      await postMessage(ledger.threadId, {
        content: content || undefined,
        embeds: [await buildEmbed(ctx, { rule, roles, from })],
        components: buildButtons(board, page),
        allowed_mentions: { parse: content && !MUTE() ? ['roles', 'users'] : [] },
      });
    }
    if (changes.length) await postEdit(ctx, ledger.threadId, changes, actor);
    if (closed) await archiveThread(ledger.threadId).catch(() => {});
  }

  // Department feed: repost on a move or an Area change, edit in place on a detail change.
  let { deptChannel = null, deptMessageId = null } = ledger;
  const deptNow = ctx.dept?.channel_id ?? null;
  const repost = Boolean(deptNow) && (moved || deptNow !== deptChannel || !deptMessageId);
  if (deptMessageId && (repost || !deptNow)) {
    await deleteMessage(deptChannel, deptMessageId).catch(() => {});
    deptChannel = null;
    deptMessageId = null;
  }
  if (repost) {
    const msg = await postDeptCard(ctx, {
      rule, roles, from, threadId: ledger.threadId, ping: !closed && (moved || deptNow !== ledger.deptChannel),
    });
    deptChannel = deptNow;
    deptMessageId = msg.id;
  } else if (deptMessageId && changes.length) {
    await editMessage(deptChannel, deptMessageId, {
      embeds: [await buildEmbed(ctx, { rule, roles })],
      components: deptButtons(ctx, ledger.threadId),
    }).catch(() => {});
  }

  await record({ deptChannel, deptMessageId });

  if (moved) return { action: 'moved', ...summary, from, to: stage };
  if (changes.length) return { action: 'edited', ...summary, fields: changes.map((c) => c.field) };
  return { action: 'no-change', ...summary };
}

/** Trashed in Notion: say so in the thread, grey out the card, drop the department copy. */
async function removed(config, board, boardKey, page, ledger, { mode, actorId }) {
  const title = getProp(page, board.title_prop) || ledger?.item || 'Untitled';
  if (!ledger?.messageId || ledger.lastStage === DELETED) return { skipped: 'archived', board: boardKey, title };

  if (mode === 'live') {
    const who = actorId ? await userName(actorId) : getProp(page, 'Last edited by');
    const note = {
      author: { name: `🗑️ DELETED · ${board.label}`, icon_url: NOTION_ICON },
      title: title.slice(0, 250),
      color: 0x747f8d,
      description: 'Deleted in Notion. Restore it from Notion\'s trash and this thread picks back up.',
      footer: { text: who ? `Deleted by ${who}` : board.label },
      timestamp: new Date().toISOString(),
    };
    await editMessage(board.channel_id, ledger.messageId, { embeds: [note], components: [] }).catch(() => {});
    if (ledger.threadId) {
      await unarchiveThread(ledger.threadId).catch(() => {});
      await postMessage(ledger.threadId, { embeds: [note] }).catch(() => {});
      await archiveThread(ledger.threadId).catch(() => {});
    }
    if (ledger.deptMessageId) await deleteMessage(ledger.deptChannel, ledger.deptMessageId).catch(() => {});
  }

  await ledgerPut(config.notion.ledger_db, { ...ledger, lastStage: DELETED, deptChannel: null, deptMessageId: null });
  return { action: 'deleted', board: boardKey, title };
}
