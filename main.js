"use strict";

const {
  Plugin,
  ItemView,
  Modal,
  Notice,
  Setting,
  PluginSettingTab,
  normalizePath,
  TFile,
  MarkdownView,
  Platform,
  requestUrl
} = require("obsidian");

const VIEW_TYPE_MIFM = "medical-image-finder-mobile-view";

const DEFAULT_SETTINGS = {
  defaultProvider: "duckduckgo",
  defaultFilterMode: "all",
  attachmentFolder: "Attachments/MedicalImages",
  defaultImageWidth: 500,
  includeCaption: false,
  batchPreviewSize: "lg",
  brightDataApiKey: "",
  brightDataZone: "serp_api1",
  braveApiKey: "",
  geminiMaxSuggestions: 25,
  aiBackend: "gemini",
  geminiApiKey: "",
  geminiModel: "gemini-2.5-flash",
  geminiCustomModels: [],
  lastImportedResponse: "",
  lastScanResults: null,
  lastScannedNote: ""
};

const BATCH_SIZE_PRESETS = [
  { id: "sm", label: "S", title: "Small thumbnails (100px)" },
  { id: "md", label: "M", title: "Medium thumbnails (160px)" },
  { id: "lg", label: "L", title: "Large thumbnails (230px)" },
  { id: "xl", label: "XL", title: "Extra Large thumbnails (310px)" }
];

const SEARCH_PROVIDERS = [
  { id: "duckduckgo", label: "DuckDuckGo (Free / No Key)", shortLabel: "DUCKDUCKGO" },
  { id: "brightdata", label: "Bright Data Google Images (5,000 Free/Mo)", shortLabel: "BRIGHT DATA" },
  { id: "brave", label: "Brave Images (API Key)", shortLabel: "BRAVE" },
  { id: "wikimedia", label: "Wikimedia Commons (Free)", shortLabel: "WIKIMEDIA" }
];

const MEDICAL_VISUAL_FILTERS = [
  { id: "all",        label: "All",                 modifier: "",                    skipIf: null },
  { id: "diagram",    label: "Anatomy / Diagram",   modifier: "labeled diagram",     skipIf: /\b(diagram|anatomy|anatomical|illustration|schematic|cross-section|chart|atlas)\b/i },
  { id: "radiology",  label: "Radiology",           modifier: "radiology X-ray",     skipIf: /\b(radiology|radiograph|x-?ray|ct|mri|ultrasound|usg|barium|angiogram|cholangiogram|mrcp|ercp)\b/i },
  { id: "histology",  label: "HPE / Histology",     modifier: "histology pathology", skipIf: /\b(histology|histopathology|pathology|biopsy|microscop\w*|hpe|smear|stain)\b/i },
  { id: "clinical",   label: "Clinical / Surgical", modifier: "clinical surgical",   skipIf: /\b(clinical|surgical|surgery|operative|laparoscop\w*|repair|procedure)\b/i },
  { id: "criteria",   label: "Criteria / Scoring",  modifier: "criteria table",      skipIf: /\b(criteria|score|scoring|classification|staging|table|flowchart|grad(?:e|ing))\b/i },
  { id: "embryology", label: "Embryology / Physio", modifier: "diagram flowchart",   skipIf: /\b(embryology|physiology|diagram|flowchart|curve|cycle|development)\b/i }
];

// -------------------------------------------------------------
// Web-Only Binary, Crypto & Clipboard Utilities (iPadOS & Android safe)
// -------------------------------------------------------------

/** Convert a base64 string into a Uint8Array using pure Web APIs. */
function base64ToUint8Array(b64) {
  const clean = String(b64 || "").replace(/\s+/g, "");
  if (typeof atob === "function") {
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const pad = clean.endsWith("==") ? 2 : (clean.endsWith("=") ? 1 : 0);
  const outLen = Math.max(0, (clean.length * 3) / 4 - pad);
  const out = new Uint8Array(outLen);
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c1 = chars.indexOf(clean[i]);
    const c2 = chars.indexOf(clean[i + 1]);
    const c3 = clean[i + 2] === "=" ? 0 : chars.indexOf(clean[i + 2]);
    const c4 = clean[i + 3] === "=" ? 0 : chars.indexOf(clean[i + 3]);
    const n = (c1 << 18) | (c2 << 12) | (c3 << 6) | c4;
    if (p < outLen) out[p++] = (n >> 16) & 255;
    if (p < outLen) out[p++] = (n >> 8) & 255;
    if (p < outLen) out[p++] = n & 255;
  }
  return out;
}

/** Encode UTF-8 string into Uint8Array. */
function utf8ToUint8Array(str) {
  const s = String(str || "");
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(s);
  }
  const encoded = unescape(encodeURIComponent(s));
  const out = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i++) out[i] = encoded.charCodeAt(i);
  return out;
}

/** Read an ASCII slice from a Uint8Array. */
function bytesToAscii(bytes, start = 0, end = bytes.length) {
  const slice = bytes.subarray(start, Math.min(end, bytes.length));
  let out = "";
  for (let i = 0; i < slice.length; i++) out += String.fromCharCode(slice[i]);
  return out;
}

/** Compare two Uint8Arrays for exact byte equality. */
function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Return an exact-sized ArrayBuffer backing the given Uint8Array. */
function u8ToArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/** Pure-JS SHA-256 fallback for environments without Web Crypto subtle.digest. */
function pureJsSha256Hex(bytes) {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const l = bytes.length;
  const bitLenHi = Math.floor((l * 8) / 0x100000000);
  const bitLenLo = (l * 8) >>> 0;
  const paddedLen = Math.ceil((l + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[l] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, bitLenHi, false);
  view.setUint32(paddedLen - 4, bitLenLo, false);

  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  return Array.from(H).map((x) => x.toString(16).padStart(8, "0")).join("");
}

/** Compute lowercase SHA-256 hex digest using Web Crypto with pure-JS fallback. */
async function sha256Hex(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    if (typeof globalThis !== "undefined" && globalThis.crypto?.subtle?.digest) {
      const digest = await globalThis.crypto.subtle.digest("SHA-256", u8ToArrayBuffer(u8));
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch (_) {}
  return pureJsSha256Hex(u8);
}

/** Copy plain text using Web Clipboard API with execCommand fallback for mobile WebViews. */
async function copyToClipboard(str) {
  const text = String(str || "");
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  try {
    if (typeof document !== "undefined" && document.body && typeof document.execCommand === "function") {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) return true;
    }
  } catch (_) {}
  return false;
}

/** Read text from system clipboard on explicit user action. */
async function readFromClipboard() {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
      return await navigator.clipboard.readText();
    }
  } catch (_) {}
  return "";
}

class SearchCache {
  constructor(maxSize = 100, ttlMs = 5 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  get(key) {
    if (!key) return null;
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return Array.isArray(entry.value) ? entry.value.map((item) => ({ ...item })) : entry.value;
  }

  set(key, value) {
    if (!key || !Array.isArray(value) || value.length === 0) return;
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.maxSize) {
      const now = Date.now();
      for (const [k, v] of this.cache.entries()) {
        if (now > v.expiry) this.cache.delete(k);
      }
      if (this.cache.size >= this.maxSize) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey !== undefined) this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, { value: value.map((item) => ({ ...item })), expiry: Date.now() + this.ttlMs });
  }

  clear() {
    this.cache.clear();
  }
}

function httpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch (_) {
    return "";
  }
}

function openExternalUrl(value) {
  const clean = httpUrl(value);
  if (!clean) return false;
  try {
    if (typeof window !== "undefined" && typeof window.open === "function") {
      window.open(clean, "_blank", "noopener");
      return true;
    }
  } catch (_) {}
  return false;
}

function bindImageFallback(img, fallbackUrl, isThumbFallback = true) {
  let triedFallback = false;
  img._usingThumbFallback = false;
  img.onerror = () => {
    if (!triedFallback && fallbackUrl && img.src !== fallbackUrl) {
      triedFallback = true;
      img._usingThumbFallback = Boolean(isThumbFallback);
      img.src = fallbackUrl;
      return;
    }
    img.onerror = null;
    if (typeof img.addClass === "function") img.addClass("mifm-img-broken");
    else if (img.classList) img.classList.add("mifm-img-broken");
  };
}

function syncDimensionBadge(badgeEl, width, height, { fullLabel = false } = {}) {
  if (!badgeEl) return;
  const lowClass = fullLabel ? "mifm-badge-lowres" : "is-lowres";
  if (!width || !height) {
    badgeEl.style.display = "none";
    return;
  }
  badgeEl.style.display = "";
  if (width < 250 || height < 250) {
    if (typeof badgeEl.addClass === "function") badgeEl.addClass(lowClass);
    badgeEl.setText(fullLabel ? `⚠️ Low res (${width}×${height} px)` : `⚠️ ${width}×${height}`);
  } else {
    if (typeof badgeEl.removeClass === "function") badgeEl.removeClass(lowClass);
    badgeEl.setText(fullLabel ? `${width} × ${height} px` : `${width}×${height}`);
  }
}

function bindHighResPreview(img, badgeEl, item, options = {}) {
  const fullUrl = item.imageUrl || item.thumbnailUrl;
  const thumbUrl = item.thumbnailUrl;
  const isDistinctThumb = Boolean(thumbUrl && item.imageUrl && thumbUrl !== item.imageUrl);
  bindImageFallback(img, thumbUrl, isDistinctThumb);
  syncDimensionBadge(badgeEl, item.width, item.height, options);
  img.onload = () => {
    const nw = img.naturalWidth || 0;
    const nh = img.naturalHeight || 0;
    if (nw > 0 && nh > 0 && !img._usingThumbFallback) {
      if (!item.width || !item.height) {
        item.width = nw;
        item.height = nh;
      }
      syncDimensionBadge(badgeEl, item.width, item.height, options);
    }
  };
  if (fullUrl) img.src = fullUrl;
}

function extractNoteSections(noteContent) {
  if (!noteContent || typeof noteContent !== "string") return [];
  const lines = noteContent.split(/\r?\n/);
  const sections = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.*)/);
    if (m) {
      const level = m[1].length;
      const heading = cleanText(m[2]) || m[2].trim();
      sections.push({
        heading,
        level,
        startLine: i + 1,
        endLine: lines.length
      });
    }
  }
  for (let idx = 0; idx < sections.length; idx++) {
    const cur = sections[idx];
    for (let j = idx + 1; j < sections.length; j++) {
      if (sections[j].level <= cur.level) {
        cur.endLine = sections[j].startLine - 1;
        break;
      }
    }
  }
  return sections;
}

function findEnclosingHeading(lines, line1Based) {
  const maxIdx = Math.max(0, Math.min((line1Based || 1) - 1, lines.length - 1));
  for (let i = maxIdx; i >= 0; i--) {
    const m = (lines[i] || "").match(/^(#{1,6})\s+(.*)/);
    if (m) return cleanText(m[2]) || m[2].trim();
  }
  return "";
}

function normalizeScanScope(scope, totalLines = Infinity) {
  if (!scope || typeof scope !== "object" || scope.mode === "full") return null;
  const maxVal = typeof totalLines === "number" && isFinite(totalLines) && totalLines >= 1 ? totalLines : Infinity;
  let startLine = parseInt(scope.startLine, 10);
  let endLine = parseInt(scope.endLine, 10);
  if (isNaN(startLine) || startLine < 1) startLine = 1;
  if (maxVal !== Infinity && startLine > maxVal) startLine = maxVal;
  if (isNaN(endLine) || endLine < startLine) endLine = startLine;
  if (maxVal !== Infinity && endLine > maxVal) endLine = maxVal;
  return {
    mode: scope.mode || "custom",
    startLine,
    endLine,
    label: String(scope.label || `Lines ${startLine}–${endLine}`).trim(),
    parentHeading: typeof scope.parentHeading === "string" ? scope.parentHeading.trim() : ""
  };
}

function prepareScopedLines(noteContent, scope = null) {
  const allLines = String(noteContent || "").split(/\r?\n/);
  const totalLines = allLines.length;
  const normScope = normalizeScanScope(scope, totalLines);
  const startLine = normScope ? normScope.startLine : 1;
  const endLine = normScope ? normScope.endLine : totalLines;
  const scopedLines = allLines.slice(startLine - 1, endLine);
  let totalImagesFound = 0;
  for (const l of scopedLines) {
    totalImagesFound += (l.match(/!\[\[.*?\]\]|!\[.*?\]\(.*?\)/g) || []).length;
  }
  const parentHeading = normScope
    ? normScope.parentHeading || findEnclosingHeading(allLines, startLine)
    : "";
  const effectiveScope = normScope ? { ...normScope, parentHeading } : null;
  return { allLines, totalLines, startLine, endLine, scopedLines, totalImagesFound, scope: effectiveScope };
}

const knownSecrets = new Set();
function rememberSecrets(settings) {
  for (const key of ["brightDataApiKey", "braveApiKey", "geminiApiKey"]) {
    const val = typeof settings?.[key] === "string" ? settings[key].trim() : "";
    if (val.length >= 8) {
      knownSecrets.add(val);
    }
  }
}

function safeError(error) {
  let message = String(error?.message || error || "Unknown error");
  const sortedSecrets = Array.from(knownSecrets).sort((a, b) => b.length - a.length);
  for (const secret of sortedSecrets) message = message.split(secret).join("[redacted]");
  return message
    .replace(/https?:\/\/[^\s<>"']+/gi, "[request URL]")
    .replace(/((?:api[_-]?key|key|token|authorization)\s*[=:]\s*(?:bearer\s+)?)[^\s&,]+/gi, "$1[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\bBSA[A-Za-z0-9_-]{6,}\b/g, "[redacted]")
    .replace(/AIza[\w-]+/g, "[redacted]");
}

function attachmentPath(value) {
  const p = String(value || DEFAULT_SETTINGS.attachmentFolder).trim().replace(/\\/g, "/");
  if (
    p.startsWith("/") ||
    /[:<>"|?*\x00-\x1f]/.test(p) ||
    p.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
  ) {
    throw new Error("Attachment folder must be a valid relative vault folder.");
  }
  return normalizePath(p);
}

function normalizeSettings(saved) {
  const settings = { ...DEFAULT_SETTINGS, ...(saved && typeof saved === "object" ? saved : {}) };
  if (!["duckduckgo", "brightdata", "brave", "wikimedia"].includes(settings.defaultProvider)) {
    settings.defaultProvider = "duckduckgo";
  }
  if (!["sm", "md", "lg", "xl"].includes(settings.batchPreviewSize)) {
    settings.batchPreviewSize = "lg";
  }
  if (!MEDICAL_VISUAL_FILTERS.some((f) => f.id === settings.defaultFilterMode)) settings.defaultFilterMode = "all";
  if (!["gemini", "offline"].includes(settings.aiBackend)) settings.aiBackend = "gemini";
  settings.brightDataApiKey = typeof settings.brightDataApiKey === "string" ? settings.brightDataApiKey.trim() : "";
  settings.brightDataZone = typeof settings.brightDataZone === "string" && settings.brightDataZone.trim()
    ? settings.brightDataZone.trim()
    : DEFAULT_SETTINGS.brightDataZone;
  settings.braveApiKey = typeof settings.braveApiKey === "string" ? settings.braveApiKey.trim() : "";
  settings.geminiApiKey = typeof settings.geminiApiKey === "string" ? settings.geminiApiKey.trim() : "";
  settings.geminiModel = typeof settings.geminiModel === "string" && settings.geminiModel.trim()
    ? settings.geminiModel.trim()
    : DEFAULT_SETTINGS.geminiModel;
  if (!Number.isInteger(settings.defaultImageWidth) || settings.defaultImageWidth <= 50) settings.defaultImageWidth = 500;
  if (!Number.isInteger(settings.geminiMaxSuggestions) || settings.geminiMaxSuggestions < 5 || settings.geminiMaxSuggestions > 50) {
    settings.geminiMaxSuggestions = 25;
  }
  if (typeof settings.includeCaption !== "boolean") settings.includeCaption = false;
  settings.geminiCustomModels = Array.isArray(settings.geminiCustomModels)
    ? settings.geminiCustomModels.filter((m) => m && typeof m.id === "string" && typeof m.label === "string")
    : [];
  settings.lastImportedResponse = typeof settings.lastImportedResponse === "string" ? settings.lastImportedResponse : "";
  settings.lastScanResults =
    settings.lastScanResults && typeof settings.lastScanResults === "object" && Array.isArray(settings.lastScanResults.suggestions)
      ? settings.lastScanResults
      : null;
  settings.lastScannedNote = typeof settings.lastScannedNote === "string" ? settings.lastScannedNote : "";
  try {
    settings.attachmentFolder = attachmentPath(settings.attachmentFolder);
  } catch (_) {
    settings.attachmentFolder = DEFAULT_SETTINGS.attachmentFolder;
  }
  return settings;
}

function isImageUri(u) {
  return typeof u === "string" && (Boolean(httpUrl(u)) || u.startsWith("data:image/"));
}

function normalizeResults(items) {
  if (!Array.isArray(items)) throw new Error("Unexpected image search response.");
  return items
    .filter((item) => item && (isImageUri(item.imageUrl) || isImageUri(item.thumbnailUrl)))
    .map((item) => {
      const validImg = httpUrl(item.imageUrl) || (typeof item.imageUrl === "string" && item.imageUrl.startsWith("data:image/") ? item.imageUrl : "");
      const validThumb = httpUrl(item.thumbnailUrl) || (typeof item.thumbnailUrl === "string" && item.thumbnailUrl.startsWith("data:image/") ? item.thumbnailUrl : "");
      return {
        ...item,
        title: typeof item.title === "string" ? item.title : "Medical image",
        imageUrl: validImg || validThumb,
        thumbnailUrl: validThumb || validImg,
        sourceUrl: httpUrl(item.sourceUrl),
        domain: typeof item.domain === "string" ? item.domain : ""
      };
    });
}

function markdownText(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/[\\`*_{}\[\]<>!|]/g, "\\$&");
}

/** Detect standard raster image format from magic bytes of a Uint8Array. */
function imageExtension(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (
    u8.length >= 8 &&
    u8[0] === 137 && u8[1] === 80 && u8[2] === 78 && u8[3] === 71 &&
    u8[4] === 13 && u8[5] === 10 && u8[6] === 26 && u8[7] === 10
  ) {
    return "png";
  }
  if (u8[0] === 255 && u8[1] === 216 && u8[2] === 255) return "jpg";
  if (u8.length >= 6 && /^GIF8[79]a/.test(bytesToAscii(u8, 0, 6))) return "gif";
  if (u8.length >= 12 && bytesToAscii(u8, 0, 4) === "RIFF" && bytesToAscii(u8, 8, 12) === "WEBP") return "webp";
  return null;
}

function cleanText(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => alias || target)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*_>`~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeFileName(title) {
  const clean = cleanText(title)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9 -]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .slice(0, 50)
    .replace(/-+$/, "");
  return clean || "medical-diagram";
}

function decodeHtmlEntities(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&(?:#0*39|#x0*27|apos);/gi, "'")
    .replace(/&(?:#0*34|#x0*22);/gi, '"')
    .replace(/&(?:#0*38|#x0*26);/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&(?:#0*8211|ndash);/gi, "–")
    .replace(/&(?:#0*8212|mdash);/gi, "—")
    .replace(/&(?:#0*8216|#0*8217|lsquo|rsquo);/gi, "'")
    .replace(/&(?:#0*8220|#0*8221|ldquo|rdquo);/gi, '"')
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        const code = parseInt(dec, 10);
        return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : "";
      } catch (_) {
        return "";
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try {
        const code = parseInt(hex, 16);
        return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : "";
      } catch (_) {
        return "";
      }
    })
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const REQUEST_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const DEFAULT_REQUEST_TIMEOUT_MS = 25000;

async function requestWithTimeout(options, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  let timerId = null;
  try {
    const timeout = new Promise((_, reject) => {
      timerId = setTimeout(() => reject(new Error("Request timed out.")), timeoutMs);
    });
    return await Promise.race([requestUrl(options), timeout]);
  } finally {
    if (timerId) clearTimeout(timerId);
  }
}

async function fetchText(url, headers = {}) {
  try {
    const res = await requestWithTimeout({
      url,
      headers: {
        "User-Agent": REQUEST_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...headers
      }
    });
    return res.text;
  } catch (err) {
    throw new Error(`Page request failed: ${safeError(err)}`);
  }
}

async function fetchJson(url, headers = {}) {
  try {
    const res = await requestWithTimeout({
      url,
      headers: {
        "User-Agent": REQUEST_UA,
        Accept: "application/json",
        ...headers
      }
    });
    let data = null;
    try {
      data = res.json;
    } catch (_) {
      if (typeof res.text === "string") data = JSON.parse(res.text);
    }
    if (!data || typeof data !== "object") throw new Error("Unexpected API response.");
    if (data.error) {
      const apiErr = new Error(
        typeof data.error === "string"
          ? data.error
          : data.error.message || data.error.detail || "Provider rejected request."
      );
      if (typeof data.error === "object") {
        apiErr.status = data.error.status || res.status;
        apiErr.code = data.error.code;
      }
      throw apiErr;
    }
    return data;
  } catch (err) {
    const wrapped = new Error(`API request failed: ${safeError(err)}`);
    if (err?.status != null) wrapped.status = err.status;
    else if (err?.statusCode != null) wrapped.status = err.statusCode;
    if (err?.code != null) wrapped.code = err.code;
    throw wrapped;
  }
}

async function fetchBinary(url, headers = {}) {
  try {
    const res = await requestWithTimeout({
      url,
      headers: {
        "User-Agent": REQUEST_UA,
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        ...headers
      }
    });
    if (!res.arrayBuffer || !res.arrayBuffer.byteLength) throw new Error("Empty image response.");
    return res.arrayBuffer;
  } catch (err) {
    throw new Error(`Failed to download image: ${safeError(err)}`);
  }
}

// -------------------------------------------------------------
// Image Search Providers (DuckDuckGo, Wikimedia, Brave, Bright Data)
// -------------------------------------------------------------

class WikimediaProvider {
  constructor() {
    this.name = "Wikimedia Commons (Free)";
  }

  async search(query) {
    if (!query || !query.trim()) return [];
    const q = query.trim();
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(
      q
    )}&gsrnamespace=6&prop=imageinfo&iiprop=url|size|extmetadata|mime&iiurlwidth=1000&format=json&origin=*`;

    const data = await fetchJson(url);
    if (data?.batchcomplete !== undefined && !data.query) return [];
    if (!data?.query?.pages) throw new Error("Unexpected Wikimedia response.");

    const pages = Object.values(data.query.pages).sort((a, b) => {
      if (a.index != null && b.index != null) return a.index - b.index;
      return 0;
    });
    return pages
      .filter((p) => p.imageinfo?.[0]?.mime?.startsWith("image/"))
      .slice(0, 25)
      .map((p) => {
        const info = p.imageinfo[0];
        const title = decodeHtmlEntities(
          (p.title || "").replace(/^File:/, "").replace(/\.[^.]+$/, "")
        );
        const meta = info.extmetadata || {};
        const license = meta.LicenseShortName ? meta.LicenseShortName.value : "Wikimedia Commons";
        const useRenderedThumb = /^image\/(?:(?:x-)?tiff|svg\+xml)$/i.test(info.mime || "");

        return {
          title: title || "Wikimedia medical illustration",
          imageUrl: useRenderedThumb ? (info.thumburl || info.url) : info.url,
          thumbnailUrl: info.thumburl || info.url,
          sourceUrl: info.descriptionurl || info.url,
          width: info.width || null,
          height: info.height || null,
          domain: "commons.wikimedia.org",
          license
        };
      });
  }
}

class DuckDuckGoProvider {
  constructor() {
    this.name = "DuckDuckGo (Free / No Key)";
  }

  static extractVqd(html) {
    if (!html || typeof html !== "string") return "";
    const patterns = [
      /vqd=["']?([a-zA-Z0-9_-]+)["']?/,
      /vqd:\s*['"]([^'"]+)['"]/,
      /["']vqd["']\s*:\s*["']([^"']+)["']/i,
      /[?&]vqd=([a-zA-Z0-9_-]+)/i,
      /vqd=([0-9]+-[0-9]+(?:-[0-9]+)?)/
    ];
    for (const pat of patterns) {
      const m = html.match(pat);
      if (m && m[1]) return m[1];
    }
    return "";
  }

  async search(query) {
    this.name = "DuckDuckGo (Free / No Key)";
    try {
      return await this.searchPrimary(query);
    } catch (_) {
      return this.searchFallback(query);
    }
  }

  async searchPrimary(query) {
    if (!query || !query.trim()) return [];
    const q = query.trim();

    const tokenUrl = `https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`;
    const html = await fetchText(tokenUrl, { Referer: "https://duckduckgo.com/" });

    const vqd = DuckDuckGoProvider.extractVqd(html);
    if (!vqd) {
      return await this.searchFallback(q);
    }

    const searchUrl = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(
      q
    )}&vqd=${encodeURIComponent(vqd)}&f=,,,&p=1`;

    const data = await fetchJson(searchUrl, {
      Referer: "https://duckduckgo.com/",
      Accept: "application/json"
    });

    if (!data || !Array.isArray(data.results)) {
      throw new Error("Unexpected DuckDuckGo response.");
    }

    return data.results.slice(0, 30).map((item) => {
      let domain = item.source || "";
      if (!domain && item.url) {
        try {
          domain = new URL(item.url).hostname;
        } catch (_) {}
      }
      return {
        title: decodeHtmlEntities(item.title) || "Medical diagram",
        imageUrl: item.image,
        thumbnailUrl: item.thumbnail || item.image,
        sourceUrl: item.url || item.image,
        width: item.width || null,
        height: item.height || null,
        domain: domain.replace(/^www\./, "")
      };
    });
  }

  async searchFallback(q) {
    this.name = "Wikimedia Commons (DuckDuckGo fallback)";
    const wikiProvider = new WikimediaProvider();
    return await wikiProvider.search(q);
  }
}

class BraveProvider {
  constructor(apiKey) {
    this.name = "Brave Images";
    this.apiKey = (apiKey || "").trim();
  }

  async search(query, retryDelayMs = 1100) {
    if (!query || !query.trim()) return [];
    if (!this.apiKey) {
      throw new Error("Brave Image Search requires an API Key. Please enter it in plugin settings.");
    }
    const q = query.trim();
    const url = `https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(
      q
    )}&count=24&search_lang=en&country=ALL&spellcheck=false&safesearch=off`;

    let data;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        data = await fetchJson(url, {
          "X-Subscription-Token": this.apiKey
        });
        break;
      } catch (err) {
        const msg = String(err?.message || "");
        const errStatus = err?.status || err?.statusCode || 0;
        if (attempt === 0 && (errStatus === 429 || /\b429\b/.test(msg))) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
          continue;
        }
        if (
          errStatus === 401 ||
          errStatus === 403 ||
          errStatus === 422 ||
          err?.code === "SUBSCRIPTION_TOKEN_INVALID" ||
          /\b(?:401|403|422)\b|SUBSCRIPTION_TOKEN_INVALID/i.test(msg)
        ) {
          throw new Error("Brave API authentication failed. Check your Brave API Key in Settings.");
        }
        throw err;
      }
    }

    if (!data || !Array.isArray(data.results)) throw new Error("Unexpected Brave response.");

    return data.results.slice(0, 24).map((item) => {
      let domain = "";
      try {
        domain = new URL(item.url).hostname;
      } catch (_) {}
      return {
        title: decodeHtmlEntities(item.title) || "Brave Image result",
        imageUrl: item.properties?.url || item.thumbnail?.src,
        thumbnailUrl: item.thumbnail?.src || item.properties?.url,
        sourceUrl: item.url,
        width: item.properties?.width || item.thumbnail?.width || null,
        height: item.properties?.height || item.thumbnail?.height || null,
        domain: domain.replace(/^www\./, "")
      };
    });
  }
}

class BrightDataProvider {
  constructor(apiKey, zone = "serp_api1") {
    this.name = "Google Images via Bright Data";
    this.apiKey = (apiKey || "").trim();
    this.zone = (zone || "serp_api1").trim() || "serp_api1";
  }

  async search(query) {
    if (!query || !query.trim()) return [];
    if (!this.apiKey) {
      throw new Error(
        "Bright Data requires an API Key. Please enter it in plugin settings (Free 5,000 records/month)."
      );
    }
    const q = query.trim();
    // Keep q= first per Bright Data Google Images guidelines; udm=2 is active Google Images parameter
    const targetUrl = `https://www.google.com/search?q=${encodeURIComponent(q)}&udm=2`;

    const isGoogleTbn = (u) => typeof u === "string" && /encrypted-tbn\d*\.gstatic\.com\/images/i.test(u);

    const unwrapSourceLink = (rawLink) => {
      if (!rawLink || typeof rawLink !== "string") return "";
      try {
        const u = new URL(rawLink, "https://www.google.com");
        if (u.hostname.includes("google.") && (u.pathname === "/url" || u.pathname === "/goto")) {
          const target = u.searchParams.get("q") || u.searchParams.get("url") || "";
          const valid = httpUrl(target);
          if (valid) return valid;
        }
      } catch (_) {}
      return httpUrl(rawLink) || rawLink;
    };

    const prioritizeHighRes = (mappedList) => {
      const highRes = [];
      const fallback = [];
      for (const item of mappedList) {
        const lowDims = item.width && item.height && (item.width < 250 || item.height < 250);
        const lowUri = !item.imageUrl || item.imageUrl.startsWith("data:image/") || isGoogleTbn(item.imageUrl);
        if (lowDims || lowUri) {
          fallback.push(item);
        } else {
          highRes.push(item);
        }
      }
      return [...highRes, ...fallback].slice(0, 30);
    };

    const parseSerpPayload = async (useLightJson) => {
      const bodyPayload = {
        zone: this.zone,
        url: targetUrl,
        format: "json"
      };
      if (useLightJson) bodyPayload.data_format = "parsed_light";

      const resp = await requestWithTimeout({
        url: "https://api.brightdata.com/request",
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(bodyPayload)
      });

      const status = resp?.status;
      if (status === 401 || status === 403) {
        const authErr = new Error(`Bright Data authentication failed (HTTP ${status}). Check your API Key and Zone.`);
        authErr.status = status;
        throw authErr;
      }

      let data = null;
      try {
        if (typeof resp?.json === "object" && resp.json !== null) data = resp.json;
      } catch (_) {}
      if (!data && typeof resp?.text === "string") {
        try {
          data = JSON.parse(resp.text);
        } catch (_) {}
      }

      if (status != null && status !== 200) {
        const msg = data?.error || data?.message || resp?.text || "";
        const err = new Error(`Bright Data SERP HTTP ${status}${msg ? `: ${msg}` : ""}`);
        err.status = status;
        err.canRetryWithoutLight = status === 400 || status === 422 || /data_format|parsed_light/i.test(String(msg));
        throw err;
      }

      let rawBodyString = typeof resp?.text === "string" ? resp.text : "";
      if (data && data.body) {
        if (typeof data.body === "string") {
          rawBodyString = data.body;
          try {
            data = JSON.parse(data.body);
          } catch (_) {}
        } else if (typeof data.body === "object" && data.body !== null) {
          data = data.body;
        }
      }

      if (data && data.error) {
        const errMsg = typeof data.error === "string" ? data.error : data.error.message || JSON.stringify(data.error);
        const err = new Error(`Bright Data error: ${errMsg}`);
        err.canRetryWithoutLight = /data_format|parsed_light/i.test(String(errMsg));
        throw err;
      }
      if (data && data.message && !data.images && !data.images_results && !data.organic) {
        const err = new Error(`Bright Data message: ${data.message}`);
        err.canRetryWithoutLight = /data_format|parsed_light/i.test(String(data.message));
        throw err;
      }

      return { data, rawBodyString };
    };

    try {
      let parsedResp;
      try {
        parsedResp = await parseSerpPayload(true);
      } catch (firstErr) {
        if (firstErr?.canRetryWithoutLight) {
          parsedResp = await parseSerpPayload(false);
        } else {
          throw firstErr;
        }
      }

      let { data, rawBodyString } = parsedResp;

      if (
        data &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        !Array.isArray(data.images) &&
        !Array.isArray(data.images_results) &&
        (!rawBodyString || !rawBodyString.includes("<"))
      ) {
        try {
          const retryResp = await parseSerpPayload(false);
          if (retryResp.data && (Array.isArray(retryResp.data.images) || Array.isArray(retryResp.data.images_results) || retryResp.rawBodyString)) {
            data = retryResp.data;
            rawBodyString = retryResp.rawBodyString;
          }
        } catch (_) {}
      }

      if (data && Array.isArray(data.images) && data.images.length > 0) {
        const visible = data.images.filter((item) => item && !item.is_hidden && !item.blurred);
        const pool = (visible.length > 0 ? visible : data.images).slice(0, 100);
        const mapped = pool.map((item) => {
          const cleanSource = unwrapSourceLink(item.link);
          const origUrl = httpUrl(item.original_image) || "";
          const chosenUrl = origUrl || item.image || item.thumbnail;
          const thumbUrl = item.image || item.thumbnail || chosenUrl;
          let domain = "";
          try {
            if (origUrl) domain = new URL(origUrl).hostname;
            else if (cleanSource) domain = new URL(cleanSource).hostname;
          } catch (_) {}
          if (domain.includes("google.") && item.title) {
            domain = item.title;
          } else if (!domain && item.title) {
            domain = item.title;
          }
          let title = decodeHtmlEntities(item.source || item.title) || q;
          if (item.title && typeof item.title === "string" && title.endsWith(item.title + item.title)) {
            title = title.slice(0, -item.title.length);
          }
          const origW = Number(item.original_width) > 0 ? Number(item.original_width) : null;
          const origH = Number(item.original_height) > 0 ? Number(item.original_height) : null;
          // Do NOT assign thumbnail dimensions (image_width) to a separate full-res original_image
          const useThumbDims = !origUrl || origUrl === thumbUrl;
          const width = origW || (useThumbDims && Number(item.image_width) > 0 ? Number(item.image_width) : null);
          const height = origH || (useThumbDims && Number(item.image_height) > 0 ? Number(item.image_height) : null);

          return {
            title,
            imageUrl: chosenUrl,
            thumbnailUrl: thumbUrl,
            sourceUrl: cleanSource || origUrl || targetUrl,
            width,
            height,
            domain: domain.replace(/^www\./, "")
          };
        });
        return prioritizeHighRes(mapped);
      }

      if (data && Array.isArray(data.images_results) && data.images_results.length > 0) {
        const mapped = data.images_results.slice(0, 100).map((item) => {
          const cleanSource = unwrapSourceLink(item.link);
          const origUrl = httpUrl(item.original) || "";
          let domain = "";
          try {
            if (origUrl) domain = new URL(origUrl).hostname;
            else if (cleanSource) domain = new URL(cleanSource).hostname;
          } catch (_) {}
          if (domain.includes("google.") && item.source) {
            domain = item.source;
          } else if (!domain && item.source) {
            domain = item.source;
          }
          return {
            title: decodeHtmlEntities(item.title) || q,
            imageUrl: origUrl || item.thumbnail,
            thumbnailUrl: item.thumbnail || origUrl,
            sourceUrl: cleanSource || origUrl || targetUrl,
            width: Number(item.original_width) > 0 ? Number(item.original_width) : null,
            height: Number(item.original_height) > 0 ? Number(item.original_height) : null,
            domain: domain.replace(/^www\./, "")
          };
        });
        return prioritizeHighRes(mapped);
      }

      if (data && Array.isArray(data.organic) && data.organic.length > 0) {
        const organicWithImages = data.organic.filter((item) => item.image || item.images);
        if (organicWithImages.length > 0) {
          return organicWithImages.slice(0, 30).map((item) => {
            const cleanSource = unwrapSourceLink(item.link);
            let domain = "";
            try {
              if (cleanSource) domain = new URL(cleanSource).hostname;
            } catch (_) {}
            const imgUrl = item.original_image || item.image || (Array.isArray(item.images) ? item.images[0] : null);
            return {
              title: decodeHtmlEntities(item.title) || q,
              imageUrl: imgUrl,
              thumbnailUrl: item.image || imgUrl,
              sourceUrl: cleanSource || targetUrl,
              width: Number(item.original_width) > 0 ? Number(item.original_width) : null,
              height: Number(item.original_height) > 0 ? Number(item.original_height) : null,
              domain: domain.replace(/^www\./, "")
            };
          });
        }
      }

      if (Array.isArray(data) && data.length > 0) {
        const mapped = data.slice(0, 100).map((item) => {
          const cleanSource = unwrapSourceLink(item.link || item.url);
          let domain = "";
          const src = httpUrl(item.original_image) || httpUrl(item.image_url) || item.image || item.url;
          try {
            if (cleanSource) domain = new URL(cleanSource).hostname;
          } catch (_) {}
          return {
            title: decodeHtmlEntities(item.title) || q,
            imageUrl: src,
            thumbnailUrl: item.image || item.thumbnail || src,
            sourceUrl: cleanSource || targetUrl,
            width: Number(item.original_width) > 0 ? Number(item.original_width) : null,
            height: Number(item.original_height) > 0 ? Number(item.original_height) : null,
            domain: domain.replace(/^www\./, "")
          };
        });
        return prioritizeHighRes(mapped);
      }

      if (rawBodyString && typeof rawBodyString === "string" && rawBodyString.includes("<")) {
        const unescapeHtmlUrl = (raw) =>
          raw
            .replace(/\\u0026/gi, "&")
            .replace(/\\x26/gi, "&")
            .replace(/\\u003d/gi, "=")
            .replace(/\\\//g, "/");

        const foundImages = [];
        const seen = new Set();
        const pairedRe = /\["(https?:\/\/encrypted-tbn\d*\.gstatic\.com\/images\?q=[^"]+)",(\d+),(\d+)\],\["(https?:\/\/[^"]+)",(\d+),(\d+)\]/g;
        let pm;
        while ((pm = pairedRe.exec(rawBodyString)) !== null && foundImages.length < 30) {
          const thumb = unescapeHtmlUrl(pm[1]);
          const orig = httpUrl(unescapeHtmlUrl(pm[4]));
          if (orig && !isGoogleTbn(orig) && !seen.has(orig)) {
            seen.add(orig);
            let domain = "";
            try {
              domain = new URL(orig).hostname.replace(/^www\./, "");
            } catch (_) {}
            foundImages.push({
              title: q,
              imageUrl: orig,
              thumbnailUrl: thumb,
              sourceUrl: targetUrl,
              width: Number(pm[6]) || null,
              height: Number(pm[5]) || null,
              domain: domain || "google.com"
            });
          }
        }
        if (foundImages.length > 0) return prioritizeHighRes(foundImages);

        const re = /"(https?:\/\/encrypted-tbn\d*\.gstatic\.com\/images\?q=[^"]+)"/g;
        let m;
        while ((m = re.exec(rawBodyString)) !== null && foundImages.length < 30) {
          const u = unescapeHtmlUrl(m[1]);
          if (!seen.has(u)) {
            seen.add(u);
            foundImages.push({
              title: q,
              imageUrl: u,
              thumbnailUrl: u,
              sourceUrl: targetUrl,
              width: null,
              height: null,
              domain: "google.com"
            });
          }
        }
        if (foundImages.length > 0) return foundImages;
      }

      if (data && (Array.isArray(data.images) || Array.isArray(data.images_results))) {
        return [];
      }

      if (data && typeof data === "object") {
        if (typeof data.status_code === "number" && data.status_code >= 400) {
          throw new Error(`Bright Data SERP HTTP ${data.status_code}`);
        }
        const keys = Object.keys(data).join(", ");
        throw new Error(
          `Bright Data returned [${keys}], but no image grid. In Bright Data dashboard → ${this.zone} → Configuration → Data format, select 'Light JSON' or 'Full JSON' and click Save changes.`
        );
      }
    } catch (serpErr) {
      const msg = String(serpErr?.message || "");
      const errStatus = serpErr?.status || serpErr?.statusCode || 0;
      if (errStatus === 401 || errStatus === 403 || /\b(?:401|403)\b/.test(msg)) {
        const code = errStatus === 403 || /\b403\b/.test(msg) ? 403 : 401;
        throw new Error(`Bright Data authentication failed (HTTP ${code}). Check your API Key and Zone.`);
      }
      if (
        msg.includes("Full JSON") ||
        msg.includes("Light JSON") ||
        msg.includes("API Key") ||
        msg.includes("Bright Data error:") ||
        msg.includes("authentication failed") ||
        msg.includes("Request timed out")
      ) {
        throw serpErr;
      }
      try {
        const dResp = await requestWithTimeout({
          url: "https://api.brightdata.com/datasets/v3/scrape?dataset_id=gd_m0cda3zn1y9cr8l8yr&format=json",
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify([{ url: targetUrl }])
        });

        if (dResp.status == null || dResp.status === 200) {
          let list = null;
          try {
            if (Array.isArray(dResp?.json)) list = dResp.json;
          } catch (_) {}
          if (!list && typeof dResp?.text === "string") {
            try {
              list = JSON.parse(dResp.text);
            } catch (_) {}
          }
          if (Array.isArray(list) && list.length > 0) {
            return list.slice(0, 24).map((item) => {
              let domain = "";
              try {
                if (item.url) domain = new URL(item.url).hostname;
              } catch (_) {}
              return {
                title: decodeHtmlEntities(item.title) || q,
                imageUrl: item.image_url || item.url,
                thumbnailUrl: item.image_url || item.url,
                sourceUrl: item.url || targetUrl,
                width: null,
                height: null,
                domain: domain.replace(/^www\./, "")
              };
            });
          }
        }
      } catch (_) {
        throw serpErr;
      }
      throw serpErr;
    }

    throw new Error(
      `Unexpected Bright Data response format. In Bright Data dashboard → ${this.zone} → Configuration → Data format, select 'Light JSON' or 'Full JSON' and Save changes.`
    );
  }
}

// -------------------------------------------------------------
// Offline Medical Rules Engine (Zero API)
// -------------------------------------------------------------

class OfflineMedicalScanner {
  static get CLINICAL_RULES() {
    return [
      { pattern: /\b(calot|cystohepatic)\b/i, concept: "Calot's Triangle Surgical Anatomy", type: "diagram", query: "Calot triangle laparoscopic cholecystectomy diagram", rationale: "Vital surgical landmark bounded by cystic duct, common hepatic duct, and liver inferior margin to prevent iatrogenic bile duct injury." },
      { pattern: /\b(triangle of doom)\b/i, concept: "Triangle of Doom TEP/TAPP Anatomy", type: "diagram", query: "Triangle of doom external iliac vessels diagram", rationale: "Bounded by vas deferens and gonadal vessels; contains external iliac artery and vein where tackers must never be placed." },
      { pattern: /\b(triangle of pain)\b/i, concept: "Triangle of Pain TEP/TAPP Anatomy", type: "diagram", query: "Triangle of pain nerves laparoscopic hernia diagram", rationale: "Contains femoral nerve branch, lateral cutaneous nerve of thigh, and genitofemoral nerve where tacking causes chronic neuralgia." },
      { pattern: /\b(hesselbach|inguinal triangle)\b/i, concept: "Hesselbach's Inguinal Triangle Anatomy", type: "diagram", query: "Hesselbach triangle boundaries direct hernia diagram", rationale: "Site of direct inguinal hernia protrusion bounded by inferior epigastric artery, rectus abdominis, and inguinal ligament." },
      { pattern: /\b(inguinal canal)\b/i, concept: "Inguinal Canal Walls and Rings", type: "diagram", query: "Inguinal canal walls rings anatomy diagram", rationale: "High-yield anatomy showing anterior wall, posterior wall, roof, floor, and deep/superficial inguinal rings." },
      { pattern: /\b(femoral (canal|sheath|hernia))\b/i, concept: "Femoral Canal and Sheath Compartments", type: "diagram", query: "Femoral canal sheath compartments anatomy diagram", rationale: "Crucial for understanding femoral hernia boundaries (lacunar ligament medially, femoral vein laterally) and strangulation risk." },
      { pattern: /\b(rectus sheath)\b/i, concept: "Rectus Sheath Cross-Section", type: "diagram", query: "Rectus sheath above below arcuate line diagram", rationale: "Demonstrates fascial arrangement above vs below arcuate line of Douglas and inferior epigastric vessel relations." },
      { pattern: /\b(celiac (axis|trunk))\b/i, concept: "Celiac Axis Branches", type: "diagram", query: "Celiac trunk branches arterial supply diagram", rationale: "Foundational vascular anatomy supplying foregut structures: left gastric, splenic, and common hepatic arteries." },
      { pattern: /\b(recurrent laryngeal|rln)\b/i, concept: "Recurrent Laryngeal Nerve Thyroid Anatomy", type: "diagram", query: "Recurrent laryngeal nerve inferior thyroid artery diagram", rationale: "High-risk surgical nerve course in tracheoesophageal groove relation to inferior thyroid artery and ligament of Berry." },
      { pattern: /\b(portosystemic|portal hypertension|esophageal varices)\b/i, concept: "Portosystemic Anastomoses Sites", type: "diagram", query: "Portosystemic venous anastomoses portal hypertension diagram", rationale: "Core viva concept covering classic sites of collateral formation: lower esophagus, rectum, umbilicus, and retroperitoneum." },
      { pattern: /\b(couinaud|liver segment)\b/i, concept: "Couinaud Liver Segments (I-VIII)", type: "diagram", query: "Couinaud liver segments I to VIII diagram", rationale: "Essential for liver resections based on portal triad branching and hepatic venous drainage." },
      { pattern: /\b(bird-?beak|rat-?tail)\b/i, concept: "Bird-Beak Sign in Achalasia", type: "radiology", query: "Achalasia bird beak sign barium swallow", rationale: "Classic pathognomonic smooth tapered narrowing of lower esophageal sphincter with proximal dilatation." },
      { pattern: /\b(coffee-?bean|omega sign|sigmoid volvulus)\b/i, concept: "Coffee-Bean Sign Abdominal X-Ray", type: "radiology", query: "Sigmoid volvulus coffee bean sign X ray", rationale: "Pathognomonic inverted U-shaped dilated loop of sigmoid colon originating from left lower quadrant." },
      { pattern: /\b(apple-?core|napkin-?ring)\b/i, concept: "Apple-Core Sign Colorectal Carcinoma", type: "radiology", query: "Apple core sign colon cancer barium enema", rationale: "Annular constricting carcinoma of the colon producing shouldered margins and central lumen narrowing." },
      { pattern: /\b(double-?bubble)\b/i, concept: "Double-Bubble Sign Duodenal Atresia", type: "radiology", query: "Duodenal atresia double bubble sign X ray", rationale: "Gas-filled stomach and dilated duodenum with absent distal bowel gas in neonates." },
      { pattern: /\b(step-?ladder|air-?fluid level)\b/i, concept: "Step-Ladder Air-Fluid Levels SBO", type: "radiology", query: "Small bowel obstruction air fluid levels X ray", rationale: "Classic erect abdominal radiograph appearance indicating mechanical small bowel obstruction." },
      { pattern: /\b(rigler|pneumoperitoneum|football sign)\b/i, concept: "Rigler Sign Pneumoperitoneum", type: "radiology", query: "Rigler sign double wall pneumoperitoneum X ray", rationale: "Double wall sign visualizing both luminal and peritoneal surfaces of bowel wall due to free air." },
      { pattern: /\b(whirl sign|target sign|pseudokidney|intussusception)\b/i, concept: "Target Sign and Whirl Sign", type: "radiology", query: "Intussusception target sign ultrasound CT", rationale: "Concentric rings representing bowel-in-bowel intussusception or mesenteric vessel swirling in volvulus." },
      { pattern: /\b(thumbprinting)\b/i, concept: "Thumbprinting Sign Ischemic Colitis", type: "radiology", query: "Thumbprinting ischemic colitis X ray CT", rationale: "Submucosal edema and hemorrhage causing scalloped mucosal indentations resembling thumbprints." },
      { pattern: /\b(string sign of kantor|cobblestone)\b/i, concept: "String Sign of Kantor in Crohn's", type: "radiology", query: "Crohn disease string sign Kantor barium", rationale: "Severe spasm and transmural stricturing of terminal ileum with ulcerated cobblestone mucosa." },
      { pattern: /\b(sentinel loop|colon cut-?off)\b/i, concept: "Sentinel Loop & Colon Cut-Off Sign", type: "radiology", query: "Acute pancreatitis sentinel loop colon cutoff sign", rationale: "Localized ileus of proximal jejunum and abrupt termination of transverse colon gas due to pancreatic inflammation." },
      { pattern: /\b(eus|endoscopic ultrasound)\b/i, concept: "EUS 5-Layer GI Wall Anatomy", type: "radiology", query: "Endoscopic ultrasound 5 layers GI wall", rationale: "Alternating hyperechoic and hypoechoic layers defining mucosa, submucosa, muscularis propria, and adventitia." },
      { pattern: /\b(daintree johnson)\b/i, concept: "Daintree Johnson Gastric Ulcer Classification", type: "criteria", query: "Daintree Johnson classification gastric ulcer diagram", rationale: "Standard surgical classification dividing gastric ulcers into Types I-V based on location and acid secretion." },
      { pattern: /\b(forrest classif)\b/i, concept: "Forrest Classification Peptic Ulcer Bleeding", type: "criteria", query: "Forrest classification peptic ulcer bleeding table", rationale: "Guides urgent endoscopic intervention vs medical therapy based on bleeding stigmata." },
      { pattern: /\b(lauren|borrmann)\b/i, concept: "Lauren & Borrmann Gastric Cancer Classifications", type: "criteria", query: "Borrmann classification gastric cancer diagram", rationale: "Borrmann gross morphology Types I-IV and Lauren intestinal vs diffuse histological subtypes." },
      { pattern: /\b(siewert)\b/i, concept: "Siewert Classification GEJ Tumors", type: "criteria", query: "Siewert classification gastroesophageal junction diagram", rationale: "Categorizes GEJ tumors into Types I, II, and III to determine surgical approach." },
      { pattern: /\b(alvarado)\b/i, concept: "Alvarado MANTRELS Score Table", type: "criteria", query: "Alvarado score acute appendicitis criteria table", rationale: "Widely tested clinical risk scoring system based on symptoms, signs, and laboratory values." },
      { pattern: /\b(atlanta|balthazar|ctsi)\b/i, concept: "Revised Atlanta Classification & CTSI", type: "criteria", query: "Revised Atlanta classification acute pancreatitis diagram", rationale: "Defines acute peripancreatic fluid collections, pseudocyst, ANC, and walled-off necrosis." },
      { pattern: /\b(child-?pugh|meld)\b/i, concept: "Child-Pugh Score Table", type: "criteria", query: "Child Pugh score classification cirrhosis table", rationale: "Stratifies perioperative surgical risk in cirrhosis across bilirubin, albumin, INR, ascites, and encephalopathy." },
      { pattern: /\b(hinchey)\b/i, concept: "Modified Hinchey Classification Diverticulitis", type: "criteria", query: "Hinchey classification diverticulitis diagram", rationale: "Essential staging from pericolic phlegmon to purulent and feculent peritonitis." },
      { pattern: /\b(bismuth-?corlette)\b/i, concept: "Bismuth-Corlette Hilar Cholangiocarcinoma", type: "criteria", query: "Bismuth Corlette classification Klatskin tumor diagram", rationale: "Determines resectability of hilar cholangiocarcinoma based on biliary confluence involvement." },
      { pattern: /\b(todani)\b/i, concept: "Todani Classification Choledochal Cysts", type: "criteria", query: "Todani classification choledochal cysts diagram", rationale: "Guides surgical excision vs drainage based on cystic dilatation of extrahepatic and intrahepatic biliary tree." },
      { pattern: /\b(nyhus|gilbert)\b/i, concept: "Nyhus & Gilbert Hernia Classifications", type: "criteria", query: "Nyhus classification inguinal hernia table", rationale: "Categorizes hernias by deep ring integrity, posterior wall defect, femoral involvement, and recurrence." },
      { pattern: /\b(ranson|glasgow)\b/i, concept: "Ranson Criteria Acute Pancreatitis", type: "criteria", query: "Ranson criteria acute pancreatitis table", rationale: "Predicts mortality at admission and within 48 hours in gallstone vs non-gallstone pancreatitis." },
      { pattern: /\b(vagotomy|truncal vagotomy|hsv|latarjet)\b/i, concept: "Truncal vs Highly Selective Vagotomy", type: "clinical", query: "Vagotomy truncal selective highly selective diagram", rationale: "Detailed vagal nerve anatomy contrasting truncal vagotomy vs HSV preserving nerve of Latarjet." },
      { pattern: /\b(graham patch|cellan-?jones)\b/i, concept: "Graham Omental Patch Repair", type: "clinical", query: "Graham patch repair perforated ulcer diagram", rationale: "Standard operative repair of perforated duodenal/gastric ulcer utilizing vascularized omental plug." },
      { pattern: /\b(billroth|roux-?en-?y|gastrectomy)\b/i, concept: "Billroth I, II & Roux-en-Y Reconstruction", type: "clinical", query: "Billroth I II Roux en Y diagram", rationale: "Classic surgical reconstructions following partial gastrectomy illustrating gastrojejunostomy loops." },
      { pattern: /\b(whipple|pancreaticoduodenectomy)\b/i, concept: "Whipple Procedure Reconstruction", type: "clinical", query: "Whipple procedure labeled diagram", rationale: "Master surgical operation showing pancreaticojejunostomy, hepaticojejunostomy, and gastrojejunostomy." },
      { pattern: /\b(d1 vs d2|d2 dissection|d1 dissection|lymphadenectomy)\b/i, concept: "Gastric Cancer D1 vs D2 Lymph Nodes", type: "diagram", query: "Gastric cancer lymph node stations diagram", rationale: "Contrasts perigastric stations 1-6 with extra-perigastric stations 7-12." },
      { pattern: /\b(lichtenstein|shouldice|tapp|tep)\b/i, concept: "Lichtenstein Mesh vs Shouldice Repair", type: "clinical", query: "Lichtenstein mesh repair inguinal hernia diagram", rationale: "Key steps in tension-free polypropylene mesh placement and fixation." },
      { pattern: /\b(hartmann|miles|abdominoperineal)\b/i, concept: "Hartmann's Procedure vs APR", type: "clinical", query: "Hartmann procedure colostomy rectal stump diagram", rationale: "Comparison between rectosigmoid resection with end colostomy vs complete abdominoperineal resection." },
      { pattern: /\b(curling|cushing)\b/i, concept: "Curling vs Cushing Stress Ulcers", type: "clinical", query: "Curling ulcer vs Cushing ulcer table", rationale: "Contrasts hypovolemia-induced mucosal ischemia in burns vs ICP-induced vagal hypersecretion." },
      { pattern: /\b(dumping syndrome)\b/i, concept: "Early vs Late Dumping Syndrome", type: "clinical", query: "Early vs late dumping syndrome pathophysiology", rationale: "Contrasts hyperosmolar rapid small bowel fluid shift (early) vs reactive hypoglycemia (late)." },
      { pattern: /\b(sma syndrome|wilkie|median arcuate|dunbar)\b/i, concept: "SMA Syndrome (Wilkie's) Anatomy", type: "radiology", query: "Superior mesenteric artery syndrome CT diagram", rationale: "Demonstrates vascular compression of third part of duodenum between aorta and SMA." },
      { pattern: /\b(signet-?ring)\b/i, concept: "Signet-Ring Cell Carcinoma Histology", type: "histology", query: "Signet ring cell carcinoma histology", rationale: "Microscopic hallmark featuring intracytoplasmic mucin vacuole pushing nucleus to periphery." },
      { pattern: /\b(reed-?sternberg)\b/i, concept: "Reed-Sternberg Cells Hodgkin Lymphoma", type: "histology", query: "Reed Sternberg cell Hodgkin lymphoma histology", rationale: "Giant binucleated neoplastic cells with prominent eosinophilic nucleoli and clear halos." },
      { pattern: /\b(psammoma)\b/i, concept: "Psammoma Bodies Histopathology", type: "histology", query: "Psammoma bodies papillary thyroid carcinoma histology", rationale: "Concentric laminated calcifications characteristic of papillary thyroid cancer and meningioma." },
      { pattern: /\b(orphan annie)\b/i, concept: "Orphan Annie Eye Nuclei", type: "histology", query: "Orphan Annie eye nuclei thyroid histology", rationale: "Optically clear ground-glass nuclei with nuclear grooves in papillary thyroid carcinoma." },
      { pattern: /\b(correa cascade)\b/i, concept: "Correa Cascade of Gastric Cancer", type: "criteria", query: "Correa cascade gastric carcinogenesis flowchart", rationale: "Sequential progression from normal mucosa to gastritis, metaplasia, dysplasia, and adenocarcinoma." },
      { pattern: /\b(virchow|troisier|krukenberg|blumer|sister mary joseph)\b/i, concept: "GI Malignancy Metastatic Signposts", type: "clinical", query: "Virchow node Krukenberg tumor Sister Mary Joseph", rationale: "Classic surgical exam spots demonstrating supraclavicular, ovarian, pelvic, and periumbilical metastases." }
    ];
  }

  async scanNote(noteTitle, noteContent, maxSuggestions = 20, onProgress = null, scope = null) {
    if (onProgress) onProgress("Running Offline Medical Rules Engine...");
    maxSuggestions = maxSuggestions || 20;

    const prepared = prepareScopedLines(noteContent, scope);
    const { allLines, totalLines, startLine, endLine, totalImagesFound, scope: normScope } = prepared;

    const sectionList = [];
    let currentHeading = normScope?.parentHeading || "Introduction";
    const lineHeadings = [];

    allLines.forEach((line, idx) => {
      const hm = line.match(/^(#{1,6})\s+(.*)$/);
      if (hm) {
        currentHeading = hm[2].replace(/[#*`_]/g, "").trim();
        const lineNum = idx + 1;
        if (lineNum >= startLine && lineNum <= endLine) {
          sectionList.push({ line: lineNum, heading: currentHeading });
        }
      }
      lineHeadings.push(currentHeading);
    });

    const matchedSuggestions = [];
    const seenQueries = new Set();
    const rules = OfflineMedicalScanner.CLINICAL_RULES;

    for (let i = startLine - 1; i < endLine; i++) {
      if (matchedSuggestions.length >= maxSuggestions * 2) break;
      const lineText = allLines[i];
      if (!lineText || lineText.trim().length < 4) continue;
      if (/!\[\[.*?\]\]|!\[.*?\]\(.*?\)/.test(lineText)) continue;

      for (const rule of rules) {
        if (rule.pattern.test(lineText)) {
          if (!seenQueries.has(rule.query)) {
            seenQueries.add(rule.query);
            matchedSuggestions.push({
              heading: lineHeadings[i] || noteTitle,
              line: i + 1,
              visualConcept: rule.concept,
              visualType: rule.type,
              rationale: rule.rationale,
              recommendedQuery: rule.query
            });
            if (matchedSuggestions.length >= maxSuggestions * 2) break;
          }
        }
      }
    }

    if (matchedSuggestions.length < maxSuggestions) {
      const META_HEADINGS = /^(?:introduction|overview|summary|references|bibliography|contents|table of contents|key points|notes|conclusion|appendix)$/i;
      for (const sec of sectionList) {
        if (matchedSuggestions.length >= maxSuggestions) break;
        const cleanTitle = sec.heading
          .replace(/^(?:Part|Section|Module)\s+\d+\s*[:.\-–—]?\s*/i, "")
          .replace(/^Chapter\s+\d+\s*[:.\-–—]?\s*/i, "")
          .replace(/^(?:\d+|[A-Z])[.)]\s+/, "")
          .trim();
        if (cleanTitle.length < 3 || META_HEADINGS.test(cleanTitle)) continue;
        const genericQuery = `${cleanTitle} anatomy diagram`;
        if (!seenQueries.has(genericQuery)) {
          seenQueries.add(genericQuery);
          matchedSuggestions.push({
            heading: sec.heading,
            line: sec.line,
            visualConcept: `${cleanTitle} Key Anatomy / Procedure`,
            visualType: "diagram",
            rationale: `Core section covering ${cleanTitle} requiring visual representation for exam retention.`,
            recommendedQuery: genericQuery
          });
        }
      }
    }

    if (matchedSuggestions.length === 0) {
      return {
        summary: `Offline Medical Rules Engine identified 0 visual opportunities${normScope ? ` in ${normScope.label}` : ` across ${sectionList.length} sections`}.`,
        existingImages: totalImagesFound,
        suggestions: [],
        scope: normScope
      };
    }

    const sanitized = GeminiScannerService.sanitizeSuggestions(
      {
        summary: `Offline Medical Rules Engine identified ${matchedSuggestions.length} high-yield visual opportunities${normScope ? ` in ${normScope.label}` : ` across ${sectionList.length} sections`}.`,
        suggestions: matchedSuggestions
      },
      totalLines,
      maxSuggestions
    );

    const scopedResult = GeminiScannerService.filterSuggestionsByScope(sanitized, normScope, totalLines);
    return {
      summary: scopedResult.summary,
      existingImages: totalImagesFound,
      suggestions: scopedResult.suggestions,
      scope: scopedResult.scope || normScope
    };
  }
}

// -------------------------------------------------------------
// AI Visual Scanner Service (Prompt Bridge + Optional Gemini API)
// -------------------------------------------------------------

class GeminiScannerService {
  constructor(apiKey, model = "gemini-2.5-flash", plugin = null) {
    this.apiKey = (apiKey || "").trim();
    this.model = model || "gemini-2.5-flash";
    this.plugin = plugin;
  }

  static normalizeVisualType(typeStr) {
    if (!typeStr) return "diagram";
    const lower = String(typeStr).toLowerCase();
    if (lower.includes("radio") || lower.includes("x-ray") || lower.includes("ct") || lower.includes("mri") || lower.includes("barium")) return "radiology";
    if (lower.includes("histo") || lower.includes("path") || lower.includes("micro") || lower.includes("hpe")) return "histology";
    if (lower.includes("clin") || lower.includes("surg") || lower.includes("operat")) return "clinical";
    if (lower.includes("crit") || lower.includes("score") || lower.includes("classif") || lower.includes("table")) return "criteria";
    if (lower.includes("embryo") || lower.includes("physio")) return "embryology";
    return "diagram";
  }

  static simplifySearchQuery(query, fallbackConcept = "", visualType = "diagram") {
    if (!query || typeof query !== "string") {
      query = fallbackConcept || "medical diagram";
    }
    let q = query.trim();
    q = q.replace(/^[`'"“”‘’]+|[`'"“”‘’]+$/g, "").trim();
    q = q.replace(/[*_`]/g, " ");
    q = q.replace(/\s*\([^)]*\)/g, " ");
    q = q.replace(/^(?:search(?:\s+for)?|find|images?\s+of|illustrations?\s+of|schematics?\s+of|pictures?\s+of|photos?\s+of|drawings?\s+of|diagram\s+of)\s+/i, "");
    q = q.replace(/\b(?:PJ|HJ|GJ)\b/gi, " ");
    q = q.replace(/\b[A-Z]{2,3}(?:\s+[A-Z]{2,3}){2,}\b/g, " ");
    q = q.replace(/\b(?:high[- ]yield|high[- ]resolution|high[- ]res|hd|4k|for\s+medical\s+students|exam\s+revision|neet[- ]pg|usmle|mbbs\s+proff?s?)\b/gi, " ");
    q = q.replace(/\b(?:showing|depicting|demonstrating|illustrating|revealing)\b/gi, " ");
    q = q.replace(/\b(?:smooth tapering|dilated loop|erect view|plain radiograph|plain|erect|comparative)\b/gi, " ");
    q = q.replace(/\b(?:microscopic|appearance|assessment)\b/gi, " ");
    q = q.replace(/\b(?:surface landmark|anatomical surface)\b/gi, " ");
    q = q.replace(/\b(?:owl eye|owl-eye)\b/gi, " ");
    q = q.replace(/\b(?:HE stain|H&E stain|HE|H&E)\b/gi, " ");

    if (/\bwhipple\b/i.test(q) && /\bpancreaticoduodenectomy\b/i.test(q)) {
      q = q.replace(/\bpancreaticoduodenectomy\b/gi, "procedure");
    }
    if (/\b(?:cystogastrostomy)\b/i.test(q) && /\b(?:cystojejunostomy)\b/i.test(q)) {
      q = q.replace(/\b(?:Jurasz|Roux-en-Y\s+cystojejunostomy|cystojejunostomy)\b/gi, " ");
    }

    q = q.replace(/[,:;/|\\+]/g, " ");
    q = q.replace(/\s+/g, " ").trim();

    const words = q.split(" ").filter(Boolean);
    const seen = new Set();
    const deduped = [];
    for (const w of words) {
      const lower = w.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        deduped.push(w);
      }
    }

    if (deduped.length > 7) {
      const stopwords = new Set(["the", "a", "an", "and", "or", "of", "in", "for", "with", "to", "at", "by", "from"]);
      const filtered = deduped.filter((w) => !stopwords.has(w.toLowerCase()));
      if (filtered.length >= 3 && filtered.length <= 7) {
        q = filtered.join(" ");
      } else if (filtered.length > 7) {
        const anchors = ["diagram", "sign", "x-ray", "ct", "mri", "histology", "table", "anatomy", "illustration", "spotter", "ultrasound", "usg", "appearance"];
        const lastWord = filtered[filtered.length - 1];
        q = anchors.includes(lastWord.toLowerCase())
          ? filtered.slice(0, 4).concat(lastWord).join(" ")
          : filtered.slice(0, 5).join(" ");
      } else {
        q = deduped.slice(0, 6).join(" ");
      }
    } else {
      q = deduped.join(" ");
    }

    q = q.replace(/\b(\w+)\s+\1\b/gi, "$1").replace(/\s+/g, " ").trim();
    if (!q) {
      q = (fallbackConcept || "medical") + " " + (visualType === "radiology" ? "x-ray" : "diagram");
    }
    return q;
  }

  static scoreHighYield(suggestion) {
    let score = 0;
    const type = (suggestion.visualType || "").toLowerCase();
    const combined = `${suggestion.heading || ""} ${suggestion.visualConcept || ""} ${suggestion.rationale || ""} ${suggestion.recommendedQuery || ""}`.toLowerCase();

    if (/\btriangle\b|\btriangles\b/.test(combined)) score += 30;
    if (/\b(?:calot|hesselbach|scarpa|femoral|carotid|submandibular|digastric|muscular|suboccipital|codman|trapezoid|killian|lumbocostal|bouchet|koch|grynfeltt|petit|passaro)\b/.test(combined)) score += 35;
    if (/\b(?:boundaries|relations|borders|contents|walls|floor|roof)\b/.test(combined)) score += 20;
    if (/\b(?:canal|sheath|fascia|fascial|arcade|space|hiatus|foramen|compartment)\b/.test(combined)) score += 15;
    if (/\b(?:blood supply|nerve supply|arterial|innervation|lymphatic drainage|anastomosis|anastomoses|course|branches)\b/.test(combined)) score += 15;
    if (/\bpathognomonic\b/.test(combined)) score += 35;
    if (/\b(?:x-ray|radiograph|radiology|ct|mri|usg|ultrasound|barium swallow|barium enema)\b/.test(combined)) score += 15;
    if (/\b(?:sign|spotter|appearance|pattern)\b/.test(combined)) score += 20;
    if (/\b(?:double[- ]bubble|bird[- ]beak|coffee[- ]bean|apple[- ]core|whirl|target|stepladder|step[- ]ladder|string sign|lead pipe|thumbprinting|rigler|sentinel loop|colon cut-?off)\b/.test(combined)) score += 35;
    if (/\b(?:classification|staging|grading|criteria|scoring|score)\b/.test(combined)) score += 25;
    if (/\b(?:forrest|daintree johnson|lauren|borrmann|siewert|alvarado|atlanta|balthazar|child[- ]?pugh|meld|hinchey|bismuth|todani|nyhus|gilbert|ranson|glasgow|correa)\b/.test(combined)) score += 30;
    if (/\b(?:repair|procedure|reconstruction|anastomosis|incision|gastrectomy|vagotomy|cholecystectomy|hernioplasty|herniorrhaphy)\b/.test(combined)) score += 20;
    if (/\b(?:whipple|billroth|roux[- ]en[- ]y|graham patch|lichtenstein|shouldice|hartmann|miles|nissan|nissen|heller)\b/.test(combined)) score += 30;
    if (/\b(?:histology|histopathology|hpe|biopsy|microscopy|h&e)\b/.test(combined)) score += 15;
    if (/\b(?:reed[- ]?sternberg|psammoma|orphan annie|signet[- ]?ring|auer rod|koilocyte|granuloma)\b/.test(combined)) score += 35;
    if (/\b(?:triangle of doom|triangle of pain|curling|cushing|dumping|virchow|krukenberg)\b/.test(combined)) score += 25;
    if (/\b(?:exam|viva|neet|high[- ]yield|proff)\b/.test(combined)) score += 15;

    if (type === "radiology" || type === "criteria") score += 10;
    else if (type === "diagram" || type === "clinical") score += 8;
    else if (type === "histology") score += 6;

    return score;
  }

  static sanitizeSuggestions(data, maxLines = Infinity, maxSuggestions = 25) {
    const summary = typeof data?.summary === "string" ? data.summary : "Scan complete.";
    const rawList = Array.isArray(data?.suggestions) ? data.suggestions : [];
    const valid = [];

    for (let i = 0; i < rawList.length; i++) {
      const s = rawList[i];
      if (!s || typeof s !== "object") continue;
      let line = 1;
      if (typeof s.line === "number" && Number.isFinite(s.line)) line = Math.round(s.line);
      else if (typeof s.line === "string") {
        const m = s.line.match(/\d+/);
        if (m) line = parseInt(m[0], 10);
      }
      if (isNaN(line) || line < 1) line = 1;
      if (maxLines !== Infinity && line > maxLines) line = Math.max(1, maxLines);

      const heading = typeof s.heading === "string" && s.heading.trim() ? s.heading.trim() : "General";
      const visualConcept = typeof s.visualConcept === "string" && s.visualConcept.trim() ? s.visualConcept.trim() : heading;
      const visualType = GeminiScannerService.normalizeVisualType(s.visualType || "diagram");
      const rationale = typeof s.rationale === "string" && s.rationale.trim()
        ? s.rationale.trim()
        : "High-yield visual gap for clinical understanding and exam revision.";
      const rawQuery = typeof s.recommendedQuery === "string" && s.recommendedQuery.trim()
        ? s.recommendedQuery.trim()
        : visualConcept;
      const recommendedQuery = GeminiScannerService.simplifySearchQuery(rawQuery, visualConcept, visualType);

      if (!visualConcept && !recommendedQuery) continue;

      valid.push({
        heading,
        line,
        visualConcept,
        visualType,
        rationale,
        recommendedQuery,
        _origIdx: i
      });
    }

    if (valid.length === 0) {
      throw new Error("No valid visual suggestions found in response.");
    }

    const cap = Math.min(typeof maxSuggestions === "number" && maxSuggestions > 0 ? maxSuggestions : 25, 50);
    let resultList;
    if (valid.length > cap) {
      for (const item of valid) item._score = GeminiScannerService.scoreHighYield(item);
      valid.sort((a, b) => (b._score - a._score) || (a._origIdx - b._origIdx));
      resultList = valid.slice(0, cap);
      resultList.sort((a, b) => (a.line - b.line) || (a._origIdx - b._origIdx));
    } else {
      valid.sort((a, b) => (a.line - b.line) || (a._origIdx - b._origIdx));
      resultList = valid;
    }

    for (const item of resultList) {
      delete item._origIdx;
      delete item._score;
    }

    return { summary, suggestions: resultList };
  }

  static parseMarkdownTable(text, maxLines = Infinity, maxSuggestions = 25) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const tableLines = lines.filter((l) => l.startsWith("|") && l.endsWith("|"));
    if (tableLines.length < 2) return null;

    let headerIndex = -1;
    for (let i = 0; i < tableLines.length; i++) {
      const lower = tableLines[i].toLowerCase();
      if (lower.includes("line") || lower.includes("concept") || lower.includes("query") || lower.includes("heading")) {
        headerIndex = i;
        break;
      }
    }
    if (headerIndex === -1) return null;

    const parseCells = (row) => row.split("|").slice(1, -1).map((c) => c.trim());
    const headers = parseCells(tableLines[headerIndex]).map((h) => h.toLowerCase().replace(/[*_`]/g, ""));

    const lineIdx = headers.findIndex((h) => h.includes("line"));
    const headIdx = headers.findIndex((h) => h.includes("head") || h.includes("sec"));
    const conceptIdx = headers.findIndex((h) => h.includes("concept") || h.includes("title") || (h.includes("visual") && !h.includes("type")));
    const typeIdx = headers.findIndex((h) => h.includes("type") || h.includes("category"));
    const ratIdx = headers.findIndex((h) => h.includes("rationale") || h.includes("reason") || h.includes("why") || h.includes("desc"));
    const queryIdx = headers.findIndex((h) => h.includes("query") || h.includes("search") || h.includes("duckduckgo"));

    const suggestions = [];
    for (let i = headerIndex + 1; i < tableLines.length; i++) {
      const row = tableLines[i];
      if (/^[|\s\-:]+$/.test(row)) continue;
      const cells = parseCells(row);
      if (cells.length < 2) continue;

      let line = 1;
      if (lineIdx !== -1 && cells[lineIdx]) {
        const m = cells[lineIdx].match(/(?:\[?L?)(\d+)\]?/i);
        if (m) line = parseInt(m[1], 10);
      }

      const heading = headIdx !== -1 && cells[headIdx] ? cells[headIdx].replace(/[*_`]/g, "").trim() : "General";
      const visualConcept = conceptIdx !== -1 && cells[conceptIdx] ? cells[conceptIdx].replace(/[*_`]/g, "").trim() : heading || "Medical Visual";
      const visualType = GeminiScannerService.normalizeVisualType(typeIdx !== -1 ? cells[typeIdx] : "diagram");
      const rationale = ratIdx !== -1 && cells[ratIdx] ? cells[ratIdx].replace(/[*_`]/g, "").trim() : "High-yield visual gap for clinical understanding and exam revision.";
      let query = queryIdx !== -1 && cells[queryIdx] ? cells[queryIdx].replace(/[*_`'"]/g, "").trim() : visualConcept;
      if (!query) query = visualConcept + " " + (visualType === "diagram" ? "anatomy diagram" : visualType);

      suggestions.push({
        heading: heading || "General",
        line: isNaN(line) || line < 1 ? 1 : maxLines !== Infinity && line > maxLines ? Math.min(line, maxLines) : line,
        visualConcept: visualConcept || "Medical Visual",
        visualType,
        rationale,
        recommendedQuery: query
      });
    }

    if (suggestions.length === 0) return null;
    return GeminiScannerService.sanitizeSuggestions(
      { summary: `Parsed ${suggestions.length} visual suggestions from Markdown table.`, suggestions },
      maxLines,
      maxSuggestions
    );
  }

  static parseMarkdownSuggestions(text, maxLines = Infinity, maxSuggestions = 25) {
    const lines = text.split(/\r?\n/);
    const items = [];
    let currentItem = null;
    let summary = "";

    const hasNumbered = lines.some((l) => /^\s*(?:#{1,4}\s*)?(?:Suggestion\s*)?\d+[.)]\s+/i.test(l.trim()));
    const isPropertyLine = (line) =>
      /^[-*]?\s*(?:\*\*)?(?:Line(?: Number)?|Section|Heading|Visual Concept|Concept|Image Title|Title|Visual Type|Type|Category|Clinical Rationale|Rationale|Why|Description|DuckDuckGo(?: Search)? Query|Search Query|Recommended Query|Query)(?:\*\*)?\s*[:\-–—]/i.test(line);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (!summary && (line.toLowerCase().startsWith("summary:") || line.toLowerCase().startsWith("### summary") || line.toLowerCase().startsWith("**summary**"))) {
        summary = line.replace(/^(?:###|\*\*|summary:?)\s*/i, "").replace(/\*\*$/, "").trim();
        continue;
      }

      if (hasNumbered) {
        if (/^\s*(?:#{1,4}\s*)?(?:Suggestion\s*)?\d+[.)]\s+/i.test(line)) {
          if (currentItem && currentItem.rawLines.length > 0) items.push(currentItem);
          currentItem = { rawLines: [line] };
          continue;
        }
        if (currentItem) currentItem.rawLines.push(line);
      } else {
        const isBullet = /^[-*]\s+/.test(line);
        const isProp = isPropertyLine(line);
        if (isBullet && !isProp) {
          if (currentItem && currentItem.rawLines.length > 0) items.push(currentItem);
          currentItem = { rawLines: [line] };
          continue;
        }
        if (currentItem) currentItem.rawLines.push(line);
        else if (isBullet || isProp) currentItem = { rawLines: [line] };
      }
    }
    if (currentItem && currentItem.rawLines.length > 0) items.push(currentItem);

    const suggestions = [];
    for (const item of items) {
      const joined = item.rawLines.join("\n");

      let lineNum = 1;
      const lMatch =
        joined.match(/(?:^|\n)\s*[-*]?\s*(?:\*\*(?:Line|Line Number)\*\*|Line|Line Number)\s*[:\-–—]\s*(?:Line\s*|\[?L?)(\d+)\]?/i) ||
        joined.match(/(?:\[L(\d+)\]|\bLine\s*(\d+)\b|\bL(\d+)\b)/i);
      if (lMatch) lineNum = parseInt(lMatch[1] || lMatch[2] || lMatch[3], 10);

      let heading = "General";
      const hMatch = joined.match(/(?:^|\n)\s*[-*]?\s*(?:\*\*(?:Section|Heading)\*\*|Heading|Section)\s*[:\-–—]\s*([^\n\r*]+)/i);
      if (hMatch) {
        heading = hMatch[1].trim();
      } else {
        const firstLineHeader = item.rawLines[0].replace(/^\s*(?:#{1,4}\s*)?(?:\d+[.)]\s*|[-*]\s*)/, "").replace(/^\*\*|\*\*$/g, "").trim();
        if (firstLineHeader && !firstLineHeader.toLowerCase().includes("concept")) {
          heading = firstLineHeader.split(/[-–—:]/)[0].trim();
        }
      }

      let concept = "";
      const cMatch = joined.match(/(?:^|\n)\s*[-*]?\s*(?:\*\*(?:Visual Concept|Concept|Image Title|Title)\*\*|Visual Concept|Concept|Image Title|Title)\s*[:\-–—]\s*([^\n\r*]+)/i);
      if (cMatch) {
        concept = cMatch[1].trim();
      } else {
        const firstBold = item.rawLines[0].match(/\*\*([^*]+)\*\*/);
        if (firstBold && !/^(?:heading|section|line|type|visual type|rationale|query)$/i.test(firstBold[1].trim())) {
          concept = firstBold[1].trim();
        } else {
          const cleanedFirst = item.rawLines[0].replace(/^\s*(?:#{1,4}\s*)?(?:\d+[.)]\s*|[-*]\s*)/, "").replace(/[*_`]/g, "").trim();
          if (cleanedFirst) concept = cleanedFirst;
        }
      }

      let visualType = "diagram";
      const tMatch = joined.match(/(?:^|\n)\s*[-*]?\s*(?:\*\*(?:Visual Type|Type|Category)\*\*|Visual Type|Type|Category)\s*[:\-–—]\s*([^\n\r*]+)/i);
      if (tMatch) visualType = GeminiScannerService.normalizeVisualType(tMatch[1].trim());

      let rationale = "High-yield visual gap for clinical understanding and exam revision.";
      const rMatch = joined.match(/(?:^|\n)\s*[-*]?\s*(?:\*\*(?:Rationale|Clinical Rationale|Why)\*\*|Rationale|Clinical Rationale|Why)\s*[:\-–—]\s*([^\n\r]+)/i);
      if (rMatch) rationale = rMatch[1].trim();

      let query = "";
      const qMatch = joined.match(/(?:^|\n)\s*[-*]?\s*(?:\*\*(?:DuckDuckGo Search Query|DuckDuckGo Query|Search Query|Recommended Query|Query)\*\*|DuckDuckGo Search Query|DuckDuckGo Query|Search Query|Recommended Query|Query)\s*[:\-–—]\s*[`'"]?([^\n\r`'"]+)[`'"]?/i);
      if (qMatch) query = qMatch[1].trim();

      if (!concept && !query && heading === "General") continue;
      if (!concept) concept = query || heading;
      if (!query) query = concept + " " + (visualType === "diagram" ? "anatomy diagram" : visualType);
      query = query.replace(/^[`'"]+|[`'"]+$/g, "").trim();

      suggestions.push({
        heading: heading || "General",
        line: isNaN(lineNum) || lineNum < 1 ? 1 : maxLines !== Infinity && lineNum > maxLines ? Math.min(lineNum, maxLines) : lineNum,
        visualConcept: concept,
        visualType,
        rationale,
        recommendedQuery: query
      });
    }

    if (suggestions.length === 0) return null;
    return GeminiScannerService.sanitizeSuggestions(
      { summary: summary || `Identified ${suggestions.length} visual suggestions.`, suggestions },
      maxLines,
      maxSuggestions
    );
  }

  static filterSuggestionsByScope(parsed, scope = null, maxLines = Infinity) {
    if (!parsed || !Array.isArray(parsed.suggestions)) return parsed;
    const normScope = normalizeScanScope(scope, maxLines);
    if (!normScope) return parsed;

    const minAllowed = normScope.startLine - 1;
    const maxAllowed = normScope.endLine + 1;
    const kept = [];
    let filteredOutCount = 0;

    for (const s of parsed.suggestions) {
      if (!s) continue;
      if (s.line >= minAllowed && s.line <= maxAllowed) {
        kept.push({
          ...s,
          line: Math.max(normScope.startLine, Math.min(normScope.endLine, s.line))
        });
      } else {
        filteredOutCount++;
      }
    }

    if (kept.length === 0) {
      throw new Error(
        `All ${parsed.suggestions.length} AI suggestion(s) fell outside your scan scope (Lines ${normScope.startLine}–${normScope.endLine}). Ensure AI uses [L${normScope.startLine}]–[L${normScope.endLine}] line numbers.`
      );
    }

    kept.sort((a, b) => a.line - b.line);
    return {
      ...parsed,
      suggestions: kept,
      scope: normScope,
      filteredOutCount
    };
  }

  static parseGeminiResponse(rawText, maxLines = Infinity, maxSuggestions = 25, scope = null) {
    const baseResult = GeminiScannerService._parseUnscopedResponse(rawText, maxLines, maxSuggestions);
    return GeminiScannerService.filterSuggestionsByScope(baseResult, scope, maxLines);
  }

  static _parseUnscopedResponse(rawText, maxLines = Infinity, maxSuggestions = 25) {
    if (!rawText || !rawText.trim()) {
      throw new Error("Input is empty. Copy the AI response and try again.");
    }
    const clean = rawText.trim();

    const jsonCandidates = [];
    const jsonBlockMatch = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) jsonCandidates.push(jsonBlockMatch[1].trim());

    const firstBrace = clean.indexOf("{");
    const lastBrace = clean.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) jsonCandidates.push(clean.slice(firstBrace, lastBrace + 1));

    const firstBracket = clean.indexOf("[");
    const lastBracket = clean.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket > firstBracket) jsonCandidates.push(clean.slice(firstBracket, lastBracket + 1));

    for (const cand of jsonCandidates) {
      const sanitized = cand.replace(/,\s*([\]}])/g, "$1");
      for (const str of [cand, sanitized]) {
        try {
          let parsed = JSON.parse(str);
          if (Array.isArray(parsed)) parsed = { suggestions: parsed };
          if (parsed && Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
            return GeminiScannerService.sanitizeSuggestions(parsed, maxLines, maxSuggestions);
          }
        } catch (_) {
          try {
            const cleanedStr = str.replace(/[\u0000-\u001F]+/g, (m) => (m === "\n" || m === "\r" || m === "\t" ? " " : ""));
            let parsed = JSON.parse(cleanedStr);
            if (Array.isArray(parsed)) parsed = { suggestions: parsed };
            if (parsed && Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
              return GeminiScannerService.sanitizeSuggestions(parsed, maxLines, maxSuggestions);
            }
          } catch (_) {}
          const lb = str.lastIndexOf("}");
          if (lb !== -1) {
            const candidate = str.slice(0, lb + 1);
            for (const suffix of ["]}", "}", "]"]) {
              try {
                let parsed = JSON.parse(candidate + suffix);
                if (Array.isArray(parsed)) parsed = { suggestions: parsed };
                if (parsed && Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
                  return GeminiScannerService.sanitizeSuggestions(parsed, maxLines, maxSuggestions);
                }
              } catch (_) {}
            }
          }
        }
      }
    }

    const tableSuggestions = GeminiScannerService.parseMarkdownTable(clean, maxLines, maxSuggestions);
    if (tableSuggestions && tableSuggestions.suggestions.length > 0) return tableSuggestions;

    const mdSuggestions = GeminiScannerService.parseMarkdownSuggestions(clean, maxLines, maxSuggestions);
    if (mdSuggestions && mdSuggestions.suggestions.length > 0) return mdSuggestions;

    const blockSuggestions = [];
    const blockRegex = /\{([^{}]+)\}/g;
    let bMatch;
    while ((bMatch = blockRegex.exec(clean)) !== null) {
      const block = bMatch[1];
      const hMatch = block.match(/(?:"|'|)\b(?:heading|section)\b(?:"|'|)\s*:\s*["']((?:\\.|[^"'\\])*?)["']/i);
      const lMatch = block.match(/(?:"|'|)\b(?:line|l)\b(?:"|'|)\s*:\s*"?\[?L?(\d+)\]?"?/i);
      const cMatch = block.match(/(?:"|'|)\b(?:visualConcept|concept|title)\b(?:"|'|)\s*:\s*["']((?:\\.|[^"'\\])*?)["']/i);
      const tMatch = block.match(/(?:"|'|)\b(?:visualType|type|category)\b(?:"|'|)\s*:\s*["']((?:\\.|[^"'\\])*?)["']/i);
      const rMatch = block.match(/(?:"|'|)\b(?:rationale|reason|description)\b(?:"|'|)\s*:\s*["']((?:\\.|[^"'\\])*?)["']/i);
      const qMatch = block.match(/(?:"|'|)\b(?:recommendedQuery|query|searchQuery)\b(?:"|'|)\s*:\s*["']((?:\\.|[^"'\\])*?)["']/i);
      if ((cMatch || hMatch) && (qMatch || cMatch)) {
        blockSuggestions.push({
          heading: hMatch ? hMatch[1] : "General",
          line: lMatch ? parseInt(lMatch[1], 10) : 1,
          visualConcept: cMatch ? cMatch[1] : hMatch ? hMatch[1] : "Visual Diagram",
          visualType: GeminiScannerService.normalizeVisualType(tMatch ? tMatch[1] : "diagram"),
          rationale: rMatch ? rMatch[1] : "High-yield visual gap for clinical understanding and exam revision.",
          recommendedQuery: qMatch ? qMatch[1] : cMatch ? cMatch[1] + " diagram" : "medical diagram"
        });
      }
    }
    if (blockSuggestions.length > 0) {
      return GeminiScannerService.sanitizeSuggestions(
        { summary: `Parsed ${blockSuggestions.length} visual suggestions.`, suggestions: blockSuggestions },
        maxLines,
        maxSuggestions
      );
    }

    throw new Error("Could not find visual suggestions in the AI response. Please ensure you copied the complete output.");
  }

  static buildPrompt(noteTitle, noteContent, targetCount = 25, scope = null) {
    const prepared = prepareScopedLines(noteContent, scope);
    const { totalLines, startLine, endLine, scopedLines, totalImagesFound, scope: normScope } = prepared;
    const fullNumberedText = scopedLines.map((l, i) => `[L${startLine + i}] ${l}`).join("\n");
    const taskScopeText = normScope
      ? `Read ONLY the SELECTED SECTION below (Lines ${normScope.startLine}–${normScope.endLine} of "${noteTitle}"${normScope.parentHeading ? ` under "${normScope.parentHeading}"` : ""}).`
      : `Read the ENTIRE, UNABRIDGED medical note below from top to bottom.`;
    const scopeRulesBlock = normScope
      ? `- SCAN SCOPE LOCKED (PARTIAL NOTE): Analyze ONLY lines [L${normScope.startLine}] through [L${normScope.endLine}] (${normScope.label}). Every returned "line" MUST be an integer between ${normScope.startLine} and ${normScope.endLine}. Do NOT output suggestions outside this range.`
      : `- Scan the ENTIRE note thoroughly. Do NOT skip any section.`;
    const excerptBanner = normScope
      ? `SELECTED PARTIAL NOTE EXCERPT (${normScope.label}: Lines ${startLine}–${endLine} of ${totalLines}, preserving original line numbers):`
      : `COMPLETE UNABRIDGED NOTE:`;
    const lineMeta = normScope
      ? `Total Lines: ${scopedLines.length} selected (Lines ${startLine}–${endLine} of ${totalLines} total)${normScope.parentHeading ? `\nParent Section Context: "${normScope.parentHeading}"` : ""}`
      : `Total Lines: ${totalLines}`;

    return `You are an expert MBBS medical educator with deep knowledge of:
- Clinical Surgery (Bailey & Love, SRB, Schwartz)
- Clinical Medicine (Davidson, Harrison, Kumar & Clark)
- Anatomy (Gray's, Snell, BD Chaurasia)
- Pathology / HPE (Robbins, Harsh Mohan)
- Radiology (pathognomonic signs, pattern recognition)
- Physiology & Pharmacology & Embryology

Your task: ${taskScopeText}
Identify every significant location where a medical student needs a visual image for exam/viva retention.

VISUAL CATEGORIES:
1. diagram: Surgical triangles, fascial layers, compartments, canals, sheaths, nerve/vascular supply, cross-sections
2. radiology: Pathognomonic X-ray/CT/MRI/USG/barium signs
3. histology: Microscopic hallmarks, H&E patterns
4. clinical: Operative steps, repair layers, incisions, physical signs, reconstruction loops
5. criteria: Diagnostic criteria tables, scoring systems, classifications
6. embryology: Developmental rotations, descent, physiological curves

STRICT RULES:
${scopeRulesBlock}
- Use the [L<number>] prefix to report the EXACT line number where each visual opportunity exists.
- Keep recommendedQuery SIMPLE, CLEAN, and CONCISE (strictly 3 to 5 clear keywords, e.g. 'Whipple procedure labeled diagram', 'Double bubble sign X-ray', 'Triangle of doom diagram').
- Recommend clean textbook illustrations, anatomical diagrams, and pathognomonic spotters optimized for medical image search.
- visualType must be one of: "diagram", "radiology", "histology", "clinical", "criteria", "embryology".
- Provide at most ${targetCount} high-yield suggestions, ordered chronologically by ascending line number [L<number>].

PREFERRED OUTPUT FORMAT (valid JSON):
\`\`\`json
{
  "summary": "One sentence overview of the note topic and visual opportunities",
  "suggestions": [
    {
      "heading": "Section heading from note",
      "line": ${startLine},
      "visualConcept": "Specific image title",
      "visualType": "diagram",
      "rationale": "Why this visual is high-yield (2 sentences)",
      "recommendedQuery": "Whipple procedure labeled diagram"
    }
  ]
}
\`\`\`

Note Title: "${noteTitle}"
${lineMeta}
Existing Images: ${totalImagesFound}

${excerptBanner}
${fullNumberedText}`;
  }

  async scanNote(noteTitle, noteContent, maxSuggestions = 20, onProgress = null, scope = null) {
    if (!this.apiKey) {
      throw new Error("Gemini API key is missing. Enter it in Settings → Medical Image Finder Mobile, or use Offline / Copy & Paste AI Scanner.");
    }

    const prepared = prepareScopedLines(noteContent, scope);
    const { totalLines, startLine, endLine, scopedLines, totalImagesFound, scope: normScope } = prepared;

    let fullNumberedText = scopedLines.map((l, i) => `[L${startLine + i}] ${l}`).join("\n");
    let truncationNote = "";
    if (fullNumberedText.length > 60000) {
      fullNumberedText = fullNumberedText.slice(0, 60000);
      truncationNote = " (scanned first 60,000 characters)";
    }

    if (onProgress) {
      onProgress(`Analyzing ${normScope ? normScope.label : "note"} (${scopedLines.length} lines) with Gemini...`);
    }

    const scopeDirective = normScope
      ? ` SCAN SCOPE: Analyze ONLY lines [L${normScope.startLine}] to [L${normScope.endLine}] (${normScope.label}). Every suggestion line MUST be between ${normScope.startLine} and ${normScope.endLine}.`
      : "";
    const systemPrompt = `You are an expert MBBS medical educator. Find visual opportunities across note.${scopeDirective} Line prefix is [L<number>]. Keep recommendedQuery SIMPLE and CONCISE (3 to 5 keywords). Output valid JSON with summary and suggestions array containing heading, line, visualConcept, visualType, rationale, recommendedQuery strictly ordered by ascending line number. Return at most ${maxSuggestions} highest-yield suggestions.`;
    const userPrompt = `Note Title: "${noteTitle}"\nTotal Lines: ${normScope ? `${startLine}-${endLine} of ${totalLines}` : totalLines}\nExisting Images: ${totalImagesFound}\n\n${fullNumberedText}`;

    const uniqueModels = Array.from(
      new Set([this.model, "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-2.5-pro"].filter(Boolean))
    );

    const ATTEMPT_TIMEOUT_MS = 180000;
    let response, lastErr, successfulModel = this.model;

    for (const curModel of uniqueModels) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        curModel
      )}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

      const payload = JSON.stringify({
        contents: [{ role: "user", parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.2,
          maxOutputTokens: 8192
        }
      });

      const retryDelays = [4000, 10000];
      let modelOk = false;

      for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        let timerId;
        try {
          const apiCall = requestUrl({
            url: endpoint,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload
          });
          const timeout = new Promise((_, rej) => {
            timerId = setTimeout(() => rej(new Error("TIMEOUT")), ATTEMPT_TIMEOUT_MS);
          });
          response = await Promise.race([apiCall, timeout]);
          successfulModel = curModel;
          modelOk = true;
          break;
        } catch (err) {
          lastErr = err;
          const status = err && (err.status || err.statusCode || 0);
          if (status === 503 || status === 529) {
            if (attempt < retryDelays.length) {
              await new Promise((r) => setTimeout(r, retryDelays[attempt]));
              continue;
            }
            break;
          }
          if (status === 404) break;
          if (status === 429) {
            if (attempt < retryDelays.length) {
              await new Promise((r) => setTimeout(r, retryDelays[attempt] * 2));
              continue;
            }
            break;
          }
          break;
        } finally {
          if (timerId) clearTimeout(timerId);
        }
      }

      if (modelOk) break;
    }

    if (!response) {
      throw new Error("Gemini API error: " + safeError(lastErr));
    }

    const data = response.json;
    const candidate = data?.candidates?.[0];
    if (!candidate || candidate.finishReason === "SAFETY" || !candidate.content) {
      throw new Error("Gemini returned no candidate response or content was blocked.");
    }
    const rawText = candidate.content.parts ? candidate.content.parts.map((p) => p.text || "").join("") : "";
    if (!rawText || !rawText.trim()) throw new Error("Gemini returned empty text.");

    let parsedJson;
    try {
      parsedJson = JSON.parse(rawText.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
    } catch (_) {
      parsedJson = GeminiScannerService.parseGeminiResponse(rawText, totalLines, maxSuggestions);
    }

    if (!parsedJson || !Array.isArray(parsedJson.suggestions) || parsedJson.suggestions.length === 0) {
      throw new Error("Gemini output missing valid suggestions array.");
    }

    const sanitized = GeminiScannerService.sanitizeSuggestions(parsedJson, totalLines, maxSuggestions);
    const scopedResult = GeminiScannerService.filterSuggestionsByScope(sanitized, normScope, totalLines);

    if (successfulModel && successfulModel !== this.model && this.plugin?.settings) {
      this.plugin.settings.geminiModel = successfulModel;
      this.plugin.saveSettings({ clearCache: false }).catch(() => {});
    }

    return {
      summary: (scopedResult.summary || `Scanned note (${totalLines} lines) with Gemini.`) + truncationNote,
      existingImages: totalImagesFound,
      suggestions: scopedResult.suggestions,
      scope: scopedResult.scope || normScope,
      filteredOutCount: scopedResult.filteredOutCount || 0
    };
  }
}

// -------------------------------------------------------------
// Modals (Mobile-First Touch UI)
// -------------------------------------------------------------

class AiResponseImportModal extends Modal {
  constructor(app, plugin, view) {
    super(app);
    this.plugin = plugin;
    this.view = view;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mifm-preview-modal");
    if (this.modalEl) this.modalEl.addClass("mifm-modal-window");

    this.titleEl.setText("📥 Import AI Visual Response");

    contentEl.createEl("p", {
      text: "Paste the response from Gemini, ChatGPT, or Claude below (JSON, Markdown list, or Markdown table).",
      cls: "mifm-scan-hero-desc"
    });

    const textarea = contentEl.createEl("textarea", { cls: "mifm-import-textarea" });
    textarea.placeholder = "Paste AI output here (JSON or Markdown list)...";
    textarea.rows = 12;
    if (this.plugin.settings.lastImportedResponse) {
      textarea.value = this.plugin.settings.lastImportedResponse;
    }

    const actions = contentEl.createDiv({ cls: "mifm-modal-actions" });

    const pasteBtn = actions.createEl("button", {
      text: "📋 Paste from Clipboard",
      cls: "mifm-btn mifm-btn-copy"
    });
    pasteBtn.onclick = async () => {
      try {
        const clip = await readFromClipboard();
        if (!clip || !clip.trim()) {
          new Notice("Clipboard is empty. Long-press inside the box to paste manually.");
          textarea.focus();
          return;
        }
        textarea.value = clip;
      } catch (err) {
        new Notice(`Could not read clipboard: ${safeError(err)}`);
      }
    };

    const importBtn = actions.createEl("button", {
      text: "⚡ Import & Show Cards",
      cls: "mifm-btn mifm-btn-insert"
    });
    importBtn.onclick = () => {
      const raw = textarea.value;
      if (!raw || !raw.trim()) {
        new Notice("Paste an AI response first.");
        return;
      }
      try {
        const lineCount = this.view.scanContext?.editor?.lineCount() || Infinity;
        const targetCount = this.plugin.settings.geminiMaxSuggestions || 25;
        const importScope = typeof this.view?.getImportScope === "function" ? this.view.getImportScope() : null;
        const parsed = GeminiScannerService.parseGeminiResponse(raw, lineCount, targetCount, importScope);
        this.view.applyScanResults(parsed, raw);
        this.close();
        if (parsed.filteredOutCount > 0) {
          new Notice(`Imported ${parsed.suggestions.length} visual suggestions (filtered ${parsed.filteredOutCount} outside scope).`, 6000);
        } else {
          new Notice(`Imported ${parsed.suggestions.length} visual suggestions!`);
        }
      } catch (err) {
        new Notice(`Import failed: ${safeError(err)}`);
      }
    };

    const cancelBtn = actions.createEl("button", { text: "Cancel", cls: "mifm-btn" });
    cancelBtn.onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ImagePreviewModal extends Modal {
  constructor(app, plugin, item, view = null, previewContext = null) {
    super(app);
    this.plugin = plugin;
    this.item = item;
    this.view = view;
    this.previewContext = previewContext;
    this.currentIndex = previewContext && Number.isInteger(previewContext.currentIndex) ? previewContext.currentIndex : 0;
    this.isZoomed = false;
    this._keydownHandler = null;
  }

  onOpen() {
    if (this.modalEl && typeof this.modalEl.addClass === "function") {
      this.modalEl.addClass("mifm-preview-modal-window");
    }
    this.renderPreview();

    if (typeof document !== "undefined" && document.addEventListener) {
      this._keydownHandler = (e) => {
        if (!e) return;
        const items = this.previewContext?.items;
        if (e.key === "ArrowLeft" && Array.isArray(items) && items.length > 1 && this.currentIndex > 0) {
          e.preventDefault();
          this.navigateBy(-1);
        } else if (e.key === "ArrowRight" && Array.isArray(items) && items.length > 1 && this.currentIndex < items.length - 1) {
          e.preventDefault();
          this.navigateBy(1);
        } else if ((e.key === "z" || e.key === "Z") && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          this.toggleZoom();
        } else if (e.key === " " && typeof this.previewContext?.onBatchToggle === "function") {
          e.preventDefault();
          this.previewContext.onBatchToggle(this.currentIndex);
          this.renderPreview();
        }
      };
      document.addEventListener("keydown", this._keydownHandler);
    }
  }

  navigateBy(delta) {
    const items = this.previewContext?.items;
    if (!Array.isArray(items) || items.length === 0) return;
    const nextIdx = Math.max(0, Math.min(items.length - 1, this.currentIndex + delta));
    if (nextIdx === this.currentIndex) return;
    this.currentIndex = nextIdx;
    this.item = items[nextIdx];
    this.isZoomed = false;
    this.renderPreview();
  }

  toggleZoom() {
    this.isZoomed = !this.isZoomed;
    const imgContainer = this.contentEl.querySelector(".mifm-modal-img-container");
    const img = this.contentEl.querySelector(".mifm-modal-img");
    const zoomBtn = this.contentEl.querySelector(".mifm-preview-zoom-btn");
    if (imgContainer) {
      if (this.isZoomed) imgContainer.addClass("is-zoomed");
      else imgContainer.removeClass("is-zoomed");
    }
    if (img) {
      if (this.isZoomed) img.addClass("is-zoomed");
      else img.removeClass("is-zoomed");
    }
    if (zoomBtn) {
      zoomBtn.setText(this.isZoomed ? "🔍 Fit screen" : "🔍 2× Zoom");
    }
  }

  renderPreview() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mifm-preview-modal");

    this.titleEl.setText(this.item.title || "Medical Image Preview");

    const items = Array.isArray(this.previewContext?.items) ? this.previewContext.items : null;
    if (items && items.length > 1) {
      const navBar = contentEl.createDiv({ cls: "mifm-preview-nav-bar" });
      const prevBtn = navBar.createEl("button", { text: "← Prev", cls: "mifm-btn mifm-preview-nav-btn" });
      prevBtn.disabled = this.currentIndex <= 0;
      prevBtn.onclick = () => this.navigateBy(-1);

      navBar.createSpan({
        text: `Image ${this.currentIndex + 1} of ${items.length}`,
        cls: "mifm-preview-nav-counter"
      });

      const nextBtn = navBar.createEl("button", { text: "Next →", cls: "mifm-btn mifm-preview-nav-btn" });
      nextBtn.disabled = this.currentIndex >= items.length - 1;
      nextBtn.onclick = () => this.navigateBy(1);
    }

    const imgContainer = contentEl.createDiv({
      cls: `mifm-modal-img-container ${this.isZoomed ? "is-zoomed" : ""}`
    });
    const img = imgContainer.createEl("img", {
      cls: `mifm-modal-img ${this.isZoomed ? "is-zoomed" : ""}`,
      attr: {
        src: this.item.imageUrl || this.item.thumbnailUrl,
        alt: this.item.title || "Medical image"
      }
    });
    imgContainer.onclick = (e) => {
      e?.stopPropagation?.();
      this.toggleZoom();
    };

    const details = contentEl.createDiv({ cls: "mifm-card-meta" });
    const dimBadge = details.createSpan({
      text: this.item.width && this.item.height ? `${this.item.width} × ${this.item.height} px` : "",
      cls: "mifm-badge"
    });
    bindHighResPreview(img, dimBadge, this.item, { fullLabel: true });

    if (this.item.domain) {
      details.createSpan({ text: `Source: ${this.item.domain}`, cls: "mifm-domain" });
    }

    const actions = contentEl.createDiv({ cls: "mifm-modal-actions" });

    const zoomBtn = actions.createEl("button", {
      text: this.isZoomed ? "🔍 Fit screen" : "🔍 2× Zoom",
      cls: "mifm-btn mifm-preview-zoom-btn"
    });
    zoomBtn.onclick = () => this.toggleZoom();

    if (typeof this.previewContext?.onBatchToggle === "function") {
      const isSelected = Boolean(this.previewContext.isIndexSelected?.(this.currentIndex));
      const batchToggleBtn = actions.createEl("button", {
        text: isSelected ? "✓ Included in Batch" : "+ Select for Batch",
        cls: `mifm-btn ${isSelected ? "mifm-btn-copy" : ""}`
      });
      batchToggleBtn.onclick = () => {
        this.previewContext.onBatchToggle(this.currentIndex);
        this.renderPreview();
      };
    }

    const insertBtn = actions.createEl("button", {
      text: "📥 Save & insert into note",
      cls: "mifm-btn mifm-btn-insert"
    });
    this.plugin.bindAction(insertBtn, this.item, "insert");
    insertBtn.onclick = async () => {
      insertBtn.disabled = true;
      insertBtn.setText("Inserting...");
      try {
        await this.plugin.saveAndInsertImage(this.item);
        if (this.view) {
          this.view.syncTargetContentAfterInsert(this.item.targetContext?.file);
          if (this.item.searchOriginSuggestionIndex != null) {
            this.view.insertedSuggestionIndices.add(this.item.searchOriginSuggestionIndex);
            this.view.lastActiveScannerIndex = this.item.searchOriginSuggestionIndex;
            this.view.pendingScannerScrollIdx = this.item.searchOriginSuggestionIndex;
            this.view.currentTab = "scan";
          }
          this.view.render();
        }
        this.close();
      } catch (err) {
        new Notice(`Failed to insert: ${safeError(err)}`);
      } finally {
        insertBtn.disabled = false;
        insertBtn.setText("📥 Save & insert into note");
      }
    };

    const copyBtn = actions.createEl("button", {
      text: "📋 Copy image",
      cls: "mifm-btn mifm-btn-copy"
    });
    this.plugin.bindAction(copyBtn, this.item, "copy");
    copyBtn.onclick = async () => {
      copyBtn.disabled = true;
      copyBtn.setText("Copying...");
      try {
        const copied = await this.plugin.copyImageToClipboard(this.item);
        if (copied) this.close();
      } catch (err) {
        new Notice(`Copy failed: ${safeError(err)}`);
      } finally {
        copyBtn.disabled = false;
        copyBtn.setText("📋 Copy image");
      }
    };

    const openSourceBtn = actions.createEl("button", {
      text: "🌐 Open source page",
      cls: "mifm-btn"
    });
    openSourceBtn.onclick = () => {
      const targetUrl = this.item.sourceUrl || this.item.imageUrl;
      if (openExternalUrl(targetUrl)) {
        new Notice(`🌐 Opening source: ${this.item.domain || "Web"}`);
      } else {
        new Notice("No valid source URL available.");
      }
    };
  }

  onClose() {
    if (this._keydownHandler && typeof document !== "undefined" && document.removeEventListener) {
      document.removeEventListener("keydown", this._keydownHandler);
      this._keydownHandler = null;
    }
    this.contentEl.empty();
  }
}

class BatchImageReviewModal extends Modal {
  constructor(app, plugin, view) {
    super(app);
    this.plugin = plugin;
    this.view = view;
    this.suggestions = (view.scanResults?.suggestions || []).map((s, idx) => ({ ...s, _idx: idx }));
    this.scanContext = view.scanContext;
    this.scanScope = view.scanResults?.scope || null;
    this.reviewItems = [];
    this.isInserting = false;
    this.isFetchingAll = false;
    this.fetchGeneration = 0;
    this.insertBtn = null;
    this.selectionCount = null;
    this.currentProviderId = plugin.settings?.defaultProvider || "duckduckgo";
    this.previewSize = ["sm", "md", "lg", "xl"].includes(plugin.settings?.batchPreviewSize)
      ? plugin.settings.batchPreviewSize
      : "lg";
  }

  getProviderDisplayName(id) {
    switch (id) {
      case "brightdata":
        return "Bright Data Google Images";
      case "brave":
        return "Brave Images";
      case "wikimedia":
        return "Wikimedia Commons";
      case "duckduckgo":
      default:
        return "DuckDuckGo";
    }
  }

  applyPreviewSizeClass() {
    if (!this.contentEl) return;
    for (const preset of BATCH_SIZE_PRESETS) {
      if (typeof this.contentEl.removeClass === "function") this.contentEl.removeClass(`is-size-${preset.id}`);
    }
    if (typeof this.contentEl.addClass === "function") this.contentEl.addClass(`is-size-${this.previewSize}`);
  }

  toggleCandidateSelection(r, cIdx) {
    r.insertError = null;
    if (!Array.isArray(r.selectedIndices)) {
      r.selectedIndices = r.selectedIdx != null && r.included ? [r.selectedIdx] : [];
    }
    const idxInSelected = r.selectedIndices.indexOf(cIdx);
    if (idxInSelected >= 0) {
      r.selectedIndices.splice(idxInSelected, 1);
    } else {
      r.selectedIndices.push(cIdx);
      r.selectedIndices.sort((a, b) => a - b);
    }
    r.selectedIdx = r.selectedIndices.length > 0 ? r.selectedIndices[0] : 0;
    r.included = r.selectedIndices.length > 0;
  }

  syncCardSelectionUI(card, r, cb, badge) {
    const s = r.suggestion;
    if (cb) cb.checked = r.included;
    const thumbs = card.querySelectorAll(".mifm-batch-thumb-option");
    thumbs.forEach((optEl, cIdx) => {
      const isSelected = r.included && Array.isArray(r.selectedIndices) && r.selectedIndices.includes(cIdx);
      if (isSelected) optEl.addClass("is-selected");
      else optEl.removeClass("is-selected");
      const lbl = optEl.querySelector(".mifm-batch-choice-label");
      if (lbl) lbl.setText(isSelected ? `✓ #${cIdx + 1}` : `#${cIdx + 1}`);
    });
    if (badge) {
      const selCount = r.included && Array.isArray(r.selectedIndices) ? r.selectedIndices.length : 0;
      const countText = r.items.length > 0 ? ` • ${r.items.length} opts` : "";
      const selText = selCount > 1 ? ` (${selCount})` : "";
      badge.setText(`${s.visualType || "diagram"}${countText}${selText}`);
    }
    this.updateFooter();
  }

  updateFooter() {
    let totalImages = 0;
    const selectedRows = this.reviewItems.filter((r) => r.included && r.items.length > 0);
    selectedRows.forEach((r) => {
      const count = Array.isArray(r.selectedIndices) && r.selectedIndices.length > 0
        ? r.selectedIndices.length
        : r.selectedIdx != null ? 1 : 0;
      totalImages += count;
    });

    if (this.selectionCount) {
      this.selectionCount.setText(`${totalImages} image${totalImages === 1 ? "" : "s"} (${selectedRows.length} of ${this.reviewItems.length} topics)`);
    }
    if (this.insertBtn) {
      this.insertBtn.setText(`📥 Insert Selected (${totalImages})`);
      this.insertBtn.disabled = totalImages === 0 || this.isInserting;
    }
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mifm-batch-modal");
    this.applyPreviewSizeClass();
    if (this.modalEl) this.modalEl.addClass("mifm-batch-modal-window");

    this.titleEl.setText("⚡ Fast Batch Image Review");

    if (!this.suggestions.length) {
      contentEl.createEl("p", { text: "No suggestions available for batch insertion." });
      return;
    }

    const topBar = contentEl.createDiv({ cls: "mifm-batch-top-bar" });
    const scopeHint = this.scanScope ? ` [Scoped: ${this.scanScope.label}]` : "";
    const desc = topBar.createEl("p", {
      text: `Reviewing ${this.suggestions.length} topics${scopeHint}. Tap to select 1 or more • Tap 🔍 for large preview.`,
      cls: "mifm-scan-hero-desc"
    });
    desc.style.margin = "0 0 6px 0";

    const toolbar = topBar.createDiv({ cls: "mifm-batch-toolbar" });
    toolbar.createSpan({ cls: "mifm-batch-toolbar-label", text: "🔍 Engine:" });

    const providerSelect = toolbar.createEl("select", { cls: "mifm-batch-provider-select" });
    const providerOptions = [
      { id: "duckduckgo", label: "🦆 DuckDuckGo (Free / No Key)" },
      { id: "brightdata", label: `🌐 Bright Data ${this.plugin.settings.brightDataApiKey ? "✓" : "(API Key)"}` },
      { id: "brave", label: `🦁 Brave ${this.plugin.settings.braveApiKey ? "✓" : "(API Key)"}` },
      { id: "wikimedia", label: "📚 Wikimedia (Free)" }
    ];
    providerOptions.forEach((opt) => {
      const el = providerSelect.createEl("option", { text: opt.label, value: opt.id });
      if (opt.id === this.currentProviderId) el.selected = true;
    });
    providerSelect.onchange = () => {
      this.currentProviderId = providerSelect.value;
      new Notice(`Switched batch engine to ${this.getProviderDisplayName(this.currentProviderId)}`);
    };

    const refreshAllBtn = toolbar.createEl("button", {
      cls: "mifm-btn mifm-btn-refresh-all",
      text: "🔄 Re-search All"
    });
    refreshAllBtn.onclick = () => {
      this.fetchAllCandidates(progressBar, progressLabel, progressContainer, true);
    };

    const sizeGroup = toolbar.createDiv({ cls: "mifm-batch-size-group" });
    sizeGroup.createSpan({ cls: "mifm-batch-toolbar-label", text: "🖼️ Size:" });
    const sizeBtns = new Map();
    for (const preset of BATCH_SIZE_PRESETS) {
      const sBtn = sizeGroup.createEl("button", {
        cls: `mifm-batch-size-btn ${this.previewSize === preset.id ? "is-active" : ""}`,
        text: preset.label,
        attr: { type: "button", title: preset.title }
      });
      sBtn.onclick = async () => {
        if (this.previewSize === preset.id) return;
        this.previewSize = preset.id;
        this.applyPreviewSizeClass();
        for (const [id, bEl] of sizeBtns.entries()) {
          if (id === preset.id) bEl.addClass("is-active");
          else bEl.removeClass("is-active");
        }
        if (this.plugin.settings) {
          this.plugin.settings.batchPreviewSize = preset.id;
          if (typeof this.plugin.saveSettings === "function") {
            await this.plugin.saveSettings({ clearCache: false });
          }
        }
      };
      sizeBtns.set(preset.id, sBtn);
    }

    const progressContainer = contentEl.createDiv({ cls: "mifm-batch-progress-box" });
    const progressLabel = progressContainer.createDiv({
      cls: "mifm-batch-progress-label",
      text: `🔍 Searching ${this.getProviderDisplayName(this.currentProviderId)}... (0/${this.suggestions.length})`
    });
    const progressBar = progressContainer.createEl("progress", { cls: "mifm-batch-progress-bar" });
    progressBar.max = this.suggestions.length;
    progressBar.value = 0;

    const listContainer = contentEl.createDiv({ cls: "mifm-batch-list-container" });

    const footer = contentEl.createDiv({ cls: "mifm-batch-footer" });
    const leftFooter = footer.createDiv({ cls: "mifm-batch-footer-left" });
    this.selectionCount = leftFooter.createSpan({ cls: "mifm-batch-counter", text: "0 selected" });
    const selectAllBtn = leftFooter.createEl("button", { cls: "mifm-link-btn", text: "Select All" });
    const deselectAllBtn = leftFooter.createEl("button", { cls: "mifm-link-btn", text: "Deselect All" });

    const rightFooter = footer.createDiv({ cls: "mifm-batch-footer-right mifm-modal-actions" });
    const cancelBtn = rightFooter.createEl("button", { cls: "mifm-btn", text: "Cancel" });
    this.insertBtn = rightFooter.createEl("button", {
      cls: "mifm-btn mifm-btn-insert mifm-batch-footer-insert-btn",
      text: "📥 Insert Selected"
    });
    this.insertBtn.disabled = true;

    cancelBtn.onclick = () => this.close();

    selectAllBtn.onclick = () => {
      this.reviewItems.forEach((r) => {
        if (r.items.length > 0) {
          r.included = true;
          if (!Array.isArray(r.selectedIndices) || r.selectedIndices.length === 0) {
            r.selectedIndices = [0];
            r.selectedIdx = 0;
          }
        }
      });
      this.renderReviewCards(listContainer);
      this.updateFooter();
    };

    deselectAllBtn.onclick = () => {
      this.reviewItems.forEach((r) => {
        r.included = false;
        r.selectedIndices = [];
      });
      this.renderReviewCards(listContainer);
      this.updateFooter();
    };

    this.insertBtn.onclick = async () => {
      if (this.isInserting) return;
      this.isInserting = true;
      this.insertBtn.disabled = true;
      this.insertBtn.setText("⏳ Inserting...");

      const selected = this.reviewItems.filter((r) => r.included && r.items.length > 0);
      const jobs = [];
      for (const r of selected) {
        const chosenIndices =
          Array.isArray(r.selectedIndices) && r.selectedIndices.length > 0
            ? r.selectedIndices
            : [r.selectedIdx || 0];
        for (let subIdx = 0; subIdx < chosenIndices.length; subIdx++) {
          const item = r.items[chosenIndices[subIdx]];
          if (!item) continue;
          jobs.push({
            suggestionIndex: r.suggestion._idx,
            subIndex: subIdx,
            targetLine: r.suggestion.line,
            targetHeading: r.suggestion.heading,
            targetConcept: r.suggestion.visualConcept,
            targetQuery: r.suggestion.recommendedQuery,
            targetScope: this.scanScope,
            imageItem: {
              ...item,
              targetContext: this.scanContext,
              targetLine: r.suggestion.line,
              targetHeading: r.suggestion.heading,
              targetConcept: r.suggestion.visualConcept,
              targetQuery: r.suggestion.recommendedQuery,
              targetScope: this.scanScope,
              searchOriginSuggestionIndex: r.suggestion._idx
            }
          });
        }
      }

      try {
        progressContainer.style.display = "block";
        progressBar.max = jobs.length;
        progressBar.value = 0;
        progressLabel.setText(`Inserting into note... (0/${jobs.length})`);
        const result = await this.plugin.batchInsertImages(jobs, (cur, total) => {
          progressBar.value = cur;
          progressLabel.setText(`Inserting into note... (${cur}/${total})`);
        });

        const successful = result?.successfulIndices || new Set(jobs.map((j) => j.suggestionIndex));
        for (const idx of successful) this.view.insertedSuggestionIndices.add(idx);
        this.view.syncTargetContentAfterInsert(this.scanContext?.file);
        this.view.render();

        const failedIndices = result?.failedIndices;
        if (failedIndices && failedIndices.size > 0) {
          this.reviewItems.forEach((r) => {
            if (failedIndices.has(r.suggestion?._idx)) {
              r.included = false;
              r.insertError = "Selected image failed to download/insert. Pick another option or retry.";
              this.updateCard(r);
            }
          });
          this.isInserting = false;
          this.updateFooter();
        } else {
          this.close();
        }
      } catch (err) {
        new Notice(`Batch insertion error: ${safeError(err)}`);
        this.isInserting = false;
        this.updateFooter();
      }
    };

    this.reviewItems = this.suggestions.map((s) => {
      const alreadyInserted = this.view.insertedSuggestionIndices.has(s._idx);
      return {
        suggestion: s,
        query: s.recommendedQuery,
        visualType: s.visualType || "diagram",
        items: [],
        selectedIndices: alreadyInserted ? [] : [0],
        selectedIdx: 0,
        included: !alreadyInserted,
        loading: true,
        error: null
      };
    });

    this.renderReviewCards(listContainer);
    await this.fetchAllCandidates(progressBar, progressLabel, progressContainer);
  }

  async fetchSingleItem(rItem, customProviderId = null, bypassCache = false) {
    if (this.isClosed) return { cached: false };
    const itemGen = (rItem._searchGen = (rItem._searchGen || 0) + 1);
    const providerId = customProviderId || this.currentProviderId || this.plugin.settings?.defaultProvider || "duckduckgo";
    const provider = this.plugin.getProvider(providerId);
    const t0 = Date.now();
    rItem.loading = true;
    rItem.providerId = providerId;
    rItem.loadingProviderId = providerId;
    rItem.error = null;
    rItem.insertError = null;
    try {
      const effQuery = this.view.getEffectiveQuery(rItem.query, rItem.visualType);
      const results = await this.plugin.searchWithCache(provider, effQuery, bypassCache);
      if (this.isClosed || itemGen !== rItem._searchGen) return { cached: false, stale: true };
      rItem.items = results;
      rItem.loading = false;
      rItem.loadingProviderId = null;
      if (results.length > 0) {
        const alreadyInserted = this.view.insertedSuggestionIndices?.has(rItem.suggestion?._idx);
        rItem.included = !alreadyInserted;
        rItem.selectedIndices = alreadyInserted ? [] : [0];
        rItem.selectedIdx = 0;
      } else {
        rItem.included = false;
        rItem.selectedIndices = [];
        rItem.selectedIdx = 0;
        rItem.error = `No images returned by ${this.getProviderDisplayName(providerId)}. Edit keywords or try another engine.`;
      }
      return { cached: Date.now() - t0 < 15 };
    } catch (err) {
      if (this.isClosed || itemGen !== rItem._searchGen) return { cached: false, stale: true };
      rItem.loading = false;
      rItem.loadingProviderId = null;
      rItem.error = safeError(err);
      rItem.included = false;
      rItem.selectedIndices = [];
      const fatal = /API Key|authentication failed|Full JSON|Light JSON/i.test(rItem.error);
      return { cached: false, fatalError: fatal ? rItem.error : null };
    }
  }

  async fetchAllCandidates(progressBar, progressLabel, progressContainer, bypassCache = false) {
    if (this.isClosed) return;
    const gen = ++this.fetchGeneration;
    this.isFetchingAll = true;
    try {
      if (progressContainer) progressContainer.style.display = "block";
      if (progressBar) {
        progressBar.max = this.reviewItems.length;
        progressBar.value = 0;
      }

      const engineId = this.currentProviderId || "duckduckgo";
      if (progressLabel) {
        progressLabel.setText(`Searching ${this.getProviderDisplayName(engineId)}... (0/${this.reviewItems.length})`);
      }

      const concurrency = (engineId === "duckduckgo" || engineId === "brave") ? 1 : Math.min(3, this.reviewItems.length);
      const delayMs = engineId === "duckduckgo" ? 650 : engineId === "brave" ? 1050 : 120;
      let nextIdx = 0;
      let completed = 0;
      let fatalStopError = null;

      const worker = async () => {
        while (!this.isClosed && gen === this.fetchGeneration && !fatalStopError) {
          const i = nextIdx++;
          if (i >= this.reviewItems.length) break;
          const item = this.reviewItems[i];
          item.loading = true;
          item.providerId = engineId;
          item.loadingProviderId = engineId;
          item.error = null;
          item.insertError = null;
          this.updateCard(item);

          const meta = await this.fetchSingleItem(item, engineId, bypassCache);
          if (this.isClosed || gen !== this.fetchGeneration) break;
          if (meta && meta.stale) continue;

          completed++;
          this.updateCard(item);
          if (progressBar) progressBar.value = completed;
          if (progressLabel) {
            progressLabel.setText(`Searching ${this.getProviderDisplayName(engineId)}... (${completed}/${this.reviewItems.length})`);
          }

          if (meta?.fatalError) {
            fatalStopError = meta.fatalError;
            break;
          }

          if (!meta?.cached && nextIdx < this.reviewItems.length && !this.isClosed && gen === this.fetchGeneration && !fatalStopError) {
            await new Promise((res) => setTimeout(res, delayMs));
          }
        }
      };

      const workers = [];
      for (let w = 0; w < concurrency; w++) workers.push(worker());
      await Promise.all(workers);

      if (fatalStopError && !this.isClosed && gen === this.fetchGeneration) {
        for (let k = nextIdx; k < this.reviewItems.length; k++) {
          const rem = this.reviewItems[k];
          if (rem.loading) {
            rem.loading = false;
            rem.loadingProviderId = null;
            rem.providerId = engineId;
            rem.error = fatalStopError;
            rem.included = false;
            rem.selectedIndices = [];
            this.updateCard(rem);
          }
        }
      }
    } finally {
      if (gen === this.fetchGeneration) {
        this.isFetchingAll = false;
        if (!this.isClosed) {
          if (progressContainer) progressContainer.style.display = "none";
          this.updateFooter();
        }
      }
    }
  }

  renderReviewCards(container) {
    container.empty();
    this.reviewItems.forEach((r, idx) => {
      const card = container.createDiv({ cls: "mifm-batch-card" });
      const cardId = r.suggestion?._idx !== undefined ? r.suggestion._idx : idx;
      card.id = `mifm-batch-card-${cardId}`;
      this.populateCard(card, r);
    });
  }

  updateCard(rItem) {
    const cardId = rItem.suggestion?._idx !== undefined ? rItem.suggestion._idx : this.reviewItems.indexOf(rItem);
    const card = this.contentEl.querySelector(`#mifm-batch-card-${cardId}`);
    if (card) {
      const prevRow = card.querySelector(".mifm-batch-options-row");
      const prevScrollLeft = prevRow ? prevRow.scrollLeft || 0 : 0;
      card.empty();
      this.populateCard(card, rItem);
      if (prevScrollLeft > 0) {
        const nextRow = card.querySelector(".mifm-batch-options-row");
        if (nextRow) nextRow.scrollLeft = prevScrollLeft;
      }
      this.updateFooter();
    }
  }

  populateCard(card, r) {
    const s = r.suggestion;
    const headerRow = card.createDiv({ cls: "mifm-batch-card-header" });

    const cb = headerRow.createEl("input", { type: "checkbox", cls: "mifm-batch-checkbox" });
    cb.checked = r.included;
    cb.disabled = r.loading || r.items.length === 0;
    cb.onchange = () => {
      r.included = cb.checked;
      if (cb.checked && (!Array.isArray(r.selectedIndices) || r.selectedIndices.length === 0)) {
        r.selectedIndices = [0];
        r.selectedIdx = 0;
      }
      this.updateCard(r);
    };

    const titleEl = headerRow.createSpan({ cls: "mifm-batch-card-title" });
    titleEl.setText(`[L${s.line}] ${s.heading} — ${s.visualConcept}`);

    if (this.view?.insertedSuggestionIndices?.has(s._idx)) {
      headerRow.createSpan({ text: "✓ Inserted", cls: "mifm-badge mifm-badge-inserted" });
    }

    const badge = headerRow.createSpan({ cls: "mifm-badge" });
    const selCount = r.included && Array.isArray(r.selectedIndices) ? r.selectedIndices.length : 0;
    const countText = r.items.length > 0 ? ` • ${r.items.length} opts` : "";
    const selText = selCount > 1 ? ` (${selCount})` : "";
    badge.setText(`${s.visualType || "diagram"}${countText}${selText}`);

    if (r.loading) {
      const loadBox = card.createDiv({ cls: "mifm-batch-loading" });
      loadBox.setText(`⏳ Searching ${this.getProviderDisplayName(r.loadingProviderId || this.currentProviderId)}...`);
      return;
    }

    if (r.error || r.items.length === 0) {
      const errBox = card.createDiv({ cls: "mifm-batch-error-box" });
      errBox.createDiv({ cls: "mifm-batch-no-results", text: r.error || "No images found." });
      this.renderCardActions(errBox, r, true);
      return;
    }

    if (r.insertError) {
      card.createDiv({ cls: "mifm-batch-insert-warn", text: r.insertError });
    }

    const optionsRow = card.createDiv({ cls: "mifm-batch-options-row" });
    optionsRow.addEventListener(
      "wheel",
      (evt) => {
        if (evt.deltaY !== 0 && !evt.shiftKey && optionsRow.scrollWidth > optionsRow.clientWidth) {
          const atRight = optionsRow.scrollLeft + optionsRow.clientWidth >= optionsRow.scrollWidth - 1;
          const atLeft = optionsRow.scrollLeft <= 0;
          if ((evt.deltaY > 0 && !atRight) || (evt.deltaY < 0 && !atLeft)) {
            optionsRow.scrollLeft += evt.deltaY;
            evt.preventDefault();
          }
        }
      },
      { passive: false }
    );

    const buildPreviewContext = (cIdx) => ({
      items: r.items.map((cand) => ({
        ...cand,
        targetContext: this.scanContext,
        targetLine: s.line,
        targetHeading: s.heading,
        targetConcept: s.visualConcept,
        targetQuery: s.recommendedQuery,
        targetScope: this.scanScope,
        searchOriginSuggestionIndex: s._idx
      })),
      currentIndex: cIdx,
      isIndexSelected: (candIdx) => r.included && Array.isArray(r.selectedIndices) && r.selectedIndices.includes(candIdx),
      onBatchToggle: (candIdx) => {
        this.toggleCandidateSelection(r, candIdx);
        this.syncCardSelectionUI(card, r, cb, badge);
      }
    });

    r.items.forEach((item, cIdx) => {
      const isSelected = r.included && Array.isArray(r.selectedIndices) && r.selectedIndices.includes(cIdx);
      const optEl = optionsRow.createDiv({
        cls: `mifm-batch-thumb-option ${isSelected ? "is-selected" : ""}`
      });

      const img = optEl.createEl("img", {
        cls: "mifm-batch-thumb-img",
        attr: { loading: "lazy", decoding: "async" }
      });
      img.alt = item.title;

      optEl.createSpan({
        cls: "mifm-batch-choice-label",
        text: isSelected ? `✓ #${cIdx + 1}` : `#${cIdx + 1}`
      });

      const cornerBar = optEl.createDiv({ cls: "mifm-thumb-corner-actions" });
      const zoomBtn = cornerBar.createEl("button", {
        cls: "mifm-thumb-corner-btn",
        text: "🔍",
        attr: { type: "button", "aria-label": "Large preview" }
      });
      zoomBtn.onclick = (e) => {
        e.stopPropagation();
        const previewCtx = buildPreviewContext(cIdx);
        const previewItem = previewCtx.items[cIdx] || { ...item };
        new ImagePreviewModal(this.app, this.plugin, previewItem, this.view, previewCtx).open();
      };

      const srcBtn = cornerBar.createEl("button", {
        cls: "mifm-thumb-corner-btn",
        text: "🌐",
        attr: { type: "button", "aria-label": "Open source website" }
      });
      srcBtn.onclick = (e) => {
        e.stopPropagation();
        const targetUrl = item.sourceUrl || item.imageUrl;
        if (openExternalUrl(targetUrl)) {
          new Notice(`🌐 Opening source: ${item.domain || "Web"}`);
        }
      };

      const overlay = optEl.createDiv({
        cls: "mifm-thumb-overlay",
        text: item.width && item.height ? `${item.width}×${item.height}` : ""
      });
      bindHighResPreview(img, overlay, item);

      optEl.onclick = (e) => {
        e.stopPropagation();
        this.toggleCandidateSelection(r, cIdx);
        this.syncCardSelectionUI(card, r, cb, badge);
      };
    });

    this.renderCardActions(card, r, false);
  }

  renderCardActions(parent, r, isErrorState) {
    const cardActions = parent.createDiv({ cls: "mifm-batch-card-actions" });
    const queryInput = cardActions.createEl("input", {
      type: "text",
      cls: "mifm-batch-card-query-input",
      value: r.query
    });
    queryInput.placeholder = isErrorState ? "Edit search query..." : "";
    queryInput.addEventListener("input", () => {
      r.query = queryInput.value;
    });
    queryInput.onchange = () => {
      r.query = queryInput.value.trim();
    };

    const runSingleSearch = async (customProviderId = null) => {
      const q = queryInput.value.trim();
      if (!q) {
        new Notice("Enter a search query first.");
        queryInput.focus();
        return;
      }
      const targetEngine = customProviderId || this.currentProviderId;
      r.query = q;
      r.loading = true;
      r.providerId = targetEngine;
      r.loadingProviderId = targetEngine;
      this.updateCard(r);
      await this.fetchSingleItem(r, customProviderId, true);
      if (!this.isClosed) this.updateCard(r);
    };

    queryInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runSingleSearch(null);
      }
    });

    const retryBtn = cardActions.createEl("button", {
      cls: "mifm-btn mifm-batch-card-retry",
      text: isErrorState ? "🔄 Retry" : "🔄 Re-search"
    });
    retryBtn.onclick = () => runSingleSearch(null);

    const altEngines = [
      {
        id: "brightdata",
        label: "🌐 Bright Data",
        keyProp: "brightDataApiKey",
        missingMsg: "Bright Data API Key is missing. Add it in Settings → Medical Image Finder Mobile."
      },
      {
        id: "brave",
        label: "🦁 Brave",
        keyProp: "braveApiKey",
        missingMsg: "Brave API Key is missing. Add it in Settings → Medical Image Finder Mobile."
      },
      {
        id: "duckduckgo",
        label: "🦆 DDG",
        keyProp: null,
        missingMsg: ""
      }
    ];

    const cardEngineId = r.loadingProviderId || r.providerId || this.currentProviderId;
    for (const eng of altEngines) {
      if (eng.id === cardEngineId) continue;
      const btn = cardActions.createEl("button", {
        cls: "mifm-btn mifm-batch-card-alt",
        text: eng.label
      });
      btn.onclick = async () => {
        if (eng.keyProp && !this.plugin.settings[eng.keyProp]) {
          new Notice(eng.missingMsg, 5000);
          return;
        }
        await runSingleSearch(eng.id);
      };
    }
  }

  onClose() {
    this.isClosed = true;
    this.contentEl.empty();
  }
}

// -------------------------------------------------------------
// Sidebar View (Mobile-First for iPadOS & Android)
// -------------------------------------------------------------

class MedicalImageFinderMobileView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.results = [];
    this.isSearching = false;
    this.currentQuery = "";
    this.statusMessage = "";
    this.statusType = "normal";
    this.activeFilter = this.plugin.settings.defaultFilterMode || "all";
    this.currentTab = "search";
    this.scanResults = this.plugin.settings.lastScanResults || null;
    this.restoredFromMemory = !!this.scanResults;
    this.isScanning = false;
    this.isAutoPiloting = false;
    this.scanErrorMessage = "";
    this.inlineQuickResults = new Map();
    this.inlineLoading = new Set();
    this.searchGeneration = 0;
    this.scanGeneration = 0;
    this.closed = false;
    this.waitingForAi = false;
    this.copiedPromptNote = "";
    this.insertedSuggestionIndices = new Set();
    this.searchOriginSuggestionIndex = null;
    this.searchTargetHeading = null;
    this.searchTargetConcept = null;
    this.searchTargetQuery = null;
    this.searchTargetScope = null;
    this.scopeMode = "full";
    this.selectedSectionKey = "";
    this.customScopeStart = 1;
    this.customScopeEnd = 1;
    this.editorSelectionScope = null;
    this.pendingScanScope = null;
    this._lastAutoSelectionKey = "";
    this.scannerCategoryFilter = "all";
    this.lastActiveScannerIndex = null;
    this.pendingScannerScrollIdx = null;
    this.scannerScrollTop = 0;
    this.searchScrollTop = 0;
    this._lastRenderedTab = null;
    this._scanWarningSlot = null;
  }

  clearSearchLink() {
    this.searchTargetContext = null;
    this.searchTargetLine = null;
    this.searchTargetHeading = null;
    this.searchTargetConcept = null;
    this.searchTargetQuery = null;
    this.searchTargetScope = null;
    this.searchOriginSuggestionIndex = null;
  }

  detectEditorSelectionScope(preferredView = null) {
    const view = preferredView || this.plugin.getTargetView?.();
    const editor = view?.editor;
    if (!editor || typeof editor.getSelection !== "function") return null;
    const totalLines = typeof editor.lineCount === "function" ? editor.lineCount() : 1;
    const sel = editor.getSelection();
    if (!sel || !sel.trim()) return null;
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    let startLine = (from?.line ?? 0) + 1;
    let endLine = (to?.line ?? startLine - 1) + 1;
    if (to && to.ch === 0 && endLine > startLine) {
      endLine -= 1;
    }
    if (endLine < startLine) [startLine, endLine] = [endLine, startLine];
    return normalizeScanScope({ mode: "selection", startLine, endLine }, totalLines);
  }

  getSelectedUiScope(preferredView = null) {
    const view = preferredView || this.plugin.getTargetView?.();
    const editor = view?.editor;
    const content = editor?.getValue?.() || this.scanContext?.content || "";
    const totalLines = editor?.lineCount?.() || (content ? content.split(/\r?\n/).length : 1);

    if (this.scopeMode === "selection") {
      const liveSel = this.detectEditorSelectionScope(view);
      if (liveSel) {
        this.editorSelectionScope = liveSel;
        return liveSel;
      }
      if (this.editorSelectionScope) {
        return normalizeScanScope(this.editorSelectionScope, totalLines);
      }
      return null;
    }
    if (this.scopeMode === "section") {
      const sections = extractNoteSections(content);
      const match = sections.find((s) => s.key === this.selectedSectionKey);
      if (match) {
        return normalizeScanScope(
          { mode: "section", startLine: match.startLine, endLine: match.endLine, heading: match.heading },
          totalLines
        );
      }
      return null;
    }
    if (this.scopeMode === "custom") {
      return normalizeScanScope(
        { mode: "custom", startLine: this.customScopeStart, endLine: this.customScopeEnd },
        totalLines
      );
    }
    return null;
  }

  getImportScope() {
    if (this.pendingScanScope) return this.pendingScanScope;
    const uiScope = this.getSelectedUiScope();
    if (uiScope) return uiScope;
    if (this.scanResults?.scope && this.scanResults.scope.mode && this.scanResults.scope.mode !== "full") {
      return this.scanResults.scope;
    }
    return null;
  }

  syncTargetContentAfterInsert(targetFile = null) {
    const file = targetFile || this.plugin.getTargetView?.()?.file;
    if (this.scanContext && (!file || this.scanContext.file === file) && this.scanContext.editor) {
      this.scanContext.content = this.scanContext.editor.getValue();
    }
    if (this.searchTargetContext && (!file || this.searchTargetContext.file === file) && this.searchTargetContext.editor) {
      this.searchTargetContext.content = this.searchTargetContext.editor.getValue();
    }
  }

  updateTargetHeader() {
    if (this.closed || !this.contentEl) return;
    const activeFile = this.plugin.getTargetView()?.file;
    const targetEl = this.contentEl.querySelector?.(".mifm-header-target-note");
    if (activeFile && targetEl && !(this.currentTab === "scan" && this.restoredFromMemory)) {
      targetEl.setText(`Target: ${activeFile.basename}`);
      if (this.currentTab === "scan") this.updateScanContextStatus();
      return;
    }
    this.render();
  }

  updateScanContextStatus() {
    if (this.closed || this.currentTab !== "scan" || !this._scanWarningSlot || !this.scanContext) return;
    this._scanWarningSlot.empty();
    try {
      this.plugin.validateTarget(this.scanContext);
    } catch (_) {
      this._scanWarningSlot.createDiv({
        cls: "mifm-status is-error",
        text: "The scanned note changed or closed. Rescan before jumping or inserting."
      });
    }
  }

  getViewType() {
    return VIEW_TYPE_MIFM;
  }

  getDisplayText() {
    return "Medical Image Finder";
  }

  getIcon() {
    return "image";
  }

  async onOpen() {
    this.closed = false;
    this.render();
  }

  async onClose() {
    this.closed = true;
    ++this.searchGeneration;
    ++this.scanGeneration;
    this.inlineLoading.clear();
  }

  switchToSearchTab(query = null, filter = null, autoSearch = false) {
    if (this.currentTab === "scan" && this.contentEl) this.scannerScrollTop = this.contentEl.scrollTop || 0;
    this.currentTab = "search";
    if (filter) this.activeFilter = filter;
    if (query) {
      this.currentQuery = query;
      if (this.queryInput) this.queryInput.value = query;
    }
    this.render();
    if (autoSearch && query) this.executeSearch(query);
  }

  switchToScanTab(autoScan = false) {
    if (this.currentTab === "search" && this.contentEl) this.searchScrollTop = this.contentEl.scrollTop || 0;
    this.currentTab = "scan";
    this.render();
    if (autoScan && !this.scanResults && !this.isScanning) {
      this.executeNoteScan();
    }
  }

  async runAutoPilotBatch() {
    if (this.isAutoPiloting) {
      new Notice("Auto-Pilot is already running.");
      return;
    }
    if (this.isScanning || !this.scanResults || !this.scanResults.suggestions.length) {
      new Notice("No visual suggestions to insert.");
      return;
    }
    try {
      this.plugin.captureTarget(this.scanContext);
    } catch (err) {
      new Notice(safeError(err));
      return;
    }

    const suggestions = this.scanResults.suggestions;
    const remaining = suggestions.filter((_, idx) => !this.insertedSuggestionIndices.has(idx));
    if (!remaining.length) {
      new Notice("All suggestions have already been inserted!");
      return;
    }

    const provider = this.plugin.getActiveProvider();
    const providerId = this.plugin.settings?.defaultProvider || "duckduckgo";
    if (providerId === "brightdata" && !this.plugin.settings?.brightDataApiKey) {
      new Notice("Bright Data API Key is missing. Add it in Settings → Medical Image Finder Mobile.", 6000);
      return;
    }
    if (providerId === "brave" && !this.plugin.settings?.braveApiKey) {
      new Notice("Brave API Key is missing. Add it in Settings → Medical Image Finder Mobile.", 6000);
      return;
    }
    this.isAutoPiloting = true;
    this.render();
    new Notice(`🚀 Auto-Pilot: Searching ${provider.name} for ${remaining.length} topics...`, 6000);

    try {
      const jobs = [];
      const delayMs = providerId === "duckduckgo" ? 650 : providerId === "brave" ? 1050 : 120;
      let lastWasCached = false;
      let fatalErrorMsg = "";

      for (let i = 0; i < suggestions.length; i++) {
        if (this.closed) return;
        if (this.insertedSuggestionIndices.has(i)) continue;
        if (jobs.length > 0 && !lastWasCached) {
          await new Promise((res) => setTimeout(res, delayMs));
        }
        const s = suggestions[i];
        const t0 = Date.now();
        try {
          const effectiveQuery = this.getEffectiveQuery(s.recommendedQuery, s.visualType || "diagram");
          const norm = await this.plugin.searchWithCache(provider, effectiveQuery);
          lastWasCached = Date.now() - t0 < 15;
          if (norm.length > 0) {
            const activeScope = this.scanResults?.scope || null;
            jobs.push({
              suggestionIndex: i,
              targetLine: s.line,
              targetHeading: s.heading,
              targetConcept: s.visualConcept,
              targetQuery: s.recommendedQuery,
              targetScope: activeScope,
              imageItem: {
                ...norm[0],
                targetContext: this.scanContext,
                targetLine: s.line,
                targetHeading: s.heading,
                targetConcept: s.visualConcept,
                targetQuery: s.recommendedQuery,
                targetScope: activeScope,
                searchOriginSuggestionIndex: i
              }
            });
          }
        } catch (err) {
          lastWasCached = false;
          const errMsg = safeError(err);
          console.warn(`Auto-pilot search failed for "${s.visualConcept}":`, err);
          if (/API Key|authentication failed|Full JSON/i.test(errMsg)) {
            fatalErrorMsg = errMsg;
            break;
          }
        }
      }

      if (this.closed) return;
      if (fatalErrorMsg && jobs.length === 0) {
        new Notice(`Auto-Pilot stopped: ${fatalErrorMsg}`, 7000);
        return;
      }
      if (jobs.length === 0) {
        new Notice("No images found to insert.");
        return;
      }

      const result = await this.plugin.batchInsertImages(jobs, (cur, total) => {
        new Notice(`Inserting ${cur} / ${total}...`, 2000);
      });
      const successful = result?.successfulIndices || new Set(jobs.map((j) => j.suggestionIndex));
      for (const idx of successful) this.insertedSuggestionIndices.add(idx);
      this.syncTargetContentAfterInsert(this.scanContext?.file);
    } catch (err) {
      new Notice(`Auto-pilot insertion failed: ${safeError(err)}`);
    } finally {
      this.isAutoPiloting = false;
      if (!this.closed) this.render();
    }
  }

  async copyNotePromptForAiApp(explicitScope = null) {
    let context;
    try {
      context = this.plugin.captureTarget();
    } catch (err) {
      new Notice(safeError(err));
      return;
    }
    const { file, content, editor } = context;
    const title = file.basename;
    if (!content || !content.trim()) {
      new Notice("The active note is empty.");
      return;
    }

    const totalLines = editor?.lineCount?.() || content.split(/\r?\n/).length;
    const targetScope = explicitScope
      ? normalizeScanScope(explicitScope, totalLines)
      : this.getSelectedUiScope(context.view);
    this.pendingScanScope = targetScope;
    this.scanContext = context;
    this.copiedPromptNote = targetScope ? `${title} (${targetScope.label})` : title;
    this.waitingForAi = true;

    const targetCount = this.plugin.settings.geminiMaxSuggestions || 25;
    const promptText = GeminiScannerService.buildPrompt(title, content, targetCount, targetScope);
    const copied = await copyToClipboard(promptText);
    if (copied) {
      new Notice(
        targetScope
          ? `Copied scoped prompt (${targetScope.label})! Paste into Gemini / ChatGPT / Claude, then return and tap Paste Response.`
          : "Copied prompt! Paste into Gemini / ChatGPT / Claude, then return and tap Paste Response.",
        7000
      );
    } else {
      new Notice("Clipboard copy failed. Check Obsidian permissions.", 5000);
    }
    this.render();
  }

  async importAiResponseFromClipboard() {
    try {
      const text = await readFromClipboard();
      if (!text || !text.trim()) {
        new Notice("Clipboard is empty or blocked. Opening paste box...", 4000);
        new AiResponseImportModal(this.app, this.plugin, this).open();
        return;
      }
      const lineCount = this.scanContext?.editor?.lineCount() || Infinity;
      const targetCount = this.plugin.settings.geminiMaxSuggestions || 25;
      const importScope = this.getImportScope();
      const parsed = GeminiScannerService.parseGeminiResponse(text, lineCount, targetCount, importScope);
      await this.applyScanResults(parsed, text);
      const filteredMsg =
        parsed.filteredOutCount > 0 ? ` (${parsed.filteredOutCount} out-of-scope filtered)` : "";
      new Notice(`Imported ${parsed.suggestions.length} visual suggestions!${filteredMsg}`, 5000);
    } catch (err) {
      new Notice(`Could not auto-parse clipboard: ${safeError(err)}. Opening paste box...`, 5000);
      new AiResponseImportModal(this.app, this.plugin, this).open();
    }
  }

  async applyScanResults(parsed, rawText = "") {
    this.scanResults = parsed;
    this.restoredFromMemory = false;
    this.scanErrorMessage = "";
    this.waitingForAi = false;
    this.pendingScanScope = null;
    this.scannerCategoryFilter = "all";
    this.inlineQuickResults.clear();
    this.inlineLoading.clear();
    this.insertedSuggestionIndices.clear();
    this.clearSearchLink();
    this.lastActiveScannerIndex = null;
    this.pendingScannerScrollIdx = null;
    this.scannerScrollTop = 0;
    try {
      this.plugin.settings.lastScanResults = parsed;
      if (rawText) this.plugin.settings.lastImportedResponse = rawText;
      this.plugin.settings.lastScannedNote = this.scanContext?.file?.basename || "";
      if (typeof this.plugin.saveSettings === "function") await this.plugin.saveSettings({ clearCache: false });
    } catch (_) {}
    this.render();
  }

  async clearScanMemory() {
    this.scanResults = null;
    this.restoredFromMemory = false;
    this.plugin.settings.lastScanResults = null;
    this.plugin.settings.lastImportedResponse = "";
    this.plugin.settings.lastScannedNote = "";
    this.insertedSuggestionIndices.clear();
    this.pendingScannerScrollIdx = null;
    try {
      await this.plugin.saveSettings({ clearCache: false });
    } catch (_) {}
    this.render();
    new Notice("Cleared visual audit memory.");
  }

  async jumpToLine(line) {
    try {
      const target = this.plugin.captureTarget(this.scanContext, line);
      await this.plugin.app.workspace.revealLeaf(target.view.leaf);
      target.editor.setCursor(target.position);
      target.editor.scrollIntoView({ from: target.position, to: target.position }, true);
      new Notice(`Navigated to line ${line}`);
    } catch (err) {
      new Notice(safeError(err));
    }
  }

  async revealTargetNote() {
    const targetView = this.plugin.getTargetView();
    if (!targetView?.leaf) {
      new Notice("Open a Markdown note first.");
      return;
    }
    await this.plugin.app.workspace.revealLeaf(targetView.leaf);
  }

  async executeNoteScan(forceOffline = false, explicitScope = null) {
    if (this.isScanning || this.closed) return;
    let context;
    try {
      context = this.plugin.captureTarget();
    } catch (err) {
      new Notice(safeError(err));
      return;
    }
    const { file, content, editor } = context;
    const title = file.basename;
    if (!content || !content.trim()) {
      new Notice("The active note is empty.");
      return;
    }

    const totalLines = editor?.lineCount?.() || content.split(/\r?\n/).length;
    const targetScope = explicitScope
      ? normalizeScanScope(explicitScope, totalLines)
      : this.getSelectedUiScope(context.view);
    this.pendingScanScope = targetScope;

    const useOffline = forceOffline || this.plugin.settings.aiBackend === "offline" || !this.plugin.settings.geminiApiKey;
    if (!forceOffline && this.plugin.settings.aiBackend === "gemini" && !this.plugin.settings.geminiApiKey) {
      // Gracefully inform and fall back or prompt user
      new Notice("No Gemini API key set — running Offline Medical Rules Engine.", 4000);
    }

    const generation = ++this.scanGeneration;
    this.scanContext = context;
    this.scanResults = null;
    this.scanProgressMsg = targetScope ? `Scanning ${targetScope.label}...` : "";
    this.inlineQuickResults.clear();
    this.inlineLoading.clear();
    this.isScanning = true;
    this.scanErrorMessage = "";
    this.render();

    try {
      const scanner = useOffline
        ? new OfflineMedicalScanner()
        : new GeminiScannerService(this.plugin.settings.geminiApiKey, this.plugin.settings.geminiModel, this.plugin);
      const max = this.plugin.settings.geminiMaxSuggestions || 25;
      const results = await scanner.scanNote(title, content, max, (msg) => {
        if (!this.closed && generation === this.scanGeneration) {
          this.scanProgressMsg = msg;
          this.render();
        }
      }, targetScope);
      if (this.closed || generation !== this.scanGeneration) return;
      this.scanResults = results;
      this.pendingScanScope = null;
      this.scannerCategoryFilter = "all";
      this.restoredFromMemory = false;
      this.insertedSuggestionIndices.clear();
      this.clearSearchLink();
      this.lastActiveScannerIndex = null;
      this.pendingScannerScrollIdx = null;
      this.scannerScrollTop = 0;
      try {
        if (this.plugin.settings) {
          this.plugin.settings.lastScanResults = results;
          this.plugin.settings.lastScannedNote = title;
          if (typeof this.plugin.saveSettings === "function") await this.plugin.saveSettings({ clearCache: false });
        }
      } catch (_) {}
      new Notice(
        targetScope
          ? `Found ${this.scanResults.suggestions.length} visual opportunities in ${targetScope.label}!`
          : `Identified ${this.scanResults.suggestions.length} high-yield visual opportunities!`,
        5000
      );
    } catch (err) {
      if (this.closed || generation !== this.scanGeneration) return;
      this.pendingScanScope = null;
      this.scanErrorMessage = safeError(err);
      new Notice(`Scan failed: ${this.scanErrorMessage}`, 7000);
    } finally {
      if (!this.closed && generation === this.scanGeneration) {
        this.isScanning = false;
        this.render();
      }
    }
  }

  async executeInlineQuickFind(index, query, visualType) {
    if (this.closed || this.inlineLoading.has(index)) return;
    const generation = this.scanGeneration;
    const context = this.scanContext;
    const suggestion = this.scanResults?.suggestions[index];
    const targetScope = this.scanResults?.scope || null;
    this.inlineLoading.add(index);
    this.render();

    try {
      const provider = this.plugin.getActiveProvider();
      const effectiveQuery = this.getEffectiveQuery(query, visualType || "diagram");
      const items = await this.plugin.searchWithCache(provider, effectiveQuery);
      if (this.closed || generation !== this.scanGeneration) return;
      this.inlineQuickResults.set(
        index,
        items.slice(0, 6).map((item) => ({
          ...item,
          targetContext: context,
          targetLine: suggestion?.line,
          targetHeading: suggestion?.heading,
          targetConcept: suggestion?.visualConcept,
          targetQuery: suggestion?.recommendedQuery,
          targetScope,
          searchOriginSuggestionIndex: index
        }))
      );
    } catch (err) {
      if (!this.closed && generation === this.scanGeneration) new Notice(`Quick find failed: ${safeError(err)}`);
    } finally {
      if (!this.closed && generation === this.scanGeneration) {
        this.inlineLoading.delete(index);
        this.render();
      }
    }
  }

  setQuery(query, autoSearch = true) {
    this.currentTab = "search";
    this.currentQuery = query;
    if (this.queryInput) this.queryInput.value = query;
    this.render();
    if (autoSearch && query.trim()) this.executeSearch(query.trim());
  }

  getEffectiveQuery(baseQuery, filterId) {
    const clean = cleanText(baseQuery);
    if (!clean) return "";
    const filter = MEDICAL_VISUAL_FILTERS.find((f) => f.id === filterId);
    if (!filter || !filter.modifier) return clean;
    if (filter.skipIf && filter.skipIf.test(clean)) return clean;
    const words = filter.modifier.split(" ");
    const needed = words.filter((w) => !clean.toLowerCase().includes(w.toLowerCase()));
    return needed.length > 0 ? `${clean} ${needed.join(" ")}` : clean;
  }

  async executeSearch(query) {
    if (this.closed || !query || !query.trim()) return;
    const generation = ++this.searchGeneration;
    const targetContext = this.searchTargetContext;
    const targetLine = this.searchTargetLine;
    const targetHeading = this.searchTargetHeading;
    const targetConcept = this.searchTargetConcept;
    const targetQuery = this.searchTargetQuery;
    const targetScope = this.searchTargetScope;
    const originIdx = this.searchOriginSuggestionIndex;
    this.currentQuery = query;
    this.isSearching = true;
    this.statusType = "loading";
    const provider = this.plugin.getActiveProvider();
    const effectiveQuery = this.getEffectiveQuery(query, this.activeFilter);
    const filterObj = MEDICAL_VISUAL_FILTERS.find((f) => f.id === this.activeFilter);
    const filterTag = filterObj && filterObj.id !== "all" ? ` [${filterObj.label}]` : "";
    this.statusMessage = `Searching "${query}"${filterTag} via ${provider.name}...`;
    this.render();

    try {
      const results = await this.plugin.searchWithCache(provider, effectiveQuery);
      if (this.closed || generation !== this.searchGeneration) return;
      this.results = results.map((item) => ({
        ...item,
        targetContext,
        targetLine,
        targetHeading,
        targetConcept,
        targetQuery,
        targetScope,
        searchOriginSuggestionIndex: originIdx
      }));
      this.isSearching = false;
      this.statusType = "normal";
      this.statusMessage =
        this.results.length > 0
          ? `Found ${this.results.length} images${filterTag} via ${provider.name}.`
          : `No images found for this query${filterTag}. Try another filter or keyword.`;
    } catch (err) {
      if (this.closed || generation !== this.searchGeneration) return;
      this.isSearching = false;
      this.statusType = "error";
      this.statusMessage = `Error: ${safeError(err)}`;
      this.results = [];
    }
    this.render();
  }

  render() {
    if (this.closed) return;
    const input = this.queryInput;
    const focused = !!input && input.ownerDocument?.activeElement === input;
    const selection = focused ? [input.selectionStart, input.selectionEnd] : null;
    const prevTab = this._lastRenderedTab;
    const tabChanged = prevTab !== this.currentTab;
    if (tabChanged && prevTab != null && this.contentEl) {
      if (prevTab === "scan") this.scannerScrollTop = this.contentEl.scrollTop || 0;
      else if (prevTab === "search") this.searchScrollTop = this.contentEl.scrollTop || 0;
    }
    this._lastRenderedTab = this.currentTab;
    const scrollTop = tabChanged
      ? this.currentTab === "scan"
        ? this.pendingScannerScrollIdx == null ? this.scannerScrollTop : 0
        : this.searchScrollTop
      : this.contentEl ? this.contentEl.scrollTop : 0;
    this.renderContent();
    if (this.contentEl) this.contentEl.scrollTop = scrollTop;
    if (focused && this.currentTab === "search" && this.queryInput) {
      this.queryInput.focus();
      if (selection) this.queryInput.setSelectionRange(...selection);
    }
  }

  renderContent() {
    const root = this.contentEl;
    root.empty();
    root.addClass("mifm-container");

    const activeProviderId = this.plugin.settings?.defaultProvider || "duckduckgo";
    const activeProviderMeta = SEARCH_PROVIDERS.find((p) => p.id === activeProviderId) || SEARCH_PROVIDERS[0];

    const header = root.createDiv({ cls: "mifm-header" });
    header.createDiv({ text: `MEDICINE & SURGERY ATLAS • ${activeProviderMeta.shortLabel}`, cls: "mifm-kicker" });

    const titleRow = header.createDiv({ cls: "mifm-title-row" });
    titleRow.createEl("h3", { text: "Medical Image Finder Mobile", cls: "mifm-title" });

    const activeFile = this.plugin.getTargetView()?.file;
    if (activeFile) {
      const targetRow = header.createDiv({ cls: "mifm-target-row" });
      targetRow.createDiv({ text: `Target: ${activeFile.basename}`, cls: "mifm-target-note mifm-header-target-note" });
      const openNoteBtn = targetRow.createEl("button", {
        text: "📄 Note",
        cls: "mifm-link-btn mifm-open-note-btn",
        attr: { type: "button", title: "Jump back to target note" }
      });
      openNoteBtn.onclick = () => this.revealTargetNote();
    }

    const tabBar = header.createDiv({ cls: "mifm-tab-bar" });
    const searchTabBtn = tabBar.createEl("button", {
      text: "🔍 Search Images",
      cls: `mifm-tab ${this.currentTab === "search" ? "is-active" : ""}`
    });
    searchTabBtn.type = "button";
    searchTabBtn.onclick = () => {
      if (this.currentTab !== "search") {
        this.currentTab = "search";
        this.render();
      }
    };

    const scanTabBtn = tabBar.createEl("button", {
      text: "✨ AI Visual Scanner",
      cls: `mifm-tab ${this.currentTab === "scan" ? "is-active" : ""}`
    });
    scanTabBtn.type = "button";
    scanTabBtn.onclick = () => {
      if (this.currentTab !== "scan") {
        this.currentTab = "scan";
        this.render();
      }
    };

    if (this.currentTab === "scan") {
      this.queryInput = null;
      this.renderScannerView(root);
      return;
    }

    const form = header.createDiv({ cls: "mifm-search-form" });
    const queryWrapper = form.createDiv({ cls: "mifm-query-wrapper" });

    this.queryInput = queryWrapper.createEl("input", {
      cls: "mifm-query-input",
      attr: {
        type: "search",
        enterkeyhint: "search",
        placeholder: "e.g. triangle of doom borders...",
        value: this.currentQuery || ""
      }
    });

    this.queryInput.addEventListener("input", () => {
      this.currentQuery = this.queryInput.value;
    });
    this.queryInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const val = this.queryInput.value.trim();
        if (val) this.executeSearch(val);
      }
    });

    const pasteBtn = queryWrapper.createEl("button", {
      cls: "mifm-btn-icon",
      text: "📋",
      attr: { type: "button", "aria-label": "Paste selection or clipboard" }
    });
    pasteBtn.onclick = async () => {
      let text = "";
      const activeView = this.plugin.getTargetView();
      if (activeView?.editor) text = activeView.editor.getSelection().trim();
      if (!text && this.plugin.lastSelectionText) text = this.plugin.lastSelectionText;
      if (!text) text = (await readFromClipboard()).trim();
      if (text) {
        this.queryInput.value = text;
        this.currentQuery = text;
        this.clearSearchLink();
        this.queryInput.focus();
        new Notice("Pasted text into search bar!");
      } else {
        new Notice("Select text in your note first, or copy text to clipboard.");
      }
    };

    const clearBtn = queryWrapper.createEl("button", {
      cls: "mifm-btn-icon",
      text: "✕",
      attr: { type: "button", "aria-label": "Clear search input" }
    });
    clearBtn.onclick = () => {
      this.queryInput.value = "";
      this.currentQuery = "";
      this.clearSearchLink();
      ++this.searchGeneration;
      this.isSearching = false;
      this.results = [];
      this.statusMessage = "";
      this.render();
      this.queryInput.focus();
    };

    const searchBtn = queryWrapper.createEl("button", {
      text: "Search",
      cls: "mifm-btn mifm-btn-copy"
    });
    searchBtn.type = "button";
    searchBtn.onclick = () => {
      const val = this.queryInput.value.trim();
      if (val) this.executeSearch(val);
    };

    const providerRow = form.createDiv({ cls: "mifm-provider-row" });
    providerRow.createSpan({ text: "Engine:", cls: "mifm-provider-label" });
    const providerSelect = providerRow.createEl("select", { cls: "mifm-provider-select" });
    const providerChoices = [
      { id: "duckduckgo", label: "🦆 DuckDuckGo (Free / No Key)" },
      { id: "brightdata", label: `🌐 Bright Data Google Images ${this.plugin.settings.brightDataApiKey ? "✓" : "(API Key)"}` },
      { id: "brave", label: `🦁 Brave Images ${this.plugin.settings.braveApiKey ? "✓" : "(API Key)"}` },
      { id: "wikimedia", label: "📚 Wikimedia Commons (Free)" }
    ];
    providerChoices.forEach((opt) => {
      const el = providerSelect.createEl("option", { text: opt.label, value: opt.id });
      if (opt.id === activeProviderId) el.selected = true;
    });
    providerSelect.onchange = async () => {
      this.plugin.settings.defaultProvider = providerSelect.value;
      await this.plugin.saveSettings();
      const val = this.queryInput ? this.queryInput.value.trim() : (this.currentQuery || "").trim();
      if (val) {
        this.executeSearch(val);
      } else {
        this.render();
      }
    };

    const filterBar = form.createDiv({ cls: "mifm-filter-bar" });
    MEDICAL_VISUAL_FILTERS.forEach((filter) => {
      const pill = filterBar.createEl("button", {
        text: filter.label,
        cls: `mifm-filter-pill ${this.activeFilter === filter.id ? "is-active" : ""}`
      });
      pill.type = "button";
      pill.onclick = () => {
        if (this.activeFilter === filter.id) return;
        this.activeFilter = filter.id;
        this.render();
        const val = this.queryInput ? this.queryInput.value.trim() : (this.currentQuery || "").trim();
        if (val) this.executeSearch(val);
      };
    });

    if (this.statusMessage) {
      root.createDiv({
        cls: `mifm-status ${
          this.statusType === "loading" ? "is-loading" : this.statusType === "error" ? "is-error" : ""
        }`,
        text: this.statusMessage
      });
    }

    if (this.searchOriginSuggestionIndex != null) {
      const banner = root.createDiv({ cls: "mifm-scanner-return-banner" });
      banner.createSpan({
        cls: "mifm-return-label",
        text: `🎯 Topic: ${this.searchTargetHeading || "Card #" + (this.searchOriginSuggestionIndex + 1)}`
      });
      const bannerActions = banner.createDiv({ cls: "mifm-banner-actions" });
      const backBtn = bannerActions.createEl("button", { cls: "mifm-link-btn", text: "← Back to Scanner" });
      backBtn.onclick = () => {
        this.pendingScannerScrollIdx = this.searchOriginSuggestionIndex;
        this.currentTab = "scan";
        this.render();
      };
      const unlinkBtn = bannerActions.createEl("button", { cls: "mifm-link-btn", text: "✕" });
      unlinkBtn.onclick = () => {
        this.clearSearchLink();
        this.results = this.results.map((r) => ({
          ...r,
          targetContext: null,
          targetLine: null,
          targetHeading: null,
          targetConcept: null,
          targetQuery: null,
          searchOriginSuggestionIndex: null
        }));
        this.render();
      };
    }

    if (this.results.length === 0 && !this.isSearching) {
      const emptyState = root.createDiv({ cls: "mifm-empty-state" });
      emptyState.createDiv({ text: "🩺", cls: "mifm-empty-icon" });
      const emptyTitles = {
        duckduckgo: "DuckDuckGo Medical Image Search",
        brightdata: "Bright Data Google Images Search",
        brave: "Brave Medical Image Search",
        wikimedia: "Wikimedia Commons Medical Search"
      };
      const emptyDescs = {
        duckduckgo: "Zero API keys needed. Select text in your note or type any anatomical/radiology query above.",
        brightdata: this.plugin.settings.brightDataApiKey
          ? "Using Google Images via Bright Data. Type a medical query or select note text above."
          : "Enter your Bright Data API key in Settings → Medical Image Finder Mobile (5,000 free/month).",
        brave: this.plugin.settings.braveApiKey
          ? "Using Brave Image Search API. Type a medical query or select note text above."
          : "Enter your Brave API key in Settings → Medical Image Finder Mobile.",
        wikimedia: "Free open-license anatomical and pathology illustrations from Wikimedia Commons."
      };
      emptyState.createEl("h3", { text: emptyTitles[activeProviderId] || "Medical Image Search" });
      emptyState.createEl("p", {
        text: emptyDescs[activeProviderId] || "Select text in your note or type any anatomical/radiology query above."
      });
      return;
    }

    const list = root.createDiv({ cls: "mifm-results-list" });
    this.results.forEach((item, rIdx) => {
      const card = list.createDiv({ cls: "mifm-card" });
      const thumbContainer = card.createDiv({ cls: "mifm-thumb-container" });
      const img = thumbContainer.createEl("img", {
        cls: "mifm-thumb",
        attr: {
          src: item.thumbnailUrl || item.imageUrl,
          alt: item.title,
          loading: "lazy",
          decoding: "async"
        }
      });
      const overlay = thumbContainer.createDiv({ cls: "mifm-thumb-overlay" });
      bindHighResPreview(img, overlay, item);
      thumbContainer.onclick = () => {
        new ImagePreviewModal(this.app, this.plugin, item, this, {
          items: this.results,
          currentIndex: rIdx
        }).open();
      };

      const body = card.createDiv({ cls: "mifm-card-body" });
      body.createEl("h4", { text: item.title, cls: "mifm-card-title" });
      const meta = body.createDiv({ cls: "mifm-card-meta" });
      if (item.domain) meta.createSpan({ text: item.domain, cls: "mifm-domain" });

      const actions = body.createDiv({ cls: "mifm-card-actions" });
      const insertBtn = actions.createEl("button", { text: "📥 Insert in note", cls: "mifm-btn mifm-btn-insert" });
      this.plugin.bindAction(insertBtn, item, "insert");
      insertBtn.onclick = async (e) => {
        e.stopPropagation();
        insertBtn.disabled = true;
        insertBtn.setText("Inserting...");
        try {
          await this.plugin.saveAndInsertImage(item);
          this.syncTargetContentAfterInsert(item.targetContext?.file);
          if (item.searchOriginSuggestionIndex != null) {
            this.insertedSuggestionIndices.add(item.searchOriginSuggestionIndex);
            this.lastActiveScannerIndex = item.searchOriginSuggestionIndex;
            this.pendingScannerScrollIdx = item.searchOriginSuggestionIndex;
            this.currentTab = "scan";
          }
          this.render();
        } catch (err) {
          new Notice(`Insert failed: ${safeError(err)}`);
        } finally {
          insertBtn.disabled = false;
          insertBtn.setText("📥 Insert in note");
        }
      };

      const copyBtn = actions.createEl("button", { text: "📋 Copy image", cls: "mifm-btn mifm-btn-copy" });
      this.plugin.bindAction(copyBtn, item, "copy");
      copyBtn.onclick = async (e) => {
        e.stopPropagation();
        copyBtn.disabled = true;
        copyBtn.setText("Copying...");
        try {
          await this.plugin.copyImageToClipboard(item);
        } catch (err) {
          new Notice(`Copy failed: ${safeError(err)}`);
        } finally {
          copyBtn.disabled = false;
          copyBtn.setText("📋 Copy image");
        }
      };

      const subActions = body.createDiv({ cls: "mifm-sub-actions" });
      const previewLink = subActions.createEl("button", { text: "🔍 Preview", cls: "mifm-link-btn" });
      previewLink.onclick = () =>
        new ImagePreviewModal(this.app, this.plugin, item, this, {
          items: this.results,
          currentIndex: rIdx
        }).open();

      const sourceUrl = item.sourceUrl || item.imageUrl;
      if (sourceUrl) {
        const sourceLink = subActions.createEl("button", { text: "🌐 Source ↗", cls: "mifm-link-btn" });
        sourceLink.onclick = () => {
          if (openExternalUrl(sourceUrl)) new Notice(`🌐 Opening source: ${item.domain || "Web"}`);
        };
      }
    });
  }

  renderScannerView(root) {
    const container = root.createDiv({ cls: "mifm-scan-container" });

    const hero = container.createDiv({ cls: "mifm-scan-hero" });
    hero.createEl("h4", { text: "⚡ AI Note Visual Scanner", cls: "mifm-scan-hero-title" });
    hero.createEl("p", {
      text: "Finds missing anatomical diagrams, triangles, operative repairs, and radiology signs, then searches your selected engine in batch.",
      cls: "mifm-scan-hero-desc"
    });

    const countRow = hero.createDiv({ cls: "mifm-scan-count-row" });
    countRow.createSpan({ text: "🎯 Target Images:", cls: "mifm-scan-count-label" });
    const countSelect = countRow.createEl("select", { cls: "mifm-scan-count-select" });
    const currentCount = this.plugin.settings.geminiMaxSuggestions || 25;
    for (const val of [5, 10, 15, 20, 25, 30, 40, 50]) {
      const opt = countSelect.createEl("option", { text: `${val} images`, value: String(val) });
      if (val === currentCount) opt.selected = true;
    }
    countSelect.onchange = async () => {
      const newCount = parseInt(countSelect.value, 10);
      if (!isNaN(newCount)) {
        this.plugin.settings.geminiMaxSuggestions = newCount;
        await this.plugin.saveSettings({ clearCache: false });
        new Notice(`Target set to ${newCount} images per note.`);
      }
    };

    const targetView = this.plugin.getTargetView?.();
    const activeFile = targetView?.file;
    const activeEditor = targetView?.editor;
    const noteContent = activeEditor?.getValue?.() || this.scanContext?.content || "";
    const totalLines = activeEditor?.lineCount?.() || (noteContent ? noteContent.split(/\r?\n/).length : 1);
    const liveSelection = this.detectEditorSelectionScope(targetView);
    const liveSelKey = liveSelection ? `${liveSelection.startLine}-${liveSelection.endLine}` : "";
    if (liveSelection) {
      this.editorSelectionScope = liveSelection;
      if (liveSelKey !== this._lastAutoSelectionKey) {
        this._lastAutoSelectionKey = liveSelKey;
        this.scopeMode = "selection";
      }
    } else if (!liveSelection && this._lastAutoSelectionKey) {
      this._lastAutoSelectionKey = "";
      if (this.scopeMode === "selection" && !this.editorSelectionScope) this.scopeMode = "full";
    }

    const sections = extractNoteSections(noteContent);
    const scopeRow = hero.createDiv({ cls: "mifm-scan-scope-row" });
    scopeRow.createSpan({ text: "🎯 Scan Scope:", cls: "mifm-scan-count-label" });
    const scopeSelect = scopeRow.createEl("select", { cls: "mifm-scan-scope-select" });

    const fullOpt = scopeSelect.createEl("option", { text: "Full Note (All Lines)", value: "full" });
    if (this.scopeMode === "full") fullOpt.selected = true;

    if (this.editorSelectionScope) {
      const selOpt = scopeSelect.createEl("option", {
        text: `Selection (Lines ${this.editorSelectionScope.startLine}–${this.editorSelectionScope.endLine})`,
        value: "selection"
      });
      if (this.scopeMode === "selection") selOpt.selected = true;
    }

    if (sections.length > 0) {
      for (const sec of sections) {
        const prefix = "#".repeat(Math.min(sec.level, 3));
        const secOpt = scopeSelect.createEl("option", {
          text: `${prefix} ${sec.heading} (L${sec.startLine}–${sec.endLine})`,
          value: `sec:${sec.key}`
        });
        if (this.scopeMode === "section" && this.selectedSectionKey === sec.key) secOpt.selected = true;
      }
    }

    const customOpt = scopeSelect.createEl("option", { text: "Custom Line Range...", value: "custom" });
    if (this.scopeMode === "custom") customOpt.selected = true;

    scopeSelect.onchange = () => {
      const val = scopeSelect.value;
      if (val === "full") {
        this.scopeMode = "full";
      } else if (val === "selection") {
        this.scopeMode = "selection";
      } else if (val === "custom") {
        this.scopeMode = "custom";
        if (!this.customScopeEnd || this.customScopeEnd < this.customScopeStart) {
          this.customScopeStart = 1;
          this.customScopeEnd = Math.min(totalLines, 40);
        }
      } else if (val.startsWith("sec:")) {
        this.scopeMode = "section";
        this.selectedSectionKey = val.slice(4);
      }
      this.render();
    };

    if (this.scopeMode === "custom") {
      const rangeBox = hero.createDiv({ cls: "mifm-scope-custom-inputs" });
      rangeBox.createSpan({ text: "From L" });
      const fromInput = rangeBox.createEl("input", {
        type: "number",
        cls: "mifm-scope-line-input",
        attr: { min: "1", max: String(totalLines) }
      });
      fromInput.value = String(this.customScopeStart || 1);
      fromInput.onchange = () => {
        this.customScopeStart = Math.max(1, parseInt(fromInput.value, 10) || 1);
        this.render();
      };

      rangeBox.createSpan({ text: "To L" });
      const toInput = rangeBox.createEl("input", {
        type: "number",
        cls: "mifm-scope-line-input",
        attr: { min: "1", max: String(totalLines) }
      });
      toInput.value = String(this.customScopeEnd || Math.min(totalLines, 40));
      toInput.onchange = () => {
        this.customScopeEnd = Math.max(this.customScopeStart || 1, parseInt(toInput.value, 10) || totalLines);
        this.render();
      };
    }

    const activeScope = this.getSelectedUiScope(targetView);

    // Primary Zero-API Mobile Bridge: Copy Note & Prompt
    const copyPromptBtn = hero.createEl("button", {
      cls: "mifm-scan-btn",
      text: activeScope ? "📋 Copy Scoped Part & Prompt for AI App" : "📋 Copy Note & Prompt for AI App"
    });
    copyPromptBtn.onclick = () => this.copyNotePromptForAiApp(activeScope);

    const bridgeActionRow = hero.createDiv({ cls: "mifm-scan-actions" });
    bridgeActionRow.style.marginTop = "6px";

    const importBtn = bridgeActionRow.createEl("button", {
      cls: "mifm-btn mifm-btn-insert",
      text: "📥 Import AI Response"
    });
    importBtn.onclick = () => new AiResponseImportModal(this.app, this.plugin, this).open();

    const pasteClipBtn = bridgeActionRow.createEl("button", {
      cls: "mifm-btn",
      text: "📋 Paste Response"
    });
    pasteClipBtn.onclick = () => this.importAiResponseFromClipboard();

    // Always provide Offline Scan (zero API) + Gemini API scan when key is present
    const offlineBtn = bridgeActionRow.createEl("button", {
      cls: "mifm-btn mifm-btn-copy",
      text: this.isScanning ? "⏳ Scanning..." : "🩺 Offline Scan"
    });
    offlineBtn.disabled = this.isScanning;
    offlineBtn.onclick = () => this.executeNoteScan(true);

    if (this.plugin.settings.geminiApiKey) {
      const geminiBtn = bridgeActionRow.createEl("button", {
        cls: "mifm-btn mifm-btn-copy",
        text: this.isScanning ? "⏳ Gemini..." : "✨ Scan (Gemini API)"
      });
      geminiBtn.disabled = this.isScanning;
      geminiBtn.onclick = () => this.executeNoteScan(false);
    }

    if (this.waitingForAi) {
      const step2Box = container.createDiv({ cls: "mifm-scan-hero mifm-step2-box" });
      step2Box.createEl("h5", {
        text: `⏳ Ready for AI Output (${this.copiedPromptNote || "Active Note"})`,
        cls: "mifm-step2-title"
      });
      step2Box.createEl("p", {
        cls: "mifm-scan-hero-desc",
        text: "1. Switch to Gemini / ChatGPT / Claude and paste. 2. Copy the AI response. 3. Tap below:"
      });
      const stepActions = step2Box.createDiv({ cls: "mifm-scan-actions" });
      const pasteNowBtn = stepActions.createEl("button", {
        cls: "mifm-btn mifm-btn-insert",
        text: "📥 Paste from Clipboard"
      });
      pasteNowBtn.onclick = () => this.importAiResponseFromClipboard();
      const manualPasteBtn = stepActions.createEl("button", {
        cls: "mifm-btn",
        text: "📝 Paste Box"
      });
      manualPasteBtn.onclick = () => new AiResponseImportModal(this.app, this.plugin, this).open();
      const cancelWaitBtn = stepActions.createEl("button", { cls: "mifm-btn", text: "Dismiss" });
      cancelWaitBtn.onclick = () => {
        this.waitingForAi = false;
        this.render();
      };
    }

    if (this.scanErrorMessage) {
      container.createDiv({ cls: "mifm-status is-error", text: this.scanErrorMessage });
    }

    if (this.isScanning) {
      container.createDiv({
        cls: "mifm-status is-loading",
        text: this.scanProgressMsg || "🧠 Analyzing note..."
      });
      return;
    }

    if (!this.scanResults) {
      if (!this.waitingForAi) {
        const emptyState = container.createDiv({ cls: "mifm-empty-state" });
        emptyState.createDiv({ text: "🔬", cls: "mifm-empty-icon" });
        emptyState.createEl("h3", { text: "Scan Note for Visual Gaps" });
        emptyState.createEl("p", {
          text: "Tap 'Copy Note & Prompt for AI App' to use Gemini/ChatGPT on your iPad or Android, or tap 'Offline Scan' for instant local rules."
        });
      }
      return;
    }

    if (this.scanContext) {
      container.createDiv({ cls: "mifm-target-note", text: `Scanned: ${this.scanContext.file.basename}` });
      this._scanWarningSlot = container.createDiv({ cls: "mifm-scan-warning-slot" });
      this.updateScanContextStatus();
    } else {
      this._scanWarningSlot = null;
    }

    const summaryBox = container.createDiv({ cls: "mifm-status" });
    const summaryHeader = summaryBox.createDiv({ cls: "mifm-summary-header" });
    summaryHeader.createEl("strong", { text: "Visual Audit: " });
    summaryHeader.createSpan({
      text: `${this.scanResults.summary} (${this.scanResults.suggestions.length} visual opportunities)`
    });

    const resultScope = this.scanResults.scope;
    if (resultScope && resultScope.mode && resultScope.mode !== "full") {
      const scopeBadgeRow = summaryBox.createDiv({ cls: "mifm-scope-badge-row" });
      scopeBadgeRow.createSpan({
        text: `📌 Scoped: ${resultScope.label}`,
        cls: "mifm-scope-pill"
      });
      const resetScopeBtn = scopeBadgeRow.createEl("button", {
        text: "Reset to Full Note",
        cls: "mifm-link-btn"
      });
      resetScopeBtn.onclick = () => {
        this.scopeMode = "full";
        this.executeNoteScan(false, { mode: "full" });
      };
    }

    if (this.restoredFromMemory && this.plugin.settings.lastScannedNote) {
      const mismatch = activeFile && activeFile.basename !== this.plugin.settings.lastScannedNote;
      summaryBox.createDiv({
        cls: mismatch ? "mifm-memory-tag mifm-status is-error" : "mifm-memory-tag",
        text: mismatch
          ? `⚠️ Restored scan is for "${this.plugin.settings.lastScannedNote}", but active note is "${activeFile.basename}".`
          : `💾 Restored previous scan (${this.plugin.settings.lastScannedNote})`
      });
    }

    const resetRow = summaryBox.createDiv({ cls: "mifm-summary-reset-row" });
    const clearMemBtn = resetRow.createEl("button", {
      cls: "mifm-btn mifm-btn-clear-mem",
      text: "🗑️ Clear Audit / Rescan"
    });
    clearMemBtn.onclick = () => this.clearScanMemory();

    const batchBar = container.createDiv({ cls: "mifm-batch-bar" });
    const batchModalBtn = batchBar.createEl("button", {
      cls: "mifm-btn mifm-btn-insert mifm-batch-btn",
      text: "⚡ Fast Batch Image Review"
    });
    batchModalBtn.onclick = () => new BatchImageReviewModal(this.app, this.plugin, this).open();

    const autoPilotBtn = batchBar.createEl("button", {
      cls: "mifm-btn mifm-batch-autopilot-btn",
      text: this.isAutoPiloting ? "⏳ Auto-Pilot..." : "🚀 1-Click Auto-Pilot"
    });
    autoPilotBtn.disabled = this.isAutoPiloting;
    autoPilotBtn.onclick = () => this.runAutoPilotBatch();

    const categoryCounts = {};
    let pendingCount = 0;
    this.scanResults.suggestions.forEach((s, idx) => {
      const vType = s.visualType || "diagram";
      categoryCounts[vType] = (categoryCounts[vType] || 0) + 1;
      if (!this.insertedSuggestionIndices.has(idx)) pendingCount++;
    });

    const scanFilterBar = container.createDiv({ cls: "mifm-filter-bar mifm-scan-filter-bar" });
    const makeScanFilterPill = (id, label) => {
      const pill = scanFilterBar.createEl("button", {
        text: label,
        cls: `mifm-filter-pill ${this.scannerCategoryFilter === id ? "is-active" : ""}`
      });
      pill.onclick = () => {
        this.scannerCategoryFilter = id;
        this.render();
      };
    };
    makeScanFilterPill("all", `All (${this.scanResults.suggestions.length})`);
    makeScanFilterPill("pending", `Pending (${pendingCount})`);
    for (const f of MEDICAL_VISUAL_FILTERS) {
      if (f.id === "all") continue;
      const cnt = categoryCounts[f.id] || 0;
      if (cnt > 0 || this.scannerCategoryFilter === f.id) {
        makeScanFilterPill(f.id, `${f.label} (${cnt})`);
      }
    }

    const filteredSuggestions = this.scanResults.suggestions
      .map((s, idx) => ({ s, idx }))
      .filter(({ s, idx }) => {
        if (this.scannerCategoryFilter === "pending") return !this.insertedSuggestionIndices.has(idx);
        if (this.scannerCategoryFilter !== "all") return (s.visualType || "diagram") === this.scannerCategoryFilter;
        return true;
      });

    if (filteredSuggestions.length === 0) {
      container.createDiv({
        cls: "mifm-status",
        text: "No visual suggestions match this filter."
      });
      return;
    }

    filteredSuggestions.forEach(({ s, idx }) => {
      const card = container.createDiv({
        cls: `mifm-scan-card ${this.insertedSuggestionIndices.has(idx) ? "is-inserted" : ""}`
      });
      card.id = `mifm-card-${idx}`;
      card.setAttribute("data-idx", String(idx));

      const headerRow = card.createDiv({ cls: "mifm-scan-header-row" });
      if (this.insertedSuggestionIndices.has(idx)) {
        headerRow.createSpan({ text: "✓ Inserted", cls: "mifm-badge mifm-badge-inserted" });
      }
      const headingEl = headerRow.createSpan({ text: `📍 ${s.heading}`, cls: "mifm-scan-heading" });
      headingEl.onclick = () => this.jumpToLine(s.line);

      const filterObj = MEDICAL_VISUAL_FILTERS.find((f) => f.id === (s.visualType || "diagram"));
      headerRow.createSpan({ text: filterObj ? filterObj.label : "Diagram", cls: "mifm-badge" });

      card.createEl("h4", { text: s.visualConcept, cls: "mifm-scan-concept" });
      if (s.rationale) card.createDiv({ text: s.rationale, cls: "mifm-scan-rationale" });

      if (s.recommendedQuery) {
        const queryRow = card.createDiv({ cls: "mifm-scan-query-row" });
        queryRow.createSpan({ text: "🔍 Query: ", cls: "mifm-scan-query-label" });
        queryRow.createSpan({ text: s.recommendedQuery });
      }

      const actions = card.createDiv({ cls: "mifm-scan-actions" });

      const quickFindBtn = actions.createEl("button", {
        text: this.inlineLoading.has(idx) ? "Searching..." : "⚡ Quick find",
        cls: "mifm-btn mifm-btn-insert"
      });
      quickFindBtn.disabled = this.inlineLoading.has(idx);
      quickFindBtn.onclick = () => this.executeInlineQuickFind(idx, s.recommendedQuery, s.visualType);

      const searchThisBtn = actions.createEl("button", {
        text: "🔍 Search images",
        cls: "mifm-btn mifm-btn-copy"
      });
      searchThisBtn.onclick = () => {
        this.searchTargetContext = this.scanContext;
        this.searchTargetLine = s.line;
        this.searchTargetHeading = s.heading;
        this.searchTargetConcept = s.visualConcept;
        this.searchTargetQuery = s.recommendedQuery;
        this.searchTargetScope = this.scanResults?.scope || null;
        this.searchOriginSuggestionIndex = idx;
        this.lastActiveScannerIndex = idx;
        this.switchToSearchTab(s.recommendedQuery, s.visualType || "diagram", true);
      };

      const jumpBtn = actions.createEl("button", { text: `📍 Line ${s.line}`, cls: "mifm-btn" });
      jumpBtn.onclick = () => this.jumpToLine(s.line);

      if (this.inlineQuickResults.has(idx)) {
        const inlineList = this.inlineQuickResults.get(idx);
        if (inlineList.length > 0) {
          const inlineContainer = card.createDiv({ cls: "mifm-inline-results" });
          inlineList.forEach((item, tileIdx) => {
            const tile = inlineContainer.createDiv({ cls: "mifm-inline-thumb-card" });
            const inlineImg = tile.createEl("img", {
              cls: "mifm-inline-thumb-img",
              attr: {
                src: item.thumbnailUrl || item.imageUrl,
                alt: item.title,
                loading: "lazy",
                decoding: "async"
              }
            });
            const inlineOverlay = tile.createDiv({ cls: "mifm-thumb-overlay" });
            bindHighResPreview(inlineImg, inlineOverlay, item);
            tile.onclick = () =>
              new ImagePreviewModal(this.app, this.plugin, item, this, {
                items: inlineList,
                currentIndex: tileIdx
              }).open();

            const tileActions = tile.createDiv({ cls: "mifm-inline-thumb-actions" });
            const iBtn = tileActions.createEl("button", { text: "📥 Insert", cls: "mifm-link-btn" });
            this.plugin.bindAction(iBtn, item, "insert");
            iBtn.onclick = async (e) => {
              iBtn.disabled = true;
              e.stopPropagation();
              try {
                await this.plugin.saveAndInsertImage(item);
                this.syncTargetContentAfterInsert(item.targetContext?.file);
                this.insertedSuggestionIndices.add(idx);
                this.lastActiveScannerIndex = idx;
                this.pendingScannerScrollIdx = idx;
                this.render();
              } catch (err) {
                new Notice(`Insert failed: ${safeError(err)}`);
              } finally {
                iBtn.disabled = false;
              }
            };

            const sBtn = tileActions.createEl("button", { text: "🌐", cls: "mifm-link-btn" });
            sBtn.onclick = (e) => {
              e.stopPropagation();
              const targetUrl = item.sourceUrl || item.imageUrl;
              if (openExternalUrl(targetUrl)) new Notice(`🌐 Opening source: ${item.domain || "Web"}`);
            };

            const cBtn = tileActions.createEl("button", { text: "📋", cls: "mifm-link-btn" });
            this.plugin.bindAction(cBtn, item, "copy");
            cBtn.onclick = async (e) => {
              cBtn.disabled = true;
              e.stopPropagation();
              try {
                await this.plugin.copyImageToClipboard(item);
              } catch (err) {
                new Notice(`Copy failed: ${safeError(err)}`);
              } finally {
                cBtn.disabled = false;
              }
            };
          });
        } else {
          card.createDiv({
            cls: "mifm-status",
            text: `No images found via ${this.plugin.getActiveProvider().name} for this query. Try 'Search images' with simpler keywords.`
          });
        }
      }
    });

    const scrollTargetIdx = this.pendingScannerScrollIdx;
    this.pendingScannerScrollIdx = null;
    if (scrollTargetIdx != null) {
      setTimeout(() => {
        const rootContainer = this.contentEl || this.containerEl;
        const cardEl = rootContainer ? rootContainer.querySelector(`#mifm-card-${scrollTargetIdx}`) : null;
        if (cardEl && typeof cardEl.scrollIntoView === "function") {
          cardEl.scrollIntoView({ behavior: "smooth", block: "center" });
          if (typeof cardEl.addClass === "function") {
            cardEl.addClass("mifm-highlight-pulse");
            setTimeout(() => {
              if (typeof cardEl.removeClass === "function") cardEl.removeClass("mifm-highlight-pulse");
            }, 2000);
          }
        }
      }, 50);
    }
  }
}

// -------------------------------------------------------------
// Settings Tab (Mobile-First)
// -------------------------------------------------------------

class MedicalImageFinderMobileSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Medical Image Finder Mobile Settings" });
    containerEl.createEl("p", {
      text: "Defaults to DuckDuckGo (zero API keys) on iPadOS, Android, and Desktop. Optionally add Bright Data or Brave API keys for Google/Brave image search.",
      cls: "setting-item-description"
    });

    new Setting(containerEl)
      .setName("Default Search Engine")
      .setDesc("Choose which image search engine to use by default.")
      .addDropdown((drop) => {
        drop
          .addOption("duckduckgo", "DuckDuckGo (Free / No Key)")
          .addOption("brightdata", "Bright Data Google Images (5,000 Free/Mo)")
          .addOption("brave", "Brave Search API")
          .addOption("wikimedia", "Wikimedia Commons (Free)")
          .setValue(this.plugin.settings.defaultProvider || "duckduckgo")
          .onChange(async (val) => {
            this.plugin.settings.defaultProvider = val;
            await this.plugin.saveSettings();
            this.plugin.refreshViews?.();
          });
      });

    new Setting(containerEl)
      .setName("Default Visual Mode Filter")
      .setDesc("Choose the default medical filter mode for searches.")
      .addDropdown((drop) => {
        MEDICAL_VISUAL_FILTERS.forEach((f) => drop.addOption(f.id, f.label));
        drop
          .setValue(this.plugin.settings.defaultFilterMode || "all")
          .onChange(async (val) => {
            this.plugin.settings.defaultFilterMode = val;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Attachment Folder")
      .setDesc("Vault directory where downloaded images are permanently stored.")
      .addText((text) => {
        text
          .setPlaceholder("Attachments/MedicalImages")
          .setValue(this.plugin.settings.attachmentFolder)
          .onChange(async (val) => {
            try {
              this.plugin.settings.attachmentFolder = attachmentPath(val);
              await this.plugin.saveSettings();
            } catch (err) {
              new Notice(safeError(err));
            }
          });
      });

    new Setting(containerEl)
      .setName("Default Embedded Image Width (px)")
      .setDesc("Markdown image display width (e.g. 500 for ![[image.png|500]]).")
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.defaultImageWidth))
          .onChange(async (val) => {
            const num = parseInt(val, 10);
            if (!isNaN(num) && num > 50) {
              this.plugin.settings.defaultImageWidth = num;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName("Fast Batch Preview Size")
      .setDesc("Thumbnail strip height in the Fast Batch Image Review modal (S / M / L / XL).")
      .addDropdown((drop) => {
        for (const preset of BATCH_SIZE_PRESETS) {
          drop.addOption(preset.id, `${preset.label} — ${preset.title}`);
        }
        drop
          .setValue(this.plugin.settings.batchPreviewSize || "lg")
          .onChange(async (val) => {
            this.plugin.settings.batchPreviewSize = BATCH_SIZE_PRESETS.some((p) => p.id === val) ? val : "lg";
            await this.plugin.saveSettings({ clearCache: false });
          });
      });

    new Setting(containerEl)
      .setName("Include Source Attribution Caption")
      .setDesc("Append a clean source caption link beneath non-bullet inserted images.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.includeCaption)
          .onChange(async (val) => {
            this.plugin.settings.includeCaption = val;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Max Visual Suggestions Per Scan")
      .setDesc("Number of visual suggestions generated per note scan (5–50).")
      .addDropdown((drop) => {
        drop
          .addOption("5", "5 — Quick overview")
          .addOption("10", "10 — Focused")
          .addOption("15", "15 — Standard")
          .addOption("20", "20 — Detailed")
          .addOption("25", "25 — Recommended (MBBS High-Yield)")
          .addOption("30", "30 — Extensive")
          .addOption("40", "40 — Deep Chapter Audit")
          .addOption("50", "50 — Maximum Exhaustive")
          .setValue(String(this.plugin.settings.geminiMaxSuggestions || 25))
          .onChange(async (val) => {
            this.plugin.settings.geminiMaxSuggestions = parseInt(val, 10);
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", { text: "Bright Data Google Images (5,000 Free Records/Month)" });
    containerEl.createEl("p", {
      text: "5,000 free Google Image records/month (no credit card required). Sign up at brightdata.com, set zone Data format to 'Full JSON', and enter your API token below.",
      cls: "setting-item-description"
    });

    new Setting(containerEl)
      .setName("Bright Data API Key")
      .setDesc("Enter your Bright Data API token (Bearer token).")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Bearer token or API key")
          .setValue(this.plugin.settings.brightDataApiKey || "")
          .onChange(async (val) => {
            this.plugin.settings.brightDataApiKey = val.trim();
            await this.plugin.saveSettings();
            this.plugin.refreshViews?.();
          });
      })
      .addButton((btn) => {
        btn.setButtonText("Test").onClick(async () => {
          const key = this.plugin.settings.brightDataApiKey;
          if (!key) {
            new Notice("Enter your Bright Data API key first.");
            return;
          }
          btn.setButtonText("Testing…").setDisabled(true);
          try {
            const p = new BrightDataProvider(key, this.plugin.settings.brightDataZone);
            const res = normalizeResults(await p.search("Calot triangle anatomy diagram"));
            new Notice(`✅ Bright Data connected (${res.length} images found).`, 5000);
          } catch (err) {
            new Notice(`❌ Bright Data test failed: ${safeError(err)}`, 7000);
          } finally {
            btn.setButtonText("Test").setDisabled(false);
          }
        });
      });

    new Setting(containerEl)
      .setName("Bright Data SERP Zone")
      .setDesc("Zone name configured in your Bright Data dashboard (defaults to 'serp_api1').")
      .addText((text) => {
        text
          .setPlaceholder("serp_api1")
          .setValue(this.plugin.settings.brightDataZone || "serp_api1")
          .onChange(async (val) => {
            this.plugin.settings.brightDataZone = val.trim() || "serp_api1";
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", { text: "Brave Search API (Optional)" });
    containerEl.createEl("p", {
      text: "Optional Brave Image Search API key from api-dashboard.search.brave.com.",
      cls: "setting-item-description"
    });

    new Setting(containerEl)
      .setName("Brave API Key")
      .setDesc("Enter your Brave Search API subscription token.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("BSA...")
          .setValue(this.plugin.settings.braveApiKey || "")
          .onChange(async (val) => {
            this.plugin.settings.braveApiKey = val.trim();
            await this.plugin.saveSettings();
            this.plugin.refreshViews?.();
          });
      })
      .addButton((btn) => {
        btn.setButtonText("Test").onClick(async () => {
          const key = this.plugin.settings.braveApiKey;
          if (!key) {
            new Notice("Enter your Brave API key first.");
            return;
          }
          btn.setButtonText("Testing…").setDisabled(true);
          try {
            const p = new BraveProvider(key);
            const res = normalizeResults(await p.search("Calot triangle anatomy diagram"));
            new Notice(`✅ Brave connected (${res.length} images found).`, 5000);
          } catch (err) {
            new Notice(`❌ Brave test failed: ${safeError(err)}`, 7000);
          } finally {
            btn.setButtonText("Test").setDisabled(false);
          }
        });
      });

    containerEl.createEl("h3", { text: "AI Visual Scanner (Optional Gemini API)" });
    containerEl.createEl("p", {
      text: "You can scan notes with zero API keys using 'Copy Note & Prompt for AI App' or 'Offline Scan'. Optionally add a free Gemini API key for 1-tap automated scanning inside Obsidian.",
      cls: "setting-item-description"
    });

    new Setting(containerEl)
      .setName("Default Scanner Backend")
      .setDesc("Choose what happens when running the 'Scan note' command.")
      .addDropdown((drop) => {
        drop
          .addOption("gemini", "Google Gemini API (falls back to Offline if no key)")
          .addOption("offline", "Offline Medical Rules Engine (Zero API)")
          .setValue(this.plugin.settings.aiBackend || "gemini")
          .onChange(async (val) => {
            this.plugin.settings.aiBackend = val;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Gemini API Key (Optional)")
      .setDesc("Free key from Google AI Studio (aistudio.google.com).")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("AIzaSy...")
          .setValue(this.plugin.settings.geminiApiKey)
          .onChange(async (val) => {
            this.plugin.settings.geminiApiKey = val.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Gemini Model")
      .setDesc("Model used when scanning via Gemini API.")
      .addDropdown((drop) => {
        const customModels = this.plugin.settings.geminiCustomModels;
        if (customModels && customModels.length > 0) {
          customModels.forEach((m) => drop.addOption(m.id, m.label));
        } else {
          drop
            .addOption("gemini-2.5-flash", "gemini-2.5-flash (Recommended)")
            .addOption("gemini-2.5-flash-lite", "gemini-2.5-flash-lite (Fast)")
            .addOption("gemini-2.0-flash", "gemini-2.0-flash")
            .addOption("gemini-2.5-pro", "gemini-2.5-pro (Deeper)");
        }
        drop
          .setValue(this.plugin.settings.geminiModel || "gemini-2.5-flash")
          .onChange(async (val) => {
            this.plugin.settings.geminiModel = val;
            await this.plugin.saveSettings();
          });
      })
      .addButton((btn) => {
        btn.setButtonText("Fetch models").onClick(async () => {
          const apiKey = this.plugin.settings.geminiApiKey;
          if (!apiKey) {
            new Notice("Enter your Gemini API key first.");
            return;
          }
          btn.setButtonText("Fetching…").setDisabled(true);
          try {
            const res = await requestUrl({
              url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
              headers: { "Content-Type": "application/json" }
            });
            const data = res.json;
            if (!data || !Array.isArray(data.models)) throw new Error("Unexpected API response.");
            const fetched = data.models
              .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
              .map((m) => ({ id: m.name.replace("models/", ""), label: m.displayName || m.name.replace("models/", "") }));
            if (fetched.length === 0) throw new Error("No generateContent-capable models found.");
            this.plugin.settings.geminiCustomModels = fetched;
            if (!fetched.find((m) => m.id === this.plugin.settings.geminiModel)) {
              this.plugin.settings.geminiModel = fetched[0].id;
            }
            await this.plugin.saveSettings();
            new Notice(`Loaded ${fetched.length} Gemini models.`);
            this.display();
          } catch (err) {
            new Notice(`Failed to fetch models: ${safeError(err)}`);
            btn.setButtonText("Fetch models").setDisabled(false);
          }
        });
      });
  }
}

// -------------------------------------------------------------
// Main Plugin Class (100% Mobile & Desktop Compatible)
// -------------------------------------------------------------

class MedicalImageFinderMobilePlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.disposed = false;
    this.pendingActions = new Map();
    this.inFlightSearches = new Map();
    this.writeQueue = Promise.resolve();
    this.searchCache = new SearchCache();
    this.lastSelectionText = "";
    this.lastMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!(leaf?.view instanceof MarkdownView)) return;
        const prevFile = this.lastMarkdownView?.file;
        this.lastMarkdownView = leaf.view;
        const sel = leaf.view.editor?.getSelection()?.trim();
        if (sel) this.lastSelectionText = sel;
        if (leaf.view.file !== prevFile) {
          for (const l of this.app.workspace.getLeavesOfType(VIEW_TYPE_MIFM)) {
            if (typeof l.view.updateTargetHeader === "function") l.view.updateTargetHeader();
            else l.view.render();
          }
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.getTargetView();
        for (const l of this.app.workspace.getLeavesOfType(VIEW_TYPE_MIFM)) {
          if (typeof l.view.updateTargetHeader === "function") l.view.updateTargetHeader();
          else l.view.render();
        }
      })
    );

    this._editorChangeTimer = null;
    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        if (this._editorChangeTimer) clearTimeout(this._editorChangeTimer);
        this._editorChangeTimer = setTimeout(() => {
          this._editorChangeTimer = null;
          if (this.disposed) return;
          for (const l of this.app.workspace.getLeavesOfType(VIEW_TYPE_MIFM)) {
            if (l.view.currentTab === "scan" && typeof l.view.updateScanContextStatus === "function") {
              l.view.updateScanContextStatus();
            }
          }
        }, 300);
      })
    );

    this.registerView(VIEW_TYPE_MIFM, (leaf) => new MedicalImageFinderMobileView(leaf, this));

    this.addRibbonIcon("image", "Medical Image Finder Mobile", () => {
      const active = this.app.workspace.getActiveViewOfType(MarkdownView);
      const sel = active?.editor?.getSelection()?.trim();
      if (sel) this.lastSelectionText = sel;
      this.activateView();
    });

    this.addCommand({
      id: "find-images-mobile",
      name: "Find images",
      editorCallback: (editor, view) => {
        this.triggerSearchFromEditor(editor, view);
      }
    });

    this.addCommand({
      id: "scan-note-visuals-mobile",
      name: "Scan note for visual opportunities (AI / Offline)",
      callback: () => {
        this.triggerScanFromCommand();
      }
    });

    this.addCommand({
      id: "scan-selection-mobile",
      name: "Scan selected part for visual opportunities (AI / Prompt)",
      editorCallback: (editor, view) => {
        this.triggerScopedPromptFromEditor(editor, view);
      }
    });

    this.addCommand({
      id: "open-sidebar-mobile",
      name: "Open Medical Image Finder Mobile",
      callback: () => {
        this.activateView();
      }
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        const selection = editor.getSelection().trim();
        if (selection) {
          this.lastSelectionText = selection;
          const shortText = selection.length > 30 ? selection.slice(0, 30) + "..." : selection;
          menu.addItem((item) => {
            item
              .setTitle(`Find images for "${shortText}"`)
              .setIcon("image")
              .onClick(() => {
                this.triggerSearchFromEditor(editor, view);
              });
          });
          menu.addItem((item) => {
            item
              .setTitle("📋 Scan selected part with AI")
              .setIcon("sparkles")
              .onClick(() => {
                this.triggerScopedPromptFromEditor(editor, view);
              });
          });
        }
      })
    );

    this.addSettingTab(new MedicalImageFinderMobileSettingTab(this.app, this));
  }

  onunload() {
    this.disposed = true;
    if (this._editorChangeTimer) {
      clearTimeout(this._editorChangeTimer);
      this._editorChangeTimer = null;
    }
    if (this.searchCache) this.searchCache.clear();
    if (this.inFlightSearches) this.inFlightSearches.clear();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_MIFM);
  }

  async searchWithCache(provider, query, bypassCache = false) {
    if (!query || !query.trim()) return [];
    const pId = provider.name || provider.constructor.name || "duckduckgo";
    const cacheKey = `${pId}:${query.trim().toLowerCase()}`;
    if (!bypassCache && this.searchCache) {
      const cached = this.searchCache.get(cacheKey);
      if (cached) return cached;
    }
    if (!bypassCache) {
      if (!this.inFlightSearches) this.inFlightSearches = new Map();
      const existing = this.inFlightSearches.get(cacheKey);
      if (existing) {
        const res = await existing;
        return Array.isArray(res) ? res.map((item) => ({ ...item })) : res;
      }
    }
    const run = (async () => {
      const results = await provider.search(query);
      const normalized = normalizeResults(results);
      if (!bypassCache && this.searchCache && normalized.length > 0) {
        this.searchCache.set(cacheKey, normalized);
      }
      return normalized;
    })();
    if (!bypassCache && this.inFlightSearches) {
      this.inFlightSearches.set(cacheKey, run);
    }
    try {
      const res = await run;
      return Array.isArray(res) ? res.map((item) => ({ ...item })) : res;
    } finally {
      if (!bypassCache && this.inFlightSearches) {
        this.inFlightSearches.delete(cacheKey);
      }
    }
  }

  async loadSettings() {
    this.settings = normalizeSettings(await this.loadData());
    rememberSecrets(this.settings);
  }

  async saveSettings({ clearCache = true } = {}) {
    rememberSecrets(this.settings);
    if (clearCache && this.searchCache) this.searchCache.clear();
    if (clearCache && this.inFlightSearches) this.inFlightSearches.clear();
    const snapshot = JSON.parse(JSON.stringify(this.settings));
    const pending = (this.settingsWriteQueue || Promise.resolve()).catch(() => {}).then(() => this.saveData(snapshot));
    this.settingsWriteQueue = pending;
    try {
      await pending;
    } catch (err) {
      new Notice(`Settings could not be saved: ${safeError(err)}`);
    }
  }

  refreshViews() {
    if (this.disposed) return;
    const leaves = this.app?.workspace?.getLeavesOfType?.(VIEW_TYPE_MIFM) || [];
    for (const leaf of leaves) {
      if (typeof leaf.view?.render === "function") leaf.view.render();
    }
  }

  getProvider(providerId = null) {
    const id = providerId || this.settings?.defaultProvider || "duckduckgo";
    switch (id) {
      case "brightdata":
        return new BrightDataProvider(this.settings?.brightDataApiKey, this.settings?.brightDataZone);
      case "brave":
        return new BraveProvider(this.settings?.braveApiKey);
      case "wikimedia":
        return new WikimediaProvider();
      case "duckduckgo":
      default:
        return new DuckDuckGoProvider();
    }
  }

  getActiveProvider() {
    return this.getProvider(this.settings?.defaultProvider);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_MIFM)[0];
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (!rightLeaf) throw new Error("No sidebar is available.");
      await rightLeaf.setViewState({ type: VIEW_TYPE_MIFM, active: true });
      leaf = rightLeaf;
    }
    workspace.revealLeaf(leaf);
    return leaf.view;
  }

  async triggerSearchFromEditor(editor, view) {
    this.lastMarkdownView = view;
    let query = editor.getSelection().trim();
    if (!query) {
      const cursor = editor.getCursor();
      query = cleanText(editor.getLine(cursor.line).trim());
    }
    if (!query) {
      new Notice("Select medical terminology in your note first.");
      await this.activateView();
      return;
    }
    const leafView = await this.activateView();
    if (leafView && typeof leafView.setQuery === "function") {
      leafView.clearSearchLink?.();
      leafView.setQuery(query, true);
    }
  }

  async triggerScanFromCommand() {
    const active = this.getTargetView();
    const sel = active?.editor?.getSelection?.();
    let selScope = null;
    if (sel && sel.trim() && active?.editor) {
      const from = active.editor.getCursor("from");
      const to = active.editor.getCursor("to");
      let startLine = (from?.line ?? 0) + 1;
      let endLine = (to?.line ?? startLine - 1) + 1;
      if (to && to.ch === 0 && endLine > startLine) endLine -= 1;
      if (endLine < startLine) [startLine, endLine] = [endLine, startLine];
      selScope = normalizeScanScope({ mode: "selection", startLine, endLine }, active.editor.lineCount());
    }
    const leafView = await this.activateView();
    if (leafView && typeof leafView.switchToScanTab === "function") {
      if (selScope) {
        leafView.editorSelectionScope = selScope;
        leafView.scopeMode = "selection";
        leafView._lastAutoSelectionKey = `${selScope.startLine}-${selScope.endLine}`;
      }
      leafView.switchToScanTab(true);
    }
  }

  async triggerScopedPromptFromEditor(editor, view) {
    this.lastMarkdownView = view;
    const totalLines = editor?.lineCount?.() || 1;
    let scope = null;
    const sel = editor?.getSelection?.();
    if (sel && sel.trim()) {
      const from = editor.getCursor("from");
      const to = editor.getCursor("to");
      let startLine = (from?.line ?? 0) + 1;
      let endLine = (to?.line ?? startLine - 1) + 1;
      if (to && to.ch === 0 && endLine > startLine) endLine -= 1;
      if (endLine < startLine) [startLine, endLine] = [endLine, startLine];
      scope = normalizeScanScope({ mode: "selection", startLine, endLine }, totalLines);
    } else if (editor) {
      const cursorLine = (editor.getCursor()?.line ?? 0) + 1;
      const content = editor.getValue?.() || "";
      const sections = extractNoteSections(content);
      const sec = sections.find((s) => cursorLine >= s.startLine && cursorLine <= s.endLine);
      if (sec) {
        scope = normalizeScanScope(
          { mode: "section", startLine: sec.startLine, endLine: sec.endLine, heading: sec.heading },
          totalLines
        );
      } else {
        scope = normalizeScanScope({ mode: "custom", startLine: cursorLine, endLine: cursorLine }, totalLines);
      }
    }

    const leafView = await this.activateView();
    if (leafView && typeof leafView.switchToScanTab === "function") {
      if (scope) {
        if (scope.mode === "selection") {
          leafView.editorSelectionScope = scope;
          leafView._lastAutoSelectionKey = `${scope.startLine}-${scope.endLine}`;
        } else if (scope.mode === "section") {
          leafView.selectedSectionKey = `${scope.startLine}:${scope.heading || ""}`;
        } else {
          leafView.customScopeStart = scope.startLine;
          leafView.customScopeEnd = scope.endLine;
        }
        leafView.scopeMode = scope.mode;
      }
      leafView.switchToScanTab(false);
      if (this.settings.geminiApiKey && this.settings.aiBackend !== "offline") {
        await leafView.executeNoteScan(false, scope);
      } else {
        await leafView.copyNotePromptForAiApp(scope);
      }
    }
  }

  getTargetView() {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file) {
      this.lastMarkdownView = active;
      return active;
    }
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    if (this.lastMarkdownView?.file && leaves.some((l) => l.view === this.lastMarkdownView)) {
      return this.lastMarkdownView;
    }
    for (let i = leaves.length - 1; i >= 0; i--) {
      const v = leaves[i].view;
      if (v?.file) {
        this.lastMarkdownView = v;
        return v;
      }
    }
    return null;
  }

  static extractConceptKeywords(concept, query) {
    const STOPWORDS = new Set([
      "labeled", "diagram", "diagrams", "schematic", "illustration", "radiology",
      "radiograph", "x-ray", "xray", "ct", "mri", "usg", "ultrasound", "hpe",
      "histology", "clinical", "surgical", "criteria", "scoring", "sign", "signs",
      "view", "cross-section", "normal", "abnormal", "image", "picture", "pathology",
      "features", "pattern", "overview", "comparison", "vs", "and", "the", "of",
      "in", "on", "at", "to", "for", "with", "from", "by", "an", "a", "or", "as", "is", "are",
      "if", "it", "be", "so", "no", "do", "my", "up", "we", "he", "me", "us"
    ]);
    const text = `${concept || ""} ${query || ""}`.toLowerCase();
    const words = text.match(/[a-z0-9'-]{2,}/g) || [];
    const cleaned = [];
    const seen = new Set();
    for (const w of words) {
      const clean = w.replace(/^['-]+|['-]+$/g, "");
      if (clean.length >= 2 && !STOPWORDS.has(clean) && !seen.has(clean)) {
        seen.add(clean);
        cleaned.push(clean);
      }
    }
    return cleaned;
  }

  _findPointEndInRange(editor, targetPointIdx, rangeEndIdx) {
    const pText = editor.getLine(targetPointIdx);
    const bulletMatch = pText.match(/^(\s*)([-*+]|\d+[.)])\s+/);
    if (bulletMatch) {
      const parentIndent = bulletMatch[1].length;
      let currEnd = targetPointIdx;
      for (let scan = targetPointIdx + 1; scan < rangeEndIdx; scan++) {
        const sLine = editor.getLine(scan);
        const sTrim = sLine.trim();
        if (!sTrim) {
          let nextChild = false;
          for (let la = scan + 1; la < rangeEndIdx; la++) {
            const laLine = editor.getLine(la);
            if (laLine.trim()) {
              const laBm = laLine.match(/^(\s*)([-*+]|\d+[.)])\s+/);
              if (laBm && laBm[1].length > parentIndent) nextChild = true;
              break;
            }
          }
          if (nextChild) continue;
          break;
        }
        const sBm = sLine.match(/^(\s*)([-*+]|\d+[.)])\s+/);
        if (sBm) {
          if (sBm[1].length > parentIndent) {
            currEnd = scan;
            continue;
          }
          break;
        } else {
          currEnd = scan;
        }
      }
      return { line: currEnd, ch: editor.getLine(currEnd).length };
    }

    let currEnd = targetPointIdx;
    for (let scan = targetPointIdx + 1; scan < rangeEndIdx; scan++) {
      const sTrim = editor.getLine(scan).trim();
      if (!sTrim || /^[-*+]\s+/.test(sTrim) || sTrim.startsWith("#") || /^\d+[.)]\s+/.test(sTrim)) break;
      currEnd = scan;
    }
    return { line: currEnd, ch: editor.getLine(currEnd).length };
  }

  findTopicInsertionPosition(editor, line = null, heading = null, concept = null, query = null, scope = null) {
    const lineCount = editor.lineCount();
    if (lineCount === 0) return { line: 0, ch: 0 };

    const normScope = scope ? normalizeScanScope(scope, lineCount) : null;
    const scopeStartIdx = normScope ? normScope.startLine - 1 : 0;
    const scopeEndIdx = normScope ? normScope.endLine : lineCount;

    let startLineIdx;
    if (line != null && line > 0) {
      startLineIdx = Math.max(scopeStartIdx, Math.min(line - 1, scopeEndIdx - 1));
    } else if (normScope) {
      startLineIdx = scopeStartIdx;
    } else {
      startLineIdx = editor.getCursor("to").line;
    }

    let headingIdx = null;
    let headingLevel = 0;

    const startLineText = editor.getLine(startLineIdx);
    const headingMatch = startLineText.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      headingIdx = startLineIdx;
      headingLevel = headingMatch[1].length;
    } else {
      if (heading && typeof heading === "string") {
        const cleanTarget = cleanText(heading).replace(/^[0-9]+[.)]\s*/, "").trim().toLowerCase();
        if (cleanTarget) {
          const offsets = [0];
          for (let d = 1; d <= 15; d++) offsets.push(-d, d);
          let substringMatch = null;
          for (const offset of offsets) {
            const cand = startLineIdx + offset;
            if (cand >= scopeStartIdx && cand < scopeEndIdx) {
              const m = editor.getLine(cand).match(/^(#{1,6})\s+(.*)/);
              if (m) {
                const candClean = cleanText(m[2]).replace(/^[0-9]+[.)]\s*/, "").trim().toLowerCase();
                if (!candClean) continue;
                if (candClean === cleanTarget) {
                  headingIdx = cand;
                  headingLevel = m[1].length;
                  break;
                }
                if (!substringMatch && (candClean.includes(cleanTarget) || cleanTarget.includes(candClean))) {
                  substringMatch = { cand, level: m[1].length };
                }
              }
            }
          }
          if (headingIdx === null && substringMatch) {
            headingIdx = substringMatch.cand;
            headingLevel = substringMatch.level;
          }
        }
      }

      if (headingIdx === null) {
        for (let up = startLineIdx; up >= scopeStartIdx; up--) {
          const m = editor.getLine(up).match(/^(#{1,6})\s+(.*)/);
          if (m) {
            headingIdx = up;
            headingLevel = m[1].length;
            break;
          }
        }
      }
    }

    if (headingIdx !== null) {
      const sectionStartIdx = Math.max(scopeStartIdx, headingIdx + 1);
      let sectionEndIdx = scopeEndIdx;

      for (let curr = sectionStartIdx; curr < scopeEndIdx; curr++) {
        const lineText = editor.getLine(curr);
        const trimmed = lineText.trim();
        const nextHeading = lineText.match(/^(#{1,6})\s+/);
        if (nextHeading && nextHeading[1].length <= headingLevel) {
          sectionEndIdx = curr;
          break;
        }
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
          sectionEndIdx = curr;
          break;
        }
      }

      const kw = MedicalImageFinderMobilePlugin.extractConceptKeywords(concept, query);
      let bestMatchIdx = null;
      let bestMatchScore = 0;

      if (kw.length > 0) {
        for (let cIdx = sectionStartIdx; cIdx < sectionEndIdx; cIdx++) {
          const cLower = editor.getLine(cIdx).toLowerCase();
          let score = 0;
          for (const w of kw) {
            const regex = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
            if (regex.test(cLower)) score += 3;
            else if (w.length >= 4 && cLower.includes(w)) score += 1;
          }
          if (score > 0 && line != null) {
            const dist = Math.abs(cIdx - (line - 1));
            if (dist === 0) score += 4;
            else if (dist <= 2) score += 2;
            else if (dist <= 5) score += 1;
          }
          if (
            score > bestMatchScore ||
            (score === bestMatchScore && bestMatchIdx !== null && line != null && Math.abs(cIdx - (line - 1)) < Math.abs(bestMatchIdx - (line - 1)))
          ) {
            bestMatchScore = score;
            bestMatchIdx = cIdx;
          }
        }
      }

      let targetPointIdx = null;
      if (bestMatchIdx !== null && bestMatchScore >= 2) targetPointIdx = bestMatchIdx;
      else if (line != null && line - 1 >= sectionStartIdx && line - 1 < sectionEndIdx) targetPointIdx = line - 1;

      if (targetPointIdx !== null) {
        return this._findPointEndInRange(editor, targetPointIdx, sectionEndIdx);
      }

      let lastContentIdx = headingIdx;
      for (let curr = sectionStartIdx; curr < sectionEndIdx; curr++) {
        if (editor.getLine(curr).trim().length > 0) lastContentIdx = curr;
      }
      return { line: lastContentIdx, ch: editor.getLine(lastContentIdx).length };
    }

    if (normScope) {
      const kw = MedicalImageFinderMobilePlugin.extractConceptKeywords(concept, query);
      let bestMatchIdx = null;
      let bestMatchScore = 0;
      if (kw.length > 0) {
        for (let cIdx = scopeStartIdx; cIdx < scopeEndIdx; cIdx++) {
          const cLower = editor.getLine(cIdx).toLowerCase();
          let score = 0;
          for (const w of kw) {
            const regex = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
            if (regex.test(cLower)) score += 3;
            else if (w.length >= 4 && cLower.includes(w)) score += 1;
          }
          if (score > 0 && line != null) {
            const dist = Math.abs(cIdx - (line - 1));
            if (dist === 0) score += 4;
            else if (dist <= 2) score += 2;
            else if (dist <= 5) score += 1;
          }
          if (
            score > bestMatchScore ||
            (score === bestMatchScore && bestMatchIdx !== null && line != null && Math.abs(cIdx - (line - 1)) < Math.abs(bestMatchIdx - (line - 1)))
          ) {
            bestMatchScore = score;
            bestMatchIdx = cIdx;
          }
        }
      }
      if (bestMatchIdx !== null && bestMatchScore >= 2) {
        return this._findPointEndInRange(editor, bestMatchIdx, scopeEndIdx);
      }
      if (line != null) {
        const rawTarget = Math.max(scopeStartIdx, Math.min(line - 1, scopeEndIdx - 1));
        return this._findPointEndInRange(editor, rawTarget, scopeEndIdx);
      }
      let lastContentIdx = scopeStartIdx;
      for (let curr = scopeStartIdx; curr < scopeEndIdx; curr++) {
        if (editor.getLine(curr).trim().length > 0) lastContentIdx = curr;
      }
      return { line: lastContentIdx, ch: editor.getLine(lastContentIdx).length };
    }

    if (line != null) {
      const rawTarget = Math.max(0, Math.min(line - 1, lineCount - 1));
      return { line: rawTarget, ch: editor.getLine(rawTarget).length };
    }

    const cursor = editor.getCursor("to");
    return { line: cursor.line, ch: cursor.ch };
  }

  captureTarget(context = null, line = null, heading = null, concept = null, query = null, scope = null) {
    const view = context?.view || this.getTargetView();
    if (!view?.file || !view.editor || view.file.extension !== "md") {
      throw new Error("Open a Markdown note in the editor first.");
    }
    if (context) this.validateTarget(context);
    const editor = view.editor;
    const position = this.findTopicInsertionPosition(editor, line, heading, concept, query, scope);
    return {
      view,
      editor,
      file: view.file,
      path: view.file.path,
      content: editor.getValue(),
      position
    };
  }

  validateTarget(target) {
    if (this.disposed) throw new Error("Plugin was disabled. Retry after enabling it.");
    if (
      !target ||
      !this.app.workspace.getLeavesOfType("markdown").some((leaf) => leaf.view === target.view) ||
      target.view.file !== target.file ||
      target.view.file.path !== target.path ||
      this.app.vault.getAbstractFileByPath(target.path) !== target.file ||
      target.view.editor !== target.editor ||
      (target.content !== undefined && target.editor.getValue() !== target.content)
    ) {
      throw new Error("The target note was changed or closed.");
    }
  }

  bindAction(button, item, kind) {
    const key = this.actionKey(item, kind);
    button.disabled = this.pendingActions?.has(key) || false;
  }

  actionKey(item, kind) {
    return `${kind}:${item.imageUrl || item.thumbnailUrl}`;
  }

  async runAction(item, kind, action) {
    const key = this.actionKey(item, kind);
    if (this.pendingActions.has(key)) return this.pendingActions.get(key);
    const pending = Promise.resolve().then(action);
    this.pendingActions.set(key, pending);
    try {
      return await pending;
    } finally {
      this.pendingActions.delete(key);
      if (!this.disposed) {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MIFM)) leaf.view.render();
      }
    }
  }

  /** Convert any browser-decodable image Uint8Array (e.g. SVG, AVIF) to a PNG Blob via Canvas. */
  async decodeToPngBlob(bytes) {
    if (typeof document === "undefined" || typeof Image === "undefined" || typeof URL === "undefined") {
      throw new Error("Canvas image decoding is unavailable in this environment.");
    }
    return new Promise((resolve, reject) => {
      const head = bytesToAscii(bytes, 0, 128).trimStart();
      const isSvg = /^<\?xml/i.test(head) || /^<svg\b/i.test(head);
      const blob = isSvg ? new Blob([u8ToArrayBuffer(bytes)], { type: "image/svg+xml" }) : new Blob([u8ToArrayBuffer(bytes)]);
      const blobUrl = URL.createObjectURL(blob);
      const img = new Image();
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        img.onload = img.onerror = null;
        URL.revokeObjectURL(blobUrl);
        error ? reject(error) : resolve(result);
      };
      const timer = setTimeout(() => finish(new Error("Image decoding timed out.")), 15000);
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth || img.width;
          canvas.height = img.naturalHeight || img.height;
          const ctx = canvas.getContext("2d");
          if (!ctx || !canvas.width || !canvas.height) throw new Error("Image has no drawable pixels.");
          ctx.drawImage(img, 0, 0);
          canvas.toBlob(
            (outBlob) => (outBlob ? finish(null, outBlob) : finish(new Error("PNG conversion failed."))),
            "image/png"
          );
        } catch (err) {
          finish(err);
        }
      };
      img.onerror = () => finish(new Error("Image decoding failed."));
      img.src = blobUrl;
    });
  }

  async downloadImage(item) {
    let lastError = new Error("No valid image URL.");
    const candidates = [];
    for (const u of [item?.imageUrl, item?.thumbnailUrl]) {
      if (typeof u === "string") {
        const h = httpUrl(u);
        if (h && !candidates.includes(h)) candidates.push(h);
        else if (u.startsWith("data:image/") && !candidates.includes(u)) candidates.push(u);
      }
    }
    for (const url of candidates) {
      try {
        let bytes;
        if (url.startsWith("data:image/")) {
          const commaIdx = url.indexOf(",");
          if (commaIdx === -1) throw new Error("Invalid data URI.");
          const meta = url.slice(0, commaIdx);
          const payload = url.slice(commaIdx + 1);
          bytes = /;base64/i.test(meta)
            ? base64ToUint8Array(payload)
            : utf8ToUint8Array(decodeURIComponent(payload));
        } else {
          const ab = await fetchBinary(url);
          bytes = new Uint8Array(ab);
        }
        const prefix = bytesToAscii(bytes, 0, 512).trimStart();
        if (!bytes.length || /^(?:<!doctype\s+html|<html|<head|<body)/i.test(prefix)) {
          throw new Error("The server returned a webpage instead of an image.");
        }
        const ext = imageExtension(bytes);
        if (ext) {
          return { bytes, ext };
        }
        // Fallback for SVG/AVIF/BMP: convert via Canvas to PNG
        const pngBlob = await this.decodeToPngBlob(bytes);
        const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
        return { bytes: pngBytes, ext: "png" };
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`Unable to load image: ${safeError(lastError)}`);
  }

  async copyImageToClipboard(item) {
    return this.runAction(item, "copy", async () => {
      if (typeof navigator === "undefined" || !navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        new Notice("Clipboard image copy isn't supported on this mobile OS — tap '📥 Insert in note' instead.", 6000);
        return false;
      }

      // On iPadOS/Safari WebKit, passing a Promise<Blob> keeps clipboard.write() inside the user gesture!
      const pngBlobPromise = (async () => {
        const image = await this.downloadImage(item);
        if (this.disposed) throw new Error("Plugin was disabled.");
        if (image.ext === "png") return new Blob([u8ToArrayBuffer(image.bytes)], { type: "image/png" });
        return await this.decodeToPngBlob(image.bytes);
      })();

      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlobPromise })]);
        new Notice("Image copied to clipboard!", 4000);
        return true;
      } catch (_) {
        try {
          const resolvedBlob = await pngBlobPromise;
          await navigator.clipboard.write([new ClipboardItem({ "image/png": resolvedBlob })]);
          new Notice("Image copied to clipboard!", 4000);
          return true;
        } catch (err) {
          if (Platform?.isMobile) {
            new Notice("Mobile WebView blocked image clipboard write — tap '📥 Insert in note' instead.", 6000);
            return false;
          }
          throw err;
        }
      }
    });
  }

  generateImageMarkdown(editor, pos, fullPath, width, includeCaption = false, item = null) {
    const lineIndex = Math.max(0, Math.min(pos ? pos.line : 0, (editor ? editor.lineCount() : 1) - 1));
    const targetLine = editor ? editor.getLine(lineIndex) || "" : "";

    const bulletMatch = targetLine.match(/^(\s*)([-*+]|\d+[.)])\s+/);
    if (bulletMatch) {
      const leadingExpanded = bulletMatch[1].replace(/\t/g, "    ");
      const prefixLen = bulletMatch[0].length - bulletMatch[1].length;
      const indent = " ".repeat(leadingExpanded.length + prefixLen);
      return `\n${indent}![[${fullPath}|${width}]]`;
    }

    const indentMatch = targetLine.match(/^(\s+)/);
    if (indentMatch && indentMatch[1].length > 0) {
      const indent = indentMatch[1].replace(/\t/g, "    ");
      return `\n${indent}![[${fullPath}|${width}]]`;
    }

    let md = targetLine.trim() === "" ? `![[${fullPath}|${width}]]\n` : `\n\n![[${fullPath}|${width}]]\n`;
    if (includeCaption && item) {
      const url = httpUrl(item.sourceUrl).replace(/>/g, "%3E").replace(/</g, "%3C");
      const source = url ? `[${markdownText(item.domain || "Source")}](<${url}>)` : markdownText(item.domain);
      md += `*${markdownText(cleanText(item.title) || "Medical reference")}*${source ? ` — ${source}` : ""}\n`;
    }
    return md;
  }

  async writeImageAttachment(folderPath, item, image, target = null) {
    const hash = (await sha256Hex(image.bytes)).slice(0, 16);
    const fileName = `${safeFileName(item.title)}-${hash}.${image.ext}`;
    const fullPath = `${folderPath}/${fileName}`;
    const existing = this.app.vault.getAbstractFileByPath(fullPath);
    if (existing && !(existing instanceof TFile)) {
      throw new Error("An attachment folder conflicts with the image filename.");
    }
    if (!existing) {
      try {
        await this.app.vault.createBinary(fullPath, u8ToArrayBuffer(image.bytes));
      } catch (err) {
        const concurrent = this.app.vault.getAbstractFileByPath(fullPath);
        if (!(concurrent instanceof TFile)) throw err;
        const stored = new Uint8Array(await this.app.vault.readBinary(concurrent));
        if (!bytesEqual(stored, image.bytes)) throw new Error("Attachment conflict; existing file was preserved.");
      }
    } else {
      const stored = new Uint8Array(await this.app.vault.readBinary(existing));
      if (!bytesEqual(stored, image.bytes)) throw new Error("Attachment conflict; existing file was preserved.");
    }
    if (target) this.validateTarget(target);
    return { fileName, fullPath };
  }

  async saveAndInsertImage(item) {
    const target = this.captureTarget(
      item.targetContext,
      item.targetLine,
      item.targetHeading,
      item.targetConcept || item.visualConcept,
      item.targetQuery || item.recommendedQuery,
      item.targetScope || null
    );
    if (item.targetLine != null) target.position.ch = target.editor.getLine(target.position.line).length;
    const folderPath = attachmentPath(this.settings.attachmentFolder);
    const width = this.settings.defaultImageWidth;
    const includeCaption = this.settings.includeCaption;

    return this.runAction(item, "insert", async () => {
      const image = await this.downloadImage(item);
      const save = async () => {
        this.validateTarget(target);
        await this.ensureFolder(folderPath);
        this.validateTarget(target);
        const { fileName, fullPath } = await this.writeImageAttachment(folderPath, item, image, target);
        const markdown = this.generateImageMarkdown(target.editor, target.position, fullPath, width, includeCaption, item);
        target.editor.replaceRange(markdown, target.position);
        new Notice(`Saved ${fileName} and inserted into ${target.file.basename}.`, 5000);
      };
      const pending = this.writeQueue.then(save);
      this.writeQueue = pending.catch(() => {});
      return pending;
    });
  }

  async batchInsertImages(jobs, onProgress = null) {
    if (!Array.isArray(jobs) || jobs.length === 0) {
      return { insertedCount: 0, successfulIndices: new Set(), failedIndices: new Set() };
    }
    const runBatch = async () => {
      const firstContext = jobs[0].imageItem?.targetContext;
      const target = this.captureTarget(firstContext);
      this.validateTarget(target);
      const editor = target.editor;

      const folderPath = attachmentPath(this.settings.attachmentFolder);
      const width = this.settings.defaultImageWidth;
      const includeCaption = this.settings.includeCaption;

      const plannedJobs = jobs.map((job) => ({
        ...job,
        pos: this.findTopicInsertionPosition(
          editor,
          job.targetLine,
          job.targetHeading,
          job.targetConcept,
          job.targetQuery,
          job.targetScope || job.imageItem?.targetScope || null
        )
      }));

      plannedJobs.sort(
        (a, b) => (b.pos.line - a.pos.line) || (b.suggestionIndex - a.suggestionIndex) || ((b.subIndex || 0) - (a.subIndex || 0))
      );

      const downloadedMap = new Map();
      const batchUrlDownloads = new Map();
      let nextDl = 0;
      let completedCount = 0;
      const dlWorkers = [];
      const dlConcurrency = Math.min(3, plannedJobs.length);
      for (let w = 0; w < dlConcurrency; w++) {
        dlWorkers.push(
          (async () => {
            while (true) {
              const idx = nextDl++;
              if (idx >= plannedJobs.length) break;
              const job = plannedJobs[idx];
              const urlKey = `${job.imageItem?.imageUrl || ""}|${job.imageItem?.thumbnailUrl || ""}`;
              try {
                let dlPromise = batchUrlDownloads.get(urlKey);
                if (!dlPromise) {
                  dlPromise = this.downloadImage(job.imageItem);
                  batchUrlDownloads.set(urlKey, dlPromise);
                }
                const image = await dlPromise;
                downloadedMap.set(idx, image);
              } catch (err) {
                console.error(`Failed to download batch image for ${job.targetConcept}:`, err);
              }
              completedCount++;
              if (onProgress) onProgress(completedCount, plannedJobs.length);
            }
          })()
        );
      }
      await Promise.all(dlWorkers);

      this.validateTarget(target);

      if (downloadedMap.size > 0) await this.ensureFolder(folderPath);
      let insertedCount = 0;
      const successfulIndices = new Set();
      const failedIndices = new Set();

      for (let i = 0; i < plannedJobs.length; i++) {
        const job = plannedJobs[i];
        const image = downloadedMap.get(i);
        if (!image) {
          if (job.suggestionIndex != null) failedIndices.add(job.suggestionIndex);
          continue;
        }
        try {
          const item = job.imageItem;
          this.validateTarget(target);
          const { fullPath } = await this.writeImageAttachment(folderPath, item, image, target);
          const markdown = this.generateImageMarkdown(editor, job.pos, fullPath, width, includeCaption, item);
          editor.replaceRange(markdown, job.pos);
          target.content = editor.getValue();
          insertedCount++;
          if (job.suggestionIndex != null) successfulIndices.add(job.suggestionIndex);
        } catch (err) {
          if (job.suggestionIndex != null) failedIndices.add(job.suggestionIndex);
          console.error(`Failed to batch insert image for ${job.targetConcept}:`, err);
        }
      }

      if (insertedCount === 0 && jobs.length > 0) {
        throw new Error(`Failed to insert any images into ${target.file.basename}. Check image sources or attachment folder.`);
      } else if (failedIndices.size > 0) {
        const failedJobsCount = jobs.length - insertedCount;
        new Notice(`⚠️ Inserted ${insertedCount} of ${jobs.length} images into ${target.file.basename} (${failedJobsCount} failed).`, 6000);
      } else {
        new Notice(`✅ Successfully inserted ${insertedCount} images into ${target.file.basename}!`, 6000);
      }
      return { insertedCount, successfulIndices, failedIndices };
    };
    const pending = (this.writeQueue || Promise.resolve()).then(runBatch);
    this.writeQueue = pending.catch(() => {});
    return pending;
  }

  async ensureFolder(folderPath) {
    let current = "";
    for (const part of attachmentPath(folderPath).split("/")) {
      current = current ? `${current}/${part}` : part;
      let file = this.app.vault.getAbstractFileByPath(current);
      if (!file) {
        try {
          await this.app.vault.createFolder(current);
        } catch (err) {
          file = this.app.vault.getAbstractFileByPath(current);
          if (!file || file instanceof TFile) throw err;
        }
      } else if (file instanceof TFile) {
        throw new Error(`A file blocks the attachment folder: ${current}`);
      }
    }
  }
}

MedicalImageFinderMobilePlugin._internals = {
  DEFAULT_SETTINGS,
  BATCH_SIZE_PRESETS,
  SEARCH_PROVIDERS,
  MEDICAL_VISUAL_FILTERS,
  base64ToUint8Array,
  utf8ToUint8Array,
  bytesToAscii,
  bytesEqual,
  u8ToArrayBuffer,
  pureJsSha256Hex,
  sha256Hex,
  imageExtension,
  bindImageFallback,
  syncDimensionBadge,
  bindHighResPreview,
  extractNoteSections,
  findEnclosingHeading,
  normalizeScanScope,
  prepareScopedLines,
  normalizeSettings,
  normalizeResults,
  attachmentPath,
  safeFileName,
  cleanText,
  httpUrl,
  safeError,
  SearchCache,
  DuckDuckGoProvider,
  WikimediaProvider,
  BraveProvider,
  BrightDataProvider,
  OfflineMedicalScanner,
  GeminiScannerService,
  AiResponseImportModal,
  ImagePreviewModal,
  BatchImageReviewModal,
  MedicalImageFinderMobileView,
  MedicalImageFinderMobileSettingTab
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = MedicalImageFinderMobilePlugin;
}

/* nosourcemap */