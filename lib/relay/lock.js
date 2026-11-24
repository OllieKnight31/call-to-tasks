import crypto from 'node:crypto';
import { notion, getProp, ledgerRows, ledgerClaim, ledgerSetLock } from './notion.js';

/**
 * One page, one worker. A single edit in Notion routinely arrives as two webhook events
 * (page.created + page.properties_updated); without this both see "no ledger row" and the
 * card is posted twice. Notion has no compare-and-set, so the lock is claim → settle → re-read
 * on the page's ledger row. A lock older than STALE_MS belonged to a function that died.
 */
// A holder may legitimately sit in Notion's Retry-After for a couple of minutes now, so a
// lock only counts as abandoned after four: stealing it earlier posts the card twice.
const STALE_MS = 240_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const holderOf = (row) => {
  const [token, at] = String(getProp(row, 'Lock') ?? '').split('|');
  return token ? { token, at: Number(at) || 0 } : null;
};

// `since` is when the caller's event arrived. If, while we wait, the ledger shows the page was
// synced after that moment, another worker already re-read the page in its current state and
// posted it: our run would change nothing, so we coalesce into theirs and return `skipped`.
export async function withLock(ledgerDb, key, fn, { waitMs = 240_000, since = 0 } = {}) {
  const myToken = crypto.randomUUID();
  const stamp = () => `${myToken}|${Date.now()}`;
  const deadline = Date.now() + waitMs;
  let rowId = null;

  while (!rowId) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for the ledger lock on ${key}`);
    const [row] = await ledgerRows(ledgerDb, key);
    if (row && since) {
      const synced = Date.parse(getProp(row, 'Last Synced') || '');
      if (synced && synced > since) return { skipped: 'coalesced', syncedAt: new Date(synced).toISOString() };
    }

    if (!row) {
      // Nobody has seen this page. Claim it, let any concurrent claim land, keep only the oldest.
      const claim = await ledgerClaim(ledgerDb, key, stamp());
      let rows = [];
      for (let i = 0; i < 4 && !rows.some((r) => r.id === claim.id); i++) {
        await sleep(i === 0 ? 2000 : 1000);
        rows = await ledgerRows(ledgerDb, key);
      }
      if (!rows.length || rows[0].id === claim.id) rowId = claim.id;
      else await notion(`/pages/${claim.id}`, { method: 'PATCH', body: { archived: true } });
      continue;
    }

    const held = holderOf(row);
    if (held && Date.now() - held.at < STALE_MS) {
      await sleep(3000 + Math.random() * 2000);   // gentle: every poll is a Notion query
      continue;
    }
    await ledgerSetLock(row.id, stamp());
    await sleep(700);
    if (holderOf(await notion(`/pages/${row.id}`))?.token === myToken) rowId = row.id;
  }

  try {
    return await fn();
  } finally {
    await ledgerSetLock(rowId, null).catch(() => {});
  }
}
