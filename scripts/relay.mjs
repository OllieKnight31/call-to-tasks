// Local runner for the Notion -> Discord relay: the same code the deployed app uses.
//   npm run relay -- sync            post anything created or moved in Notion since the last run
//   npm run relay -- baseline        record the board's current state WITHOUT posting (use once when the board already has tasks)
//   npm run relay -- page <pageId>   process a single task
import { loadEnv, run } from "./_env.mjs";
loadEnv();
const { relayConfig } = await import("../lib/relay/config.js");
const { handlePage } = await import("../lib/relay/relay.js");
const { syncBoards } = await import("../lib/relay/sync.js");

await run(async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "page") {
    if (!arg) throw new Error("Give the Notion page id of the task.");
    console.log(JSON.stringify(await handlePage(relayConfig(), arg, { mode: "live" }), null, 2));
    return;
  }
  if (!["baseline", "sync"].includes(cmd)) throw new Error("usage: npm run relay -- sync | baseline | page <pageId>");
  const mode = cmd === "baseline" ? "baseline" : "live";
  const results = await syncBoards(relayConfig(), {
    mode,
    log: (key, rows, tally) => console.log(`${key.padEnd(9)} ${String(rows).padStart(3)} rows  ${JSON.stringify(tally)}`),
  });
  for (const r of results.filter((x) => x.error)) console.error(`  ! ${r.board} ${r.page}: ${r.error}`);
  console.log(`\n${mode} complete: ${results.length} rows processed`);
});
