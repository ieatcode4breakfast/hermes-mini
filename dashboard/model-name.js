// Friendly model names: "deepseek/deepseek-v4.1-flash" -> "DeepSeek v4.1 Flash". Hermes sends models only as ids
// (model.options, session.info), so the name is derived here, ported from Hermes's desktop app
// (apps/desktop/src/lib/model-status-label.ts: modelDisplayParts / displayModelName) so both read the same.
// One difference: a version written "v<number>" keeps its lowercase v ("v4.1", not "V4.1").
// Display only: the id is what is sent, saved and compared.

// Trailing variants that read as a word after the name, so look-alike ids never collapse to one name.
const VARIANT_TAGS = [
  [/-fast$/i, "Fast"],
  [/-flash$/i, "Flash"],
  [/-thinking$/i, "Thinking"],
  [/-preview$/i, "Preview"],
  [/-latest$/i, "Latest"],
];

// Vendors spell their names in a casing the id does not carry; applied to whole words after title-casing.
const VENDOR_CASING = [
  [/\bDeepseek\b/g, "DeepSeek"],
  [/\bGlm\b/g, "GLM"],
  [/\bMinimax\b/g, "MiniMax"],
  [/\bOpenai\b/g, "OpenAI"],
  [/\bErnie\b/g, "ERNIE"],
  [/\bMimo\b/g, "MiMo"],
  [/\bBge\b/g, "BGE"],
  [/\bVl\b/g, "VL"],
  [/\bIt\b/g, "IT"],
  [/\bFp8\b/g, "FP8"],
  [/\bAi\b/g, "AI"],
];

// Parameter counts: vendors write 8B, 235B, A22B, never 8b.
const PARAMETER_COUNT = /\b(a?)(\d+(?:\.\d+)?)b\b/gi;

const titleCase = (text) => text.replace(/\b\w/g, (char) => char.toUpperCase()).trim();

function applyVendorCasing(text) {
  let cased = text.replace(PARAMETER_COUNT, (_match, prefix, size) => `${prefix.toUpperCase()}${size}B`);
  for (const [pattern, replacement] of VENDOR_CASING) cased = cased.replace(pattern, replacement);
  return cased.replace(/\bV(?=\d)/g, "v"); // "V4.1" -> "v4.1"
}

function prettifyBase(base) {
  if (/^claude-/i.test(base)) {
    // Anthropic ids spell the version with hyphens ("haiku-4-5"); the name is dotted ("Haiku 4.5").
    return applyVendorCasing(titleCase(base.replace(/^claude-/i, "").replace(/(\d)-(?=\d)/g, "$1.").replace(/-/g, " ")));
  }
  if (/^gpt-/i.test(base)) return base.replace(/^gpt-/i, "GPT-");
  if (/^gemini-/i.test(base)) return applyVendorCasing(titleCase(base.replace(/^gemini-/i, "Gemini ").replace(/-/g, " ")));
  return applyVendorCasing(titleCase(base.replace(/-/g, " ")));
}

// A variant tag and a GGUF quant ("-UD-Q4_K_XL", "-Q8_0") can trail in either order.
function splitTrailingTags(base) {
  let variant = "";
  let quant = "";
  for (let progress = true; progress; ) {
    progress = false;
    if (!variant) {
      for (const [pattern, label] of VARIANT_TAGS) {
        if (pattern.test(base)) {
          variant = label;
          base = base.replace(pattern, "");
          progress = true;
          break;
        }
      }
    }
    if (!quant) {
      const hit = base.match(/-(?:UD-)?(Q\d(?:_[A-Z0-9]+)*|IQ\d(?:_[A-Z0-9]+)*|F16|BF16)$/i);
      if (hit) {
        quant = hit[1].split("_")[0].toUpperCase();
        base = base.slice(0, -hit[0].length).replace(/-(?:Instruct|Chat)(?:-\d{4})?$/i, "");
        progress = true;
      }
    }
  }
  return { base, variant, quant };
}

// The id without its "provider/" prefix.
export function modelBaseId(model) {
  const id = String(model || "").trim();
  return id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
}

export function displayModelName(model) {
  const id = String(model || "").trim();
  if (!id) return "";
  let { base, variant, quant } = splitTrailingTags(modelBaseId(id));
  const tags = [variant, quant].filter(Boolean);
  // Anthropic's "[1m]" route suffix (the 1M-context window) reads as a tag, not raw brackets.
  const contextWindow = base.match(/\[(\d+[mk])\]$/i);
  if (contextWindow) {
    tags.push(contextWindow[1].toUpperCase());
    base = base.slice(0, -contextWindow[0].length);
  }
  base = base.replace(/-\d{8}$/, ""); // a date pin is snapshot noise, not a name
  const name = prettifyBase(base) || id;
  return tags.length ? `${name} ${tags.join(" ")}` : name;
}
