---
name: call-to-tasks
description: >
  Set up, check and run the Call to Tasks pipeline: Fathom call -> Notion Call Library briefing ->
  one Notion task per action item, assigned and linked to the call -> Discord ping. Use when the user
  wants to set the pipeline up, asks whether a call reached Notion, wants a call rerun or backfilled,
  changes who is on the team, or pastes a call transcript (or a Fathom link or recording id) and wants
  its action items put on the task board.
  Triggers: "set up call to tasks", "did my call go into Notion", "where are the tasks from my call",
  "rerun that call", "backfill my calls", "add someone to the team", "here's the transcript",
  "tasks from this call", "digest this call", a fathom.video link.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
---

# Call to Tasks

The app lives in the folder named in `project-path.txt` next to this file (written by `install.sh`).
Read that file first and run every command from that folder. If the file is missing or the folder is
gone, ask the user where they unpacked `call-to-tasks` and tell them to run `bash install.sh` there.

Ground rules:

- Never ask the user to paste a key, token or secret into the chat, and never print the contents of
  `.env.local`. The user types secrets into `.env.local` themselves. `npm run check` tells you what is
  set without showing values.
- `README.md` in the project folder is the source of truth for set-up. Follow its step numbers.
- Do not rename Notion properties or edit `lib/schema.js` to "fix" a mismatch: fix the database.

## 1. Setting it up

1. Run `npm test` and `npm run demo`. Both are offline. If they fail, stop and show the failure.
2. Run `npm run check`. Work through the FAIL lines with the user in README order:
   Notion connection and `npm run setup:notion -- "<page link>"` (step 2), Fathom key (3),
   `config.json` team (4), Discord bot (5, optional), `CRON_SECRET` and `ADMIN_KEY` (6).
   For each one, tell the user exactly where to click and which line of `.env.local` to fill, wait
   for them to say it is done, then run `npm run check` again.
3. For the team, ask for each person's short name, the full name Fathom shows, and the email they
   join calls with. Edit `config.json` yourself. Run `npm run notion:users` to find Notion user ids.
   Ask the user to copy Discord user ids (Developer Mode > right-click > Copy User ID).
4. When `npm run check` passes, run `npm run check -- --live`.
5. Deploy (README step 8): the user runs `vercel link`, pastes `.env.local` into the Vercel
   project's Environment Variables, then `vercel --prod`. Confirm `<address>/api/fathom-webhook`
   answers `call-to-tasks webhook is live`.
6. `npm run register -- <address>/api/fathom-webhook`, then the user adds `FATHOM_WEBHOOK_SECRET`
   to Vercel and runs `vercel --prod` again.
7. First test: `npm run send-sample -- <address>/api/fathom-webhook`. Expect 202, then one call
   page, one task for the default owner and one Discord card. Explain that the other three sample
   items name people outside the team. If the answer is 401 or 500, the README troubleshooting table
   has the fix.

## 2. Did a call go through?

`npm run status -- <days>` lists each recording with its Notion status and task count.

- `NOT IN NOTION`: run `npm run one -- <recording id>`.
- `Error`: read the Error field on the call page, fix the cause, run `npm run one -- <recording id>`.
- `Done` but the user wants it rebuilt: they set the page's Status to Error in Notion, then
  `npm run one -- <recording id>`. Tasks are not duplicated.
- Several missing: `npm run backfill -- <days> --dry-run`, then without `--dry-run`.
- Tasks exist but Discord shows nothing: `npm run relay -- sync`.

## 3. Changing the team or the rules

Edit `config.json` (fields are explained in README step 4), run `npm run check`, then the user runs
`vercel --prod`. A change is not live until it is deployed.

## 4. A transcript the webhook did not handle

Use this for pasted text, a transcript file, or a call a teammate recorded.

1. Get the text into a file in your scratch folder. For a Fathom link or recording id:
   `npm run -s fathom -- <link or id> --out <scratch>/call.txt`. `npm run -s fathom -- --latest` lists recent calls.
2. If there is a recording id, run `npm run -s board -- --recording <id>`. Tasks the webhook already
   made must not be created again: add only what it missed.
3. Run `npm run -s board -- --open-only` and keep the output for de-duplication. It also prints the
   Client and Area options: reuse the exact spelling.
4. Read the whole transcript, every line. Extract tasks by these rules:
   - Capture every real commitment: things to build, send, decide, record or research, for every
     owner. Skip small talk, general advice and ideas nobody committed to.
   - One task is one deliverable. Put its sub-steps in `checklist`. Roughly 8 to 25 tasks for an hour.
   - If a task is already on the board, do not recreate it. If the call adds information, add an
     entry to `updates` with the existing task's id (the part after `::`) and a one-sentence note.
   - `status` is `Done` only with evidence in the call, quoted in `done_evidence`. `In progress` if
     clearly started. Otherwise `Not Started`.
   - `owner` is a team member's `name` from `config.json`, or the client's name. Unowned decisions
     go to the default owner.
   - `urgency`: 🔥 P0 money, blocking or due this week. ⚡ P1 important soon. 📌 P2 normal. 🌱 P3 nice to have.
   - `due` only when a date is stated or clearly implied. Otherwise null.
   - Anything unclear: keep the task, set `needs_check` to true and say what to confirm in `notes`.
   - Any price, payment or deal term: put the exact figures and the verbatim quote in the task.
5. Write `<scratch>/tasks.json` in the format of `sample/tasks.example.json`.
6. `npm run -s push -- <scratch>/tasks.json --dry-run`, show the user the list, then run it without
   `--dry-run` once they agree. Running it twice is safe.
7. Report in under 200 words: tasks created per owner, each P0, each `needs_check` item, existing
   tasks updated, and any money figures with their timestamps.
