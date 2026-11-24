# Call to Tasks

Finish a sales call and the admin is already done.

1. **Fathom** records the call. When the recording is ready it calls your small web app.
2. The app writes a full briefing into a **Notion Call Library**: summary, key takeaways, next steps, the recording link and the whole transcript.
3. Every action item becomes a task on a **Notion task board**, assigned to the right person on your team and linked back to the call, with a link that opens the recording at the moment it was said.
4. The assignee is pinged in a **Discord** channel, one card per task with its own thread. When a task later moves to Blocked or Done in Notion, the thread is updated.

No AI key is needed and nothing is charged per call: the summary and the action items are the ones Fathom already writes.

## What you need

| Thing | Why | Cost |
|---|---|---|
| Fathom account with an API key | Records the call, writes the summary and action items | Check your plan: the API key is under Settings > API Access, and summaries and action items must be switched on for your recordings. I could not confirm which Fathom plans include these, so look before you start. |
| Notion workspace where you can create a connection (integration) | Holds the Call Library and the task board | Free plan is enough |
| Vercel account and the Vercel CLI | Hosts the app that Fathom calls | Hobby (free) plan is enough |
| Discord server where you can add a bot | Pings the assignee. Optional: leave it out and everything still reaches Notion | Free |
| Node.js 22 or newer on your computer | Runs the set-up commands | Free |
| Claude Code | Optional. The included skill walks you through set-up and handles pasted transcripts | Your existing plan |

You do not need: an OpenAI or Anthropic API key, a database, or a paid Vercel plan.

## How the pieces fit

```
Fathom  --webhook-->  /api/fathom-webhook  --writes-->  Notion Call Library (one page per call)
                              |                         Notion Tasks (one row per action item, linked to the call)
                              '--posts-->  Discord channel (one card + thread per task, assignee pinged)

Vercel daily job  -->  /api/sweep    catches any call the webhook missed, retries calls marked Error,
                                     and posts any task that was created or moved in Notion since yesterday
Notion webhook    -->  /api/notion   optional: makes status moves reach Discord within a minute instead of daily
```

Your personal details live in two files and nowhere else:

- `.env.local`: keys, secrets and ids. Stays on your computer. The same values go into your Vercel project.
- `config.json`: your team (names, emails, Notion and Discord ids) and the task rules. Contains no secrets and is deployed with the app.

## Set-up, step by step

Allow about 40 minutes. Do the steps in order. Every command is run inside this folder.

### 1. Install

```bash
bash install.sh
npm test        # 32 offline tests, about a minute, no accounts needed
npm run demo    # watch the invented sample call go through the whole pipeline, offline
```

`install.sh` installs one small package, creates `.env.local` and `config.json` from the examples, and adds the `call-to-tasks` skill to Claude Code. If you use Claude Code you can now say "set up call to tasks" and it will take you through the rest of this list.

### 2. Notion: connection and databases

1. Go to notion.so/profile/integrations and create a new **internal** connection for your workspace. Under capabilities allow Read content, Update content, Insert content, and "Read user information including email addresses".
2. Copy its secret and paste it after `NOTION_API_KEY=` in `.env.local`.
3. In Notion create an empty page (call it anything, for example "Calls"). Open the page menu (three dots, top right) > Connections > add the connection you just made.
4. Copy the page link and run:

```bash
npm run setup:notion -- "https://www.notion.so/your-page-link"
```

This creates three databases inside that page and saves their ids to `.env.local`:

- **Tasks**: Task, Status (Not Started, In progress, Bottleneck, Blocked, Done), Urgency, Owner, Assignee, Area, Client, Source, Due Date, Call Link, Notes, Sync Key, Call (link to the call)
- **Call Library**: Call, Date, Client, Call Type, Briefing, Next Steps, Attendees, Duration (min), Recording, Recording ID, Recorded By, Tasks Created, Status, Error, Tasks (link to the tasks)
- **Discord Sync Ledger**: the app's own memory of which Discord card belongs to which task. Do not edit it.

You can add your own properties and views to Tasks and the Call Library. Do not rename or delete the ones listed above. To see the schema without creating anything add `--dry-run`.

### 3. Fathom: API key

Fathom > Settings > API Access > generate a key. Paste it after `FATHOM_API_KEY=` in `.env.local`.

### 4. Your team

Open `config.json` and replace the placeholders.

```json
{
  "team": [
    { "name": "Sam", "aliases": ["Sam Carter"], "emails": ["sam@example.com"], "notion_user_id": "", "discord_user_id": "" }
  ],
  "default_owner": "Sam",
  "tasks": { "other_people": "skip", "default_urgency": "📌 P2", "only_for_titles_matching": "" },
  "discord": { "label": "Tasks", "escalation_role_id": "" }
}
```

- `name`: the short name written in the task's Owner field.
- `aliases`: every other way Fathom shows this person (full name, nickname). Matching ignores capitals.
- `emails`: the address they join calls with. An email match always wins over a name match.
- `notion_user_id`: fills the Assignee field. Run `npm run notion:users` to list them. Optional.
- `discord_user_id`: who gets pinged. In Discord turn on Settings > Advanced > Developer Mode, then right-click the person > Copy User ID. Optional: without it the card shows the name and nobody is pinged.
- `default_owner`: gets every action item Fathom did not assign to anyone.
- `other_people`: `"skip"` keeps action items for people outside your team (your client) on the call page only. `"default_owner"` puts them on the board under the default owner.
- `only_for_titles_matching`: leave empty to make tasks for every call, or put words such as `sales|discovery` to limit tasks to calls whose title contains one of them. Every call still gets a Call Library page.
- `escalation_role_id`: a Discord role to ping when a task moves to Bottleneck or Blocked. The role must be set to "Allow anyone to @mention this role". Optional.

### 5. Discord (optional)

1. discord.com/developers/applications > New Application > Bot > Reset Token. Paste the token after `DISCORD_BOT_TOKEN=`.
2. Invite the bot. On the General Information page copy the Application ID, then open this address with your id in place of `APP_ID`:
   `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot&permissions=326417599488`
   That grants exactly: View Channels, Send Messages, Embed Links, Read Message History, Create Public Threads, Send Messages in Threads, Manage Threads.
3. Create or pick the channel for task cards. If it is private, add the bot to it.
4. With Developer Mode on, right-click the server > Copy Server ID into `DISCORD_GUILD_ID`, and right-click the channel > Copy Channel ID into `DISCORD_TASK_CHANNEL_ID`.

### 6. Two passwords of your own

```bash
openssl rand -hex 24    # paste the result after CRON_SECRET=
openssl rand -hex 24    # run it again and paste after ADMIN_KEY=
```

### 7. Check

```bash
npm run check             # reads .env.local and config.json and lists anything missing
npm run check -- --live   # also asks Notion, Fathom and Discord whether the keys and ids really work
```

Fix every line that starts with FAIL before going on. The check never prints a key.

### 8. Deploy to Vercel

```bash
npm install -g vercel     # once
vercel link               # creates the project; accept the defaults
```

Now give the project your settings: Vercel dashboard > your project > Settings > Environment Variables. Open `.env.local` in a text editor, copy everything, and paste it into the first Key box: Vercel fills in one row per line. Remove any row whose value is empty (Vercel will not save an empty value), save, then:

```bash
vercel --prod
```

Note the production address it prints (it looks like `https://<your-project>.vercel.app`). Open `<address>/api/fathom-webhook` in a browser: it should say `call-to-tasks webhook is live`. Open `<address>/api/notion?action=health`: every item you have set up should say `true`.

### 9. Connect Fathom

```bash
npm run register -- https://<your-project>.vercel.app/api/fathom-webhook
```

This creates the webhook in Fathom and writes its signing secret into `.env.local` as `FATHOM_WEBHOOK_SECRET` (it is not shown on screen). Add that one value to Vercel's Environment Variables as well, then deploy again:

```bash
vercel --prod
```

On a Fathom Team plan add `--team` to the register command to include recordings shared within the team.

## First test

```bash
npm run send-sample -- https://<your-project>.vercel.app/api/fathom-webhook
```

This sends the invented call in `sample/fathom-webhook-payload.json`, signed the way Fathom signs. Within a minute you should see:

- a page called "Northwind Studio discovery call" in the Call Library, Status **Done**, with the summary, four action items and the transcript inside a toggle;
- **one** task on the board, "Book the kickoff call...", owned by your default owner and linked to the call. The other three action items name invented people who are not on your team, so they stay on the call page. That is the `other_people: "skip"` rule working;
- one card in your Discord channel pinging the default owner.

Delete the sample call page, the task and the Discord card afterwards. Then record a real call with Fathom: the page appears when Fathom finishes processing the recording, usually a few minutes after the call ends.

## Day to day

| Command | What it does |
|---|---|
| `npm run status -- 7` | Lists the last 7 days of recordings and whether each reached Notion |
| `npm run one -- <recording id>` | Processes one call again. A call marked Done is skipped: set its Status to Error in Notion first to rebuild it |
| `npm run backfill -- 14` | Processes every call from the last 14 days that is missing or marked Error (`--dry-run` to preview) |
| `npm run relay -- sync` | Posts to Discord anything created or moved in Notion since the last run |
| `npm run push -- tasks.json` | Adds hand-written tasks for a call that Fathom did not record (format in `sample/tasks.example.json`) |

Tasks are never duplicated: each carries a Sync Key made from the recording id and the action item, and a call is rebuilt in place.

## Optional: instant status updates

Without this step, tasks created from calls are still posted to Discord immediately. Only later changes made by hand in Notion (a task moved to Blocked, a task you add yourself) wait for the daily job at 06:00 UTC. To make those arrive within about a minute:

1. In Notion open your connection's settings > Webhooks > Create a subscription. Address: `https://<your-project>.vercel.app/api/notion`. Choose the page events.
2. Notion sends a one-time token to the app. Read it by opening `https://<your-project>.vercel.app/api/notion?action=verify_token&key=YOUR_ADMIN_KEY` straight away. If it shows `null`, press "Resend token" in Notion and reload.
3. Paste the token into Notion's Verify box. Also save it in Vercel as `NOTION_WEBHOOK_SECRET` and run `vercel --prod`, so the app rejects events that are not from Notion.

## Troubleshooting

| What you see | Cause and fix |
|---|---|
| `SETUP PROBLEM: Missing environment variable ...` | That value is empty in `.env.local`. Fill it in, and add it to Vercel too |
| `send-sample` prints `401 bad signature` | Vercel has no `FATHOM_WEBHOOK_SECRET`, or an old one. Copy the line from `.env.local` into Vercel and run `vercel --prod` |
| `send-sample` prints `500 setup problem: ...` | The message names what the deployed app is missing. Add it in Vercel and redeploy |
| `500 setup problem: config.json not found` | `config.json` was not deployed. It must sit next to `package.json` and must not be listed in `.gitignore` |
| `Notion 404 ... not shared with your integration` | Open the page that holds the databases > Connections > add your connection |
| `Notion 400 ... is not a property that exists` | A property was renamed or deleted. Run `npm run check -- --live` to see which, and rename it back |
| Call page stuck on **Error**: "Fathom summary not ready yet" | Fathom had not finished the summary. The daily job retries it, or run `npm run one -- <recording id>` |
| Call page is Done but the Error field mentions Discord | The call and tasks are safe in Notion. Fix what the message says (usually a missing bot permission in the channel), then `npm run relay -- sync` |
| Card appears but nobody is pinged | That person has no `discord_user_id` in `config.json`, or the name Fathom used is not in their `aliases` |
| A task went to the wrong person, or to nobody | Add the name Fathom showed to the right person's `aliases` and their email to `emails`, then deploy again |
| No tasks, only the call page | Fathom produced no action items for that call, every item named someone outside your team, or `only_for_titles_matching` excluded the title |
| Nothing arrives after a real call | Run `npm run status`. If the call is listed as NOT IN NOTION, check the webhook exists in Fathom > Settings > API Access and that its address ends in `/api/fathom-webhook` |
| `vercel --prod` fails mentioning maxDuration | Your project has Fluid Compute switched off. Turn it on in Project Settings > Functions, or lower `maxDuration` in `vercel.json` to 60 |
| Vercel asks you to log in when you open the address | You opened a preview address. Use the production address printed by `vercel --prod` |
| Existing tasks all get posted to Discord at once | You pointed the app at a board that already had tasks. Run `npm run relay -- baseline` once before the first sync to record them silently |

## What is in this folder

```
api/        the three addresses Vercel serves: fathom-webhook, sweep, notion
lib/        core.js (call -> Notion), team.js (who owns what), schema.js (database shapes),
            settings.js (reads .env.local and config.json), relay/ (Notion -> Discord)
scripts/    the npm run commands
sample/     an invented Fathom payload and an example task file
tests/      offline tests and the fake Fathom, Notion and Discord they run against
skill/      the Claude Code skill
```

## Limits worth knowing

- The summary is only as good as Fathom's. Speaker names can be wrong when two people share a microphone.
- One task board and one Discord channel. Routing different calls to different boards is not built in.
- Discord cannot change Notion: move tasks in Notion.
- The daily job runs once a day at 06:00 UTC on Vercel's free plan.
