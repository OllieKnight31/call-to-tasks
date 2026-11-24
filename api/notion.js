// Optional: live status updates. Point a Notion webhook subscription at this endpoint and a task
// that is created or moved in Notion reaches Discord within about a minute. Without it the daily
// sweep does the same job once a day, and tasks made from calls are still posted immediately.
import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { relayConfig } from '../lib/relay/config.js';
import { handlePage, boardFor } from '../lib/relay/relay.js';
import { syncBoards } from '../lib/relay/sync.js';
import { postMessage } from '../lib/relay/discord.js';

const EVENTS = /^page\.(created|properties_updated|content_updated|moved|deleted|undeleted)$/;

// Notion sends the verification token exactly once. It is kept in module memory and read back
// with ?action=verify_token&key=ADMIN_KEY straight after creating the subscription.
let lastVerificationToken = null;

const readRaw = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

export function signatureOk(raw, header, secret = process.env.NOTION_WEBHOOK_SECRET) {
  if (!secret) return true;   // not configured yet: accept, the events only ever name a page id
  if (!header) return false;  // configured: an unsigned event is not Notion's
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const action = url.searchParams.get('action');
  const keyOk = Boolean(process.env.ADMIN_KEY) && url.searchParams.get('key') === process.env.ADMIN_KEY;

  try {
    if (req.method === 'GET') {
      if (action === 'verify_token') {
        if (!keyOk) return res.status(403).json({ error: 'forbidden: add ?key= with your ADMIN_KEY' });
        return res.status(200).json({
          "token": lastVerificationToken,
          hint: lastVerificationToken ? 'Paste this into Notion, then save it as NOTION_WEBHOOK_SECRET.' : 'Nothing received yet. In Notion press "Resend token", then call this again straight away.',
        });
      }
      if (action === 'health') {
        const has = (k) => Boolean(process.env[k]);
        return res.status(200).json({
          ok: true,
          fathom_key: has('FATHOM_API_KEY'), fathom_webhook_secret: has('FATHOM_WEBHOOK_SECRET'),
          notion_key: has('NOTION_API_KEY'), calls_db: has('NOTION_CALLS_DB'), tasks_db: has('NOTION_TASKS_DB'),
          cron_secret: has('CRON_SECRET'), admin_key: has('ADMIN_KEY'),
          discord_token: has('DISCORD_BOT_TOKEN'), discord_guild: has('DISCORD_GUILD_ID'),
          discord_channel: has('DISCORD_TASK_CHANNEL_ID'), ledger_db: has('NOTION_LEDGER_DB'),
          notion_webhook_secret: has('NOTION_WEBHOOK_SECRET'),
        });
      }
      if (action === 'sync' || action === 'baseline') {
        if (!keyOk) return res.status(403).json({ error: 'forbidden: add ?key= with your ADMIN_KEY' });
        const out = await syncBoards(relayConfig(), { mode: action === 'baseline' ? 'baseline' : 'live' });
        return res.status(200).json({ mode: action, count: out.length, results: out });
      }
      return res.status(200).json({ ok: true, hint: 'POST Notion webhook events here. ?action=health shows what is configured.' });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

    const raw = await readRaw(req);
    let body = {};
    try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { /* keep {} */ }

    // ---- one-time subscription verification ----
    if (body.verification_token) {
      lastVerificationToken = body.verification_token;
      console.log('[relay] Notion verification token received. Read it with ?action=verify_token&key=ADMIN_KEY');
      return res.status(200).json({ ok: true });
    }

    if (!signatureOk(raw, req.headers['x-notion-signature'])) {
      return res.status(401).json({ error: 'bad signature' });
    }

    const type = body.type || '';
    const pageId = body.entity?.id;
    if (!pageId || body.entity?.type !== 'page') return res.status(200).json({ skipped: 'not a page event' });
    if (!EVENTS.test(type)) return res.status(200).json({ skipped: type });

    const config = relayConfig();
    // The integration can see more than the task board (and the relay's own ledger writes come
    // back as events too): filter on the payload's parent before spending any API calls.
    const parentId = body.data?.parent?.id;
    const match = parentId ? boardFor(config, parentId) : null;
    if (parentId && !match) return res.status(200).json({ skipped: 'not a watched database' });
    if (type === 'page.content_updated' && !(match?.board.watch_fields ?? []).includes('@body')) {
      return res.status(200).json({ skipped: 'page body not watched' });
    }

    const actorId = body.authors?.find((a) => a.type === 'person')?.id ?? null;

    // Acknowledge first, work after: Notion pauses a subscription whose endpoint answers slowly or
    // with errors. The jitter spreads a burst of events so it does not trip Notion's rate limit.
    const since = Date.now();
    waitUntil((async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 4000));
      try {
        const out = await handlePage(config, pageId, { mode: 'live', actorId, since });
        console.log('[relay]', type, pageId, JSON.stringify(out));
      } catch (e) {
        const msg = String(e);
        console.error('[relay] error', type, pageId, msg);
        // Rate-limit exhaustion and lock contention are repaired by the daily sweep; the rest is
        // worth a human seeing, when a log channel is configured.
        const logChannel = config.guilds.main.log_channel;
        if (logChannel && !/rate limited out|waiting for the ledger lock/.test(msg)) {
          await postMessage(logChannel, {
            content: `⚠️ Notion to Discord task relay error on \`${pageId}\` (${type})\n\`\`\`${msg.slice(0, 1500)}\`\`\``,
          }).catch(() => {});
        }
      }
    })());
    return res.status(200).json({ accepted: true, type, pageId });
  } catch (e) {
    console.error('[relay] request failed', e);
    return res.status(500).json({ error: e.name === 'SetupError' ? `setup problem: ${e.message}` : 'error, see the function logs' });
  }
}
