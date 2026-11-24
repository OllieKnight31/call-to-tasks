// Posts the Discord card for tasks the call pipeline has just created.
import { relayConfig } from "./relay/config.js";
import { handlePage } from "./relay/relay.js";

export async function notifyTasks(taskIds) {
  const config = relayConfig();
  const out = { enabled: true, posted: 0, errors: [] };
  for (const id of taskIds) {
    try {
      const r = await handlePage(config, id, { mode: "live" });
      if (r.action === "created") out.posted++;
    } catch (e) {
      out.errors.push(String(e.message || e).slice(0, 300));
    }
  }
  return out;
}
