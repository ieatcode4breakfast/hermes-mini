"""Presentation only: never alter stored/model-facing assistant history.

Keep these rules in sync with dashboard/message-policy.js; parity fixtures test both.
Only identified machinery and canned failure copy are rewritten. Ordinary prose is untouched.
"""
import re

NOTICE = r"^\W{0,4}(?:Hermes is (?:shutting down|restarting)\b|Restarting gateway\b|Gateway (?:online|restarted)\b|Hermes gateway (?:is back online|restarted)\b|First-time tip\s*[—-])"
INTRO = r"^I'm Hermes, your assistant here [—-] I can find things, run tasks, and keep track of work for you\. Typing /help shows the commands you can use\.$"
FAILURE = r"^(?:The model provider (?:rejected|reports|is rate-limiting|is overloaded|had an internal error|did not answer|does not know|refused|returned an error)|The connection to (?:the model provider|\S+) |The conversation is too long |This conversation \(including attachments\)|This conversation is too long |The request (?:was too large|failed)|Your custom model endpoint |The local model server |A firewall/CDN |Hermes (?:hit an internal error|could not start the assistant|couldn't shrink)|Could not reopen that session|Session storage (?:is unavailable|could not be written)|The disk is full|History changed during this turn|I ran out of steps for this turn|[^\n]{1,100} didn't produce a reply this time)"


def failure_text(text):
    """Replace only known failure templates, never arbitrary replies mentioning commands."""
    value = str(text or "").strip()
    if not re.search(FAILURE, value):
        return value
    lower = value.lower()
    if any(x in lower for x in ("not saved", "could not save", "storage", "disk is full")):
        return "Your message or reply could not be saved. The person who manages this setup needs to check it before you continue."
    if any(x in lower for x in ("too long", "too large", "shrink")):
        return "This chat is too long to continue. Start a new chat using the menu; your existing chat stays available."
    if any(x in lower for x in ("api key", "credentials", "no credit", "account policy", "could not start", "model_not_found")):
        return "The assistant is unavailable because of a setup or account problem. The person who manages this setup needs to check it."
    if "ran out of steps" in lower:
        return "The work stopped before it finished. Send “continue” to keep going."
    if "content policy" in lower or "refused this request" in lower:
        return "This request could not be answered. Try rephrasing it."
    return "The assistant could not finish this reply. Wait a moment and send your message again. If it keeps happening, the person who manages this setup needs to check it."


def display_text(text, *, notice=False):
    value = str(text or "").strip()
    if notice and re.search(NOTICE, value, re.I):
        return ""
    # Exact legacy boilerplate only; fenced examples and quoted documentation survive.
    parts = re.split(r"\n\s*\n", value)
    result = []
    fenced = False
    for part in parts:
        if not fenced and (re.fullmatch(INTRO, " ".join(part.split())) or
                           (notice and re.search(r"^\W{0,4}First-time tip\s*[—-]", part, re.I))):
            continue
        result.append(part)
        if len(re.findall(r"(?m)^\s*(?:```|~~~)", part)) % 2:
            fenced = not fenced
    return failure_text("\n\n".join(result))
