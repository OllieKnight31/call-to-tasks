// Print the task board compactly, for checking what already exists before adding tasks.
//   npm run -s board -- [--client "Name"] [--open-only] [--recording <id>]
import { loadEnv, run } from "./_env.mjs";
loadEnv();
const { notion, tasksDb } = await import("../lib/core.js");

const text = (p) => (p?.title || p?.rich_text || []).map((t) => t.plain_text).join("") || p?.select?.name || p?.status?.name || "";

async function queryAll(body = {}) {
  const out = [];
  let cursor = null;
  do {
    const d = await notion("POST", `/databases/${tasksDb()}/query`, { page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}) });
    out.push(...d.results);
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  return out;
}

await run(async () => {
  const args = process.argv.slice(2);
  const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const row = (p) => `[${text(p.properties.Status)}|${text(p.properties.Owner)}|${text(p.properties.Client)}] ${text(p.properties.Task)}  ::${p.id}`;

  if (opt("--recording")) {
    const rows = await queryAll({ filter: { property: "Sync Key", rich_text: { starts_with: `${opt("--recording")}:` } } });
    console.log(`ALREADY ON THE BOARD FROM RECORDING ${opt("--recording")}: ${rows.length}`);
    rows.forEach((p) => console.log(row(p)));
    return;
  }
  const db = await notion("GET", `/databases/${tasksDb()}`);
  const options = (name) => (db.properties?.[name]?.select?.options || []).map((o) => o.name);
  console.log("CLIENT OPTIONS:", JSON.stringify(options("Client")));
  console.log("AREA OPTIONS:", JSON.stringify(options("Area")));
  const and = [];
  if (opt("--client")) and.push({ property: "Client", select: { equals: opt("--client") } });
  if (args.includes("--open-only")) and.push({ property: "Status", select: { does_not_equal: "Done" } });
  const rows = await queryAll(and.length ? { filter: { and } } : {});
  console.log(`TASKS (${rows.length}):`);
  rows.forEach((p) => console.log(row(p)));
});
