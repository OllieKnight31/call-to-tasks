const BASE = 'https://discord.com/api/v10';
const UA = 'DiscordBot (https://github.com/discord/discord-api-docs, 1.0)';

export async function discord(path, { method = 'GET', body, token = process.env.DISCORD_BOT_TOKEN } = {}) {
  if (!token) throw new Error('Missing environment variable DISCORD_BOT_TOKEN. See .env.example.');
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers: { Authorization: `Bot ${token}`, 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429) {
      const d = await res.json().catch(() => ({}));
      // Channel renames are limited to 2 per 10 minutes; waiting that out would outlive the function.
      if ((d.retry_after ?? 1) > 20) throw new Error(`Discord ${method} ${path} -> 429 retry_after ${d.retry_after}s`);
      await new Promise((r) => setTimeout(r, ((d.retry_after ?? 1) + 0.25) * 1000));
      continue;
    }
    const text = await res.text();
    if (res.status === 401) throw new Error('Discord refused the bot token (401). Check DISCORD_BOT_TOKEN.');
    if (res.status === 403) throw new Error(`Discord ${method} ${path} -> 403. The bot lacks a permission in that channel: it needs View Channel, Send Messages, Embed Links, Create Public Threads, Send Messages in Threads and Manage Threads. ${text.slice(0, 200)}`);
    if (res.status === 404) throw new Error(`Discord ${method} ${path} -> 404. Check the channel id and that the bot has been invited to the server. ${text.slice(0, 200)}`);
    if (!res.ok) throw new Error(`Discord ${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : {};
  }
  throw new Error(`Discord ${method} ${path} -> rate limited out`);
}

export const postMessage  = (channelId, payload) => discord(`/channels/${channelId}/messages`, { method: 'POST', body: payload });
export const editMessage  = (channelId, messageId, payload) => discord(`/channels/${channelId}/messages/${messageId}`, { method: 'PATCH', body: payload });
export const deleteMessage = (channelId, messageId) => discord(`/channels/${channelId}/messages/${messageId}`, { method: 'DELETE' });
export const renameThread = (threadId, name) => discord(`/channels/${threadId}`, { method: 'PATCH', body: { name: name.slice(0, 100) } });
export const startThread  = (channelId, messageId, name) =>
  discord(`/channels/${channelId}/messages/${messageId}/threads`, {
    method: 'POST',
    body: { name: name.slice(0, 100), auto_archive_duration: 10080 },
  });
export const archiveThread = (threadId) => discord(`/channels/${threadId}`, { method: 'PATCH', body: { archived: true } });
export const unarchiveThread = (threadId) => discord(`/channels/${threadId}`, { method: 'PATCH', body: { archived: false } });
