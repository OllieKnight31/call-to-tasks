// Who is on your team, and who owns an action item. Pure functions: no network, no environment.

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

/** The team member a person (name and/or email) is, or null when they are not on the team. */
export function memberFor(person, cfg) {
  const email = String(person?.email ?? "").trim().toLowerCase();
  if (email) {
    const byEmail = cfg.team.find((m) => m.emails.includes(email));
    if (byEmail) return byEmail;
  }
  const name = norm(person?.name);
  if (!name) return null;
  const padded = ` ${name} `;
  const byName = cfg.team.find((m) => [m.name, ...m.aliases].some((a) => norm(a) && padded.includes(` ${norm(a)} `)));
  if (!byName) return null;
  // A different, known email beats a matching first name: "Sam" the client is not "Sam" on your team.
  if (email && byName.emails.length) return null;
  return byName;
}

export const defaultOwner = (cfg) => cfg.team.find((m) => m.name === cfg.default_owner);

/**
 * Owner of one Fathom action item.
 *   nobody named            -> the default owner
 *   someone on the team     -> that person
 *   anyone else (a client)  -> null (the item stays on the call page only),
 *                              or the default owner when tasks.other_people is "default_owner"
 */
export function ownerOf(assignee, cfg) {
  if (!assignee?.name && !assignee?.email) return defaultOwner(cfg);
  const member = memberFor(assignee, cfg);
  if (member) return member;
  return cfg.tasks.other_people === "default_owner" ? defaultOwner(cfg) : null;
}
