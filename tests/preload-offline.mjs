// Loaded with "node --import" in front of a command by the tests: installs the fake Fathom, Notion
// and Discord before the command starts, with the sample call as the only recording in "Fathom".
import fs from "node:fs";
import path from "node:path";
import { startOffline, ROOT } from "./harness.mjs";

const sample = JSON.parse(fs.readFileSync(path.join(ROOT, "sample", "fathom-webhook-payload.json"), "utf8"));
sample.created_at = "2030-01-15T10:30:00Z";
await startOffline({ configFile: process.env.CALL_TO_TASKS_CONFIG, meetings: [sample] });
