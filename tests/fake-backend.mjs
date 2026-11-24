// An in-memory stand-in for Fathom, Notion and Discord. install() replaces global fetch, so nothing
// in a test or in the demo can reach the internet: any address it does not know throws.
import crypto from "node:crypto";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
const uuid = () => crypto.randomUUID();
const flat = (id) => String(id).replace(/-/g, "");

/** A written Notion property value -> the shape Notion sends back when the page is read. */
function stored(value, users) {
  const type = Object.keys(value)[0];
  const v = value[type];
  const rich = (arr) => (arr || []).map((t) => ({ ...t, plain_text: t.text?.content ?? "" }));
  if (type === "title" || type === "rich_text") return { type, [type]: rich(v) };
  if (type === "people") return { type, people: (v || []).map((p) => ({ id: p.id, name: users[p.id] })) };
  return { type, [type]: v };
}

export function createFakeBackend({ meetings = [], users = {}, discordMembers = null } = {}) {
  const state = {
    calls: [],            // every request, in order: { service, method, path, body }
    databases: new Map(), // id -> { id, title, properties, parent }
    pages: new Map(),     // id -> Notion page
    blocks: new Map(),    // parent id -> [block]
    discord: { messages: [], threads: [], edits: [] },
    fathomWebhooks: [],
    meetings,
    fail: {},             // e.g. { discord: 403 } makes every Discord call answer with that status
  };
  const now = () => new Date().toISOString();

  const addBlocks = (parentId, children) => {
    const list = state.blocks.get(parentId) || [];
    state.blocks.set(parentId, list);
    const made = [];
    for (const child of children) {
      const { children: nested, ...own } = child[child.type] || {};
      const block = { ...child, id: uuid(), [child.type]: own, has_children: Boolean(nested?.length) };
      block[block.type].rich_text = (block[block.type].rich_text || []).map((t) => ({ ...t, plain_text: t.text?.content ?? "" }));
      list.push(block);
      made.push(block);
      if (nested?.length) addBlocks(block.id, nested);
    }
    return made;
  };

  const matches = (page, filter) => {
    if (!filter) return true;
    if (filter.and) return filter.and.every((f) => matches(page, f));
    const prop = page.properties[filter.property];
    const textOf = (p) => (p?.title || p?.rich_text || []).map((t) => t.plain_text).join("");
    if (filter.number) return prop?.number === filter.number.equals;
    if (filter.rich_text?.starts_with !== undefined) return textOf(prop).startsWith(filter.rich_text.starts_with);
    if (filter.title?.equals !== undefined) return textOf(prop) === filter.title.equals;
    if (filter.select?.equals !== undefined) return prop?.select?.name === filter.select.equals;
    if (filter.select?.does_not_equal !== undefined) return prop?.select?.name !== filter.select.does_not_equal;
    throw new Error(`fake Notion: filter not supported ${JSON.stringify(filter)}`);
  };

  function notion(method, path, body) {
    let m;
    if (method === "POST" && path === "/databases") {
      const db = { object: "database", id: uuid(), url: `https://notion.test/${uuid()}`, title: body.title, parent: body.parent, properties: {} };
      for (const [name, def] of Object.entries(body.properties)) db.properties[name] = { id: name, name, type: Object.keys(def)[0], ...def };
      state.databases.set(flat(db.id), db);
      return json(db);
    }
    if ((m = path.match(/^\/databases\/([^/?]+)$/))) {
      const db = state.databases.get(flat(m[1]));
      if (!db) return json({ object: "error", code: "object_not_found" }, 404);
      if (method === "PATCH") {
        for (const [name, def] of Object.entries(body.properties || {})) {
          if (def === null) { delete db.properties[name]; continue; }
          if (def.name && db.properties[name]) { db.properties[def.name] = { ...db.properties[name], name: def.name }; delete db.properties[name]; continue; }
          db.properties[name] = { id: name, name, type: Object.keys(def)[0], ...def };
          if (def.relation?.type === "dual_property") {
            const other = state.databases.get(flat(def.relation.database_id));
            const mirror = `Related to ${db.title?.[0]?.text?.content || "database"} (${name})`;
            other.properties[mirror] = { id: mirror, name: mirror, type: "relation", relation: { database_id: db.id, type: "dual_property" } };
          }
        }
      }
      return json(db);
    }
    if (method === "POST" && (m = path.match(/^\/databases\/([^/]+)\/query$/))) {
      const results = [...state.pages.values()]
        .filter((p) => !p.archived && flat(p.parent.database_id) === flat(m[1]) && matches(p, body?.filter))
        .slice(0, body?.page_size ?? 100);
      return json({ results, has_more: false, next_cursor: null });
    }
    if (method === "POST" && path === "/pages") {
      if (!state.databases.has(flat(body.parent.database_id)) && state.strictDatabases) return json({ object: "error", code: "object_not_found" }, 404);
      const t = now();
      const page = {
        object: "page", id: uuid(), parent: { type: "database_id", database_id: body.parent.database_id },
        created_time: t, last_edited_time: t, archived: false, in_trash: false, icon: body.icon ?? null,
        url: `https://notion.test/page/${uuid()}`, properties: {},
      };
      for (const [k, v] of Object.entries(body.properties || {})) page.properties[k] = stored(v, users);
      state.pages.set(page.id, page);
      if (body.children) addBlocks(page.id, body.children);
      return json(page);
    }
    if ((m = path.match(/^\/pages\/([^/?]+)$/))) {
      const page = state.pages.get(m[1]);
      if (!page) return json({ object: "error", code: "object_not_found" }, 404);
      if (method === "PATCH") {
        for (const [k, v] of Object.entries(body.properties || {})) page.properties[k] = stored(v, users);
        if (body.archived !== undefined) { page.archived = body.archived; page.in_trash = body.archived; }
        page.last_edited_time = now();
      }
      return json(page);
    }
    if ((m = path.match(/^\/blocks\/([^/]+)\/children/))) {
      if (method === "PATCH") return json({ results: addBlocks(m[1], body.children) });
      return json({ results: state.blocks.get(m[1]) || [], has_more: false, next_cursor: null });
    }
    if (method === "DELETE" && (m = path.match(/^\/blocks\/([^/]+)$/))) {
      for (const [parent, list] of state.blocks) state.blocks.set(parent, list.filter((b) => b.id !== m[1]));
      return json({});
    }
    if (method === "GET" && path.startsWith("/users")) {
      const id = path.split("/")[2]?.split("?")[0];
      if (id) return users[id] ? json({ id, name: users[id], type: "person" }) : json({ object: "error" }, 404);
      return json({ results: Object.entries(users).map(([uid, name]) => ({ id: uid, name, type: "person", person: {} })), has_more: false });
    }
    throw new Error(`fake Notion: no handler for ${method} ${path}`);
  }

  function fathom(method, path, body) {
    if (method === "GET" && path.startsWith("/meetings")) return json({ items: state.meetings, next_cursor: null });
    let m;
    if (method === "GET" && (m = path.match(/^\/recordings\/(\d+)\/transcript/))) {
      const hit = state.meetings.find((x) => String(x.recording_id) === m[1]);
      return json({ transcript: hit?.transcript || [] });
    }
    if (method === "POST" && path === "/webhooks") {
      state.fathomWebhooks.push(body);
      return json({ id: "wh_test", secret: "whsec_" + Buffer.from("fake-signing-secret").toString("base64"), url: body.destination_url }, 201);
    }
    throw new Error(`fake Fathom: no handler for ${method} ${path}`);
  }

  function discord(method, path, body) {
    if (state.fail.discord) return json({ message: "Missing Access" }, state.fail.discord);
    let m;
    if (method === "GET" && (m = path.match(/^\/guilds\/(\d+)\/members/))) return discordMembers ? json(discordMembers) : json({ message: "Missing Access" }, 403);
    if (method === "GET" && (m = path.match(/^\/channels\/(\d+)$/))) return json({ id: m[1], guild_id: state.guildId ?? "0", name: "task-board" });
    if (method === "POST" && (m = path.match(/^\/channels\/(\d+)\/messages$/))) {
      const msg = { id: String(7000000000000000 + state.discord.messages.length), channel_id: m[1], ...body };
      state.discord.messages.push(msg);
      return json(msg);
    }
    if (method === "POST" && (m = path.match(/^\/channels\/(\d+)\/messages\/(\d+)\/threads$/))) {
      const thread = { id: String(8000000000000000 + state.discord.threads.length), parent_message: m[2], ...body };
      state.discord.threads.push(thread);
      return json(thread);
    }
    if (method === "PATCH" && (m = path.match(/^\/channels\/(\d+)\/messages\/(\d+)$/))) {
      state.discord.edits.push({ channel_id: m[1], id: m[2], ...body });
      return json({ id: m[2] });
    }
    if (method === "PATCH" && (m = path.match(/^\/channels\/(\d+)$/))) {
      const thread = state.discord.threads.find((t) => t.id === m[1]);
      if (thread) Object.assign(thread, body);
      return json({ id: m[1] });
    }
    if (method === "DELETE") return json({});
    throw new Error(`fake Discord: no handler for ${method} ${path}`);
  }

  const realFetch = globalThis.fetch;
  async function fakeFetch(input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    const service = url.host === "api.notion.com" ? "notion" : url.host === "api.fathom.ai" ? "fathom" : url.host === "discord.com" ? "discord" : null;
    if (!service) throw new Error(`OFFLINE GUARD: blocked a network call to ${url.host}${url.pathname}`);
    const path = (url.pathname + url.search).replace(/^\/v1|^\/external\/v1|^\/api\/v10/, "");
    state.calls.push({ service, method, path, body });
    if (service === "notion") return notion(method, path, body);
    if (service === "fathom") return fathom(method, path, body);
    return discord(method, path, body);
  }

  return {
    state,
    install() { globalThis.fetch = fakeFetch; return this; },
    restore() { globalThis.fetch = realFetch; },
    /** Registers an empty database under a fixed id, for tests that do not run the setup script. */
    addDatabase(id, title = "db") { state.databases.set(flat(id), { id, title: [{ text: { content: title } }], properties: {} }); },
    pagesIn(dbId) { return [...state.pages.values()].filter((p) => !p.archived && flat(p.parent.database_id) === flat(dbId)); },
    text(page, prop) { const p = page.properties[prop]; return (p?.title || p?.rich_text || []).map((t) => t.plain_text).join(""); },
    blocksOf(id) { return state.blocks.get(id) || []; },
  };
}
