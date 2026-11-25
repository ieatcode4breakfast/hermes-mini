// Activity tree live narrator and history renderer: groups rapid/parallel tool waves per subject into
// a collapsible outline above each reply (starting a fresh tree after any interim message).

const ACTIVITY_API = "/api/plugins/hermes-mini/activity";
const NARRATE_API = "/api/plugins/hermes-mini/narrate";
const SETTLE_MS = 1500;
const MIN_GAP_MS = 4000;
const QUIET_POLL_MS = 25000;
const MAX_EVENTS = 12;
const MAX_PREVIOUS = 20;
const MAX_STEP_IMAGES = 8;
const MAX_IMAGE_REF_CHARS = 500;
const MAX_STEP_URLS = 8;
const MAX_URL_CHARS = 500;
const MATCH_CHARS = 160;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif|bmp|avif|svg|ico|tiff?)(?:$|[?#])/i;
const URL_IGNORED_TOOLS = new Set(["web_search", "x_search", "vision_analyze", "session_search", "search_files", "image_generate"]);
const FETCH_HINT_RE = /\b(?:curl|wget|fetch|urlopen|urlretrieve|urllib|requests\.(?:get|post|head|request|Session)|httpx\.(?:get|post|head|request|Client|AsyncClient)|aiohttp|http\.client|read_html|read_csv|read_excel|read_json|web_extract|goto_url|new_tab)\b/i;
const WIKI_RAW_HOST_RE = /\.(?:wikipedia|wikimedia|wiktionary|wikisource|wikibooks)\.org$/i;
const SEARCH_API_HOSTS = new Set(["api.search.brave.com", "api.tavily.com", "api.exa.ai", "api.firecrawl.dev", "api.perplexity.ai", "serpapi.com", "search.yahoo.com"]);
const PACKAGE_MIRROR_HOSTS = new Set(["pypi.org", "files.pythonhosted.org", "registry.npmjs.org", "archive.ubuntu.com", "security.ubuntu.com", "deb.debian.org"]);
const CHEVRON_SVG = '<svg class="activity-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>';
const LINK_ICON_SVG = '<svg class="activity-url-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.8 9.2a3.2 3.2 0 0 0 4.5.1l1.8-1.8a3.2 3.2 0 0 0-4.5-4.5L7.5 4.1"/><path d="M9.2 6.8a3.2 3.2 0 0 0-4.5-.1L2.9 8.5a3.2 3.2 0 0 0 4.5 4.5l1.1-1.1"/></svg>';
const STOP_ICON_SVG = '<svg class="activity-stopped-icon" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><line x1="3.8" y1="3.8" x2="12.2" y2="12.2"/></svg>';

let treeSeq = 0;

export function normalizeMatch(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, MATCH_CHARS);
}

function normStepKey(text) {
  return String(text || "").replace(/\s+/g, " ").trim().replace(/[.\u2026,]+$/, "").toLowerCase();
}

export function cleanImageRef(raw) {
  if (typeof raw !== "string") return null;
  let ref = raw.trim();
  if (!ref || ref.length > MAX_IMAGE_REF_CHARS || /[\s\x00-\x1f]/.test(ref)) return null;
  if (ref.startsWith("file://")) ref = ref.slice(7);
  if (ref.startsWith("https://")) {
    if (/[{}]/.test(ref)) return null;
    let parsed;
    try {
      parsed = new URL(ref);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    if (isPrivateHost(parsed.hostname)) return null;
    return ref;
  }
  if ((ref.startsWith("/") || ref.startsWith("~/")) && IMAGE_EXT_RE.test(ref)) return ref;
  return null;
}

export function extractToolImages(payload) {
  if (!payload || typeof payload !== "object") return [];
  const args = payload.args && typeof payload.args === "object" ? payload.args : {};
  const result = payload.result && typeof payload.result === "object" ? payload.result : {};
  const meta = result.meta && typeof result.meta === "object" ? result.meta : {};
  const candidates = [
    payload.image_path,
    args.image_path,
    args.image_url,
    result.image_path,
    result.screenshot_path,
    result.image,
    meta.image_path,
    meta.screenshot_path,
    ...(Array.isArray(result.images) ? result.images : []),
  ];
  const out = [];
  for (const item of candidates) {
    const clean = cleanImageRef(item);
    if (clean && !out.includes(clean)) {
      out.push(clean);
      if (out.length >= MAX_STEP_IMAGES) break;
    }
  }
  return out;
}

function isPrivateHost(hostname) {
  let host = String(hostname || "").toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host.includes(":")) {
    const bare = host.split("%")[0];
    return (
      bare === "::1"
      || bare === "::"
      || bare.startsWith("fe80:")
      || bare.startsWith("fc")
      || bare.startsWith("fd")
      || bare.startsWith("::ffff:127.")
      || bare.startsWith("::ffff:10.")
      || bare.startsWith("::ffff:192.168.")
    );
  }
  if (/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)) return true;
  if (!host.includes(".")) return true;
  return false;
}

function isNoisyOpenedUrl(parsed) {
  const h = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (SEARCH_API_HOSTS.has(h) || PACKAGE_MIRROR_HOSTS.has(h)) return true;
  if ((/(?:^|\.)google\.[a-z.]+$/i.test(h) || /(?:^|\.)bing\.com$/i.test(h)) && /^\/search(?:\/|$)/i.test(parsed.pathname)) {
    return true;
  }
  if (/(?:^|\.)duckduckgo\.com$/i.test(h) && (parsed.searchParams.has("q") || /^\/(?:html|lite)(?:\/|$)/i.test(parsed.pathname))) {
    return true;
  }
  return false;
}

export function cleanOpenedUrl(raw) {
  if (typeof raw !== "string") return null;
  let ref = raw.trim();
  if (!ref || ref.length > MAX_URL_CHARS || /[\s\x00-\x1f{}]/.test(ref)) return null;
  let parsed;
  try {
    parsed = new URL(ref);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password) return null;
  if (isPrivateHost(parsed.hostname)) return null;
  if (
    WIKI_RAW_HOST_RE.test(parsed.hostname)
    && /\/w\/index\.php$/i.test(parsed.pathname)
    && (parsed.searchParams.get("action") || "").toLowerCase() === "raw"
  ) {
    const title = (parsed.searchParams.get("title") || "").trim();
    if (!title || /[\s\x00-\x1f{}]/.test(title)) return null;
    ref = `https://${parsed.hostname}/wiki/${encodeURIComponent(title.replace(/ /g, "_")).replace(/%2F/gi, "/").replace(/%3A/gi, ":")}`;
    if (ref.length > MAX_URL_CHARS) return null;
    try {
      parsed = new URL(ref);
    } catch {
      return null;
    }
  }
  if (IMAGE_EXT_RE.test(parsed.pathname)) return null;
  if (/\/api\.php$/i.test(parsed.pathname) || /(?:^|&)action=raw(?:&|$)/i.test(parsed.search.slice(1))) {
    return null;
  }
  if (isNoisyOpenedUrl(parsed)) return null;
  return ref;
}

export function formatUrlLabel(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    const s = String(raw || "");
    return s.length > 120 ? `${s.slice(0, 119)}\u2026` : s;
  }
  const host = parsed.hostname.replace(/^www\./i, "");
  let decodedPath = parsed.pathname || "";
  try {
    decodedPath = decodeURIComponent(decodedPath);
  } catch {
    /* keep raw pathname if percent-encoding is malformed */
  }
  if (decodedPath.length > 1) decodedPath = decodedPath.replace(/\/+$/, "");
  const pathPart = decodedPath && decodedPath !== "/" ? decodedPath : "";
  const combined = `${host}${pathPart}${parsed.search || ""}`;
  return combined.length > 120 ? `${combined.slice(0, 119)}\u2026` : combined;
}

function extractCallArgSlices(code, callRegex) {
  const src = String(code || "");
  const slices = [];
  const re = new RegExp(callRegex.source, callRegex.flags.includes("g") ? callRegex.flags : `${callRegex.flags}g`);
  let match;
  while ((match = re.exec(src)) !== null) {
    let i = match.index + match[0].length;
    const argStart = i;
    let depth = 1;
    let quote = "";
    let triple = false;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (quote) {
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (triple) {
          if (src.slice(i, i + 3) === quote.repeat(3)) {
            quote = "";
            triple = false;
            i += 3;
            continue;
          }
        } else if (ch === quote) {
          quote = "";
        }
        i += 1;
        continue;
      }
      if ((ch === "'" || ch === '"') && src.slice(i, i + 3) === ch.repeat(3)) {
        quote = ch;
        triple = true;
        i += 3;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        triple = false;
        i += 1;
        continue;
      }
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      i += 1;
    }
    if (depth === 0) {
      slices.push(src.slice(argStart, i - 1));
    }
  }
  return slices;
}

function extractQuotedUrlsFromSnippet(snippet) {
  const out = [];
  const text = String(snippet || "");
  const re = /(["'])(https?:\/\/[^"'\r\n\\]+)\1/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m[2]);
  }
  return out;
}

function extractWebExtractUrlsFromCode(code) {
  const src = String(code || "");
  const out = [];
  const slices = extractCallArgSlices(src, /\bweb_extract\s*\(/g);
  for (const slice of slices) {
    out.push(...extractQuotedUrlsFromSnippet(slice));
    const posMatch = slice.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,|$)/);
    const kwMatch = slice.match(/(?:^|,)\s*urls\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,|$)/);
    const varName = (kwMatch && kwMatch[1]) || (posMatch && posMatch[1]);
    if (varName) {
      const assignRe = new RegExp(
        `(?:^|[\\n;])\\s*${varName}\\s*=\\s*(\\[[\\s\\S]*?\\]|\\([\\s\\S]*?\\)|["']https?:\\/\\/[^"'\\r\\n]+["'])`,
        "gm",
      );
      let am;
      while ((am = assignRe.exec(src)) !== null) {
        out.push(...extractQuotedUrlsFromSnippet(am[1]));
      }
    }
  }
  return out;
}

function stripCallArgSpans(code, callRegex) {
  const src = String(code || "");
  let out = "";
  let lastEnd = 0;
  const re = new RegExp(callRegex.source, callRegex.flags.includes("g") ? callRegex.flags : `${callRegex.flags}g`);
  let match;
  while ((match = re.exec(src)) !== null) {
    if (match.index < lastEnd) continue;
    let i = match.index + match[0].length;
    let depth = 1;
    let quote = "";
    let triple = false;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (quote) {
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (triple) {
          if (src.slice(i, i + 3) === quote.repeat(3)) {
            quote = "";
            triple = false;
            i += 3;
            continue;
          }
        } else if (ch === quote) {
          quote = "";
        }
        i += 1;
        continue;
      }
      if ((ch === "'" || ch === '"') && src.slice(i, i + 3) === ch.repeat(3)) {
        quote = ch;
        triple = true;
        i += 3;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        triple = false;
        i += 1;
        continue;
      }
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      i += 1;
    }
    if (depth === 0) {
      out += src.slice(lastEnd, match.index) + " ";
      lastEnd = i;
      re.lastIndex = i;
    }
  }
  return out + src.slice(lastEnd);
}

function trimBalancedUrl(raw) {
  let u = String(raw || "").replace(/[,;:.!?'"\\]+$/, "");
  while (true) {
    const opens = (u.match(/\(/g) || []).length;
    const closes = (u.match(/\)/g) || []).length;
    if (u.endsWith(")") && closes > opens) {
      u = u.slice(0, -1);
      continue;
    }
    const bOpens = (u.match(/\[/g) || []).length;
    const bCloses = (u.match(/\]/g) || []).length;
    if (u.endsWith("]") && bCloses > bOpens) {
      u = u.slice(0, -1);
      continue;
    }
    break;
  }
  return u.replace(/[,;:.!?'"\\]+$/, "");
}

function extractFetchUrlsFromText(text) {
  if (typeof text !== "string" || !FETCH_HINT_RE.test(text)) return [];
  let cleaned = stripCallArgSpans(text, /\b(?:web_search|x_search|print|console\.log|warnings\.warn|logging\.(?:debug|info|warning|error))\s*\(/g);
  cleaned = cleaned.replace(/^[ \t]*#.*$/gm, " ");
  cleaned = cleaned.replace(/(?:^|;|&&|\|\|)[ \t]*echo\b[^;&\n]*/gi, " ");
  cleaned = cleaned.replace(/(?:^|\s)(?:-A|--user-agent)(?:\s+|=)(["'])[^\n]*?\1/gi, " ");
  cleaned = cleaned.replace(/user-agent(["']?)\s*[:=]\s*(["'])[^\n]*?\2/gi, " ");
  if (!FETCH_HINT_RE.test(cleaned)) return [];
  const out = [];
  const re = /https?:\/\/[^\s"'`<>\\]+/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const candidate = trimBalancedUrl(m[0]);
    if (candidate) out.push(candidate);
  }
  return out;
}

export function extractToolUrls(payload) {
  if (!payload || typeof payload !== "object") return [];
  const name = String(payload.name || "").trim().toLowerCase();
  if (URL_IGNORED_TOOLS.has(name)) return [];
  const args = payload.args && typeof payload.args === "object" ? payload.args : {};
  const result = payload.result && typeof payload.result === "object" ? payload.result : {};
  const meta = result.meta && typeof result.meta === "object" ? result.meta : {};
  const candidates = [];
  if (name === "web_extract" || name === "web_fetch" || name === "fetch_url") {
    candidates.push(
      args.url,
      ...(Array.isArray(args.urls) ? args.urls : []),
      result.url,
      ...(Array.isArray(result.results) ? result.results.map((r) => (r && typeof r === "object" ? r.url : null)) : []),
    );
  } else if (name === "browser_exec") {
    if (typeof args.code === "string") {
      for (const slice of extractCallArgSlices(args.code, /\b(?:goto_url|new_tab|open_url|navigate)\s*\(/g)) {
        candidates.push(...extractQuotedUrlsFromSnippet(slice));
      }
    }
    candidates.push(args.url, result.url, meta.url);
  } else if (name === "browser_cdp") {
    const method = String(args.method || "").trim();
    if (!method || method === "Page.navigate" || method === "Target.createTarget") {
      candidates.push(args.url, args.params && typeof args.params === "object" ? args.params.url : null, result.url);
    }
  } else if (name === "browser_navigate" || name === "browser_open") {
    candidates.push(args.url, ...(Array.isArray(args.urls) ? args.urls : []), result.url);
  } else if (name === "terminal") {
    if (typeof args.command === "string") {
      candidates.push(...extractFetchUrlsFromText(args.command));
    }
  } else if (name === "execute_code") {
    if (typeof args.code === "string") {
      candidates.push(...extractWebExtractUrlsFromCode(args.code));
      candidates.push(...extractFetchUrlsFromText(args.code));
    }
  }
  const imageRefs = new Set(extractToolImages(payload));
  const out = [];
  for (const item of candidates) {
    const clean = cleanOpenedUrl(item);
    if (clean && !imageRefs.has(clean) && !out.includes(clean)) {
      out.push(clean);
      if (out.length >= MAX_STEP_URLS) break;
    }
  }
  return out;
}

function mergeList(target, incoming, maxItems) {
  let added = false;
  for (const ref of incoming || []) {
    if (ref && !target.includes(ref) && target.length < maxItems) {
      target.push(ref);
      added = true;
    }
  }
  return added;
}

function cleanPlaceholder(label) {
  return String(label || "").replace(/\s+/g, " ").trim().replace(/(\.\.\.|\u2026|\.)$/, "").trim();
}

function matchPrefixScore(haystack, needle) {
  if (!haystack || !needle) return false;
  return haystack.startsWith(needle) || needle.startsWith(haystack);
}

function timestampDistance(tree, entryTs) {
  const ref = Number(tree.ended_at) || Number(tree.started_at) || 0;
  if (!ref || !entryTs) return 0;
  return Math.abs(entryTs - ref);
}

export function matchTreesToEntries(trees, entries, renderedIds = new Set(), { isOldestPage = false } = {}) {
  const before = new Map();
  const after = new Map();
  if (!Array.isArray(trees) || !Array.isArray(entries) || !entries.length) {
    return { before, after };
  }
  let minEntryTs = 0;
  for (const e of entries) {
    const ts = Number(e?.ts) || 0;
    if (ts > 0 && (!minEntryTs || ts < minEntryTs)) minEntryTs = ts;
  }

  const pushAt = (map, idx, tree) => {
    const list = map.get(idx);
    if (list) list.push(tree);
    else map.set(idx, [tree]);
  };

  const pickBestIndex = (candidates, tree) => {
    if (!candidates.length) return -1;
    let best = candidates[0];
    let bestDist = timestampDistance(tree, Number(entries[best]?.ts) || 0);
    for (let i = 1; i < candidates.length; i += 1) {
      const idx = candidates[i];
      const dist = timestampDistance(tree, Number(entries[idx]?.ts) || 0);
      if (dist < bestDist) {
        best = idx;
        bestDist = dist;
      }
    }
    return best;
  };

  const findAfterIndex = (tree) => {
    if (Number.isInteger(tree.anchor_after_id) && tree.anchor_after_id > 0) {
      const idx = entries.findIndex((e) => e.rowId === tree.anchor_after_id);
      if (idx !== -1) return idx;
    }
    if (tree.anchor_after_match) {
      const needle = normalizeMatch(tree.anchor_after_match);
      const matches = [];
      for (let i = 0; i < entries.length; i += 1) {
        const e = entries[i];
        const dist = timestampDistance(tree, Number(e.ts) || 0);
        if (tree.started_at && e.ts && dist > 1800) continue;
        if (matchPrefixScore(normalizeMatch(e.text), needle)) matches.push(i);
      }
      return pickBestIndex(matches, tree);
    }
    return -1;
  };

  for (const tree of trees) {
    if (!tree || !tree.id || renderedIds.has(tree.id)) continue;
    const hasSteps = Array.isArray(tree.steps) && tree.steps.length > 0;
    if (!hasSteps && !tree.title && tree.status !== "stopped") continue;
    if (tree.status === "running") {
      const afterIdx = findAfterIndex(tree);
      let replyIdx = -1;
      if (afterIdx !== -1) {
        for (let i = afterIdx + 1; i < entries.length; i += 1) {
          if (entries[i].role === "user") break;
          if (entries[i].role === "assistant") {
            replyIdx = i;
            break;
          }
        }
      } else if (tree.started_at > 0) {
        for (let i = 0; i < entries.length; i += 1) {
          const e = entries[i];
          const ets = Number(e.ts) || 0;
          if (ets && ets < tree.started_at - 2) continue;
          if (e.role === "user" && ets && ets > tree.started_at + 2) break;
          if (e.role === "assistant" && (!ets || ets <= tree.started_at + 1800)) {
            replyIdx = i;
            break;
          }
        }
      }
      if (replyIdx !== -1) {
        pushAt(before, replyIdx, {
          ...tree,
          status: "done",
          ended_at: tree.ended_at || Number(entries[replyIdx].ts) || tree.started_at,
        });
        renderedIds.add(tree.id);
      }
      continue;
    }

    let placed = false;

    // 1. Place before the assistant reply produced by this tree when any reply exists.
    const wantsBefore = Boolean(tree.anchor_before_id || tree.anchor_before_match || tree.status === "done");
    if (wantsBefore) {
      if (Number.isInteger(tree.anchor_before_id) && tree.anchor_before_id > 0) {
        const idx = entries.findIndex((e) => e.role === "assistant" && e.rowId === tree.anchor_before_id);
        if (idx !== -1) {
          pushAt(before, idx, tree);
          renderedIds.add(tree.id);
          placed = true;
        }
      }
      if (!placed && tree.anchor_before_match) {
        const needle = normalizeMatch(tree.anchor_before_match);
        const matches = [];
        for (let i = 0; i < entries.length; i += 1) {
          const e = entries[i];
          if (e.role !== "assistant") continue;
          const dist = timestampDistance(tree, Number(e.ts) || 0);
          if (tree.started_at && e.ts && dist > 1800) continue;
          if (matchPrefixScore(normalizeMatch(e.text), needle)) matches.push(i);
        }
        const best = pickBestIndex(matches, tree);
        if (best !== -1) {
          pushAt(before, best, tree);
          renderedIds.add(tree.id);
          placed = true;
        }
      }
      if (!placed && tree.status === "done" && !tree.anchor_before_id && !tree.anchor_before_match && tree.started_at > 0) {
        const afterIdx = findAfterIndex(tree);
        const maxTs = Math.max((tree.ended_at || tree.started_at) + 120, tree.started_at + 1800);
        let idx = -1;
        if (afterIdx !== -1) {
          for (let i = afterIdx + 1; i < entries.length; i += 1) {
            const e = entries[i];
            if (e.role === "user") break;
            const ets = Number(e.ts) || 0;
            if (e.role === "assistant" && (!ets || ets <= maxTs)) {
              idx = i;
              break;
            }
          }
        } else if (!tree.anchor_after_id && !tree.anchor_after_match) {
          for (let i = 0; i < entries.length; i += 1) {
            const e = entries[i];
            const ets = Number(e.ts) || 0;
            if (ets && ets < tree.started_at - 2) continue;
            if (e.role === "user" && ets && ets > tree.started_at + 2) break;
            if (e.role === "assistant" && ets && ets <= maxTs) {
              idx = i;
              break;
            }
          }
        }
        if (idx !== -1) {
          pushAt(before, idx, tree);
          renderedIds.add(tree.id);
          placed = true;
        }
      }
    }

    if (placed) continue;

    // 2. Place after the preceding bubble (typical for stopped runs with no following assistant reply).
    const afterIdx = findAfterIndex(tree);
    if (afterIdx !== -1) {
      pushAt(after, afterIdx, tree);
      renderedIds.add(tree.id);
      placed = true;
    }
    if (!placed && tree.status === "stopped") {
      const ref = Number(tree.started_at) || 0;
      if (ref > 0 && minEntryTs > 0 && ref < minEntryTs - 2) {
        if (isOldestPage) {
          pushAt(before, 0, tree);
          renderedIds.add(tree.id);
        }
        continue;
      }
      let idx = -1;
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const ts = Number(entries[i].ts) || 0;
        if (!ref || !ts || ts <= ref + 2) {
          idx = i;
          break;
        }
      }
      if (idx !== -1) {
        pushAt(after, idx, tree);
        renderedIds.add(tree.id);
      } else if (isOldestPage) {
        pushAt(before, 0, tree);
        renderedIds.add(tree.id);
      }
    }
  }

  return { before, after };
}

export function createActivity(deps = {}) {
  const {
    el: makeEl,
    logEl,
    api,
    displayText = (t) => String(t || ""),
    nearBottom = () => false,
    scrollToBottom = () => {},
    getStoredId = () => null,
    resolveRowId = async () => null,
    fetchMedia = null,
    openViewer = null,
    formatTime = () => "",
    isHidden = () => (typeof document !== "undefined" ? Boolean(document.hidden) : false),
    nowMs = () => Date.now(),
    perfNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  } = deps;

  let currentRequest = "";
  let currentTurnId = null;
  let active = null;
  let pendingAnchorTree = null;
  let sessionCache = new Map();
  let renderedIds = new Set();
  const saveQueues = new Map();
  const sessionEpoch = new Map();
  const cancelledTreeIds = new Set();

  function markTreeCancelled(id) {
    if (!id) return;
    if (cancelledTreeIds.size > 500) {
      const oldest = cancelledTreeIds.values().next().value;
      cancelledTreeIds.delete(oldest);
    }
    cancelledTreeIds.add(id);
  }

  function isTreeCancelled(tree, sid) {
    if (!tree || !tree.id || !sid) return true;
    if (cancelledTreeIds.has(tree.id)) return true;
    return tree.saveEpoch !== undefined && tree.saveEpoch !== (sessionEpoch.get(sid) || 0);
  }

  function createElNode(tag, className, text) {
    if (makeEl) return makeEl(tag, className, text);
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clearTimer(tree) {
    if (tree && tree.timer) {
      clearTimeout(tree.timer);
      tree.timer = 0;
    }
  }

  function safeArgs(args) {
    if (!args || typeof args !== "object") return String(args || "").slice(0, 200);
    try {
      return JSON.stringify(args).slice(0, 200);
    } catch {
      return "";
    }
  }

  function serialize(tree) {
    const cleanBefore = tree.anchorBeforeMatch ? normalizeMatch(tree.anchorBeforeMatch) : "";
    const cleanAfter = tree.anchorAfterMatch ? normalizeMatch(tree.anchorAfterMatch) : "";
    return {
      id: tree.id,
      turn_id: tree.turnId || "",
      title: String(tree.title || "").slice(0, 160),
      steps: Array.isArray(tree.steps) ? tree.steps.slice(0, 60).map((s) => String(s).slice(0, 160)) : [],
      step_images: Array.isArray(tree.stepImages)
        ? tree.stepImages.slice(0, 60).map((list) => (Array.isArray(list) ? list.slice(0, MAX_STEP_IMAGES) : []))
        : [],
      step_urls: Array.isArray(tree.stepUrls)
        ? tree.stepUrls.slice(0, 60).map((list) => (Array.isArray(list) ? list.slice(0, MAX_STEP_URLS) : []))
        : [],
      status: tree.status,
      started_at: Number(tree.startedAt) || 0,
      ended_at: Number(tree.endedAt) || 0,
      anchor_before_id: Number.isInteger(tree.anchorBeforeId) && tree.anchorBeforeId > 0 ? tree.anchorBeforeId : null,
      anchor_before_match: cleanBefore,
      anchor_after_id: Number.isInteger(tree.anchorAfterId) && tree.anchorAfterId > 0 ? tree.anchorAfterId : null,
      anchor_after_match: cleanAfter,
    };
  }

  function saveTree(tree) {
    const sid = (tree && tree.sid) || getStoredId();
    if (!sid || !api || !tree || !tree.id) return Promise.resolve();
    if (!tree.sid) tree.sid = sid;
    if (tree.saveEpoch === undefined) tree.saveEpoch = sessionEpoch.get(sid) || 0;
    if (isTreeCancelled(tree, sid)) return Promise.resolve();
    if (!tree.steps.length && !tree.title && tree.status !== "stopped") return Promise.resolve();
    const payload = serialize(tree);
    updateCacheRecord(sid, payload);
    const key = `${sid}\0${tree.id}`;
    const entry = saveQueues.get(key) || { pending: null, tree: null, inflight: null };
    entry.pending = payload;
    entry.tree = tree;
    saveQueues.set(key, entry);
    if (entry.inflight) return entry.inflight;
    // One PUT at a time per tree: a later save coalesces into the next turn of the loop instead of racing it, so an
    // older "running" payload can never land after the newer "done" one and re-open a finished outline.
    entry.inflight = (async () => {
      try {
        while (entry.pending) {
          const body = entry.pending;
          entry.pending = null;
          if (isTreeCancelled(entry.tree, sid)) break;
          try {
            await api(`${ACTIVITY_API}/${encodeURIComponent(sid)}/${encodeURIComponent(tree.id)}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify(body),
            });
          } catch {
            /* activity persistence is best-effort and must never break a chat */
          }
        }
      } finally {
        entry.inflight = null;
        if (!entry.pending) saveQueues.delete(key);
      }
    })();
    return entry.inflight;
  }

  function updateCacheRecord(sid, record) {
    if (!sid || !record || !record.id) return;
    const list = sessionCache.get(sid) || [];
    const idx = list.findIndex((t) => t.id === record.id);
    if (idx >= 0) list[idx] = record;
    else list.push(record);
    sessionCache.set(sid, list);
  }

  function buildTreeDOM(tree) {
    const root = createElNode("div", "activity-tree");
    root.dataset.treeId = tree.id;

    const headBtn = createElNode("button", "activity-head");
    headBtn.type = "button";
    const typingEl = createElNode("span", "typing activity-typing");
    typingEl.setAttribute("aria-hidden", "true");
    typingEl.append(createElNode("i"), createElNode("i"), createElNode("i"));
    const headTextEl = createElNode("span", "activity-head-text");
    headBtn.append(typingEl, headTextEl);
    headBtn.insertAdjacentHTML("beforeend", CHEVRON_SVG);

    const bodyEl = createElNode("div", "activity-body");
    const stepsEl = createElNode("div", "activity-steps");
    bodyEl.append(stepsEl);

    const stoppedEl = createElNode("div", "activity-stopped");
    stoppedEl.insertAdjacentHTML("beforeend", STOP_ICON_SVG);
    const stopLabel = createElNode("span", "", "Stopped");
    stoppedEl.append(stopLabel);
    stoppedEl.hidden = true;
    bodyEl.append(stoppedEl);

    const stoppedNoteEl = createElNode("div", "activity-stopped-note", "You stopped this response");
    stoppedNoteEl.hidden = true;

    root.append(headBtn, bodyEl, stoppedNoteEl);

    headBtn.addEventListener("click", () => {
      tree.collapsed = !tree.collapsed;
      renderTreeDOM(tree);
    });

    tree.el = root;
    tree.headBtn = headBtn;
    tree.typingEl = typingEl;
    tree.headTextEl = headTextEl;
    tree.bodyEl = bodyEl;
    tree.stepsEl = stepsEl;
    tree.stoppedEl = stoppedEl;
    tree.stoppedNoteEl = stoppedNoteEl;
    renderTreeDOM(tree);
    return root;
  }

  function renderTreeDOM(tree) {
    if (!tree || !tree.el) return;
    tree.el.dataset.status = tree.status;
    tree.el.classList.toggle("collapsed", Boolean(tree.collapsed));
    tree.headBtn.setAttribute("aria-expanded", tree.collapsed ? "false" : "true");

    const running = tree.status === "running";
    const displaySteps = tree.steps.length ? tree.steps : (tree.placeholder ? [tree.placeholder] : []);
    const activeStepText = displaySteps.length ? displaySteps[displaySteps.length - 1] : "";

    let headLabel = "";
    let headShimmer = false;
    if (tree.collapsed && running) {
      headLabel = activeStepText || tree.title || "Working";
      headShimmer = Boolean(headLabel);
    } else if (tree.collapsed) {
      headLabel = tree.title || displaySteps[0] || "Activity";
    } else {
      headLabel = tree.title || (displaySteps.length ? "Working on your request" : "Working");
    }

    if (tree.typingEl) tree.typingEl.hidden = !running;
    tree.headTextEl.textContent = headLabel;
    tree.headTextEl.classList.toggle("narration", headShimmer);
    tree.headTextEl.classList.toggle("is-shimmer", headShimmer);

    tree.bodyEl.hidden = Boolean(tree.collapsed);

    tree.renderGen = (tree.renderGen || 0) + 1;
    const renderGen = tree.renderGen;
    tree.stepsEl.textContent = "";
    for (let i = 0; i < displaySteps.length; i += 1) {
      const itemEl = createElNode("div", "activity-step-item");
      const stepEl = createElNode("div", "activity-step", displaySteps[i]);
      const isLast = i === displaySteps.length - 1;
      if (running && isLast) stepEl.classList.add("is-active", "narration");
      itemEl.append(stepEl);
      const urls = tree.steps.length
        ? (Array.isArray(tree.stepUrls?.[i]) ? tree.stepUrls[i] : [])
        : (tree.pendingUrls || []);
      if (urls.length && !tree.collapsed) {
        const urlsEl = createElNode("div", "activity-urls");
        for (const href of urls) {
          const link = createElNode("a", "activity-url");
          link.href = href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.title = href;
          link.innerHTML = LINK_ICON_SVG;
          link.append(createElNode("span", "activity-url-text", formatUrlLabel(href)));
          urlsEl.append(link);
        }
        itemEl.append(urlsEl);
      }
      const imgs = tree.steps.length
        ? (Array.isArray(tree.stepImages?.[i]) ? tree.stepImages[i] : [])
        : (tree.pendingImages || []);
      if (imgs.length && !tree.collapsed) {
        const thumbsEl = createElNode("div", "activity-thumbs");
        thumbsEl.hidden = true;
        itemEl.append(thumbsEl);
        hydrateStepThumbs(tree, thumbsEl, imgs, renderGen);
      }
      tree.stepsEl.append(itemEl);
    }

    const showStopped = tree.status === "stopped";
    tree.stoppedEl.hidden = !showStopped;
    const showNote = showStopped && tree.showStoppedNote;
    if (showNote) {
      const when = formatTime(tree.endedAt || tree.startedAt);
      tree.stoppedNoteEl.textContent = "";
      tree.stoppedNoteEl.append(createElNode("span", "activity-stopped-label", "You stopped this response"));
      if (when) {
        const timeEl = createElNode("time", "activity-stopped-time", ` ${when}`);
        tree.stoppedNoteEl.append(timeEl);
      }
    }
    tree.stoppedNoteEl.hidden = !showNote;
  }

  function collectViewerItems(tree) {
    const items = [];
    for (const list of tree.stepImages || []) {
      for (const ref of list || []) {
        const src = tree.loadedUrls?.get(ref);
        if (src) items.push({ url: src, alt: ref.split("/").pop() || "image" });
      }
    }
    return items;
  }

  function appendThumbButton(tree, thumbsEl, ref, src) {
    const btn = createElNode("button", "activity-thumb");
    btn.type = "button";
    const label = ref.split("/").pop() || "image";
    btn.setAttribute("aria-label", `View ${label}`);
    const img = createElNode("img");
    img.referrerPolicy = "no-referrer";
    img.src = src;
    img.alt = label;
    img.loading = "lazy";
    btn.append(img);
    btn.addEventListener("click", () => {
      if (!openViewer) return;
      const items = collectViewerItems(tree);
      const idx = items.findIndex((item) => item.url === src);
      if (items.length) openViewer(items, Math.max(0, idx));
    });
    thumbsEl.append(btn);
    thumbsEl.hidden = false;
  }

  function hydrateStepThumbs(tree, thumbsEl, refs, renderGen) {
    if (!tree.loadedUrls) tree.loadedUrls = new Map();
    for (const ref of refs) {
      if (tree.loadedUrls.has(ref)) {
        const cached = tree.loadedUrls.get(ref);
        if (cached) appendThumbButton(tree, thumbsEl, ref, cached);
        continue;
      }
      if (ref.startsWith("https://")) {
        if (typeof createElNode !== "function") continue;
        const probe = createElNode("img");
        probe.addEventListener("load", () => {
          tree.loadedUrls.set(ref, ref);
          if (tree.renderGen === renderGen && thumbsEl.parentNode) appendThumbButton(tree, thumbsEl, ref, ref);
        });
        probe.addEventListener("error", () => {
          tree.loadedUrls.set(ref, null);
        });
        probe.referrerPolicy = "no-referrer";
        probe.src = ref;
        continue;
      }
      if (!fetchMedia) continue;
      Promise.resolve(fetchMedia(ref)).then((url) => {
        tree.loadedUrls.set(ref, url || null);
        if (url && tree.renderGen === renderGen && thumbsEl.parentNode) {
          appendThumbButton(tree, thumbsEl, ref, url);
        }
      }).catch(() => {
        tree.loadedUrls.set(ref, null);
      });
    }
  }

  function fromSavedRecord(record, sid = "") {
    const treeSid = sid || "";
    const stoppedNoReply = record.status === "stopped" && !record.anchor_before_id && !record.anchor_before_match;
    const steps = Array.isArray(record.steps) ? record.steps.slice() : [];
    const rawStepImgs = Array.isArray(record.step_images) ? record.step_images : [];
    const stepImages = steps.map((_, idx) => (Array.isArray(rawStepImgs[idx]) ? rawStepImgs[idx].slice(0, MAX_STEP_IMAGES) : []));
    const rawStepUrls = Array.isArray(record.step_urls) ? record.step_urls : [];
    const stepUrls = steps.map((_, idx) => (Array.isArray(rawStepUrls[idx]) ? rawStepUrls[idx].slice(0, MAX_STEP_URLS) : []));
    const tree = {
      id: record.id,
      sid: sid || "",
      turnId: record.turn_id || "",
      title: record.title || "",
      steps,
      stepImages,
      pendingImages: [],
      stepUrls,
      pendingUrls: [],
      loadedUrls: new Map(),
      renderGen: 0,
      placeholder: "",
      status: record.status || "done",
      collapsed: record.status === "done" || (record.status === "stopped" && !stoppedNoReply),
      showStoppedNote: stoppedNoReply,
      startedAt: Number(record.started_at) || 0,
      endedAt: Number(record.ended_at) || 0,
      anchorBeforeId: record.anchor_before_id || null,
      anchorBeforeMatch: record.anchor_before_match || "",
      anchorAfterId: record.anchor_after_id || null,
      anchorAfterMatch: record.anchor_after_match || "",
      events: [],
      thinking: "",
      activeTools: 0,
      dirty: false,
      inflight: false,
      timer: 0,
      lastCompletedAt: 0,
      token: 0,
      targetRow: null,
      el: null,
      saveEpoch: treeSid ? (sessionEpoch.get(treeSid) || 0) : undefined,
    };
    buildTreeDOM(tree);
    return tree;
  }

  function scheduleCheck(tree, baseDelay = SETTLE_MS) {
    if (!tree || tree.status !== "running" || active !== tree) return;
    clearTimer(tree);
    if (isHidden()) return;
    const gapWait = tree.lastCompletedAt > 0
      ? Math.max(0, MIN_GAP_MS - (perfNow() - tree.lastCompletedAt))
      : 0;
    const delay = Math.max(baseDelay, gapWait);
    tree.timer = setTimeout(() => {
      tree.timer = 0;
      if (active !== tree || tree.status !== "running") return;
      if (isHidden()) return;
      if (tree.dirty && !tree.inflight) {
        void requestTreeStep(tree);
      } else {
        scheduleCheck(tree, QUIET_POLL_MS);
      }
    }, delay);
  }

  function pushStep(tree, rawStep) {
    const clean = cleanPlaceholder(rawStep);
    if (!clean) return false;
    const key = normStepKey(clean);
    if (tree.steps.some((existing) => normStepKey(existing) === key)) return false;
    tree.steps.push(clean);
    const attached = Array.isArray(tree.pendingImages) ? tree.pendingImages.slice(0, MAX_STEP_IMAGES) : [];
    tree.pendingImages = [];
    if (!Array.isArray(tree.stepImages)) tree.stepImages = [];
    tree.stepImages.push(attached);
    const attachedUrls = Array.isArray(tree.pendingUrls) ? tree.pendingUrls.slice(0, MAX_STEP_URLS) : [];
    tree.pendingUrls = [];
    if (!Array.isArray(tree.stepUrls)) tree.stepUrls = [];
    tree.stepUrls.push(attachedUrls);
    tree.placeholder = "";
    return true;
  }

  function flushPendingImagesToCurrentStep(tree) {
    if (!tree || !Array.isArray(tree.pendingImages) || !tree.pendingImages.length) return false;
    if (!tree.steps.length) return false;
    const idx = tree.steps.length - 1;
    if (!Array.isArray(tree.stepImages)) tree.stepImages = tree.steps.map(() => []);
    while (tree.stepImages.length < tree.steps.length) tree.stepImages.push([]);
    const added = mergeList(tree.stepImages[idx], tree.pendingImages, MAX_STEP_IMAGES);
    tree.pendingImages = [];
    return added;
  }

  function flushPendingUrlsToCurrentStep(tree) {
    if (!tree || !Array.isArray(tree.pendingUrls) || !tree.pendingUrls.length) return false;
    if (!tree.steps.length) return false;
    const idx = tree.steps.length - 1;
    if (!Array.isArray(tree.stepUrls)) tree.stepUrls = tree.steps.map(() => []);
    while (tree.stepUrls.length < tree.steps.length) tree.stepUrls.push([]);
    const added = mergeList(tree.stepUrls[idx], tree.pendingUrls, MAX_STEP_URLS);
    tree.pendingUrls = [];
    return added;
  }

  async function requestTreeStep(tree) {
    if (!api || active !== tree || tree.status !== "running" || tree.inflight) return;
    const events = tree.events.slice(-MAX_EVENTS);
    if (tree.thinking) events.push({ kind: "thinking", text: tree.thinking.slice(-400) });
    if (!events.length) return;
    const callToken = tree.token;
    tree.inflight = true;
    tree.dirty = false;
    try {
      const stick = nearBottom();
      const data = await api(NARRATE_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          mode: "tree",
          request: String(currentRequest || "").slice(0, 300),
          title: tree.title || "",
          previous: tree.steps.slice(-MAX_PREVIOUS),
          events,
        }),
      });
      if (callToken !== tree.token || active !== tree || tree.status !== "running") return;
      tree.lastCompletedAt = perfNow();
      let changed = false;
      const newTitle = typeof data?.title === "string" ? cleanPlaceholder(data.title) : "";
      if (!tree.title && newTitle) {
        tree.title = newTitle;
        changed = true;
      }
      const newStep = typeof data?.step === "string" ? data.step : "";
      if (pushStep(tree, newStep)) {
        changed = true;
      } else {
        const flushedImgs = flushPendingImagesToCurrentStep(tree);
        const flushedUrls = flushPendingUrlsToCurrentStep(tree);
        if (flushedImgs || flushedUrls) changed = true;
      }
      if (changed) {
        renderTreeDOM(tree);
        if (stick) scrollToBottom(true);
        void saveTree(tree);
      }
    } catch {
      /* narration is cosmetic; leave existing steps untouched */
    } finally {
      if (callToken === tree.token) {
        tree.inflight = false;
        tree.lastCompletedAt = perfNow();
        if (active === tree && tree.status === "running") {
          scheduleCheck(tree, tree.dirty ? SETTLE_MS : QUIET_POLL_MS);
        }
      }
    }
  }

  function resolveBubbleMeta(rowEl) {
    if (!rowEl || !rowEl.hermesMiniMsg) return { rowId: null, match: "" };
    const msg = rowEl.hermesMiniMsg;
    return {
      rowId: Number.isInteger(msg.rowId) && msg.rowId > 0 ? msg.rowId : null,
      match: msg.text ? normalizeMatch(displayText(msg.text)) : "",
    };
  }

  function ensureActiveTree({ insertBefore = null, afterEl = null, turnId = null, label = "", sid = null } = {}) {
    if (active && active.status === "running") {
      if (label) startPlaceholder(label);
      return active;
    }
    treeSeq += 1;
    const afterMeta = resolveBubbleMeta(afterEl);
    const treeSid = sid || getStoredId() || "";
    const tree = {
      id: `act_${nowMs()}_${treeSeq}`,
      sid: treeSid,
      turnId: turnId || currentTurnId || "",
      title: "",
      steps: [],
      stepImages: [],
      pendingImages: [],
      stepUrls: [],
      pendingUrls: [],
      loadedUrls: new Map(),
      renderGen: 0,
      placeholder: cleanPlaceholder(label),
      status: "running",
      collapsed: false,
      showStoppedNote: false,
      startedAt: nowMs() / 1000,
      endedAt: 0,
      anchorBeforeId: null,
      anchorBeforeMatch: "",
      anchorAfterId: afterMeta.rowId,
      anchorAfterMatch: afterMeta.match,
      events: [],
      thinking: "",
      activeTools: 0,
      dirty: false,
      inflight: false,
      timer: 0,
      lastCompletedAt: 0,
      token: 1,
      targetRow: null,
      el: null,
      saveEpoch: treeSid ? (sessionEpoch.get(treeSid) || 0) : undefined,
    };
    buildTreeDOM(tree);
    renderedIds.add(tree.id);
    if (logEl) {
      if (insertBefore && insertBefore.parentNode === logEl) {
        logEl.insertBefore(tree.el, insertBefore);
      } else {
        logEl.append(tree.el);
      }
    }
    active = tree;
    return tree;
  }

  function startPlaceholder(label) {
    if (!active || active.status !== "running") return;
    if (active.steps.length > 0 || active.placeholder) return;
    const clean = cleanPlaceholder(label);
    if (!clean) return;
    active.placeholder = clean;
    renderTreeDOM(active);
  }

  function recordToolArtifacts(payload) {
    if (!active || !payload) return;
    const imgsChanged = mergeList(active.pendingImages, extractToolImages(payload), MAX_STEP_IMAGES);
    const urlsChanged = mergeList(active.pendingUrls, extractToolUrls(payload), MAX_STEP_URLS);
    if ((imgsChanged || urlsChanged) && !active.steps.length) {
      renderTreeDOM(active);
    }
  }

  function buildArtifactPayload(name, args, payload) {
    return payload && typeof payload === "object"
      ? { ...payload, name: payload.name || name, args: payload.args || args }
      : { name, args };
  }

  function onToolStart(name, args, label = "", payload = null) {
    if (!active || active.status !== "running") return;
    if (label) startPlaceholder(label);
    recordToolArtifacts(buildArtifactPayload(name, args, payload));
    active.events.push({
      kind: "tool",
      name: String(name || ""),
      args: safeArgs(args),
      status: "running",
    });
    if (active.events.length > MAX_EVENTS) active.events = active.events.slice(-MAX_EVENTS);
    active.activeTools += 1;
    active.dirty = true;
    scheduleCheck(active, SETTLE_MS);
  }

  function onToolComplete(name, args, summary = "", payload = null) {
    if (!active || active.status !== "running") return;
    recordToolArtifacts(buildArtifactPayload(name, args, payload));
    active.events.push({
      kind: "tool",
      name: String(name || ""),
      args: safeArgs(args),
      status: "done",
      ...(summary ? { summary: String(summary).slice(0, 200) } : {}),
    });
    if (active.events.length > MAX_EVENTS) active.events = active.events.slice(-MAX_EVENTS);
    active.activeTools = Math.max(0, active.activeTools - 1);
    active.dirty = true;
    scheduleCheck(active, active.activeTools === 0 ? 400 : SETTLE_MS);
  }

  function onThinking(text) {
    if (!active || active.status !== "running") return;
    const raw = String(text || "");
    if (!raw) return;
    active.thinking = (active.thinking + raw).slice(-400);
    active.dirty = true;
    if (!active.timer && !active.inflight) {
      scheduleCheck(active, active.steps.length === 0 ? SETTLE_MS : QUIET_POLL_MS);
    }
  }

  function onStatusLine(line) {
    if (!active || active.status !== "running") return false;
    const clean = cleanPlaceholder(line);
    if (!clean) return false;
    if (pushStep(active, clean)) {
      renderTreeDOM(active);
      void saveTree(active);
    }
    return true;
  }

  function finalizeActiveForBubble({ rowEl = null, matchText = "", rowId = null, expectReply = true } = {}) {
    if (!active) return null;
    const tree = active;
    active = null;
    clearTimer(tree);
    tree.token += 1;
    tree.inflight = false;

    if (!tree.steps.length && (tree.pendingImages.length || tree.pendingUrls.length) && tree.placeholder) {
      pushStep(tree, tree.placeholder);
    } else {
      flushPendingImagesToCurrentStep(tree);
      flushPendingUrlsToCurrentStep(tree);
    }
    if (!tree.steps.length && !tree.title) {
      if (tree.el) tree.el.remove();
      return null;
    }

    tree.status = "done";
    tree.collapsed = true;
    tree.showStoppedNote = false;
    tree.endedAt = nowMs() / 1000;
    tree.targetRow = rowEl;
    if (matchText) tree.anchorBeforeMatch = normalizeMatch(displayText(matchText));
    if (Number.isInteger(rowId) && rowId > 0) tree.anchorBeforeId = rowId;

    // No reply is coming (a silent completion, an error, or a hidden turn): close the outline in place after the last
    // bubble, and never leave a pending anchor that would attach it to somebody else's reply.
    if (!expectReply) {
      tree.targetRow = null;
      tree.anchorBeforeMatch = "";
      tree.anchorBeforeId = null;
      pendingAnchorTree = null;
      renderTreeDOM(tree);
      void saveTree(tree);
      return tree;
    }

    renderTreeDOM(tree);

    if (tree.anchorBeforeMatch || tree.anchorBeforeId) {
      pendingAnchorTree = null;
      void saveTree(tree);
    } else {
      pendingAnchorTree = tree;
      void saveTree(tree);
    }
    return tree;
  }

  function attachBubbleAnchor({ rowEl = null, text = "", rowId = null } = {}) {
    if (!pendingAnchorTree) return;
    const tree = pendingAnchorTree;
    if (tree.targetRow && rowEl && tree.targetRow !== rowEl) return;
    const target = rowEl || tree.targetRow;
    const meta = resolveBubbleMeta(target);
    if (text) tree.anchorBeforeMatch = normalizeMatch(displayText(text));
    else if (meta.match) tree.anchorBeforeMatch = meta.match;
    if (Number.isInteger(rowId) && rowId > 0) {
      tree.anchorBeforeId = rowId;
      if (target && target.hermesMiniMsg && !Number.isInteger(target.hermesMiniMsg.rowId)) target.hermesMiniMsg.rowId = rowId;
    } else if (meta.rowId) tree.anchorBeforeId = meta.rowId;
    const owningSid = tree.sid || getStoredId() || "";
    if (!tree.sid && owningSid) tree.sid = owningSid;
    pendingAnchorTree = null;
    void saveTree(tree);

    if (!tree.anchorBeforeId && target && resolveRowId) {
      resolveRowId(target, owningSid).then((resolved) => {
        if (
          Number.isInteger(resolved)
          && resolved > 0
          && tree.anchorBeforeId !== resolved
          && (!owningSid || tree.sid === owningSid)
          && !isTreeCancelled(tree, owningSid)
        ) {
          tree.anchorBeforeId = resolved;
          void saveTree(tree);
        }
      }).catch(() => {});
    }
  }

  function markStopped({ afterEl = null, afterText = "", afterRowId = null, showNote = true } = {}) {
    const tree = active;
    if (!tree) return null;
    active = null;
    pendingAnchorTree = null;
    clearTimer(tree);
    tree.token += 1;
    tree.inflight = false;

    if (!tree.steps.length && tree.placeholder) {
      pushStep(tree, tree.placeholder);
    } else {
      flushPendingImagesToCurrentStep(tree);
      flushPendingUrlsToCurrentStep(tree);
    }
    if (!tree.title) {
      tree.title = cleanPlaceholder(currentRequest).slice(0, 80) || "Working on your request";
    }
    if (afterEl) {
      const meta = resolveBubbleMeta(afterEl);
      if (meta.match && !tree.anchorAfterMatch) tree.anchorAfterMatch = meta.match;
      if (meta.rowId && !tree.anchorAfterId) tree.anchorAfterId = meta.rowId;
    }
    if (afterText) tree.anchorAfterMatch = normalizeMatch(afterText);
    if (Number.isInteger(afterRowId) && afterRowId > 0) tree.anchorAfterId = afterRowId;

    tree.status = "stopped";
    tree.showStoppedNote = Boolean(showNote);
    tree.endedAt = nowMs() / 1000;
    renderTreeDOM(tree);
    void saveTree(tree);
    return tree;
  }

  function abandonActive({ removeDom = false } = {}) {
    if (active) {
      clearTimer(active);
      active.token += 1;
      active.inflight = false;
      if ((removeDom || !active.steps.length) && active.el) active.el.remove();
      active = null;
    }
    pendingAnchorTree = null;
  }

  function startTurn(turnId = null) {
    abandonActive();
    currentTurnId = turnId || null;
  }

  function setRequest(text) {
    currentRequest = String(text || "");
  }

  async function loadSessionTrees(sid) {
    if (!sid || !api) return [];
    try {
      const data = await api(`${ACTIVITY_API}/${encodeURIComponent(sid)}`);
      const trees = Array.isArray(data?.trees) ? data.trees : [];
      sessionCache.set(sid, trees);
      return trees;
    } catch {
      return [];
    }
  }

  function renderHistoryTrees(sid, entries, appendEntryFn, opts = {}) {
    const trees = (sid && sessionCache.get(sid)) || [];
    const { before, after } = matchTreesToEntries(trees, entries, renderedIds, opts);
    for (let i = 0; i < entries.length; i += 1) {
      const beforeList = before.get(i);
      if (beforeList) {
        for (const rec of beforeList) {
          const node = fromSavedRecord(rec, sid || "").el;
          if (logEl) logEl.append(node);
        }
      }
      appendEntryFn(entries[i], i);
      const afterList = after.get(i);
      if (afterList) {
        for (const rec of afterList) {
          const node = fromSavedRecord(rec, sid || "").el;
          if (logEl) logEl.append(node);
        }
      }
    }
  }

  function restoreLiveTree({ sid = null, insertBefore = null } = {}) {
    const key = sid || getStoredId();
    const trees = (key && sessionCache.get(key)) || [];
    const runningRec = [...trees].reverse().find((t) => t && t.status === "running");
    if (!runningRec || active) return null;
    const restored = fromSavedRecord(runningRec, key || "");
    restored.collapsed = false;
    restored.showStoppedNote = false;
    renderTreeDOM(restored);
    renderedIds.add(restored.id);
    if (logEl) {
      if (insertBefore && insertBefore.parentNode === logEl) {
        logEl.insertBefore(restored.el, insertBefore);
      } else {
        logEl.append(restored.el);
      }
    }
    active = restored;
    return restored;
  }

  function clearLogState() {
    abandonActive();
    renderedIds.clear();
  }

  function onVisibilityChange() {
    if (!isHidden() && active && active.status === "running" && active.dirty && !active.inflight) {
      scheduleCheck(active, 200);
    }
  }

  async function deleteSession(sid) {
    if (!sid) return;
    // Bump the epoch first so any queued or delayed save for this chat is refused, then let the PUTs already on the
    // wire finish before the DELETE: otherwise a late save re-creates a tree after the chat was wiped.
    sessionEpoch.set(sid, (sessionEpoch.get(sid) || 0) + 1);
    sessionCache.delete(sid);
    const inflight = [];
    const prefix = `${sid}\0`;
    for (const [key, entry] of saveQueues) {
      if (!key.startsWith(prefix)) continue;
      entry.pending = null;
      if (entry.inflight) inflight.push(entry.inflight);
    }
    if (inflight.length) await Promise.allSettled(inflight);
    if (!api) return;
    try {
      await api(`${ACTIVITY_API}/${encodeURIComponent(sid)}`, { method: "DELETE" });
    } catch {
      /* ignore */
    }
  }

  async function pruneSessionFrom(sid, { fromRowId = null, fromTs = null, beforeTs = null } = {}) {
    if (!sid) return;
    const hasBefore = Number.isFinite(beforeTs) && beforeTs > 0;
    const prunedIds = new Set();
    if (active && (!active.sid || active.sid === sid) && (!hasBefore || (Number(active.startedAt) || 0) <= beforeTs)) {
      prunedIds.add(active.id);
      clearTimer(active);
      active.token += 1;
      active.inflight = false;
      if (!active.steps.length && active.el) active.el.remove();
      active = null;
    }
    if (
      pendingAnchorTree
      && (!pendingAnchorTree.sid || pendingAnchorTree.sid === sid)
      && (!hasBefore || (Number(pendingAnchorTree.startedAt) || 0) <= beforeTs)
    ) {
      prunedIds.add(pendingAnchorTree.id);
      pendingAnchorTree = null;
    }
    const existing = sessionCache.get(sid);
    if (Array.isArray(existing)) {
      const hasRowId = Number.isInteger(fromRowId) && fromRowId > 0;
      const hasTs = Number.isFinite(fromTs) && fromTs > 0;
      const kept = [];
      for (const t of existing) {
        if (hasBefore && Number(t.started_at || 0) > beforeTs) {
          kept.push(t);
          continue;
        }
        const bId = Number.isInteger(t.anchor_before_id) ? t.anchor_before_id : null;
        const aId = Number.isInteger(t.anchor_after_id) ? t.anchor_after_id : null;
        let drop = false;
        if (hasRowId && ((bId !== null && bId >= fromRowId) || (aId !== null && aId >= fromRowId))) {
          drop = true;
        } else if (!(hasRowId && bId !== null && bId < fromRowId) && hasTs && Number(t.started_at || 0) >= fromTs - 2) {
          drop = true;
        }
        if (drop) {
          renderedIds.delete(t.id);
          prunedIds.add(t.id);
        } else {
          kept.push(t);
        }
      }
      sessionCache.set(sid, kept);
    }
    // A pruned tree's queued save would re-create it server-side; cancel it and let in-flight PUTs land before the
    // DELETE so nothing is written back after the prune.
    const inflight = [];
    for (const id of prunedIds) {
      markTreeCancelled(id);
      const entry = saveQueues.get(`${sid}\0${id}`);
      if (!entry) continue;
      entry.pending = null;
      if (entry.inflight) inflight.push(entry.inflight);
    }
    if (inflight.length) await Promise.allSettled(inflight);
    if (!api) return;
    const params = new URLSearchParams();
    if (Number.isInteger(fromRowId) && fromRowId > 0) params.set("from_row_id", String(fromRowId));
    if (Number.isFinite(fromTs) && fromTs > 0) params.set("from_ts", String(fromTs));
    if (hasBefore) params.set("before_ts", String(beforeTs));
    const qs = params.toString();
    try {
      await api(`${ACTIVITY_API}/${encodeURIComponent(sid)}${qs ? `?${qs}` : ""}`, { method: "DELETE" });
    } catch {
      /* ignore */
    }
  }

  return {
    setRequest,
    startTurn,
    hasActiveTree: () => Boolean(active && active.status === "running"),
    hasPendingAnchor: () => Boolean(pendingAnchorTree),
    ensureActiveTree,
    startPlaceholder,
    onToolStart,
    onToolComplete,
    onThinking,
    onStatusLine,
    finalizeActiveForBubble,
    attachBubbleAnchor,
    markStopped,
    abandonActive,
    loadSessionTrees,
    renderHistoryTrees,
    restoreLiveTree,
    clearLogState,
    onVisibilityChange,
    deleteSession,
    pruneSessionFrom,
    _debugActive: () => active,
  };
}
