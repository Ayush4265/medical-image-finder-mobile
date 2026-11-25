"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const nodeCrypto = require("node:crypto");
const Module = require("node:module");

const PLUGIN_DIR = path.resolve(__dirname, "..");

function loadPluginWithMock(requestUrlMock = async () => ({ text: "", json: {}, arrayBuffer: new ArrayBuffer(0) })) {
  const originalLoad = Module._load;
  const notices = [];
  class MockPlugin {
    constructor(app, manifest) { this.app = app; this.manifest = manifest; }
    addCommand() {}
    addRibbonIcon() {}
    addSettingTab() {}
    registerEvent() {}
    registerView() {}
    async loadData() { return {}; }
    async saveData() {}
  }
  class MockItemView { constructor(leaf) { this.leaf = leaf; this.contentEl = {}; } }
  class MockModal { constructor(app) { this.app = app; this.contentEl = {}; this.titleEl = { setText() {} }; } open() {} close() {} }
  class MockSetting { setName() { return this; } setDesc() { return this; } addText() { return this; } addDropdown() { return this; } addToggle() { return this; } addButton() { return this; } }
  class MockSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
  class MockTFile {}
  class MockMarkdownView {}
  class MockNotice { constructor(msg) { notices.push(msg); } }

  Module._load = function (request, parent, isMain) {
    if (request === "obsidian") {
      return {
        Plugin: MockPlugin,
        ItemView: MockItemView,
        Modal: MockModal,
        Notice: MockNotice,
        Setting: MockSetting,
        PluginSettingTab: MockSettingTab,
        normalizePath: (p) => String(p || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, ""),
        TFile: MockTFile,
        MarkdownView: MockMarkdownView,
        Platform: { isMobile: true, isIosApp: true, isAndroidApp: false },
        requestUrl: requestUrlMock
      };
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    const mainPath = path.join(PLUGIN_DIR, "main.js");
    delete require.cache[require.resolve(mainPath)];
    const PluginClass = require(mainPath);
    return { PluginClass, notices, MockTFile, MockMarkdownView };
  } finally {
    Module._load = originalLoad;
  }
}

test("manifest.json declares mobile compatibility (isDesktopOnly: false)", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "manifest.json"), "utf8"));
  assert.equal(manifest.id, "medical-image-finder-mobile");
  assert.equal(manifest.isDesktopOnly, false);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.minAppVersion);
});

test("styles.css avoids !important and :has() for Obsidian CSS lint compliance", () => {
  const css = fs.readFileSync(path.join(PLUGIN_DIR, "styles.css"), "utf8");
  assert.doesNotMatch(css, /!important/i);
  assert.doesNotMatch(css, /:has\s*\(/i);
});

test("main.js has zero Node.js, Electron, Buffer, or desktop-only polling dependencies", () => {
  const src = fs.readFileSync(path.join(PLUGIN_DIR, "main.js"), "utf8");
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(codeOnly, /require\s*\(\s*["']electron["']\s*\)/);
  assert.doesNotMatch(codeOnly, /require\s*\(\s*["']node:/);
  assert.doesNotMatch(codeOnly, /require\s*\(\s*["'](?:fs|path|os|crypto|child_process)["']\s*\)/);
  assert.doesNotMatch(codeOnly, /\bBuffer\b/);
  assert.doesNotMatch(codeOnly, /\bondblclick\b/);
  assert.doesNotMatch(codeOnly, /startClipboardWatcher/);
});

test("pureJsSha256Hex matches Node crypto SHA-256 across empty, short, and multi-block inputs", async () => {
  const { PluginClass } = loadPluginWithMock();
  const { pureJsSha256Hex, sha256Hex } = PluginClass._internals;

  const samples = [
    new Uint8Array(0),
    new TextEncoder().encode("abc"),
    new TextEncoder().encode("The quick brown fox jumps over the lazy dog".repeat(5)),
    Uint8Array.from({ length: 256 }, (_, i) => i)
  ];

  for (const sample of samples) {
    const expected = nodeCrypto.createHash("sha256").update(sample).digest("hex");
    assert.equal(pureJsSha256Hex(sample), expected);
    assert.equal(await sha256Hex(sample), expected);
  }
});

test("imageExtension and binary helpers work cleanly on Uint8Array", () => {
  const { PluginClass } = loadPluginWithMock();
  const { imageExtension, base64ToUint8Array, bytesEqual, u8ToArrayBuffer } = PluginClass._internals;

  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
  const jpg = new Uint8Array([255, 216, 255, 224]);
  const gif = new TextEncoder().encode("GIF89a...");
  const webp = new TextEncoder().encode("RIFF1234WEBP");
  const html = new TextEncoder().encode("<!doctype html><html></html>");

  assert.equal(imageExtension(png), "png");
  assert.equal(imageExtension(jpg), "jpg");
  assert.equal(imageExtension(gif), "gif");
  assert.equal(imageExtension(webp), "webp");
  assert.equal(imageExtension(html), null);

  const decoded = base64ToUint8Array(Buffer.from(png).toString("base64"));
  assert.ok(bytesEqual(decoded, png));
  assert.equal(bytesEqual(decoded, jpg), false);
  const ab = u8ToArrayBuffer(decoded);
  assert.ok(ab instanceof ArrayBuffer);
  assert.equal(ab.byteLength, png.length);
});

test("normalizeSettings enforces mobile defaults with DuckDuckGo default plus Bright Data and Brave support", () => {
  const { PluginClass } = loadPluginWithMock();
  const { normalizeSettings } = PluginClass._internals;

  const s = normalizeSettings({
    defaultProvider: "serpapi",
    defaultFilterMode: "invalid",
    aiBackend: "groq",
    geminiMaxSuggestions: 99,
    defaultImageWidth: 10,
    attachmentFolder: "/abs/bad",
    brightDataApiKey: "  bd_test_key  ",
    brightDataZone: "   ",
    braveApiKey: "  BSA_test_key  "
  });

  assert.equal(s.defaultProvider, "duckduckgo");
  assert.equal(s.defaultFilterMode, "all");
  assert.equal(s.aiBackend, "gemini");
  assert.equal(s.geminiMaxSuggestions, 25);
  assert.equal(s.defaultImageWidth, 500);
  assert.equal(s.attachmentFolder, "Attachments/MedicalImages");
  assert.equal(s.brightDataApiKey, "bd_test_key");
  assert.equal(s.brightDataZone, "serp_api1");
  assert.equal(s.braveApiKey, "BSA_test_key");
  assert.equal("serpApiKey" in s, false);
  assert.equal("googleApiKey" in s, false);

  assert.equal(normalizeSettings({ defaultProvider: "brightdata" }).defaultProvider, "brightdata");
  assert.equal(normalizeSettings({ defaultProvider: "brave" }).defaultProvider, "brave");
  assert.equal(normalizeSettings({ defaultProvider: "wikimedia" }).defaultProvider, "wikimedia");
});
