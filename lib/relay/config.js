// Builds the relay's routing from your environment variables and config.json.
// One Notion task board -> one Discord channel. Nothing here is hard-coded to a workspace.
import { notionId, discordId, env, loadConfig, SetupError } from '../settings.js';

let cached = null;

export function relayConfig() {
  if (cached) return cached;
  if (!env('DISCORD_BOT_TOKEN', { optional: true })) {
    throw new SetupError('Discord is not configured: DISCORD_BOT_TOKEN is missing. Set it (with DISCORD_GUILD_ID, DISCORD_TASK_CHANNEL_ID and NOTION_LEDGER_DB) or leave all four empty to run without Discord.');
  }
  const cfg = loadConfig();
  const role = cfg.discord.escalation_role_id;
  const escalate = role ? ['Escalation'] : [];

  // Name, aliases and Notion user id all resolve to the person's Discord id, so the ping never
  // depends on the bot being allowed to list server members.
  const people = {};
  for (const m of cfg.team) {
    if (!m.discord_user_id) continue;
    for (const key of [m.name, ...m.aliases, m.notion_user_id].filter(Boolean)) people[key] = m.discord_user_id;
  }

  const stage = (emoji, headline, color, extra = {}) => ({ emoji, headline, color, ping: [], ...extra });
  cached = {
    notion: { ledger_db: notionId('NOTION_LEDGER_DB') },
    guilds: {
      main: {
        label: 'Discord',
        guild_id: discordId('DISCORD_GUILD_ID'),
        log_channel: discordId('DISCORD_LOG_CHANNEL_ID', { optional: true }),
        roles: role ? { Escalation: role } : {},
      },
    },
    people,
    boards: {
      tasks: {
        label: cfg.discord.label,
        guild: 'main',
        database_id: notionId('NOTION_TASKS_DB'),
        channel_id: discordId('DISCORD_TASK_CHANNEL_ID'),
        title_prop: 'Task',
        stage_prop: 'Status',
        assignee_prop: 'Assignee',
        owner_prop: 'Owner',
        due_prop: 'Due Date',
        created: stage('📋', 'NEW TASK', 0x95a5a6),
        stages: {
          'Not Started': stage('📋', 'NOT STARTED', 0x95a5a6),
          'In progress': stage('⏳', 'IN PROGRESS', 0x3498db),
          Bottleneck: stage('🚧', 'BOTTLENECK', 0xe67e22, { ping: escalate }),
          Blocked: stage('⛔', 'BLOCKED', 0xe74c3c, { ping: escalate }),
          Done: stage('✅', 'DONE', 0x27ae60, { close: true }),
        },
        fields: [
          { prop: '@assignee', label: 'Assignee' },
          { prop: 'Urgency', label: 'Urgency' },
          { prop: 'Client', label: 'Client' },
        ],
        brief: { source: 'Notes', limit: 500, label: 'Notes' },
        watch_fields: [],
        buttons: [
          { label: 'Open in Notion', page: true },
          { label: 'Call recording', prop: 'Call Link' },
        ],
      },
    },
  };
  return cached;
}

export function resetRelayConfigCache() { cached = null; }
