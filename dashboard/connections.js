// The "connect an app" card for Hermes' manage_connections tool. Hermes opens it with connection.request, keeps it
// current with connection.update and takes the card's answers through connection.respond. While the card is open the
// tool waits for it (up to its deadline), so a client without the card leaves the turn hanging.
// Pure: labels, which buttons a row gets and the answers sent back. app.js draws the card.

const STATE_LABELS = {
  pending: "Waiting",
  initiated: "Waiting for you to sign in",
  connected: "Connected",
  skipped: "Skipped",
  failed: "Could not connect",
  expired: "The link expired",
  not_connected: "Not connected",
};
const FINAL_STATES = new Set(["connected", "skipped", "failed", "expired", "not_connected"]);
const ACTION_WORDS = { connect: "Connect", reconnect: "Reconnect", install: "Install", enable: "Turn on", authorize: "Authorize" };

/** "notion" -> "Notion", "google-drive" -> "Google Drive". */
export function appName(target) {
  return String(target?.name || "app")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** A local install or enable asks for an OK; a hosted app is connected by signing in through its link. */
export function needsApproval(target) {
  return target?.kind !== "connector" && (target?.action === "install" || target?.action === "enable");
}

/** Credentials an install asks for are typed in Hermes' desktop app, not here. */
export function needsDesktop(target) {
  return Array.isArray(target?.required_env) && target.required_env.length > 0;
}

/** The sign-in link, only when it is an https URL. */
export function openUrl(target) {
  const url = String(target?.connect_url || "");
  return /^https:\/\/[^\s]+$/i.test(url) ? url : "";
}

export function isResolved(target) {
  return target?.resolved === true || FINAL_STATES.has(target?.state);
}

export function stateLabel(target) {
  if (!isResolved(target) && needsDesktop(target)) return "Finish this one in the Hermes desktop app";
  if (target?.state === "pending" && needsApproval(target)) return "Needs your OK";
  return STATE_LABELS[target?.state] || "Waiting";
}

/** The buttons a row gets: "open" (the sign-in link), "allow" (an install or enable), "skip". None once resolved. */
export function rowButtons(target) {
  if (isResolved(target)) return [];
  const buttons = [];
  if (needsApproval(target) && !needsDesktop(target)) buttons.push("allow");
  else if (!needsApproval(target) && openUrl(target)) buttons.push("open");
  buttons.push("skip");
  return buttons;
}

export function cardTitle(payload) {
  const targets = Array.isArray(payload?.targets) ? payload.targets : [];
  if (targets.length !== 1) return "Connect apps";
  return `${ACTION_WORDS[targets[0].action] || "Connect"} ${appName(targets[0])}`;
}

/** One row's answer: status "approved" or "skipped". */
export function rowAnswer(target, status) {
  return { targets: [{ name: String(target.name), status }] };
}

/** Done: stop waiting for the rows still open and let the agent carry on. */
export function doneAnswer() {
  return { targets: [], settled_by: "continue" };
}

export function isSettled(payload) {
  return payload?.settled === true || (payload?.settled_at !== undefined && payload?.settled_at !== null);
}

/** Whether an update is newer than what the card shows (Hermes numbers them with seq). */
export function isNewer(shownSeq, payload) {
  const seq = Number(payload?.seq);
  return !Number.isFinite(seq) || !Number.isFinite(shownSeq) || seq >= shownSeq;
}
