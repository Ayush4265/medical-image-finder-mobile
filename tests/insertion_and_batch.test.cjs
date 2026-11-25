"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const PLUGIN_DIR = path.resolve(__dirname, "..");

function createMockEditor(initialLines) {
  let lines = [...initialLines];
  let cursor = { line: 0, ch: 0 };
  return {
    lineCount: () => lines.length,
    getLine: (idx) => lines[idx] ?? "",
    getValue: () => lines.join("\n"),
    getSelection: () => "",
    getCursor: () => cursor,
    setCursor: (pos) => { cursor = { ...pos }; },
    replaceRange(text, from, to = from) {
      const full = lines.join("\n");
      const offsetAt = (pos) => {
        let off = 0;
        for (let i = 0; i < pos.line; i++) off += lines[i].length + 1;
        return off + Math.min(pos.ch, (lines[pos.line] || "").length);
      };
      const start = offsetAt(from);
      const end = offsetAt(to);
      const updated = full.slice(0, start) + text + full.slice(end);
      lines = updated.split("\n");
    }
  };
}

function setupPlugin(initialLines, requestUrlMock) {
  const originalLoad = Module._load;
  const notices = [];
  const files = new Map();
  const folders = new Set();

  class MockTFile {
    constructor(p) { this.path = p; this.basename = path.basename(p, ".md"); this.extension = "md"; }
  }
  class MockMarkdownView {}
  class MockPlugin {
    constructor(app, manifest) { this.app = app; this.manifest = manifest; }
  }
  class MockItemView {}
  class MockModal {}
  class MockSetting {}
  class MockSettingTab {}
  class MockNotice { constructor(msg) { notices.push(msg); } }

  Module._load = function (request) {
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
        Platform: { isMobile: true, isIosApp: false, isAndroidApp: true },
        requestUrl: requestUrlMock
      };
    }
    return originalLoad.apply(this, arguments);
  };

  let PluginClass;
  try {
    const mainPath = path.join(PLUGIN_DIR, "main.js");
    delete require.cache[require.resolve(mainPath)];
    PluginClass = require(mainPath);
  } finally {
    Module._load = originalLoad;
  }

  const editor = createMockEditor(initialLines);
  const noteFile = new MockTFile("Surgery/Pancreas.md");
  const view = { file: noteFile, editor, leaf: {} };
  const markdownLeaf = { view };

  const app = {
    workspace: {
      getActiveViewOfType: () => view,
      getLeavesOfType: (type) => (type === "markdown" ? [markdownLeaf] : [])
    },
    vault: {
      getAbstractFileByPath(p) {
        if (p === noteFile.path) return noteFile;
        if (files.has(p)) return files.get(p).file;
        if (folders.has(p)) return { path: p };
        return null;
      },
      async createFolder(p) { folders.add(p); },
      async createBinary(p, ab) {
        files.set(p, { file: new MockTFile(p), bytes: new Uint8Array(ab) });
      },
      async readBinary(fileObj) {
        return files.get(fileObj.path).bytes.buffer;
      }
    }
  };

  const plugin = new PluginClass(app, { id: "medical-image-finder-mobile" });
  plugin.settings = PluginClass._internals.normalizeSettings({});
  plugin.disposed = false;
  plugin.pendingActions = new Map();
  plugin.writeQueue = Promise.resolve();
  plugin.lastMarkdownView = view;

  return { plugin, editor, view, files, notices };
}

test("findTopicInsertionPosition + generateImageMarkdown indent cleanly under target bullets", () => {
  const note = [
    "### B. Annular Pancreas",
    "- **Embryology:** Ventral bud fails to rotate.",
    "- **Radiology:** Double-bubble sign on abdominal X-ray.",
    "  - Absent distal bowel gas.",
    "- **Treatment:** Duodenoduodenostomy."
  ];
  const { plugin, editor } = setupPlugin(note, async () => ({}));

  const pos = plugin.findTopicInsertionPosition(editor, 3, "B. Annular Pancreas", "Double-bubble sign", "Double bubble sign X ray");
  assert.equal(pos.line, 3); // Includes child bullet line 3 ("  - Absent distal bowel gas.")
  const md = plugin.generateImageMarkdown(editor, pos, "Attachments/MedicalImages/double-bubble.png", 500, true, { title: "X" });
  assert.equal(md, "\n    ![[Attachments/MedicalImages/double-bubble.png|500]]");
});

test("batchInsertImages inserts bottom-to-top without line drift and deduplicates identical images", async () => {
  const note = [
    "## Section One",
    "- Point A: Calot triangle boundaries.",
    "## Section Two",
    "- Point B: Triangle of Doom vessels.",
    "- Point C: Next bullet."
  ];
  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  const { plugin, editor, view, files } = setupPlugin(note, async () => ({
    arrayBuffer: pngBytes.buffer.slice(0)
  }));

  const ctx = plugin.captureTarget();
  const jobs = [
    {
      suggestionIndex: 0,
      targetLine: 2,
      targetHeading: "Section One",
      targetConcept: "Calot triangle",
      targetQuery: "Calot triangle diagram",
      imageItem: {
        title: "Calot Diagram",
        imageUrl: "https://example.org/calot.png",
        thumbnailUrl: "https://example.org/calot.png",
        targetContext: ctx
      }
    },
    {
      suggestionIndex: 1,
      targetLine: 4,
      targetHeading: "Section Two",
      targetConcept: "Triangle of Doom",
      targetQuery: "Triangle of Doom diagram",
      imageItem: {
        title: "Calot Diagram", // Same bytes + same title tests dedup reuse!
        imageUrl: "https://example.org/calot.png",
        thumbnailUrl: "https://example.org/calot.png",
        targetContext: ctx
      }
    }
  ];

  const result = await plugin.batchInsertImages(jobs);
  assert.equal(result.insertedCount, 2);
  assert.equal(files.size, 1);

  const finalText = editor.getValue();
  const lines = finalText.split("\n");
  assert.ok(lines[2].startsWith("  ![[Attachments/MedicalImages/Calot-Diagram-"));
  assert.ok(lines[5].startsWith("  ![[Attachments/MedicalImages/Calot-Diagram-"));
  assert.equal(lines[6], "- Point C: Next bullet.");
});

test("copyImageToClipboard fails gracefully on mobile WebView without ClipboardItem", async () => {
  const { plugin, notices } = setupPlugin(["# Test"], async () => ({}));
  const ok = await plugin.copyImageToClipboard({ imageUrl: "https://example.org/test.png" });
  assert.equal(ok, false);
  assert.ok(notices.some((m) => m.includes("Insert in note")));
});
