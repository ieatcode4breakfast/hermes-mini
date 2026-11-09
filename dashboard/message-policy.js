// Presentation only. Python parity fixtures cover bridge and push previews too.
const NOTICE = /^\W{0,4}(?:Hermes is (?:shutting down|restarting)\b|Restarting gateway\b|Gateway (?:online|restarted)\b|Hermes gateway (?:is back online|restarted)\b|First-time tip\s*[—-])/i;
const INTRO = /^I'm Hermes, your assistant here [—-] I can find things, run tasks, and keep track of work for you\. Typing \/help shows the commands you can use\.$/;
const FAILURE = /^(?:The model provider (?:rejected|reports|is rate-limiting|is overloaded|had an internal error|did not answer|does not know|refused|returned an error)|The connection to (?:the model provider|\S+) |The conversation is too long |This conversation \(including attachments\)|This conversation is too long |The request (?:was too large|failed)|Your custom model endpoint |The local model server |A firewall\/CDN |Hermes (?:hit an internal error|could not start the assistant|couldn't shrink)|Could not reopen that session|Session storage (?:is unavailable|could not be written)|The disk is full|History changed during this turn|I ran out of steps for this turn|[^\n]{1,100} didn't produce a reply this time)/;

export function failureText(text) {
  const value = String(text || "").trim();
  if (!FAILURE.test(value)) return value;
  const lower = value.toLowerCase();
  if (["not saved", "could not save", "storage", "disk is full"].some((x) => lower.includes(x)))
    return "Your message or reply could not be saved. The person who manages this setup needs to check it before you continue.";
  if (["too long", "too large", "shrink"].some((x) => lower.includes(x)))
    return "This chat is too long to continue. Start a new chat using the menu; your existing chat stays available.";
  if (["api key", "credentials", "no credit", "account policy", "could not start", "model_not_found"].some((x) => lower.includes(x)))
    return "The assistant is unavailable because of a setup or account problem. The person who manages this setup needs to check it.";
  if (lower.includes("ran out of steps")) return "The work stopped before it finished. Send “continue” to keep going.";
  if (lower.includes("content policy") || lower.includes("refused this request")) return "This request could not be answered. Try rephrasing it.";
  return "The assistant could not finish this reply. Wait a moment and send your message again. If it keeps happening, the person who manages this setup needs to check it.";
}

export function displayText(text, { notice = false, streaming = false } = {}) {
  const value = String(text || "").trim();
  if (notice && NOTICE.test(value)) return "";
  const result = [];
  const parts = value.split(/\n\s*\n/);
  let fenced = false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const normalized = part.split(/\s+/).join(" ");
    // Hold an incomplete legacy introduction until it can be classified, so it cannot flash
    // during streaming. Keep all earlier answer paragraphs and attachment refs visible.
    const prefix = "I'm Hermes, your assistant here";
    const pending = streaming && i === parts.length - 1 &&
      (prefix.startsWith(normalized) || normalized.startsWith(prefix));
    if (!fenced && (INTRO.test(normalized) || pending ||
        (notice && /^\W{0,4}First-time tip\s*[—-]/i.test(part)))) continue;
    result.push(part);
    if ((part.match(/^\s*(?:```|~~~)/gm) || []).length % 2) fenced = !fenced;
  }
  return failureText(result.join("\n\n"));
}
