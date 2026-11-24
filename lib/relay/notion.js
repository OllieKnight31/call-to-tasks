const NOTION = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';

// Notion means its Retry-After: a burst of edits earns `retry_after: 20+`, and a short fixed
// backoff just earns another 429 until the webhook subscription is paused. Wait what Notion asks
// (plus jitter so parallel invocations desynchronise), up to 150s in total: the webhook path has
// already answered before this work starts and the function has a 300s budget.
const RETRY_BUDGET_MS = 150_000;
export async function notion(path, { method = 'GET', body, token = process.env.NOTION_API_KEY } = {}) {
  if (!token) throw new Error('Missing environment variable NOTION_API_KEY. See .env.example.');
  let waited = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await fetch(NOTION + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': VERSION,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
      const asked = parseFloat(res.headers.get('retry-after') || '') || Math.min(2 ** attempt, 8);
      const wait = Math.min(asked, 60) * 1000 + Math.random() * 1500;
      if (waited + wait > RETRY_BUDGET_MS) break;
      await new Promise((r) => setTimeout(r, wait));
      waited += wait;
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Notion ${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : {};
  }
  throw new Error(`Notion ${method} ${path} -> rate limited out after ${Math.round(waited / 1000)}s`);
}

export const dashify = (id) =>
  /-/.test(id) ? id : id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

/** Read one Notion property down to a plain JS value. Returns null when empty. */
export function readProp(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case 'title':      return prop.title.map((t) => t.plain_text).join('').trim() || null;
    case 'rich_text':  return prop.rich_text.map((t) => t.plain_text).join('').trim() || null;
    case 'status':     return prop.status?.name ?? null;
    case 'select':     return prop.select?.name ?? null;
    case 'multi_select': return prop.multi_select.length ? prop.multi_select.map((o) => o.name).join(', ') : null;
    case 'people':     return prop.people.length ? prop.people.map((p) => p.name || p.id).join(', ') : null;
    case 'date':       return prop.date?.start ?? null;
    case 'url':        return prop.url || null;
    case 'email':      return prop.email || null;
    case 'phone_number': return prop.phone_number || null;
    case 'number':     return prop.number ?? null;
    case 'checkbox':   return prop.checkbox ? 'Yes' : 'No';
    case 'formula':    return prop.formula?.string ?? prop.formula?.number ?? null;
    case 'created_by': return prop.created_by?.name || prop.created_by?.id || null;
    case 'last_edited_by': return prop.last_edited_by?.name || prop.last_edited_by?.id || null;
    case 'created_time': return prop.created_time;
    case 'last_edited_time': return prop.last_edited_time;
    default:           return null;
  }
}

export const getProp = (page, name) => readProp(page.properties?.[name]);

const userCache = new Map();
export async function userName(id) {
  if (!id) return null;
  if (userCache.has(id)) return userCache.get(id);
  try {
    const u = await notion(`/users/${id}`);
    const name = u.name || u.bot?.owner?.user?.name || null;
    userCache.set(id, name);
    return name;
  } catch {
    userCache.set(id, null);
    return null;
  }
}

/* ------------------------------- ledger ---------------------------------- */

/** Rich text in 1900-char chunks: a single text object caps at 2000, and a clipped JSON snapshot would not parse. */
const rt = (v) => {
  if (v == null || v === '') return [];
  const s = String(v);
  const out = [];
  for (let i = 0; i < s.length && out.length < 100; i += 1900) {
    out.push({ type: 'text', text: { content: s.slice(i, i + 1900) } });
  }
  return out;
};

/** Every ledger row for a key, oldest first. created_time is minute-granular, so ties break on id. */
export async function ledgerRows(ledgerDb, key) {
  const res = await notion(`/databases/${ledgerDb}/query`, {
    method: 'POST',
    body: { filter: { property: 'Key', title: { equals: key } }, page_size: 10 },
  });
  return res.results.sort((a, b) =>
    a.created_time.localeCompare(b.created_time) || a.id.localeCompare(b.id));
}

export const ledgerClaim = (ledgerDb, key, lock) =>
  notion('/pages', {
    method: 'POST',
    body: { parent: { database_id: ledgerDb }, properties: { Key: { title: rt(key) }, Lock: { rich_text: rt(lock) } } },
  });

export const ledgerSetLock = (rowId, lock) =>
  notion(`/pages/${rowId}`, { method: 'PATCH', body: { properties: { Lock: { rich_text: rt(lock) } } } });

export async function ledgerGet(ledgerDb, key) {
  const [row] = await ledgerRows(ledgerDb, key);
  if (!row) return null;
  return {
    rowId: row.id,
    key,
    item: getProp(row, 'Item'),
    board: getProp(row, 'Board'),
    threadId: getProp(row, 'Thread ID'),
    messageId: getProp(row, 'Message ID'),
    lastStage: getProp(row, 'Last Stage'),
    snapshot: getProp(row, 'Snapshot'),
    deptChannel: getProp(row, 'Dept Channel'),
    deptMessageId: getProp(row, 'Dept Message ID'),
  };
}

/** Never writes Lock: only the lock holder's release does, or a waiter could be clobbered. */
export async function ledgerPut(ledgerDb, entry) {
  const properties = {
    Key: { title: rt(entry.key) },
    Item: { rich_text: rt(entry.item) },
    Board: { select: entry.board ? { name: entry.board } : null },
    'Thread ID': { rich_text: rt(entry.threadId) },
    'Message ID': { rich_text: rt(entry.messageId) },
    'Last Stage': { rich_text: rt(entry.lastStage) },
    Snapshot: { rich_text: rt(entry.snapshot) },
    'Dept Channel': { rich_text: rt(entry.deptChannel) },
    'Dept Message ID': { rich_text: rt(entry.deptMessageId) },
    'Last Synced': { date: { start: new Date().toISOString() } },
  };
  if (entry.rowId) return notion(`/pages/${entry.rowId}`, { method: 'PATCH', body: { properties } });
  return notion('/pages', { method: 'POST', body: { parent: { database_id: ledgerDb }, properties } });
}

export async function queryAll(databaseId, body = {}) {
  const out = [];
  let cursor;
  do {
    const res = await notion(`/databases/${databaseId}/query`, {
      method: 'POST',
      body: { page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}) },
    });
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

/** All blocks on a page, one level deep: enough for a brief. */
export async function pageBlocks(pageId) {
  const out = [];
  let cursor;
  do {
    const q = `/blocks/${dashify(pageId)}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
    const res = await notion(q);
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor && out.length < 200);
  return out;
}
