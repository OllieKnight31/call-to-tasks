import { discord } from './discord.js';

/**
 * Notion person → Discord member.
 *
 * Listing guild members needs the SERVER MEMBERS INTENT, which is a toggle in the
 * Developer Portal. Without it Discord answers 403 and we fall back to plain names -
 * the notification still works, it just can't ping the individual.
 */
const caches = new Map();   // guildId -> { members, at }
const TTL = 10 * 60 * 1000;

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

export async function loadMembers(guildId) {
  const hit = caches.get(guildId);
  if (hit && Date.now() - hit.at < TTL) return hit.members;
  let members = [];
  try {
    members = (await discord(`/guilds/${guildId}/members?limit=1000`))
      .filter((m) => !m.user.bot)
      .map((m) => ({
        id: m.user.id,
        names: [m.nick, m.user.global_name, m.user.username].filter(Boolean),
      }));
  } catch (e) {
    if (!/403/.test(String(e))) console.error('[people] member list failed:', String(e).slice(0, 160));
  }
  caches.set(guildId, { members, at: Date.now() });
  return members;
}

/** Exact match first, then first-name + last-initial, then a unique first name. */
function match(members, personName) {
  const want = norm(personName);
  if (!want) return null;
  const exact = members.find((m) => m.names.some((n) => norm(n) === want));
  if (exact) return exact.id;

  const parts = String(personName).trim().split(/\s+/);
  if (parts.length >= 2) {
    const initialed = norm(parts[0] + parts[parts.length - 1][0]);
    const hit = members.find((m) => m.names.some((n) => norm(n).startsWith(initialed)));
    if (hit) return hit.id;
  }
  const first = norm(parts[0]);
  if (first.length >= 3) {
    const hits = members.filter((m) => m.names.some((n) => norm(n).startsWith(first)));
    if (hits.length === 1) return hits[0].id;
  }
  return null;
}

/**
 * Render a person's name as a Discord mention where we can, plain text otherwise.
 * `pinned` maps a Notion name (or a free-text owner such as "Both") to one Discord id or a list,
 * and always wins over name matching. Names may be separated by commas or "&".
 */
export async function renderPeople({ guildId, pinned = {} }, value) {
  if (!value) return { text: null, ids: [] };
  const pin = new Map(Object.entries(pinned).map(([k, v]) => [norm(k), [].concat(v)]));
  const members = await loadMembers(guildId);
  const ids = [];
  const render = (name) => {
    const found = pin.get(norm(name)) ?? [match(members, name)].filter(Boolean);
    if (!found.length) return name;
    ids.push(...found);
    return found.map((id) => `<@${id}>`).join(' ');
  };
  const whole = String(value).trim();
  const names = pin.has(norm(whole)) ? [whole] : whole.split(/,|&/).map((s) => s.trim()).filter(Boolean);
  return { text: names.map(render).join(', '), ids: [...new Set(ids)] };
}
