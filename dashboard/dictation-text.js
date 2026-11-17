// Where dictated text goes into the message box, with the spaces a keyboard would add. Pure: no page.
//
// Before: a space when the text before the caret ends in a word or closing punctuation, never at the start of the
// box, after whitespace or an opening bracket or quote, and never before dictated text that starts with punctuation.
// After: always a space, so typing or dictating again just continues, unless the text after the caret already
// starts with whitespace or closing punctuation. A trailing space at the very end is trimmed when the message is sent.

const OPENERS = "([{<«“‘";
const CLOSING_START = /^[.,!?;:…)\]}>»”’%]/;

function opensSomething(before) {
  const last = before.slice(-1);
  if (OPENERS.includes(last)) return true;
  // A straight quote opens when it starts the box or follows whitespace or an opener: `say "` vs `said."`.
  if (last === '"' || last === "'") {
    const prev = before.slice(-2, -1);
    return prev === "" || /\s/.test(prev) || OPENERS.includes(prev);
  }
  return false;
}

// A straight quote right after the caret closes when what follows it is the end, whitespace or punctuation.
function closesQuote(after) {
  return /^["'](?:$|[\s.,!?;:…)\]}])/.test(after);
}

/** The text to insert at the caret: {text, caret} where caret is the offset in that text to put the caret at. */
export function dictationInsert(before, spoken, after) {
  const words = String(spoken || "").trim();
  if (!words) return { text: "", caret: 0 };
  const lead = before && !/\s$/.test(before) && !opensSomething(before) && !CLOSING_START.test(words) ? " " : "";
  const tail = after && (/^\s/.test(after) || CLOSING_START.test(after) || closesQuote(after)) ? "" : " ";
  const text = lead + words + tail;
  return { text, caret: text.length };
}
