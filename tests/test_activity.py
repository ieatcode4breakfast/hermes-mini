"""Activity trees: per-subject /narrate mode, activity persistence routes with compaction resolution,
frontend activity state/matching logic, and sw.js/app.js wiring.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import subprocess
import types
import unittest
from unittest import mock

from tests.support import DASHBOARD, DisposableHome

try:
    from tests.test_routes import HAVE_FASTAPI, build_app

    from starlette.testclient import TestClient
except Exception:  # noqa: BLE001
    HAVE_FASTAPI = False
    build_app = None  # type: ignore[assignment]
    TestClient = None  # type: ignore[assignment]


NODE_SCRIPT = r"""
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { normalizeMatch, matchTreesToEntries, createActivity, extractToolImages, cleanImageRef, cleanOpenedUrl, formatUrlLabel, extractToolUrls } = await import(pathToFileURL(process.argv[1]).href);

// Minimal DOM node fake to test real UI transitions in Node
function makeNode(tag, className = '', text = '') {
  const node = {
    tagName: tag.toUpperCase(),
    className,
    children: [],
    parentNode: null,
    dataset: {},
    attrs: {},
    hidden: false,
    listeners: {},
    _text: text,
    get textContent() {
      return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
    },
    set textContent(v) {
      this._text = String(v ?? '');
      this.children = [];
    },
    classList: {
      add(...cls) {
        const parts = new Set(node.className.split(/\s+/).filter(Boolean));
        for (const c of cls) parts.add(c);
        node.className = [...parts].join(' ');
      },
      remove(...cls) {
        const parts = new Set(node.className.split(/\s+/).filter(Boolean));
        for (const c of cls) parts.delete(c);
        node.className = [...parts].join(' ');
      },
      toggle(c, force) {
        const parts = new Set(node.className.split(/\s+/).filter(Boolean));
        const has = parts.has(c);
        const want = force === undefined ? !has : Boolean(force);
        if (want) parts.add(c); else parts.delete(c);
        node.className = [...parts].join(' ');
        return want;
      },
      contains(c) {
        return node.className.split(/\s+/).filter(Boolean).includes(c);
      },
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    append(...items) {
      for (const item of items) {
        if (!item) continue;
        if (item.parentNode) item.parentNode.removeChild(item);
        item.parentNode = node;
        node.children.push(item);
      }
    },
    insertBefore(item, ref) {
      if (!ref) return node.append(item);
      const idx = node.children.indexOf(ref);
      if (idx === -1) return node.append(item);
      if (item.parentNode) item.parentNode.removeChild(item);
      item.parentNode = node;
      node.children.splice(idx, 0, item);
    },
    removeChild(child) {
      const idx = node.children.indexOf(child);
      if (idx !== -1) node.children.splice(idx, 1);
      child.parentNode = null;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    insertAdjacentHTML() {},
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    click() {
      for (const fn of this.listeners.click || []) fn({});
    },
  };
  return node;
}

globalThis.document = { hidden: false };

const logEl = makeNode('div', 'log');
const calls = [];
let nextNarrate = { title: 'Comparing self-hosted apps', step: 'Checking Bitwarden memory and mobile features' };
const api = async (url, opts) => {
  calls.push({ url, opts });
  if (url.endsWith('/narrate')) return nextNarrate;
  return { ok: true };
};

const act = createActivity({
  el: makeNode,
  logEl,
  api,
  displayText: (t) => String(t || ''),
  getStoredId: () => 'chat-1',
  formatTime: () => '6:31 PM',
  isHidden: () => false,
});

// 1. Initial ack bubble stays clean (no tree yet); first tool creates Tree #1 right above trailing turn row
const ackRow = makeNode('div', 'msg assistant');
ackRow.hermesMiniMsg = { rowId: 10, text: 'Got it, checking all 8 apps one by one.' };
logEl.append(ackRow);
const trailingRow1 = makeNode('div', 'msg assistant');
trailingRow1.hermesMiniMsg = { rowId: null, text: '' };
logEl.append(trailingRow1);

act.setRequest('Compare 8 self-hosted apps');
act.startTurn('turn-1');
const t1 = act.ensureActiveTree({ insertBefore: trailingRow1, afterEl: ackRow, turnId: 'turn-1', label: 'Searching the web…' });
assert.equal(logEl.children.indexOf(ackRow), 0);
assert.equal(logEl.children.indexOf(t1.el), 1);
assert.equal(logEl.children.indexOf(trailingRow1), 2);
assert.equal(t1.collapsed, false);

// Preset labels must NEVER overwrite existing placeholder or accepted AI steps
act.onToolStart('web_search', { q: 'bitwarden' }, 'Searching the web…');
assert.equal(t1.placeholder, 'Searching the web');
act.onToolStart('web_fetch', { url: 'https://bitwarden.com' }, 'Reading a webpage…');
assert.equal(t1.placeholder, 'Searching the web');

// Simulate AI narrator response delivering title + step 1
nextNarrate = { title: 'Comparing self-hosted apps', step: 'Checking Bitwarden features and Docker footprint' };
await new Promise((r) => setTimeout(r, 1700));
assert.equal(t1.title, 'Comparing self-hosted apps');
assert.deepEqual(t1.steps, ['Checking Bitwarden features and Docker footprint']);
assert.equal(t1.placeholder, '');
assert.equal(t1.headBtn.children[0], t1.typingEl);
assert.ok(t1.typingEl.classList.contains('activity-typing'));
assert.equal(t1.typingEl.children.length, 3);
assert.equal(t1.typingEl.hidden, false);
assert.equal(t1.headBtn.children[1], t1.headTextEl);
assert.equal(t1.headTextEl.textContent, 'Comparing self-hosted apps');
assert.equal(t1.stepsEl.children.length, 1);
assert.equal(t1.stepsEl.children[0].children[0].classList.contains('is-active'), true);

// Collapse while STILL running -> header shows active step + shimmer, body hidden
t1.headBtn.click();
assert.equal(t1.collapsed, true);
assert.equal(t1.headTextEl.textContent, 'Checking Bitwarden features and Docker footprint');
assert.equal(t1.headTextEl.classList.contains('narration'), true);
assert.equal(t1.bodyEl.hidden, true);
assert.equal(t1.typingEl.hidden, false);
t1.headBtn.click();
assert.equal(t1.collapsed, false);
assert.equal(t1.bodyEl.hidden, false);

// Tool switch after AI step still never overwrites AI step
act.onToolStart('web_fetch', { url: 'https://vaultwarden' }, 'Reading a webpage…');
assert.deepEqual(t1.steps, ['Checking Bitwarden features and Docker footprint']);

// Interim message finalizes & auto-collapses Tree #1, then second tool starts brand-new Tree #2!
act.finalizeActiveForBubble({ rowEl: trailingRow1 });
assert.equal(t1.status, 'done');
assert.equal(t1.collapsed, true);
assert.equal(t1.headTextEl.textContent, 'Comparing self-hosted apps');
assert.equal(t1.headTextEl.classList.contains('narration'), false);
assert.equal(t1.typingEl.hidden, true);
assert.equal(act.hasActiveTree(), false);

trailingRow1.hermesMiniMsg.text = 'Finished password managers, checking bookmark apps next.';
act.attachBubbleAnchor({ rowEl: trailingRow1, text: trailingRow1.hermesMiniMsg.text, rowId: 11 });
await new Promise((r) => setTimeout(r, 20)); // saves are serialized per tree, so let the queued PUT run
const putTree1 = calls.filter((c) => c.url.includes('/activity/chat-1/' + t1.id)).at(-1);
assert.ok(putTree1);
assert.equal(JSON.parse(putTree1.opts.body).anchor_before_match, normalizeMatch('Finished password managers, checking bookmark apps next.'));

const trailingRow2 = makeNode('div', 'msg assistant');
trailingRow2.hermesMiniMsg = { rowId: null, text: '' };
logEl.append(trailingRow2);
const t2 = act.ensureActiveTree({ insertBefore: trailingRow2, afterEl: trailingRow1, turnId: 'turn-1', label: 'Searching the web…' });
assert.notEqual(t2.id, t1.id);
assert.equal(logEl.children.indexOf(t2.el), 3);

// Pressing Stop marks Tree #2 stopped with note, keeping Preceding interim row anchor
act.markStopped({ afterEl: trailingRow1, showNote: true });
assert.equal(t2.status, 'stopped');
assert.equal(t2.collapsed, false);
assert.equal(t2.stoppedEl.hidden, false);
assert.equal(t2.stoppedNoteEl.hidden, false);
assert.equal(t2.stoppedNoteEl.textContent, 'You stopped this response 6:31 PM');
assert.equal(t2.typingEl.hidden, true);
await new Promise((r) => setTimeout(r, 20));
const putTree2 = calls.filter((c) => c.url.includes('/activity/chat-1/' + t2.id)).at(-1);
assert.equal(JSON.parse(putTree2.opts.body).anchor_after_id, 11);

// 2. matchTreesToEntries placement & deduplication
const entries = [
  { role: 'user', rowId: 9, ts: 1000, text: 'Compare 8 apps' },
  { role: 'assistant', rowId: 10, ts: 1002, text: 'Got it, checking all 8 apps one by one.' },
  { role: 'assistant', rowId: 20, ts: 1050, text: 'Finished password managers, checking bookmark apps next.' },
];
const savedTrees = [
  { id: 'a1', status: 'done', title: 'Password check', steps: ['Bitwarden'], started_at: 1005, ended_at: 1045, anchor_before_id: 20, anchor_before_match: 'finished password managers' },
  { id: 'a2', status: 'stopped', title: 'Bookmark check', steps: ['Linkwarden'], started_at: 1055, ended_at: 1080, anchor_after_id: 20, anchor_after_match: 'finished password managers' },
];
const rendered = new Set();
const placed = matchTreesToEntries(savedTrees, entries, rendered);
assert.equal(placed.before.get(2)?.[0]?.id, 'a1');
assert.equal(placed.after.get(2)?.[0]?.id, 'a2');
// Calling again with same rendered set never duplicates!
const placedAgain = matchTreesToEntries(savedTrees, entries, rendered);
assert.equal(placedAgain.before.size, 0);
assert.equal(placedAgain.after.size, 0);

// 3. extractToolImages filters safe image paths/HTTPS URLs and rejects unsafe strings
assert.deepEqual(
  extractToolImages({
    image_path: '/tmp/a.png',
    args: { image_url: 'https://example.com/photo.jpg' },
    result: { screenshot_path: 'javascript:alert(1)', meta: { image_path: '/tmp/b.webp' } },
  }),
  ['/tmp/a.png', 'https://example.com/photo.jpg', '/tmp/b.webp'],
);
assert.deepEqual(
  extractToolImages({ args: { image_url: 'data:image/png;base64,xx' }, result: { image_path: 'http://insecure.local/x.png' } }),
  [],
);

// 4. Per-step image attachment + quiet no-change merge + missing-image silent fallback
const imgLog = makeNode('div', 'log');
const imgCalls = [];
let imgNarrateResp = { title: 'Checking photos', step: 'Inspecting Bitwarden screenshots' };
const viewerOpened = [];
const fetchMediaMock = async (ref) => (ref === '/tmp/gone.png' ? null : 'data:image/png;base64,OK');
const actImg = createActivity({
  el: makeNode,
  logEl: imgLog,
  api: async (url, opts) => {
    imgCalls.push({ url, opts });
    if (url.endsWith('/narrate')) return imgNarrateResp;
    return { ok: true };
  },
  getStoredId: () => 'chat-img',
  fetchMedia: fetchMediaMock,
  openViewer: (items, idx) => viewerOpened.push({ items, idx }),
  isHidden: () => false,
});
const tailImg = makeNode('div', 'msg assistant');
imgLog.append(tailImg);
actImg.setRequest('Check screenshots');
actImg.startTurn('t-img');
const it = actImg.ensureActiveTree({ insertBefore: tailImg, label: 'Looking at an image' });
actImg.onToolComplete('vision_analyze', { image_url: '/tmp/live1.png' }, 'ok', { image_path: '/tmp/live1.png' });
await new Promise((r) => setTimeout(r, 600));
assert.deepEqual(it.steps, ['Inspecting Bitwarden screenshots']);
assert.deepEqual(it.stepImages, [['/tmp/live1.png']]);

// Narrator stays quiet (step: null) on same subject while checking a second image -> merges onto step 0
imgNarrateResp = { step: null };
actImg.onToolComplete('vision_analyze', { image_url: '/tmp/gone.png' }, 'ok', { image_path: '/tmp/gone.png' });
await new Promise((r) => setTimeout(r, 4200));
assert.deepEqual(it.steps, ['Inspecting Bitwarden screenshots']);
assert.deepEqual(it.stepImages, [['/tmp/live1.png', '/tmp/gone.png']]);

// Move to second subject -> attaches /tmp/live2.png to step 1 instead of step 0
imgNarrateResp = { step: 'Inspecting Linkwarden screenshots' };
actImg.onToolComplete('vision_analyze', { image_url: '/tmp/live2.png' }, 'ok', { image_path: '/tmp/live2.png' });
await new Promise((r) => setTimeout(r, 4200));
assert.deepEqual(it.steps, ['Inspecting Bitwarden screenshots', 'Inspecting Linkwarden screenshots']);
assert.deepEqual(it.stepImages, [['/tmp/live1.png', '/tmp/gone.png'], ['/tmp/live2.png']]);

// Check thumbnails rendered: /tmp/gone.png dropped cleanly; live1 + live2 visible and clickable into viewer
await new Promise((r) => setTimeout(r, 20));
const step0ThumbsWrap = it.stepsEl.children[0].children[1];
assert.equal(step0ThumbsWrap.className, 'activity-thumbs');
assert.equal(step0ThumbsWrap.hidden, false);
assert.equal(step0ThumbsWrap.children.length, 1);
step0ThumbsWrap.children[0].click();
assert.equal(viewerOpened.length, 1);
assert.equal(viewerOpened[0].items.length, 2);

// Missing-only tree keeps thumbs container hidden with zero thumb buttons (looks identical to plain text!)
const onlyGoneLog = makeNode('div', 'log');
const actGone = createActivity({
  el: makeNode,
  logEl: onlyGoneLog,
  api: async () => ({ ok: true }),
  getStoredId: () => 'chat-gone',
  fetchMedia: async () => null,
});
await actGone.loadSessionTrees('chat-gone');
// Render via renderHistoryTrees using pre-loaded saved tree with only /tmp/gone.png
actGone._debugActive();
const fakeEntry = { role: 'user', rowId: 1, ts: 100, text: 'hi' };
const apiWithSaved = createActivity({
  el: makeNode,
  logEl: onlyGoneLog,
  api: async () => ({
    trees: [{
      id: 'g1',
      status: 'done',
      title: 'Past photo check',
      steps: ['Checked deleted photo'],
      step_images: [['/tmp/gone.png']],
      started_at: 101,
      ended_at: 105,
      anchor_after_id: 1,
    }],
  }),
  fetchMedia: async () => null,
});
await apiWithSaved.loadSessionTrees('chat-gone');
apiWithSaved.renderHistoryTrees('chat-gone', [fakeEntry], () => {});
const restoredNode = onlyGoneLog.children[0];
assert.ok(restoredNode);
restoredNode.children[0].click(); // expand collapsed history tree
await new Promise((r) => setTimeout(r, 20));
const goneThumbsWrap = restoredNode.children[1].children[0].children[0].children[1];
assert.equal(goneThumbsWrap.hidden, true);
assert.equal(goneThumbsWrap.children.length, 0);

// Opened-URL cleaning, label formatting, and extraction rules
assert.equal(cleanOpenedUrl('https://en.wikipedia.org/wiki/Jackie_Chan'), 'https://en.wikipedia.org/wiki/Jackie_Chan');
assert.equal(cleanOpenedUrl('http://example.org/docs/guide'), 'http://example.org/docs/guide');
assert.equal(cleanOpenedUrl('javascript:alert(1)'), null);
assert.equal(cleanOpenedUrl('file:///etc/passwd'), null);
assert.equal(cleanOpenedUrl('http://localhost:8080/secret'), null);
assert.equal(cleanOpenedUrl('http://127.0.0.1:9119/'), null);
assert.equal(cleanOpenedUrl('http://[::1]:8080/'), null);
assert.equal(cleanOpenedUrl('http://192.168.1.5/admin'), null);
assert.equal(cleanOpenedUrl('http://10.0.0.1/status'), null);
assert.equal(cleanOpenedUrl('https://user:pass@example.com/private'), null);
assert.equal(cleanOpenedUrl('https://example.com/{sym}'), null);
assert.equal(cleanOpenedUrl('https://commons.wikimedia.org/w/api.php?action=query'), null);
assert.equal(cleanOpenedUrl('https://en.wikipedia.org/w/index.php?title=Jackie_Chan&action=raw'), 'https://en.wikipedia.org/wiki/Jackie_Chan');
assert.equal(cleanOpenedUrl('https://en.wikipedia.org/w/index.php?title=List_of_S%26P_500_companies&action=raw'), 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies');
assert.equal(cleanOpenedUrl('https://example.com/page?action=raw'), null);
assert.equal(cleanOpenedUrl('https://www.google.com/search?q=sp500'), null);
assert.equal(cleanOpenedUrl('https://www.bing.com/search?q=sp500'), null);
assert.equal(cleanOpenedUrl('https://duckduckgo.com/?q=sp500'), null);
assert.equal(cleanOpenedUrl('https://pypi.org/simple/pandas/'), null);
assert.equal(cleanOpenedUrl('https://upload.wikimedia.org/wikipedia/commons/f/f9/Jackie_Chan_2024.jpg'), null);
assert.equal(cleanOpenedUrl('https://example.com/chart.png'), null);

assert.equal(formatUrlLabel('https://www.dataroma.com/m/stock.php?sym=BRK.B'), 'dataroma.com/m/stock.php?sym=BRK.B');
assert.equal(formatUrlLabel('https://en.wikipedia.org/wiki/Jackie_Chan/'), 'en.wikipedia.org/wiki/Jackie_Chan');

assert.deepEqual(
  extractToolUrls({
    name: 'web_extract',
    args: { urls: ['https://en.wikipedia.org/wiki/Michael_Fassbender', 'https://example.com/photo.jpg'] },
    result: { results: [{ url: 'https://www.rottentomatoes.com/celebrity/michael_fassbender' }] },
  }),
  ['https://en.wikipedia.org/wiki/Michael_Fassbender', 'https://www.rottentomatoes.com/celebrity/michael_fassbender']
);
assert.deepEqual(
  extractToolUrls({
    name: 'browser_exec',
    args: { code: 'new_tab("https://www.dataroma.com/m/g/portfolio.php")\ngoto_url("https://www.dataroma.com/m/stock.php?sym=BRK.B")\ngoto_url(f"https://www.dataroma.com/m/activity.php?sym={sym}")' },
  }),
  ['https://www.dataroma.com/m/g/portfolio.php', 'https://www.dataroma.com/m/stock.php?sym=BRK.B']
);
assert.deepEqual(
  extractToolUrls({
    name: 'browser_cdp',
    args: { method: 'Page.navigate', params: { url: 'https://example.com/cdp-page' } },
  }),
  ['https://example.com/cdp-page']
);
assert.deepEqual(
  extractToolUrls({
    name: 'execute_code',
    args: {
      code: [
        'from hermes_tools import web_extract, web_search, terminal',
        'web_search("https://websearch-should-stay-ignored.example.com/q")',
        'print("https://not-fetched.example.com")',
        'terminal("curl -sL https://www.slickcharts.com/sp500")',
        'targets = ["https://sea.mashable.com/headphones/56997", "https://www.ownersreview.com/over-ear"]',
        'r1 = web_extract(["https://en.wikipedia.org/wiki/Michael_Fassbender"], char_limit=4000)',
        'r2 = web_extract(urls=targets, char_limit=6000)',
      ].join('\n'),
    },
  }),
  [
    'https://en.wikipedia.org/wiki/Michael_Fassbender',
    'https://sea.mashable.com/headphones/56997',
    'https://www.ownersreview.com/over-ear',
    'https://www.slickcharts.com/sp500',
  ]
);
assert.deepEqual(extractToolUrls({ name: 'web_search', args: { url: 'https://ignored.example.com' } }), []);
assert.deepEqual(extractToolUrls({ name: 'x_search', args: { url: 'https://ignored.example.com' } }), []);
assert.deepEqual(extractToolUrls({ name: 'vision_analyze', args: { image_url: 'https://example.com/page' } }), []);
assert.deepEqual(extractToolUrls({ name: 'terminal', args: { url: 'https://ignored.example.com' } }), []);
assert.deepEqual(extractToolUrls({ name: 'terminal', args: { command: 'echo https://not-fetched.example.com; pip install pandas' } }), []);
assert.deepEqual(
  extractToolUrls({
    name: 'terminal',
    args: {
      command: [
        'curl -sL -A "Bot (+https://bot.example.com)" https://www.slickcharts.com/sp500',
        'python3 -c "import urllib.request; urllib.request.urlopen(\'https://www.sec.gov/files/company_tickers.json\')"',
        'curl -s "https://data.sec.gov/api/xbrl/companyfacts/CIK{ciks[t]}.json"',
        'curl -s "https://en.wikipedia.org/wiki/Apple_(company)"',
      ].join('; '),
    },
  }),
  [
    'https://www.slickcharts.com/sp500',
    'https://www.sec.gov/files/company_tickers.json',
    'https://en.wikipedia.org/wiki/Apple_(company)',
  ]
);
assert.equal(
  extractToolUrls({
    name: 'web_extract',
    args: { urls: Array.from({ length: 12 }, (_, idx) => `https://example.com/p/${idx % 10}`) },
  }).length,
  8
);

// Live step URL + image DOM order, merge across quiet narration, save payload, and history restore
const urlImgLog = makeNode('div', 'log');
const urlPutPayloads = [];
let urlNarrateResp = { title: 'Checking sources & photos', step: 'Reading biography and checking portraits' };
const actUrl = createActivity({
  el: makeNode,
  logEl: urlImgLog,
  api: async (url, opts) => {
    if (url.endsWith('/narrate')) return urlNarrateResp;
    if (opts && opts.method === 'PUT') urlPutPayloads.push(JSON.parse(opts.body));
    return { ok: true };
  },
  getStoredId: () => 'chat-urls',
  fetchMedia: async (ref) => `data:image/png;base64,${ref}`,
  openViewer: () => {},
  isHidden: () => false,
});
const tailUrl = makeNode('div', 'msg assistant');
urlImgLog.append(tailUrl);
actUrl.setRequest('Read and verify photo');
actUrl.startTurn('t-url');
const ut = actUrl.ensureActiveTree({ insertBefore: tailUrl, label: 'Reading web page' });
actUrl.onToolStart('web_extract', { urls: ['https://en.wikipedia.org/wiki/Michael_Fassbender'] }, 'Reading web page');
actUrl.onToolComplete('vision_analyze', { image_url: '/tmp/portrait.png' }, 'ok', { image_path: '/tmp/portrait.png' });
await new Promise((r) => setTimeout(r, 600));
assert.deepEqual(ut.steps, ['Reading biography and checking portraits']);
assert.deepEqual(ut.stepUrls, [['https://en.wikipedia.org/wiki/Michael_Fassbender']]);
assert.deepEqual(ut.stepImages, [['/tmp/portrait.png']]);

// Verify DOM order inside itemEl: narration (.activity-step) -> links (.activity-urls) -> thumbs (.activity-thumbs)
await new Promise((r) => setTimeout(r, 20));
const combinedItem = ut.stepsEl.children[0];
assert.ok(combinedItem.children[0].classList.contains('activity-step'));
assert.equal(combinedItem.children[1].className, 'activity-urls');
assert.equal(combinedItem.children[2].className, 'activity-thumbs');
const linkNode = combinedItem.children[1].children[0];
assert.equal(linkNode.className, 'activity-url');
assert.equal(linkNode.href, 'https://en.wikipedia.org/wiki/Michael_Fassbender');
assert.equal(linkNode.target, '_blank');
assert.equal(linkNode.rel, 'noopener noreferrer');
assert.equal(linkNode.children[0].className, 'activity-url-text');
assert.equal(linkNode.children[0].textContent, 'en.wikipedia.org/wiki/Michael_Fassbender');

// Quiet poll merges a second opened URL onto step 0, then new subject attaches URL to step 1
urlNarrateResp = { step: null };
actUrl.onToolComplete('browser_exec', { code: 'goto_url("https://www.imdb.com/name/nm1055413/")' }, 'ok');
await new Promise((r) => setTimeout(r, 4200));
assert.deepEqual(ut.stepUrls, [[
  'https://en.wikipedia.org/wiki/Michael_Fassbender',
  'https://www.imdb.com/name/nm1055413/',
]]);

urlNarrateResp = { step: 'Checking awards history' };
actUrl.onToolComplete('web_extract', { urls: ['https://www.oscars.org/oscars'] }, 'ok');
await new Promise((r) => setTimeout(r, 4200));
assert.deepEqual(ut.stepUrls, [
  ['https://en.wikipedia.org/wiki/Michael_Fassbender', 'https://www.imdb.com/name/nm1055413/'],
  ['https://www.oscars.org/oscars'],
]);
assert.ok(urlPutPayloads.length >= 1);
assert.deepEqual(urlPutPayloads[urlPutPayloads.length - 1].step_urls, ut.stepUrls);

// Restore saved step_urls on expanded history tree
const urlHistLog = makeNode('div', 'log');
const urlHistApi = createActivity({
  el: makeNode,
  logEl: urlHistLog,
  api: async () => ({
    trees: [{
      id: 'u1',
      status: 'done',
      title: 'Past web read',
      steps: ['Opened article'],
      step_urls: [['https://en.wikipedia.org/wiki/Jackie_Chan']],
      started_at: 201,
      ended_at: 205,
      anchor_after_id: 1,
    }],
  }),
});
await urlHistApi.loadSessionTrees('chat-urls-hist');
urlHistApi.renderHistoryTrees('chat-urls-hist', [fakeEntry], () => {});
const restoredUrlNode = urlHistLog.children[0];
assert.ok(restoredUrlNode);
restoredUrlNode.children[0].click();
const restoredItem = restoredUrlNode.children[1].children[0].children[0];
assert.equal(restoredItem.children[1].className, 'activity-urls');
assert.equal(restoredItem.children[1].children[0].href, 'https://en.wikipedia.org/wiki/Jackie_Chan');

// Frontend fallback recovers a stale running tree whose reply already arrived while disconnected
const staleEntries = [
  { role: 'user', rowId: 50, ts: 1000, text: 'Tell me about Gaugamela' },
  { role: 'assistant', rowId: 51, ts: 1005, text: 'Gaugamela is the answer — looking into it.' },
  { role: 'assistant', rowId: 55, ts: 1245, text: '## Gaugamela\nThe decisive battle.' },
];
const staleTree = {
  id: 'stale-run-1',
  status: 'running',
  title: 'Checking Gaugamela',
  steps: ['Checking battle accounts'],
  step_images: [['https://upload.wikimedia.org/map1.png']],
  step_urls: [['https://en.wikipedia.org/wiki/Battle_of_Gaugamela']],
  started_at: 1004,
  ended_at: 0,
  anchor_after_match: 'gaugamela is the answer — looking into it.',
};
const matchedStale = matchTreesToEntries([staleTree], staleEntries, new Set());
assert.equal(matchedStale.before.get(2)?.length, 1);
assert.equal(matchedStale.before.get(2)[0].status, 'done');
assert.equal(matchedStale.before.get(2)[0].ended_at, 1245);

const staleLog = makeNode('div', 'log');
const staleApi = createActivity({
  el: makeNode,
  logEl: staleLog,
  api: async () => ({ trees: [staleTree] }),
});
await staleApi.loadSessionTrees('chat-stale-fe');
staleApi.renderHistoryTrees('chat-stale-fe', staleEntries, (entry) => staleLog.append(makeNode('div', `msg ${entry.role}`, entry.text)));
// Order: user(50), intro(51), recovered tree (before final reply), final reply(55)
assert.equal(staleLog.children.length, 4);
assert.equal(staleLog.children[2].className, 'activity-tree collapsed');

// Genuinely still-running tree (no assistant reply following it) stays unrendered in history (left for restoreLiveTree)
const stillRunning = matchTreesToEntries([staleTree], staleEntries.slice(0, 2), new Set());
assert.equal(stillRunning.before.size, 0);
assert.equal(stillRunning.after.size, 0);

// 7. Page-scoped stopped-tree placement, cross-chat ownership & edit pruning
const oldStopped = {
  id: 't-old-stop',
  status: 'stopped',
  title: 'Old interrupted task',
  steps: ['Step 1'],
  started_at: 500,
  ended_at: 520,
  anchor_after_match: 'old prompt here',
};
const newestPageEntries = [
  { role: 'user', rowId: 50, ts: 2000, text: 'latest question' },
  { role: 'assistant', rowId: 51, ts: 2010, text: 'latest reply' },
];
const pageRendered = new Set();
const newestPageMatch = matchTreesToEntries([oldStopped], newestPageEntries, pageRendered, { isOldestPage: false });
assert.equal(newestPageMatch.before.size, 0);
assert.equal(newestPageMatch.after.size, 0);
assert.equal(pageRendered.has('t-old-stop'), false);

// Scrolling up to the page containing the preceding message places the stopped tree after that message
const olderPageEntries = [
  { role: 'user', rowId: 10, ts: 498, text: 'old prompt here' },
  { role: 'user', rowId: 11, ts: 600, text: 'unrelated later prompt' },
];
const olderPageMatch = matchTreesToEntries([oldStopped], olderPageEntries, pageRendered, { isOldestPage: true });
assert.equal(olderPageMatch.after.get(0)?.[0]?.id, 't-old-stop');
assert.equal(pageRendered.has('t-old-stop'), true);

// Orphaned stopped tree on the very oldest page still places at top instead of dumping at bottom
const orphanStop = { id: 't-orphan-stop', status: 'stopped', title: 'Orphaned stop', steps: ['A'], started_at: 100 };
const orphanMatch = matchTreesToEntries([orphanStop], newestPageEntries, new Set(), { isOldestPage: true });
assert.equal(orphanMatch.before.get(0)?.[0]?.id, 't-orphan-stop');
assert.equal(orphanMatch.after.size, 0);

// Cross-chat race: switching currentSid while resolveRowId is pending still saves chat-A tree to chat-A only
let activeSid = 'chat-A';
const crossCalls = [];
const crossLog = makeNode('div', 'log');
const crossAct = createActivity({
  el: makeNode,
  logEl: crossLog,
  api: async (url, opts) => {
    crossCalls.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok: true };
  },
  getStoredId: () => activeSid,
  resolveRowId: async (_target, sidArg) => {
    activeSid = 'chat-B';
    await new Promise((r) => setTimeout(r, 15));
    return sidArg === 'chat-A' ? 77 : 99;
  },
});
crossAct.setRequest('Question in A');
crossAct.startTurn('turn-A');
crossAct.ensureActiveTree({ label: 'Checking in A' });
crossAct.onStatusLine('Checking item in A');
const replyInA = makeNode('div', 'msg assistant', 'Reply A');
replyInA.hermesMiniMsg = { role: 'assistant', text: 'Reply A', rowId: null };
crossAct.finalizeActiveForBubble({ rowEl: replyInA });
crossAct.attachBubbleAnchor({ rowEl: replyInA, text: 'Reply A' });
await new Promise((r) => setTimeout(r, 40));
const crossPuts = crossCalls.filter((c) => c.method === 'PUT');
assert.ok(crossPuts.length >= 2);
assert.ok(crossPuts.every((c) => c.url.includes('/activity/chat-A/')));
assert.ok(crossPuts.some((c) => c.body && c.body.anchor_before_id === 77));
assert.equal(crossCalls.some((c) => c.url.includes('/activity/chat-B/')), false);

// Edit pruning removes cache + running active tree and hits DELETE with from_row_id/from_ts
const pruneCalls = [];
const pruneLog = makeNode('div', 'log');
const pruneAct = createActivity({
  el: makeNode,
  logEl: pruneLog,
  api: async (url, opts) => {
    pruneCalls.push({ url, method: (opts && opts.method) || 'GET' });
    if ((opts && opts.method) === 'DELETE') return { ok: true };
    return {
      trees: [
        { id: 'p-keep', status: 'done', title: 'Early', steps: ['Step 1'], started_at: 40, ended_at: 45, anchor_before_id: 5 },
        { id: 'p-drop', status: 'done', title: 'Truncated', steps: ['Step 2'], started_at: 110, ended_at: 115, anchor_before_id: 12 },
      ],
    };
  },
  getStoredId: () => 'chat-prune',
});
await pruneAct.loadSessionTrees('chat-prune');
await pruneAct.pruneSessionFrom('chat-prune', { fromRowId: 10, fromTs: 100 });
assert.ok(pruneCalls.some((c) => c.method === 'DELETE' && c.url.includes('/activity/chat-prune?from_row_id=10&from_ts=100')));
pruneAct.renderHistoryTrees('chat-prune', [
  { role: 'user', rowId: 4, ts: 35, text: 'Earlier prompt' },
  { role: 'assistant', rowId: 5, ts: 45, text: 'Earlier answer' },
  { role: 'user', rowId: 20, ts: 200, text: 'Edited prompt' },
], (entry) => pruneLog.append(makeNode('div', `msg ${entry.role}`, entry.text)), { isOldestPage: true });
assert.equal(pruneLog.children.filter((n) => n.dataset?.treeId === 'p-keep').length, 1);
assert.equal(pruneLog.children.filter((n) => n.dataset?.treeId === 'p-drop').length, 0);

// 8. Unanchored done trees respect anchor_after + user boundaries, and pruneSessionFrom honors beforeTs
const unanchoredAckEntries = [
  { role: 'user', rowId: 100, ts: 1000, text: 'Plan two days in Antipolo' },
  { role: 'assistant', rowId: 101, ts: 1004, text: 'Got it — two days in Antipolo with a car.' },
  { role: 'assistant', rowId: 102, ts: 1080, text: 'Day 1 starts at Pinto Art Museum.' },
];
const unanchoredTree = {
  id: 't-unanchored-ack',
  status: 'done',
  title: 'Planning road trip',
  steps: ['Checking attractions'],
  started_at: 1003,
  ended_at: 1075,
  anchor_after_match: 'got it — two days in antipolo with a car.',
};
const placedUnanchored = matchTreesToEntries([unanchoredTree], unanchoredAckEntries, new Set(), { isOldestPage: true });
assert.equal(placedUnanchored.before.get(2)?.[0]?.id, 't-unanchored-ack');
assert.equal(placedUnanchored.before.has(1), false);

// Failed turn without reply and without saved error row must NOT cross user turn to steal next reply
const failedCrossTurnEntries = [
  { role: 'user', rowId: 200, ts: 2000, text: 'Run failing report' },
  { role: 'assistant', rowId: 201, ts: 2002, text: 'Starting report.' },
  { role: 'user', rowId: 202, ts: 2050, text: 'Never mind, say hi' },
  { role: 'assistant', rowId: 203, ts: 2055, text: 'Hello!' },
];
const unanchoredFailed = {
  id: 't-failed-no-reply',
  status: 'done',
  title: 'Report run',
  steps: ['Pulling metrics'],
  started_at: 2003,
  ended_at: 2020,
  anchor_after_id: 201,
  anchor_after_match: 'starting report.',
};
const placedFailed = matchTreesToEntries([unanchoredFailed], failedCrossTurnEntries, new Set(), { isOldestPage: true });
assert.equal(placedFailed.before.size, 0);
assert.equal(placedFailed.after.get(1)?.[0]?.id, 't-failed-no-reply');

// pruneSessionFrom with beforeTs keeps a brand-new replacement turn active & in cache
const beforePruneCalls = [];
const beforePruneLog = makeNode('div', 'log');
const beforeAct = createActivity({
  el: makeNode,
  logEl: beforePruneLog,
  nowMs: () => 505000,
  api: async (url, opts) => {
    beforePruneCalls.push({ url, method: (opts && opts.method) || 'GET' });
    if ((opts && opts.method) === 'DELETE') return { ok: true };
    return {
      trees: [
        { id: 'old-drop', status: 'done', title: 'Old edit target', steps: ['Old'], started_at: 110, ended_at: 115, anchor_before_id: 12 },
        { id: 'new-keep', status: 'done', title: 'New replacement', steps: ['New'], started_at: 505, ended_at: 510 },
      ],
    };
  },
  getStoredId: () => 'chat-before',
});
await beforeAct.loadSessionTrees('chat-before');
beforeAct.ensureActiveTree({ label: 'Running replacement turn' });
await beforeAct.pruneSessionFrom('chat-before', { fromRowId: 10, fromTs: 100, beforeTs: 500 });
assert.equal(beforeAct.hasActiveTree(), true);
assert.ok(beforePruneCalls.some((c) => c.method === 'DELETE' && c.url.includes('/activity/chat-before?from_row_id=10&from_ts=100&before_ts=500')));
const afterBeforeLog = makeNode('div', 'log');
const beforeRendered = [];
beforeAct.renderHistoryTrees('chat-before', [
  { role: 'user', rowId: 20, ts: 504, text: 'Edited prompt' },
  { role: 'assistant', rowId: 21, ts: 510, text: 'Replacement answer' },
], (entry) => beforeRendered.push(entry.text), { isOldestPage: true });
// old-drop is pruned; new-keep survives in cache and renders before replacement answer
assert.equal(beforePruneLog.children.filter((n) => n.dataset?.treeId === 'new-keep').length, 1);
assert.equal(beforePruneLog.children.filter((n) => n.dataset?.treeId === 'old-drop').length, 0);

// 9. Strict image-ref validation: private hosts, credentials and template braces rejected; file:// stripped
assert.equal(cleanImageRef('https://example.com/photo.png'), 'https://example.com/photo.png');
assert.equal(cleanImageRef('file:///tmp/x.png'), '/tmp/x.png');
assert.equal(cleanImageRef('/tmp/x.png'), '/tmp/x.png');
assert.equal(cleanImageRef('https://localhost/a.png'), null);
assert.equal(cleanImageRef('https://127.0.0.1/a.png'), null);
assert.equal(cleanImageRef('https://192.168.1.5/a.png'), null);
assert.equal(cleanImageRef('https://[::1]/a.png'), null);
assert.equal(cleanImageRef('https://user:pass@example.com/a.png'), null);
assert.equal(cleanImageRef('https://example.com/{x}.png'), null);
assert.equal(cleanImageRef('/etc/passwd'), null);
assert.deepEqual(
  extractToolImages({ image_path: 'https://localhost/a.png', args: { image_url: 'https://192.168.1.5/b.png' }, result: { image_path: 'https://example.com/ok.png' } }),
  ['https://example.com/ok.png'],
);

// 10. expectReply:false clears pendingAnchorTree/anchors so a silent completion never steals the next reply
const silentLog = makeNode('div', 'log');
const silentCalls = [];
const silentAct = createActivity({
  el: makeNode,
  logEl: silentLog,
  api: async (url, opts) => { silentCalls.push({ url, opts }); return { ok: true }; },
  getStoredId: () => 'chat-silent',
});
silentAct.setRequest('Quiet check');
silentAct.startTurn('t-silent');
const st = silentAct.ensureActiveTree({ label: 'Checking quietly' });
silentAct.onStatusLine('Checking quietly');
assert.equal(silentAct.hasActiveTree(), true);
const finalized = silentAct.finalizeActiveForBubble({ rowEl: null, expectReply: false });
assert.equal(finalized.status, 'done');
assert.equal(finalized.targetRow, null);
assert.equal(finalized.anchorBeforeMatch, '');
assert.equal(finalized.anchorBeforeId, null);
assert.equal(silentAct.hasPendingAnchor(), false);
assert.equal(silentAct.hasActiveTree(), false);
await new Promise((r) => setTimeout(r, 20));
const silentPut = silentCalls.filter((c) => c.opts && c.opts.method === 'PUT').at(-1);
assert.equal(JSON.parse(silentPut.opts.body).status, 'done');
assert.equal(JSON.parse(silentPut.opts.body).anchor_before_id, null);
assert.equal(JSON.parse(silentPut.opts.body).anchor_before_match, '');

// matchTreesToEntries: that unanchored done tree sits after its preceding bubble, never on the next turn's reply
const afterEntries = [
  { role: 'user', rowId: 300, ts: 3000, text: 'Quiet check' },
  { role: 'assistant', rowId: 301, ts: 3002, text: 'Checking quietly.' },
  { role: 'user', rowId: 310, ts: 4000, text: 'New question' },
  { role: 'assistant', rowId: 311, ts: 4010, text: 'New answer' },
];
const silentTree = {
  id: 'silent-tree', status: 'done', title: 'Quiet check', steps: ['Checking quietly'],
  started_at: 3001, ended_at: 3050, anchor_after_id: 301, anchor_after_match: 'checking quietly.',
};
const silentPlaced = matchTreesToEntries([silentTree], afterEntries, new Set(), { isOldestPage: true });
assert.equal(silentPlaced.before.size, 0);
assert.equal(silentPlaced.after.get(1)?.[0]?.id, 'silent-tree');

// abandonActive({ removeDom: true }) drops an active tree that already has steps from the DOM
const abandonLog = makeNode('div', 'log');
const abandonAct = createActivity({ el: makeNode, logEl: abandonLog, api: async () => ({ ok: true }), getStoredId: () => 'chat-abandon' });
abandonAct.ensureActiveTree({ label: 'Working on it' });
abandonAct.onStatusLine('Working on it');
assert.equal(abandonLog.children.length, 1);
abandonAct.abandonActive({ removeDom: true });
assert.equal(abandonLog.children.length, 0);
assert.equal(abandonAct.hasActiveTree(), false);

// 11. saveTree serializes/coalesces PUTs: a delayed first PUT cannot let "running" land after "done"
const queueCalls = [];
let queueStart = 0;
let queueDelayed = true;
let livePuts = 0;
let maxLivePuts = 0;
const queueAct = createActivity({
  el: makeNode,
  logEl: makeNode('div', 'log'),
  api: async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    const call = { url, method: (opts && opts.method) || 'GET', body };
    queueCalls.push(call);
    if (opts && opts.method === 'PUT') {
      call.start = ++queueStart;
      livePuts += 1;
      maxLivePuts = Math.max(maxLivePuts, livePuts);
      if (queueDelayed) {
        queueDelayed = false;
        await new Promise((r) => setTimeout(r, 60));
      }
      livePuts -= 1;
    }
    return { ok: true };
  },
  getStoredId: () => 'chat-queue',
});
queueAct.setRequest('Serialized saves');
queueAct.startTurn('t-queue');
const qt = queueAct.ensureActiveTree({ label: 'Working' });
// Trigger a run-time save (still "running"), then finalize to "done" while that PUT is still in flight.
queueAct.onStatusLine('First step');
await new Promise((r) => setTimeout(r, 5));
queueAct.onStatusLine('Second step');
queueAct.finalizeActiveForBubble({ rowEl: null, expectReply: false });
await new Promise((r) => setTimeout(r, 250));
const queuePuts = queueCalls.filter((c) => c.method === 'PUT');
assert.ok(queuePuts.length >= 2, 'expected at least two serialized PUTs');
assert.equal(qt.status, 'done');
assert.equal(queuePuts[queuePuts.length - 1].body.status, 'done');
assert.equal(maxLivePuts, 1, 'PUTs for one tree must be serialized, never concurrent');
assert.deepEqual(queuePuts.map((c) => c.body.status).slice(-1), ['done']);

// 12. deleteSession / pruneSessionFrom wait for in-flight PUTs before DELETE, and a delayed resolveRowId save
//     cannot resurrect a deleted tree
const delCalls = [];
let resolveHold = null;
const delAct = createActivity({
  el: makeNode,
  logEl: makeNode('div', 'log'),
  api: async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    delCalls.push({ url, method });
    if (method === 'PUT') await new Promise((r) => setTimeout(r, 60));
    return { ok: true };
  },
  getStoredId: () => 'chat-del',
  resolveRowId: async () => {
    await new Promise((r) => { resolveHold = r; });
    return 404;
  },
});
delAct.setRequest('Deleting chat');
delAct.startTurn('t-del');
const dt = delAct.ensureActiveTree({ label: 'Working' });
delAct.onStatusLine('Step');
const delReply = makeNode('div', 'msg assistant', 'Reply');
delReply.hermesMiniMsg = { text: 'Reply', rowId: null };
delAct.finalizeActiveForBubble({ rowEl: delReply });
delAct.attachBubbleAnchor({ rowEl: delReply, text: 'Reply' });
await new Promise((r) => setTimeout(r, 10));
const delPromise = delAct.deleteSession('chat-del');
if (resolveHold) resolveHold();
await delPromise;
await new Promise((r) => setTimeout(r, 120));
const delDeleteIdx = delCalls.findIndex((c) => c.method === 'DELETE');
assert.ok(delDeleteIdx !== -1);
const putsBeforeDelete = delCalls.slice(0, delDeleteIdx).filter((c) => c.method === 'PUT').length;
const putsAfterDelete = delCalls.slice(delDeleteIdx).filter((c) => c.method === 'PUT').length;
assert.ok(putsBeforeDelete >= 1);
assert.equal(putsAfterDelete, 0, 'no save may resurrect a deleted tree');

// pruneSessionFrom: the DELETE is sent only after the pruned tree's in-flight PUT settles, and no save revives it
const pruneWaitCalls = [];
const pruneWaitAct = createActivity({
  el: makeNode,
  logEl: makeNode('div', 'log'),
  api: async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    pruneWaitCalls.push({ url, method });
    if (method === 'PUT') await new Promise((r) => setTimeout(r, 60));
    if (method === 'GET' && url.includes('/activity/')) {
      return { trees: [{ id: 'pw-1', status: 'done', title: 'T', steps: ['s'], started_at: 110, ended_at: 115, anchor_before_id: 12 }] };
    }
    return { ok: true };
  },
  getStoredId: () => 'chat-prune-wait',
});
await pruneWaitAct.loadSessionTrees('chat-prune-wait');
const pwt = pruneWaitAct.ensureActiveTree({ label: 'Pruning me' });
pruneWaitAct.onStatusLine('Doing work');
await new Promise((r) => setTimeout(r, 5));
await pruneWaitAct.pruneSessionFrom('chat-prune-wait', { fromRowId: 10, fromTs: 100 });
const pwDeleteIdx = pruneWaitCalls.findIndex((c) => c.method === 'DELETE');
assert.ok(pwDeleteIdx !== -1);
assert.ok(pruneWaitCalls.slice(0, pwDeleteIdx).filter((c) => c.method === 'PUT').length >= 1);
assert.equal(pruneWaitCalls.slice(pwDeleteIdx).filter((c) => c.method === 'PUT').length, 0, 'no save may revive a pruned tree');
assert.equal(pruneWaitAct.hasActiveTree(), false);
assert.equal(pwt.sid, 'chat-prune-wait');

// 13. referrerPolicy is assigned BEFORE src on both the probe and the rendered thumbnail
const refLog = makeNode('div', 'log');
const refImgs = [];
const refSrcOrder = [];
const refAct = createActivity({
  el: (tag, className, text) => {
    const node = makeNode(tag, className, text);
    if (tag === 'img') {
      let srcVal = '';
      Object.defineProperty(node, 'src', {
        get() { return srcVal; },
        set(v) {
          srcVal = String(v);
          refSrcOrder.push({ src: srcVal, policy: node.referrerPolicy });
        },
        configurable: true,
      });
      refImgs.push(node);
    }
    return node;
  },
  logEl: refLog,
  api: async (url) => (url.endsWith('/narrate') ? { step: null } : { ok: true }),
  getStoredId: () => 'chat-ref',
  fetchMedia: async (ref) => `data:image/png;base64,${ref}`,
  isHidden: () => false,
});
const refTail = makeNode('div', 'msg assistant');
refLog.append(refTail);
refAct.startTurn('t-ref');
refAct.ensureActiveTree({ insertBefore: refTail, label: 'Looking at remote picture' });
refAct.onToolComplete('vision_analyze', { image_url: 'https://example.com/pic.png' }, 'ok', { image_path: 'https://example.com/pic.png' });
refAct.onStatusLine('Looking at remote picture');
await new Promise((r) => setTimeout(r, 20));
const refProbe = refImgs.find((n) => n.src === 'https://example.com/pic.png');
assert.ok(refProbe, 'probe img for the https thumbnail must exist');
assert.equal(refProbe.referrerPolicy, 'no-referrer');
// Fire the probe's load event: the same render pass (no narration change) appends the thumbnail.
for (const fn of refProbe.listeners.load || []) fn({});
await new Promise((r) => setTimeout(r, 20));
assert.ok(refImgs.length >= 2, 'rendered thumbnail img must exist after the probe loads');
assert.ok(refImgs.every((n) => n.referrerPolicy === 'no-referrer'));
assert.ok(refSrcOrder.length >= 2);
assert.ok(refSrcOrder.every((e) => e.policy === 'no-referrer'), 'referrerPolicy must be set before src');

queueAct.abandonActive();
silentAct.abandonActive();
abandonAct.abandonActive();
delAct.abandonActive();
pruneWaitAct.abandonActive();
refAct.abandonActive();

act.abandonActive();
actImg.abandonActive();
apiWithSaved.abandonActive();
actUrl.abandonActive();
urlHistApi.abandonActive();
staleApi.abandonActive();
crossAct.abandonActive();
pruneAct.abandonActive();
beforeAct.abandonActive();
"""


class ActivityFrontendTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node is needed for the browser module")
    def test_activity_module_state_lifecycle_and_matching(self):
        run = subprocess.run(
            ["node", "--input-type=module", "-e", NODE_SCRIPT, str(DASHBOARD / "activity.js")],
            text=True,
            capture_output=True,
            timeout=30,
        )
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_app_and_sw_wire_activity_module(self):
        sw = (DASHBOARD / "sw.js").read_text(encoding="utf-8")
        core = sw.split("const CORE = [", 1)[1].split("];", 1)[0]
        self.assertIn('"activity.js"', core)
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        self.assertIn('import { createActivity } from "./activity.js";', app)
        act_js = (DASHBOARD / "activity.js").read_text(encoding="utf-8")
        self.assertIn("You stopped this response", act_js)
        self.assertIn('<circle cx="8" cy="8" r="6"/>', act_js)
        self.assertIn('<line x1="3.8" y1="3.8" x2="12.2" y2="12.2"/>', act_js)
        css = (DASHBOARD / "style.css").read_text(encoding="utf-8")
        self.assertIn(".activity-tree", css)
        self.assertIn(".activity-step::before", css)
        self.assertIn(".activity-stopped-icon", css)
        self.assertIn(".activity-thumbs", css)
        self.assertIn(".activity-thumb", css)
        self.assertIn(".activity-typing", css)
        self.assertIn(".msg[hidden]", css)
        self.assertIn("treeHidesWait", app)

    def test_app_guards_hidden_turns_and_closes_outlines_without_reply(self):
        app = (DASHBOARD / "app.js").read_text(encoding="utf-8")
        # Hidden turns touch nothing the drawing layer owns.
        for case in ("tool.start", "tool.complete", "reasoning.delta", "thinking.delta", "status.update"):
            start = app.index(f'case "{case}":')
            self.assertIn("if (state.hiddenTurn) break;", app[start:start + 200], case)
        # A hidden completion abandons the outline with its DOM; a silent one closes it in place.
        hidden_block = app[app.index('case "message.complete":'):]
        self.assertIn("activity.abandonActive({ removeDom: true });", hidden_block)
        self.assertIn("activity.finalizeActiveForBubble({ rowEl: null, expectReply: false });", hidden_block)
        # A seeded tail finalizes against the on-screen row so finishTurn attaches text + durable row id.
        self.assertIn("activity.finalizeActiveForBubble({ rowEl: state.turn.row });", hidden_block)
        self.assertIn("showNote: !text || Boolean(repeat)", hidden_block)
        # The error path never leaves a stray pending anchor.
        err = app[app.index('case "error":'):]
        self.assertIn("activity.finalizeActiveForBubble({ rowEl: null, expectReply: false });", err[err.index("activity.hasActiveTree"):])
        sw = (DASHBOARD / "sw.js").read_text(encoding="utf-8")
        self.assertIn('const CACHE = "hermes-mini-v111";', sw)


@unittest.skipUnless(HAVE_FASTAPI, "FastAPI is not installed in this environment")
class ActivityRouteTest(DisposableHome):
    def setUp(self):
        super().setUp()
        self.app, self.api = build_app()
        self.client = TestClient(self.app, raise_server_exceptions=False)

    def _db_with_compaction(self):
        conn = sqlite3.connect(self.home / "state.db")
        self.addCleanup(conn.close)
        conn.execute("CREATE TABLE sessions (id TEXT, title TEXT, archived INTEGER)")
        conn.execute(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,"
            " display_kind TEXT, display_metadata TEXT, timestamp REAL, finish_reason TEXT, tool_calls TEXT,"
            " active INTEGER, compacted INTEGER, message_uid TEXT, display_order INTEGER)"
        )
        conn.execute("CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL, acquired_at REAL)")
        conn.execute("INSERT INTO sessions VALUES ('chat-1', 'Research', 0)")
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, timestamp, active, compacted, message_uid, display_order) "
            "VALUES (100, 'chat-1', 'assistant', 'Final answer', 1000.0, 0, 1, 'uid-reply-1', 1)"
        )
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, timestamp, active, compacted, message_uid, display_order) "
            "VALUES (250, 'chat-1', 'assistant', 'Final answer', 1000.0, 1, 0, 'uid-reply-1', 1)"
        )
        conn.commit()
        return conn

    def test_narrate_tree_mode_and_quiet_no_change(self):
        fake_llm_mod = types.ModuleType("agent.plugin_llm")
        responses = [
            '```json\n{"title": "Comparing self-hosted apps...", "step": "Checking Bitwarden features."}\n```',
            '{"step": null}',
            '{"step": "Checking Bitwarden features"}',
            '{"step": "Checking Linkwarden bookmark sync"}',
        ]

        class FakeLlm:
            def __init__(self, **_kw):
                pass

            async def acomplete(self, *_args, **_kw):
                return types.SimpleNamespace(text=responses.pop(0))

        fake_llm_mod.PluginLlm = FakeLlm
        fake_agent_pkg = types.ModuleType("agent")
        fake_agent_pkg.plugin_llm = fake_llm_mod

        with mock.patch.dict("sys.modules", {"agent": fake_agent_pkg, "agent.plugin_llm": fake_llm_mod}):
            r1 = self.client.post("/api/plugins/hermes-mini/narrate", json={
                "mode": "tree",
                "request": "Compare 8 apps",
                "title": "",
                "previous": [],
                "events": [{"kind": "tool", "name": "web_search", "status": "running"}],
            })
            self.assertEqual(r1.status_code, 200)
            self.assertEqual(r1.json(), {
                "title": "Comparing self-hosted apps",
                "step": "Checking Bitwarden features",
                "line": "Checking Bitwarden features",
            })

            r2 = self.client.post("/api/plugins/hermes-mini/narrate", json={
                "mode": "tree",
                "request": "Compare 8 apps",
                "title": "Comparing self-hosted apps",
                "previous": ["Checking Bitwarden features"],
                "events": [{"kind": "tool", "name": "web_fetch", "status": "done"}],
            })
            self.assertEqual(r2.json(), {"title": None, "step": None, "line": None})

            r3 = self.client.post("/api/plugins/hermes-mini/narrate", json={
                "mode": "tree",
                "request": "Compare 8 apps",
                "title": "Comparing self-hosted apps",
                "previous": ["Checking Bitwarden features"],
                "events": [{"kind": "tool", "name": "web_fetch", "status": "done"}],
            })
            self.assertEqual(r3.json(), {"title": None, "step": None, "line": None})

            r4 = self.client.post("/api/plugins/hermes-mini/narrate", json={
                "mode": "tree",
                "request": "Compare 8 apps",
                "title": "Comparing self-hosted apps",
                "previous": ["Checking Bitwarden features"],
                "events": [{"kind": "tool", "name": "web_search", "status": "running"}],
            })
            self.assertEqual(r4.json(), {
                "title": None,
                "step": "Checking Linkwarden bookmark sync",
                "line": "Checking Linkwarden bookmark sync",
            })

    def test_activity_store_put_get_delete_and_compaction_resolution(self):
        self._db_with_compaction()
        put = self.client.put("/api/plugins/hermes-mini/activity/chat-1/tree-1", json={
            "id": "tree-1",
            "turn_id": "t1",
            "title": "Comparing apps",
            "steps": ["Checking Bitwarden", "Checking Vaultwarden"],
            "status": "done",
            "started_at": 900.0,
            "ended_at": 999.0,
            "anchor_before_id": 100,
            "anchor_before_match": "Final answer",
        })
        self.assertEqual(put.status_code, 200)
        self.assertTrue(put.json()["ok"])

        got = self.client.get("/api/plugins/hermes-mini/activity/chat-1")
        self.assertEqual(got.status_code, 200)
        trees = got.json()["trees"]
        self.assertEqual(len(trees), 1)
        self.assertEqual(trees[0]["anchor_before_id"], 250)  # followed compaction copy

        deleted = self.client.delete("/api/plugins/hermes-mini/activity/chat-1")
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(self.client.get("/api/plugins/hermes-mini/activity/chat-1").json()["trees"], [])

    def test_activity_step_images_stored_filtered_and_backward_compatible(self):
        put = self.client.put("/api/plugins/hermes-mini/activity/chat-img/t-img", json={
            "id": "t-img",
            "title": "Image check",
            "steps": ["Bitwarden shots", "Linkwarden shots"],
            "step_images": [
                ["/tmp/a.png", "https://example.com/b.jpg", "javascript:alert(1)", "data:image/png;base64,zz", "http://bad.local/c.png", "/tmp/a.png"],
                ["~/Downloads/d.webp"],
            ],
            "status": "done",
            "started_at": 100.0,
        })
        self.assertEqual(put.status_code, 200)
        got = self.client.get("/api/plugins/hermes-mini/activity/chat-img").json()["trees"]
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["step_images"], [
            ["/tmp/a.png", "https://example.com/b.jpg"],
            ["~/Downloads/d.webp"],
        ])

        # Legacy records without step_images still load cleanly
        put_old = self.client.put("/api/plugins/hermes-mini/activity/chat-img/t-old", json={
            "id": "t-old",
            "title": "Old tree",
            "steps": ["Plain step"],
            "status": "done",
            "started_at": 50.0,
        })
        self.assertEqual(put_old.status_code, 200)
        got_all = self.client.get("/api/plugins/hermes-mini/activity/chat-img").json()["trees"]
        self.assertEqual(got_all[0]["step_images"], [])

    def test_activity_step_urls_stored_filtered_and_backward_compatible(self):
        many_urls = [f"https://example.com/article/{i}" for i in range(12)]
        put = self.client.put("/api/plugins/hermes-mini/activity/chat-url/t-url", json={
            "id": "t-url",
            "title": "URL check",
            "steps": ["Reading pages", "Checking lots of pages"],
            "step_urls": [
                [
                    "https://en.wikipedia.org/wiki/Jackie_Chan",
                    "http://example.org/notes",
                    "https://en.wikipedia.org/wiki/Jackie_Chan",
                    "javascript:alert(1)",
                    "http://localhost:9119/",
                    "http://127.0.0.1:8080/a",
                    "http://192.168.1.2/admin",
                    "http://10.0.0.1/internal",
                    "https://[::1]/local",
                    "https://user:pass@example.com/secret",
                    "https://example.com/{sym}",
                    "https://commons.wikimedia.org/w/api.php?action=query",
                    "https://en.wikipedia.org/w/index.php?title=Jackie_Chan&action=raw",
                    "https://en.wikipedia.org/w/index.php?title=Michael_Fassbender&action=raw",
                    "https://example.com/rawpage?action=raw",
                    "https://www.google.com/search?q=sp500",
                    "https://www.bing.com/search?q=sp500",
                    "https://duckduckgo.com/?q=sp500",
                    "https://pypi.org/simple/pandas/",
                ],
                many_urls,
            ],
            "status": "done",
            "started_at": 100.0,
        })
        self.assertEqual(put.status_code, 200)
        got = self.client.get("/api/plugins/hermes-mini/activity/chat-url").json()["trees"]
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["step_urls"], [
            [
                "https://en.wikipedia.org/wiki/Jackie_Chan",
                "http://example.org/notes",
                "https://en.wikipedia.org/wiki/Michael_Fassbender",
            ],
            many_urls[:8],
        ])

        put_old = self.client.put("/api/plugins/hermes-mini/activity/chat-url/t-old", json={
            "id": "t-old",
            "title": "Old tree",
            "steps": ["Plain step"],
            "status": "done",
            "started_at": 50.0,
        })
        self.assertEqual(put_old.status_code, 200)
        got_all = self.client.get("/api/plugins/hermes-mini/activity/chat-url").json()["trees"]
        self.assertEqual(got_all[0]["step_urls"], [])

    def test_stale_running_tree_reconciled_and_backfilled_from_state_db(self):
        conn = sqlite3.connect(self.home / "state.db")
        self.addCleanup(conn.close)
        conn.execute("CREATE TABLE sessions (id TEXT, title TEXT, archived INTEGER)")
        conn.execute(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,"
            " tool_calls TEXT, tool_name TEXT, tool_call_id TEXT, timestamp REAL, display_kind TEXT,"
            " active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0, message_uid TEXT, display_order INTEGER)"
        )
        conn.execute("CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL, acquired_at REAL)")
        conn.execute("INSERT INTO sessions VALUES ('chat-stale', 'Gaugamela', 0)")
        conn.execute("INSERT INTO sessions VALUES ('chat-live', 'Live run', 0)")
        conn.execute("INSERT INTO sessions VALUES ('chat-abandoned', 'Abandoned run', 0)")

        # 1. Completed while client was disconnected: intro bubble + tool calls + final reply 3+ mins later
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (10, 'chat-stale', 'user', 'Tell me about Gaugamela', 1000.0)"
        )
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
            (
                11,
                "chat-stale",
                "assistant",
                "Gaugamela is the answer — looking into it.",
                json.dumps([{
                    "id": "c1",
                    "function": {
                        "name": "execute_code",
                        "arguments": json.dumps({
                            "code": 'from hermes_tools import web_extract, web_search\nweb_search("gaugamela")\nweb_extract(["https://en.wikipedia.org/wiki/Battle_of_Gaugamela"])'
                        }),
                    },
                }]),
                1005.0,
            ),
        )
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, tool_name, tool_call_id, timestamp) VALUES (12, 'chat-stale', 'tool', 'ok', 'execute_code', 'c1', 1008.0)"
        )
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
            (
                13,
                "chat-stale",
                "assistant",
                "",
                json.dumps([{
                    "id": "c2",
                    "function": {"name": "vision_analyze", "arguments": json.dumps({"image_url": "https://upload.wikimedia.org/map1.png"})},
                }]),
                1020.0,
            ),
        )
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, tool_name, tool_call_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)", (14, "chat-stale", "tool", json.dumps({"success": True}), "vision_analyze", "c2", 1040.0)
        )
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
            (
                15,
                "chat-stale",
                "assistant",
                "",
                json.dumps([
                    {
                        "id": "c3",
                        "function": {"name": "browser_exec", "arguments": json.dumps({"code": 'goto_url("https://www.britannica.com/event/Battle-of-Gaugamela")'})},
                    },
                    {
                        "id": "c4",
                        "function": {"name": "vision_analyze", "arguments": json.dumps({"image_url": "https://upload.wikimedia.org/map2.png"})},
                    },
                    {
                        "id": "c5",
                        "function": {"name": "terminal", "arguments": json.dumps({"command": "curl -sL https://www.slickcharts.com/sp500 && curl -s https://commons.wikimedia.org/w/api.php?action=query"})},
                    },
                ]),
                1100.0,
            ),
        )
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, tool_name, tool_call_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)", (16, "chat-stale", "tool", json.dumps({"success": True}), "browser_exec", "c3", 1120.0)
        )
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, tool_name, tool_call_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)", (17, "chat-stale", "tool", json.dumps({"success": True}), "vision_analyze", "c4", 1140.0)
        )
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (18, 'chat-stale', 'assistant', '## Gaugamela\nThe decisive battle.', 1200.0)"
        )

        # 2. Genuinely still-running turn (no final assistant reply yet)
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (20, 'chat-live', 'user', 'Check something live', 2000.0)"
        )
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (21, 'chat-live', 'assistant', 'Working on it now.', 2002.0)"
        )

        # 3. Interrupted turn superseded by next user prompt without a reply
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (30, 'chat-abandoned', 'user', 'Old question', 3000.0)"
        )
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (31, 'chat-abandoned', 'assistant', 'Checking old question.', 3002.0)"
        )
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (32, 'chat-abandoned', 'user', 'New question instead', 3050.0)"
        )
        conn.commit()

        self.client.put("/api/plugins/hermes-mini/activity/chat-stale/t-stale", json={
            "id": "t-stale",
            "title": "Finding victory details",
            "steps": ["Checking historical accounts"],
            "step_images": [["https://upload.wikimedia.org/map1.png"]],
            "status": "running",
            "started_at": 1004.0,
            "ended_at": 0.0,
            "anchor_after_match": "gaugamela is the answer — looking into it.",
        })
        self.client.put("/api/plugins/hermes-mini/activity/chat-live/t-live", json={
            "id": "t-live",
            "title": "Checking live",
            "steps": ["Step 1"],
            "status": "running",
            "started_at": 2001.0,
            "ended_at": 0.0,
            "anchor_after_match": "working on it now.",
        })
        self.client.put("/api/plugins/hermes-mini/activity/chat-abandoned/t-abandoned", json={
            "id": "t-abandoned",
            "title": "Old work",
            "steps": ["Looking it up"],
            "status": "running",
            "started_at": 3001.0,
            "ended_at": 0.0,
            "anchor_after_match": "checking old question.",
        })

        got_stale = self.client.get("/api/plugins/hermes-mini/activity/chat-stale").json()["trees"]
        self.assertEqual(len(got_stale), 1)
        t = got_stale[0]
        self.assertEqual(t["status"], "done")
        self.assertEqual(t["ended_at"], 1200.0)
        self.assertEqual(t["anchor_before_id"], 18)
        self.assertTrue(t["anchor_before_match"].startswith("## gaugamela"))
        self.assertEqual(t["step_images"], [[
            "https://upload.wikimedia.org/map1.png",
            "https://upload.wikimedia.org/map2.png",
        ]])
        self.assertEqual(t["step_urls"], [[
            "https://en.wikipedia.org/wiki/Battle_of_Gaugamela",
            "https://www.britannica.com/event/Battle-of-Gaugamela",
            "https://www.slickcharts.com/sp500",
        ]])

        # Second read stays reconciled on disk
        got_again = self.client.get("/api/plugins/hermes-mini/activity/chat-stale").json()["trees"]
        self.assertEqual(got_again[0]["status"], "done")
        self.assertEqual(got_again[0]["anchor_before_id"], 18)

        # Genuinely live turn stays running
        got_live = self.client.get("/api/plugins/hermes-mini/activity/chat-live").json()["trees"]
        self.assertEqual(got_live[0]["status"], "running")

        # Superseded running turn becomes stopped
        got_abandoned = self.client.get("/api/plugins/hermes-mini/activity/chat-abandoned").json()["trees"]
        self.assertEqual(got_abandoned[0]["status"], "stopped")

    def test_clearing_app_home_removes_old_home_activity(self):
        self.client.post("/api/plugins/hermes-mini/app-chats", json={"id": "home-1", "home": True})
        self.client.put("/api/plugins/hermes-mini/activity/home-1/t1", json={
            "title": "Home task",
            "steps": ["Step 1"],
            "status": "done",
            "started_at": 100.0,
        })
        self.assertEqual(len(self.client.get("/api/plugins/hermes-mini/activity/home-1").json()["trees"]), 1)
        res = self.client.delete("/api/plugins/hermes-mini/app-chats/home")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(self.client.get("/api/plugins/hermes-mini/activity/home-1").json()["trees"], [])

    def test_reconcile_skips_non_turn_user_rows_soft_deleted_and_handles_failed_turn(self):
        conn = sqlite3.connect(self.home / "state.db")
        self.addCleanup(conn.close)
        conn.execute("CREATE TABLE sessions (id TEXT, title TEXT, archived INTEGER)")
        conn.execute(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,"
            " tool_calls TEXT, tool_name TEXT, tool_call_id TEXT, timestamp REAL, display_kind TEXT,"
            " active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0, message_uid TEXT, display_order INTEGER)"
        )
        conn.execute("INSERT INTO sessions VALUES ('chat-steered', 'Steered', 0)")
        conn.execute("INSERT INTO sessions VALUES ('chat-still-steered', 'Still steered', 0)")
        conn.execute("INSERT INTO sessions VALUES ('chat-failed', 'Failed', 0)")

        # 1. Steered + job_delivery + background completions mid-turn still recover to the final reply
        conn.execute("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (10, 'chat-steered', 'user', 'Check servers', 1000.0)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (11, 'chat-steered', 'assistant', 'Checking your servers.', 1002.0)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, display_kind, timestamp) VALUES (12, 'chat-steered', 'user', 'Also check disk', 'steer', 1005.0)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, display_kind, timestamp) VALUES (13, 'chat-steered', 'user', '[Scheduled job] ok', 'job_delivery', 1006.0)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, display_kind, timestamp) VALUES (14, 'chat-steered', 'user', 'bg done', 'process_complete', 1007.0)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, display_kind, timestamp) VALUES (15, 'chat-steered', 'user', 'subagent done', 'async_delegation_complete', 1008.0)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (16, 'chat-steered', 'user', '[System: note]', 1009.0)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (17, 'chat-steered', 'assistant', 'Everything looks healthy.', 1020.0)")

        # 2. Active run with steer & job delivery stays running when no final reply yet
        conn.execute("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (20, 'chat-still-steered', 'user', 'Long task', 2000.0)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (21, 'chat-still-steered', 'assistant', 'On it now.', 2001.0)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, display_kind, timestamp) VALUES (22, 'chat-still-steered', 'user', 'Be brief', 'steer', 2004.0)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, display_kind, timestamp) VALUES (23, 'chat-still-steered', 'user', '[Scheduled job] ping', 'job_delivery', 2005.0)")

        # 3. Soft-deleted edit leftovers ignored, and failed_turn closes quietly (done, unanchored) instead of stopped
        conn.execute("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (30, 'chat-failed', 'user', 'Run report', 3000.0)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (31, 'chat-failed', 'assistant', 'Starting report.', 3001.0)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, active, compacted, timestamp) VALUES (32, 'chat-failed', 'user', 'Erased edit', 0, 0, 3003.0)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, display_kind, timestamp) VALUES (33, 'chat-failed', 'assistant', 'Timed out', 'failed_turn', 3010.0)")
        conn.commit()

        self.client.put("/api/plugins/hermes-mini/activity/chat-steered/t-1", json={
            "title": "Server check", "steps": ["Checking host"], "status": "running", "started_at": 1003.0,
            "anchor_after_match": "checking your servers.",
        })
        self.client.put("/api/plugins/hermes-mini/activity/chat-still-steered/t-2", json={
            "title": "Long task", "steps": ["Working"], "status": "running", "started_at": 2002.0,
            "anchor_after_match": "on it now.",
        })
        self.client.put("/api/plugins/hermes-mini/activity/chat-failed/t-3", json={
            "title": "Report run", "steps": ["Fetching metrics"], "status": "running", "started_at": 3002.0,
            "anchor_after_match": "starting report.",
        })

        got_steered = self.client.get("/api/plugins/hermes-mini/activity/chat-steered").json()["trees"][0]
        self.assertEqual(got_steered["status"], "done")
        self.assertEqual(got_steered["anchor_before_id"], 17)

        got_still = self.client.get("/api/plugins/hermes-mini/activity/chat-still-steered").json()["trees"][0]
        self.assertEqual(got_still["status"], "running")

        got_failed = self.client.get("/api/plugins/hermes-mini/activity/chat-failed").json()["trees"][0]
        self.assertEqual(got_failed["status"], "done")
        self.assertEqual(got_failed["ended_at"], 3010.0)
        self.assertIsNone(got_failed["anchor_before_id"])
        self.assertEqual(got_failed["anchor_before_match"], "")

    def test_delete_activity_partial_prune_for_edit_truncation(self):
        conn = sqlite3.connect(self.home / "state.db")
        self.addCleanup(conn.close)
        conn.execute("CREATE TABLE sessions (id TEXT, title TEXT, archived INTEGER)")
        conn.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, display_kind TEXT, active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0, message_uid TEXT, display_order INTEGER)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (5, 'chat-edit', 'assistant', 'First reply', 50.0)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, timestamp, active, compacted) VALUES (10, 'chat-edit', 'user', 'Edited prompt', 100.0, 0, 0)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, timestamp, active, compacted) VALUES (15, 'chat-edit', 'assistant', 'Truncated reply', 150.0, 0, 0)")
        conn.commit()

        self.client.put("/api/plugins/hermes-mini/activity/chat-edit/t1", json={
            "title": "First task", "steps": ["S1"], "status": "done", "started_at": 45.0, "ended_at": 50.0, "anchor_before_id": 5,
        })
        self.client.put("/api/plugins/hermes-mini/activity/chat-edit/t2", json={
            "title": "Second task", "steps": ["S2"], "status": "done", "started_at": 105.0, "ended_at": 150.0, "anchor_after_id": 10, "anchor_before_id": 15,
        })
        self.client.put("/api/plugins/hermes-mini/activity/chat-edit/t3", json={
            "title": "Third task", "steps": ["S3"], "status": "stopped", "started_at": 160.0,
        })

        res = self.client.delete("/api/plugins/hermes-mini/activity/chat-edit?from_row_id=10&from_ts=100")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["removed"], 2)
        remaining = self.client.get("/api/plugins/hermes-mini/activity/chat-edit").json()["trees"]
        self.assertEqual([t["id"] for t in remaining], ["t1"])

        res_all = self.client.delete("/api/plugins/hermes-mini/activity/chat-edit")
        self.assertEqual(res_all.status_code, 200)
        self.assertEqual(self.client.get("/api/plugins/hermes-mini/activity/chat-edit").json()["trees"], [])

    def test_activity_lru_eviction_and_main_chat_protection(self):
        self.client.post("/api/plugins/hermes-mini/app-chats", json={"id": "home-main", "home": True})
        with mock.patch.object(self.api, "MAX_ACTIVITY_SESSIONS", 3):
            self.client.put("/api/plugins/hermes-mini/activity/home-main/th", json={"title": "Home", "steps": ["H"], "status": "done", "started_at": 10.0})
            self.client.put("/api/plugins/hermes-mini/activity/side-1/t1", json={"title": "Side 1", "steps": ["1"], "status": "done", "started_at": 20.0})
            self.client.put("/api/plugins/hermes-mini/activity/side-2/t2", json={"title": "Side 2", "steps": ["2"], "status": "done", "started_at": 30.0})
            # Re-touch side-1 so side-2 becomes least recently used (after protected home-main)
            self.client.put("/api/plugins/hermes-mini/activity/side-1/t1b", json={"title": "Side 1b", "steps": ["1b"], "status": "done", "started_at": 40.0})
            self.client.put("/api/plugins/hermes-mini/activity/side-3/t3", json={"title": "Side 3", "steps": ["3"], "status": "done", "started_at": 50.0})

            self.assertEqual(len(self.client.get("/api/plugins/hermes-mini/activity/home-main").json()["trees"]), 1)
            self.assertEqual(len(self.client.get("/api/plugins/hermes-mini/activity/side-1").json()["trees"]), 2)
            self.assertEqual(len(self.client.get("/api/plugins/hermes-mini/activity/side-2").json()["trees"]), 0)
            self.assertEqual(len(self.client.get("/api/plugins/hermes-mini/activity/side-3").json()["trees"]), 1)

    def test_reconcile_ignores_compaction_and_model_only_and_delete_honors_before_ts(self):
        conn = sqlite3.connect(self.home / "state.db")
        self.addCleanup(conn.close)
        conn.execute("CREATE TABLE sessions (id TEXT, title TEXT, archived INTEGER)")
        conn.execute(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,"
            " tool_calls TEXT, tool_name TEXT, tool_call_id TEXT, timestamp REAL, display_kind TEXT,"
            " display_metadata TEXT, _compressed_summary INTEGER DEFAULT 0,"
            " active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0, message_uid TEXT, display_order INTEGER)"
        )
        conn.execute("INSERT INTO sessions VALUES ('chat-compact-done', 'Compacted done', 0)")
        conn.execute("INSERT INTO sessions VALUES ('chat-compact-live', 'Compacted live', 0)")

        # Mid-turn compaction summary (user + assistant) + model_only must NOT stop scan or masquerade as reply
        conn.execute("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (1, 'chat-compact-done', 'user', 'Analyze repo', 1000.0)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (2, 'chat-compact-done', 'assistant', 'Reading repository.', 1002.0)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, _compressed_summary, timestamp, active, compacted) VALUES (3, 'chat-compact-done', 'user', '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted.', 1, 1005.0, 0, 1)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, _compressed_summary, timestamp, active, compacted) VALUES (4, 'chat-compact-done', 'assistant', '[CONTEXT COMPACTION — REFERENCE ONLY] Summary text.', 1, 1006.0, 0, 1)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, display_metadata, timestamp) VALUES (5, 'chat-compact-done', 'user', 'Synthetic prompt', ?, 1007.0)", (json.dumps({"model_only": True}),))
        conn.execute("INSERT INTO messages (id, session_id, role, content, display_metadata, timestamp) VALUES (6, 'chat-compact-done', 'assistant', 'Synthetic note', ?, 1008.0)", (json.dumps({"model_only": True}),))
        conn.execute("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (7, 'chat-compact-done', 'assistant', 'Full analysis complete.', 1020.0)")

        conn.execute("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (20, 'chat-compact-live', 'user', 'Still working', 2000.0)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (21, 'chat-compact-live', 'assistant', 'Starting work.', 2001.0)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (22, 'chat-compact-live', 'user', '[CONTEXT COMPACTION — REFERENCE ONLY] Mid-run summary.', 2005.0)")
        conn.execute("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (23, 'chat-compact-live', 'assistant', '[CONTEXT COMPACTION — REFERENCE ONLY] Assistant summary.', 2006.0)")
        conn.commit()

        self.client.put("/api/plugins/hermes-mini/activity/chat-compact-done/t1", json={
            "title": "Repo check", "steps": ["Scanning"], "status": "running", "started_at": 1003.0,
            "anchor_after_match": "reading repository.",
        })
        self.client.put("/api/plugins/hermes-mini/activity/chat-compact-live/t2", json={
            "title": "Live work", "steps": ["Running"], "status": "running", "started_at": 2002.0,
            "anchor_after_match": "starting work.",
        })

        got_done = self.client.get("/api/plugins/hermes-mini/activity/chat-compact-done").json()["trees"][0]
        self.assertEqual(got_done["status"], "done")
        self.assertEqual(got_done["anchor_before_id"], 7)

        got_live = self.client.get("/api/plugins/hermes-mini/activity/chat-compact-live").json()["trees"][0]
        self.assertEqual(got_live["status"], "running")

        # before_ts preserves a newly started replacement turn tree while pruning old truncated trees
        self.client.put("/api/plugins/hermes-mini/activity/chat-before/old", json={
            "title": "Old", "steps": ["Old step"], "status": "done", "started_at": 110.0,
        })
        self.client.put("/api/plugins/hermes-mini/activity/chat-before/new", json={
            "title": "New", "steps": ["New step"], "status": "running", "started_at": 505.0,
        })
        res = self.client.delete("/api/plugins/hermes-mini/activity/chat-before?from_row_id=10&from_ts=100&before_ts=500")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["removed"], 1)
        remaining = self.client.get("/api/plugins/hermes-mini/activity/chat-before").json()["trees"]
        self.assertEqual([t["id"] for t in remaining], ["new"])

    def _db_with_mid_run_compaction(self, sid: str, *, with_reply: bool) -> None:
        """A turn whose first half is archived by compaction into later active copies of the same display slots."""
        conn = sqlite3.connect(self.home / "state.db")
        self.addCleanup(conn.close)
        conn.execute("CREATE TABLE sessions (id TEXT, title TEXT, archived INTEGER)")
        conn.execute(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,"
            " tool_calls TEXT, tool_name TEXT, tool_call_id TEXT, timestamp REAL, display_kind TEXT,"
            " active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0, message_uid TEXT, display_order INTEGER)"
        )
        conn.execute("CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL, acquired_at REAL)")
        conn.execute("INSERT INTO sessions VALUES (?, 'Compacted turn', 0)", (sid,))

        def insert(mid, role, content, ts, *, uid_order=None, active=1, compacted=0, tool_calls=None):
            uid, order = uid_order if uid_order else (None, None)
            conn.execute(
                "INSERT INTO messages (id, session_id, role, content, tool_calls, timestamp, active, compacted,"
                " message_uid, display_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (mid, sid, role, content, tool_calls, ts, active, compacted, uid, order),
            )

        # Pre-compaction originals (archived): user prompt, opening ack, and a tool call.
        insert(10, "user", "Plan the migration", 1000.0, uid_order=("u-q", 1), active=0, compacted=1)
        insert(11, "assistant", "On it — checking the repo.", 1001.0, uid_order=("u-ack", 2), active=0, compacted=1)
        insert(
            12,
            "assistant",
            "",
            1002.0,
            uid_order=("u-tool1", 3),
            active=0,
            compacted=1,
            tool_calls=json.dumps([
                {"id": "c-pre-1", "function": {"name": "vision_analyze", "arguments": json.dumps({"image_url": "https://upload.wikimedia.org/pre.png"})}},
                {"id": "c-pre-2", "function": {"name": "browser_exec", "arguments": json.dumps({"code": 'goto_url("https://example.com/pre-page")'})}},
            ]),
        )
        insert(13, "tool", json.dumps({"success": True}), 1003.0, uid_order=("u-tool1r", 3), active=0, compacted=1)
        # Carried-forward active copies in the same display slots (higher ids, active=1, compacted=0).
        insert(20, "user", "Plan the migration", 1000.0, uid_order=("u-q", 1))
        insert(21, "assistant", "On it — checking the repo.", 1001.0, uid_order=("u-ack", 2))
        insert(
            22,
            "assistant",
            "",
            1002.0,
            uid_order=("u-tool1", 3),
            tool_calls=json.dumps([
                {"id": "c-pre-1", "function": {"name": "vision_analyze", "arguments": json.dumps({"image_url": "https://upload.wikimedia.org/pre.png"})}},
                {"id": "c-pre-2", "function": {"name": "browser_exec", "arguments": json.dumps({"code": 'goto_url("https://example.com/pre-page")'})}},
            ]),
        )
        insert(23, "tool", json.dumps({"success": True}), 1003.0, uid_order=("u-tool1r", 3))
        # Post-compaction tools.
        insert(
            30,
            "assistant",
            "",
            1010.0,
            uid_order=("u-tool2", 4),
            tool_calls=json.dumps([
                {"id": "c-post-1", "function": {"name": "vision_analyze", "arguments": json.dumps({"image_url": "https://upload.wikimedia.org/post.png"})}},
                {"id": "c-post-2", "function": {"name": "web_extract", "arguments": json.dumps({"urls": ["https://example.com/post-page"]})}},
            ]),
        )
        insert(31, "tool", json.dumps({"success": True}), 1011.0, uid_order=("u-tool2r", 4))
        if with_reply:
            insert(40, "assistant", "Migration plan is ready.", 1020.0, uid_order=("u-reply", 5))
        conn.commit()

    def test_compaction_copies_collapse_by_display_slot_and_recover_anchor_after(self):
        self._db_with_mid_run_compaction("chat-mid-done", with_reply=True)
        # anchor_after points at the archived opening ack (id 11); it is drawn as its active copy (21).
        self.client.put("/api/plugins/hermes-mini/activity/chat-mid-done/t-done", json={
            "id": "t-done",
            "title": "Migration run",
            "steps": ["Checking the repo"],
            "status": "running",
            "started_at": 1001.5,
            "anchor_after_id": 11,
        })
        got = self.client.get("/api/plugins/hermes-mini/activity/chat-mid-done").json()["trees"][0]
        self.assertEqual(got["status"], "done")
        self.assertEqual(got["ended_at"], 1020.0)
        self.assertEqual(got["anchor_before_id"], 40)
        # Both pre- and post-compaction artifacts are backfilled exactly once.
        self.assertEqual(got["step_images"], [[
            "https://upload.wikimedia.org/pre.png",
            "https://upload.wikimedia.org/post.png",
        ]])
        self.assertEqual(got["step_urls"], [[
            "https://example.com/pre-page",
            "https://example.com/post-page",
        ]])

    def test_compaction_copies_keep_turn_running_without_final_reply(self):
        self._db_with_mid_run_compaction("chat-mid-live", with_reply=False)
        self.client.put("/api/plugins/hermes-mini/activity/chat-mid-live/t-live", json={
            "id": "t-live",
            "title": "Migration run",
            "steps": ["Checking the repo"],
            "status": "running",
            "started_at": 1001.5,
            "anchor_after_id": 11,
        })
        got = self.client.get("/api/plugins/hermes-mini/activity/chat-mid-live").json()["trees"][0]
        self.assertEqual(got["status"], "running")
        self.assertIsNone(got["anchor_before_id"])

    def test_put_is_monotonic_and_preserves_anchors(self):
        base = {
            "id": "t-mono",
            "title": "Monotonic",
            "steps": ["Step"],
            "started_at": 100.0,
        }
        done = self.client.put("/api/plugins/hermes-mini/activity/chat-mono/t-mono", json={
            **base, "status": "done", "ended_at": 150.0,
            "anchor_before_id": 42, "anchor_before_match": "the answer",
            "anchor_after_id": 7, "anchor_after_match": "the question",
        })
        self.assertEqual(done.status_code, 200)

        late_running = self.client.put("/api/plugins/hermes-mini/activity/chat-mono/t-mono", json={
            **base, "status": "running", "ended_at": 0.0,
        })
        self.assertEqual(late_running.status_code, 200)
        self.assertEqual(late_running.json()["tree"]["status"], "done")
        stored = self.client.get("/api/plugins/hermes-mini/activity/chat-mono").json()["trees"][0]
        self.assertEqual(stored["status"], "done")
        self.assertEqual(stored["anchor_before_id"], 42)
        self.assertEqual(stored["ended_at"], 150.0)

        # A same-status update with no anchors/ended_at keeps what the server already has.
        self.client.put("/api/plugins/hermes-mini/activity/chat-mono/t-mono", json={
            **base, "status": "done", "ended_at": 0.0, "steps": ["Step", "Step 2"],
        })
        merged = self.client.get("/api/plugins/hermes-mini/activity/chat-mono").json()["trees"][0]
        self.assertEqual(merged["status"], "done")
        self.assertEqual(merged["steps"], ["Step", "Step 2"])
        self.assertEqual(merged["anchor_before_id"], 42)
        self.assertEqual(merged["anchor_before_match"], "the answer")
        self.assertEqual(merged["anchor_after_id"], 7)
        self.assertEqual(merged["anchor_after_match"], "the question")
        self.assertEqual(merged["ended_at"], 150.0)

    def test_activity_image_refs_require_public_https_without_credentials(self):
        self.client.put("/api/plugins/hermes-mini/activity/chat-imgref/t", json={
            "id": "t",
            "title": "Image refs",
            "steps": ["Shots"],
            "step_images": [[
                "https://localhost/a.png",
                "https://127.0.0.1/a.png",
                "https://192.168.1.10/a.png",
                "https://user:pass@example.com/a.png",
                "https://example.com/{x}.png",
                "/etc/passwd",
                "file:///tmp/x.png",
                "https://example.com/ok.png",
            ]],
            "status": "done",
            "started_at": 100.0,
        })
        got = self.client.get("/api/plugins/hermes-mini/activity/chat-imgref").json()["trees"][0]
        self.assertEqual(got["step_images"], [["/tmp/x.png", "https://example.com/ok.png"]])


if __name__ == "__main__":
    unittest.main()
