import { handlePage } from './relay.js';
import { queryAll, getProp } from './notion.js';

/**
 * Walk the watched boards. Live mode only touches rows edited since the ledger last saw
 * them, which keeps the cron backstop inside a serverless time limit. Baseline touches all.
 *   only: board keys to include, e.g. ['content', 'sales']
 */
export async function syncBoards(config, { mode = 'live', only = null, log = () => {} } = {}) {
  const lastSynced = new Map();
  if (mode === 'live') {
    for (const row of await queryAll(config.notion.ledger_db)) {
      lastSynced.set(getProp(row, 'Key'), getProp(row, 'Last Synced'));
    }
  }

  const results = [];
  for (const [key, board] of Object.entries(config.boards)) {
    if (only && !only.includes(key)) continue;
    let rows;
    try { rows = await queryAll(board.database_id); }
    catch (e) {   // one board's listing failing must not abort the others
      results.push({ board: key, error: String(e).slice(0, 300) });
      log(key, 0, { error: 1 });
      continue;
    }
    const tally = {};
    const count = (k) => { tally[k] = (tally[k] ?? 0) + 1; };

    for (const row of rows) {
      const synced = lastSynced.get(row.id);
      // Notion's last_edited_time is minute-granular, hence the two-minute overlap.
      if (mode === 'live' && synced && Date.parse(row.last_edited_time) < Date.parse(synced) - 120_000) {
        count('unchanged');
        continue;
      }
      try {
        const r = await handlePage(config, row.id, { mode });
        results.push({ board: key, ...r });
        count(r.action ?? r.skipped);
      } catch (e) {
        results.push({ board: key, page: row.id, error: String(e).slice(0, 300) });
        count('error');
      }
    }
    log(key, rows.length, tally);
  }
  return results;
}
