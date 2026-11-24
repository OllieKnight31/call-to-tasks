// Loads .env.local (or .env) from the project folder into process.env for the local commands.
// Values already set in the shell win. Nothing is printed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where the local commands read and save settings. Tests point this at a throwaway file. */
export const envFilePath = () => process.env.CALL_TO_TASKS_ENV_FILE || path.join(ROOT, ".env.local");

export function loadEnv() {
  if (process.env.CALL_TO_TASKS_NO_ENV_FILE) return null;
  const file = [envFilePath(), path.join(ROOT, ".env")].find((f) => fs.existsSync(f));
  if (!file) return null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const key = t.slice(0, i).trim().replace(/^export\s+/, "");
    const value = t.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (value && !process.env[key]) process.env[key] = value;
  }
  return file;
}

/** Run a command's main function and turn setup problems into one clear line instead of a stack trace. */
export async function run(main) {
  try {
    await main();
  } catch (e) {
    if (e?.name === "SetupError") console.error(`\nSETUP PROBLEM: ${e.message}\n`);
    else console.error(`\nFAILED: ${e?.message || e}\n`);
    process.exit(1);
  }
}
