// The exact Notion database schemas the pipeline reads and writes. "npm run setup:notion" creates
// them; "npm run check -- --live" compares your databases against them. Property names are part of
// the contract: rename one in Notion and the matching write fails.

const sel = (...options) => ({ select: { options: options.map(([name, color]) => ({ name, color })) } });
const text = { rich_text: {} };
const number = { number: { format: "number" } };

export const TASKS_SCHEMA = {
  Task: { title: {} },
  Status: sel(["Not Started", "gray"], ["In progress", "blue"], ["Bottleneck", "orange"], ["Blocked", "red"], ["Done", "green"]),
  Urgency: sel(["🔥 P0", "red"], ["⚡ P1", "orange"], ["📌 P2", "yellow"], ["🌱 P3", "green"]),
  Owner: text,
  Assignee: { people: {} },
  Area: sel(["Sales", "green"], ["Marketing", "pink"], ["Operations", "blue"], ["Client", "purple"], ["Content", "orange"], ["Other", "default"]),
  Client: { select: { options: [] } },
  Source: sel(["Fathom call", "blue"], ["Manual", "gray"]),
  "Due Date": { date: {} },
  "Call Link": { url: {} },
  Notes: text,
  "Sync Key": text,
  // "Call" (relation to the Call Library) is added by the setup script once both databases exist.
};

export const CALLS_SCHEMA = {
  Call: { title: {} },
  Date: { date: {} },
  Client: { select: { options: [{ name: "Internal", color: "gray" }] } },
  "Call Type": sel(["Sales / Discovery", "green"], ["Client Coaching", "blue"], ["Onboarding", "purple"], ["Internal / Team", "gray"], ["Content / Interview", "pink"], ["Other", "default"]),
  Briefing: text,
  "Next Steps": text,
  Attendees: text,
  "Duration (min)": number,
  Recording: { url: {} },
  "Recording ID": number,
  "Recorded By": text,
  "Tasks Created": number,
  Status: sel(["Processing", "yellow"], ["Done", "green"], ["Error", "red"]),
  Error: text,
  // "Tasks" (relation to the task board) is added by the setup script once both databases exist.
};

export const LEDGER_SCHEMA = {
  Key: { title: {} },
  Item: text,
  Board: { select: { options: [] } },
  "Thread ID": text,
  "Message ID": text,
  "Last Stage": text,
  Snapshot: text,
  "Dept Channel": text,
  "Dept Message ID": text,
  "Last Synced": { date: {} },
  Lock: text,
};

const typeOf = (def) => Object.keys(def)[0];

/** name -> type for everything a database must have, relations included. */
export const REQUIRED = {
  NOTION_TASKS_DB: { ...Object.fromEntries(Object.entries(TASKS_SCHEMA).map(([k, v]) => [k, typeOf(v)])), Call: "relation" },
  NOTION_CALLS_DB: { ...Object.fromEntries(Object.entries(CALLS_SCHEMA).map(([k, v]) => [k, typeOf(v)])), Tasks: "relation" },
  NOTION_LEDGER_DB: Object.fromEntries(Object.entries(LEDGER_SCHEMA).map(([k, v]) => [k, typeOf(v)])),
};

/** What is missing or of the wrong type in a database fetched from Notion. Empty when it matches. */
export function schemaProblems(envName, database) {
  const have = database?.properties || {};
  const out = [];
  for (const [name, type] of Object.entries(REQUIRED[envName])) {
    if (!have[name]) out.push(`property "${name}" (${type}) is missing`);
    // A Status-type property works as well as a Select for the task status.
    else if (have[name].type !== type && !(name === "Status" && have[name].type === "status")) out.push(`property "${name}" is ${have[name].type}, expected ${type}`);
  }
  return out;
}

/** 32 hex characters out of a Notion page URL or a bare id. */
export function pageIdFrom(input) {
  const s = String(input || "").split("?")[0];
  const m = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || s.match(/[0-9a-f]{32}(?![0-9a-f])/i);
  return m ? m[0].replace(/-/g, "").toLowerCase() : null;
}
