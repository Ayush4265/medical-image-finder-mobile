"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const PLUGIN_DIR = path.resolve(__dirname, "..");

function createMockElement(tagName = "div", doc = null) {
  const listeners = {};
  const attrs = {};
  const el = {
    tagName: String(tagName).toUpperCase(),
    id: "",
    className: "",
    textContent: "",
    value: "",
    type: "",
    disabled: false,
    checked: false,
    title: "",
    style: {},
    dataset: {},
    children: [],
    parentElement: null,
    naturalWidth: 0,
    naturalHeight: 0,
    ownerDocument: doc,
    get src() {
      return attrs.src || "";
    },
    set src(val) {
      attrs.src = val;
    },
    get onclick() {
      return el._onclick || null;
    },
    set onclick(fn) {
      el._onclick = fn;
    },
    addClass(...cls) {
      const set = new Set(el.className.split(/\s+/).filter(Boolean));
      for (const c of cls) {
        for (const part of String(c || "").split(/\s+/).filter(Boolean)) set.add(part);
      }
      el.className = Array.from(set).join(" ");
    },
    removeClass(...cls) {
      const drop = new Set(cls.flatMap((c) => String(c || "").split(/\s+/).filter(Boolean)));
      el.className = el.className.split(/\s+/).filter((c) => c && !drop.has(c)).join(" ");
    },
    toggleClass(cls, force) {
      const has = el.hasClass(cls);
      const next = force === undefined ? !has : !!force;
      if (next) el.addClass(cls);
      else el.removeClass(cls);
    },
    hasClass(cls) {
      return el.className.split(/\s+/).filter(Boolean).includes(cls);
    },
    setText(t) {
      el.textContent = String(t ?? "");
    },
    empty() {
      el.children = [];
      el.textContent = "";
    },
    setAttribute(k, v) {
      attrs[k] = String(v);
    },
    getAttribute(k) {
      return attrs[k];
    },
    addEventListener(type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    dispatchEvent(evt) {
      for (const fn of listeners[evt.type] || []) fn(evt);
    },
    appendChild(child) {
      child.parentElement = el;
      el.children.push(child);
      return child;
    },
    createEl(tag, opts = {}) {
      const child = createMockElement(tag, el.ownerDocument);
      if (opts.cls) child.addClass(opts.cls);
      if (opts.text != null) child.setText(opts.text);
      if (opts.type) child.type = opts.type;
      if (opts.value != null) child.value = String(opts.value);
      if (opts.placeholder) attrs.placeholder = opts.placeholder;
      if (opts.attr) {
        for (const [k, v] of Object.entries(opts.attr)) child.setAttribute(k, v);
      }
      el.appendChild(child);
      return child;
    },
    createDiv(opts = {}) {
      return el.createEl("div", opts);
    },
    createSpan(opts = {}) {
      return el.createEl("span", opts);
    },
    findAll(pred) {
      const out = [];
      for (const c of el.children) {
        if (pred(c)) out.push(c);
        out.push(...c.findAll(pred));
      }
      return out;
    },
    querySelector(selector) {
      return el.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      if (selector.startsWith(".")) {
        const cls = selector.slice(1);
        return el.findAll((c) => c.hasClass(cls));
      }
      if (selector.startsWith("#")) {
        const id = selector.slice(1);
        return el.findAll((c) => c.id === id);
      }
      return [];
    },
    closest() {
      return null;
    },
    scrollIntoView() {}
  };
  return el;
}

function createMockDocument() {
  const listeners = {};
  const doc = {
    activeElement: null,
    addEventListener(type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    dispatchKeydown(key, opts = {}) {
      let prevented = false;
      const evt = {
        type: "keydown",
        key,
        preventDefault() {
          prevented = true;
        },
        target: opts.target || { tagName: "DIV", isContentEditable: false },
        get defaultPrevented() {
          return prevented;
        }
      };
      for (const fn of [...(listeners.keydown || [])]) fn(evt);
      return evt;
    },
    createElement(tag) {
      return createMockElement(tag, doc);
    }
  };
  return doc;
}

function loadEnv(requestUrlMock = async () => ({ status: 200, text: "", json: {} })) {
  const originalLoad = Module._load;
  const notices = [];
  const doc = createMockDocument();

  class MockTFile {
    constructor(p) {
      this.path = p;
      this.basename = path.basename(p, ".md");
      this.extension = "md";
    }
  }
  class MockMarkdownView {}
  class MockPlugin {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
    }
    addCommand() {}
    addRibbonIcon() {}
    addSettingTab() {}
    registerEvent() {}
    registerView() {}
    async loadData() {
      return {};
    }
    async saveData() {}
  }
  class MockItemView {
    constructor(leaf) {
      this.leaf = leaf;
      this.contentEl = createMockElement("div", doc);
    }
  }
  class MockModal {
    constructor(app) {
      this.app = app;
      this.modalEl = createMockElement("div", doc);
      this.contentEl = createMockElement("div", doc);
      this.titleEl = createMockElement("div", doc);
    }
    open() {
      return this.onOpen?.();
    }
    close() {
      return this.onClose?.();
    }
  }
  class MockSetting {
    setName() { return this; }
    setDesc() { return this; }
    addText() { return this; }
    addDropdown() { return this; }
    addToggle() { return this; }
    addButton() { return this; }
  }
  class MockSettingTab {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
    }
  }
  class MockNotice {
    constructor(msg) {
      notices.push(msg);
    }
  }

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
        Platform: { isMobile: true, isIosApp: true },
        requestUrl: requestUrlMock
      };
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    const mainPath = path.join(PLUGIN_DIR, "main.js");
    delete require.cache[require.resolve(mainPath)];
    const PluginClass = require(mainPath);
    return { PluginClass, notices, MockTFile, doc };
  } finally {
    Module._load = originalLoad;
  }
}

test("BrightDataProvider uses udm=2, retries without parsed_light on 400/empty, filters hidden/blurred, and separates original dimensions", async () => {
  const requests = [];
  const { PluginClass } = loadEnv(async (opts) => {
    const body = JSON.parse(opts.body);
    requests.push(body);
    if (body.data_format === "parsed_light") {
      return { status: 400, json: { error: "light json disabled" }, text: "light json disabled" };
    }
    return {
      status: 200,
      json: {
        images: [
          {
            title: "Blurred low-res",
            original_image: "https://example.org/hidden.jpg",
            thumbnail: "https://encrypted-tbn0.gstatic.com/1",
            image_width: 150,
            image_height: 150,
            is_hidden: true
          },
          {
            title: "Tiny thumb",
            link: "https://example.org/tiny-thumb.jpg",
            thumbnail: "https://encrypted-tbn0.gstatic.com/tiny",
            image_width: 120,
            image_height: 90
          },
          {
            title: "Separate high-res diagram",
            original_image: "https://upload.wikimedia.org/calot-triangle-hd.png",
            thumbnail: "https://encrypted-tbn0.gstatic.com/calot",
            image_width: 180,
            image_height: 120,
            source: "https://commons.wikimedia.org/wiki/File:Calot.png"
          }
        ]
      }
    };
  });

  const { BrightDataProvider } = PluginClass._internals;
  const provider = new BrightDataProvider("bd_secret_1234567890", "serp_api1");
  const results = await provider.search("Calot triangle");

  assert.equal(requests.length, 2);
  assert.equal(requests[0].data_format, "parsed_light");
  assert.match(requests[0].url, /\?q=Calot%20triangle&udm=2$/);
  assert.equal(requests[1].data_format, undefined);

  assert.equal(results.length, 2);
  // High-res image with unknown natural dimensions is NOT stamped 180x120 from thumbnail and ranks above tiny 120x90
  assert.equal(results[0].imageUrl, "https://upload.wikimedia.org/calot-triangle-hd.png");
  assert.equal(results[0].width, null);
  assert.equal(results[0].height, null);
  assert.equal(results[1].width, 120);
});

test("BrightDataProvider Case E HTML fallback extracts paired full-res script tuples", async () => {
  const html = `
    <html><body>
      <script>
        var pair = ["https://encrypted-tbn0.gstatic.com/images?q=tbn:123",180,220],["https://anatomy.example.org/brachial-plexus-full.png",1200,1600];
      </script>
    </body></html>
  `;
  const { PluginClass } = loadEnv(async () => ({
    status: 200,
    json: { status_code: 200, body: html }
  }));

  const { BrightDataProvider } = PluginClass._internals;
  const provider = new BrightDataProvider("bd_secret_1234567890");
  const results = await provider.search("brachial plexus");
  assert.equal(results.length, 1);
  assert.equal(results[0].imageUrl, "https://anatomy.example.org/brachial-plexus-full.png");
  assert.equal(results[0].thumbnailUrl, "https://encrypted-tbn0.gstatic.com/images?q=tbn:123");
  assert.equal(results[0].width, 1600);
  assert.equal(results[0].height, 1200);
});

test("bindHighResPreview upgrades thumbnail to full imageUrl and flags <250px low-res warnings", () => {
  const { PluginClass, doc } = loadEnv();
  const { bindHighResPreview } = PluginClass._internals;

  const img = createMockElement("img", doc);
  const badge = createMockElement("div", doc);
  const item = {
    imageUrl: "https://example.org/full-diagram.png",
    thumbnailUrl: "https://example.org/thumb.jpg",
    width: null,
    height: null
  };

  bindHighResPreview(img, badge, item, { fullLabel: true });
  assert.equal(img.src, "https://example.org/full-diagram.png");

  // If fullUrl fails, fall back to thumbnail and flag low-res dimensions
  img.onerror();
  assert.equal(img.src, "https://example.org/thumb.jpg");
  img.naturalWidth = 180;
  img.naturalHeight = 120;
  img.onload();

  // Thumbnail fallback skips overwriting item's own natural dimensions, whereas direct low-res image triggers badge
  const lowItem = {
    imageUrl: "https://example.org/small.png",
    thumbnailUrl: "https://example.org/small.png",
    width: null,
    height: null
  };
  const lowImg = createMockElement("img", doc);
  const lowBadge = createMockElement("div", doc);
  bindHighResPreview(lowImg, lowBadge, lowItem, { fullLabel: true });
  lowImg.naturalWidth = 180;
  lowImg.naturalHeight = 120;
  lowImg.onload();
  assert.equal(lowItem.width, 180);
  assert.equal(lowItem.height, 120);
  assert.equal(lowBadge.textContent, "⚠️ Low res (180×120 px)");
  assert.equal(lowBadge.hasClass("mifm-badge-lowres"), true);

  // Full-res load clears low-res warning
  const hdItem = { imageUrl: "https://example.org/full.png", thumbnailUrl: "https://example.org/t.jpg", width: null, height: null };
  const hdImg = createMockElement("img", doc);
  const hdBadge = createMockElement("div", doc);
  bindHighResPreview(hdImg, hdBadge, hdItem, { fullLabel: true });
  hdImg.naturalWidth = 1280;
  hdImg.naturalHeight = 960;
  hdImg.onload();
  assert.equal(hdItem.width, 1280);
  assert.equal(hdItem.height, 960);
  assert.equal(hdBadge.textContent, "1280 × 960 px");
  assert.equal(hdBadge.hasClass("mifm-badge-lowres"), false);
});

test("Scoped note scanning and findTopicInsertionPosition stay strictly bounded within scope", async () => {
  const { PluginClass, MockTFile } = loadEnv();
  const {
    extractNoteSections,
    normalizeScanScope,
    OfflineMedicalScanner,
    GeminiScannerService
  } = PluginClass._internals;

  const lines = [
    "# Upper Limb",                  // L1
    "## Brachial Plexus",            // L2
    "- Roots C5 to T1 form trunks.", // L3
    "- Erb palsy affects C5-C6.",    // L4
    "",                              // L5
    "## Hepatobiliary",              // L6
    "- Triangle of Calot contains cystic artery.", // L7
    "  - Sub-bullet boundaries.",    // L8
    "- Gallbladder fundus projects below liver.",  // L9
    "## Portal Triad",               // L10
    "- Portal vein lies posterior."  // L11
  ];

  const sections = extractNoteSections(lines.join("\n"));
  assert.equal(sections.length, 4);
  assert.equal(sections[2].heading, "Hepatobiliary");
  assert.equal(sections[2].startLine, 6);
  assert.equal(sections[2].endLine, 9);

  const scope = normalizeScanScope({ mode: "custom", startLine: 7, endLine: 8 }, lines.length);
  assert.equal(scope.startLine, 7);
  assert.equal(scope.endLine, 8);
  assert.match(scope.label, /Lines 7–8/);

  // Scoped prompt only numbers scoped lines L7..L8
  const prompt = GeminiScannerService.buildPrompt("Surgery", lines.join("\n"), 10, scope);
  assert.match(prompt, /\[L7\] - Triangle of Calot/);
  assert.match(prompt, /\[L8\]   - Sub-bullet boundaries/);
  assert.doesNotMatch(prompt, /\[L3\]/);
  assert.doesNotMatch(prompt, /\[L11\]/);

  // Out-of-scope suggestions are filtered out cleanly
  const parsed = GeminiScannerService.parseGeminiResponse(
    JSON.stringify({
      summary: "Test",
      suggestions: [
        { line: 3, heading: "Brachial Plexus", visualConcept: "Brachial plexus", recommendedQuery: "brachial plexus" },
        { line: 7, heading: "Hepatobiliary", visualConcept: "Triangle of Calot", recommendedQuery: "triangle of calot" }
      ]
    }),
    lines.length,
    10,
    scope
  );
  assert.equal(parsed.suggestions.length, 1);
  assert.equal(parsed.filteredOutCount, 1);
  assert.equal(parsed.suggestions[0].line, 7);

  // OfflineMedicalScanner respects scope too
  const offline = new OfflineMedicalScanner();
  const offRes = await offline.scanNote("Surgery", lines.join("\n"), 10, null, scope);
  assert.ok(offRes.suggestions.every((s) => s.line >= 7 && s.line <= 8));

  // Insertion boundary test: even though heading "Hepatobiliary" starts at L6 above L7-L8 and has L9 below,
  // bounded insertion stops at index 7 (L8) and never jumps into L9 or L3.
  const editor = {
    lineCount: () => lines.length,
    getLine: (idx) => lines[idx] ?? "",
    getValue: () => lines.join("\n"),
    getCursor: () => ({ line: 6, ch: 0 })
  };
  const plugin = new PluginClass({ workspace: {} }, { id: "medical-image-finder-mobile" });
  const pos = plugin.findTopicInsertionPosition(editor, 7, "Hepatobiliary", "Triangle of Calot", "calot triangle", scope);
  assert.ok(pos.line >= 6 && pos.line <= 7, `Expected insertion within 0-based lines 6..7, got ${pos.line}`);
  assert.equal(pos.line, 7);
});

test("ImagePreviewModal supports Prev/Next navigation, 2x zoom toggle, and Batch selection toggle", () => {
  const { PluginClass, doc } = loadEnv();
  const { ImagePreviewModal } = PluginClass._internals;

  const items = [
    { title: "Img One", imageUrl: "https://example.org/1.png", thumbnailUrl: "https://example.org/t1.jpg", width: 800, height: 600, domain: "example.org" },
    { title: "Img Two", imageUrl: "https://example.org/2.png", thumbnailUrl: "https://example.org/t2.jpg", width: 200, height: 150, domain: "tiny.org" }
  ];
  let selectedIdx = 0;
  let toggledCount = 0;

  const plugin = {
    bindAction() {},
    saveAndInsertImage: async () => {},
    copyImageToClipboard: async () => {}
  };

  const prevGlobalDoc = global.document;
  global.document = doc;
  try {
    const modal = new ImagePreviewModal(
      {},
      plugin,
      items[0],
      null,
      {
        items,
        currentIndex: 0,
        isIndexSelected: (idx) => idx === selectedIdx,
        onBatchToggle: (idx) => {
          toggledCount++;
          selectedIdx = selectedIdx === idx ? -1 : idx;
          return selectedIdx === idx;
        }
      }
    );
    modal.open();

    assert.equal(modal.modalEl.hasClass("mifm-preview-modal-window"), true);
    assert.equal(modal.titleEl.textContent, "Img One");

    doc.dispatchKeydown("z");
    assert.equal(modal.isZoomed, true);
    assert.equal(modal.contentEl.querySelector(".mifm-modal-img-container").hasClass("is-zoomed"), true);

    doc.dispatchKeydown("ArrowRight");
    assert.equal(modal.titleEl.textContent, "Img Two");
    assert.equal(modal.isZoomed, false);
    const lowResBadge = modal.contentEl.querySelector(".mifm-badge-lowres");
    assert.ok(lowResBadge);
    assert.match(lowResBadge.textContent, /Low res \(200×150 px\)/);

    doc.dispatchKeydown(" ");
    assert.equal(toggledCount, 1);
    assert.equal(selectedIdx, 1);

    modal.close();
  } finally {
    if (prevGlobalDoc === undefined) delete global.document;
    else global.document = prevGlobalDoc;
  }
});

test("BatchImageReviewModal starts at 0/N, switches S/M/L/XL size classes, and View renders category filters", async () => {
  const { PluginClass } = loadEnv(async () => ({
    status: 200,
    json: { images: [{ title: "Test", link: "https://example.org/test.png", image_width: 900, image_height: 700 }] }
  }));
  const {
    DEFAULT_SETTINGS,
    BATCH_SIZE_PRESETS,
    normalizeSettings,
    BatchImageReviewModal,
    MedicalImageFinderMobileView
  } = PluginClass._internals;

  assert.equal(DEFAULT_SETTINGS.batchPreviewSize, "lg");
  assert.ok(Array.isArray(BATCH_SIZE_PRESETS));
  assert.equal(BATCH_SIZE_PRESETS.find((p) => p.id === "lg").label, "L");
  assert.equal(normalizeSettings({ batchPreviewSize: "xl" }).batchPreviewSize, "xl");
  assert.equal(normalizeSettings({ batchPreviewSize: "bogus" }).batchPreviewSize, "lg");

  const savedCalls = [];
  const fakeView = new MedicalImageFinderMobileView(
    { id: "leaf" },
    {
      settings: {
        ...DEFAULT_SETTINGS,
        defaultProvider: "brightdata",
        brightDataApiKey: "bd_test_1234567890",
        batchPreviewSize: "lg"
      },
      async saveSettings(opts) {
        savedCalls.push(opts);
      },
      getProvider() {
        return {
          name: "Bright Data",
          async search() {
            return [{ title: "Result", imageUrl: "https://example.org/r.png", thumbnailUrl: "https://example.org/rt.jpg" }];
          }
        };
      },
      async searchWithCache(p, q) {
        return p.search(q);
      },
      captureTarget() {
        return {
          file: { basename: "AnatomyNote", extension: "md", path: "AnatomyNote.md" },
          editor: { lineCount: () => 20, getValue: () => "# Head\nLine 2", getSelection: () => "" }
        };
      },
      validateTarget() {},
      getTargetView() {
        return null;
      },
      bindAction() {}
    }
  );

  fakeView.scanResults = {
    summary: "Anatomy Gaps",
    scope: { mode: "custom", startLine: 1, endLine: 10, label: "Lines 1–10" },
    suggestions: [
      { line: 2, heading: "Head", visualType: "diagram", visualConcept: "Circle of Willis", recommendedQuery: "circle of willis" },
      { line: 5, heading: "Head", visualType: "radiology", visualConcept: "Subdural hematoma", recommendedQuery: "subdural hematoma ct" }
    ]
  };
  fakeView.currentTab = "scan";
  fakeView.render();

  const filterBar = fakeView.contentEl.querySelector(".mifm-scan-filter-bar");
  assert.ok(filterBar);
  assert.ok(filterBar.children.some((b) => b.textContent === "All (2)"));
  assert.ok(filterBar.children.some((b) => b.textContent === "Pending (2)"));

  // Filter by radiology only -> card ID stays mifm-card-1!
  const radPill = filterBar.children.find((b) => b.textContent.includes("(1)") && b.textContent.includes("Radiology"));
  assert.ok(radPill);
  radPill.onclick();
  const visibleCards = fakeView.contentEl.querySelectorAll(".mifm-scan-card");
  assert.equal(visibleCards.length, 1);
  assert.equal(visibleCards[0].id, "mifm-card-1");

  // Batch modal opens with size lg and 0/2 initial progress
  const batchModal = new BatchImageReviewModal({}, fakeView.plugin, fakeView);
  const openPromise = batchModal.onOpen();
  assert.equal(batchModal.contentEl.hasClass("is-size-lg"), true);
  const progressLabel = batchModal.contentEl.querySelector(".mifm-batch-progress-label");
  assert.ok(progressLabel);
  assert.match(progressLabel.textContent, /\(0\/2\)/);

  // Switch size to S without clearing cache
  const sBtn = batchModal.contentEl.querySelectorAll(".mifm-batch-size-btn").find((b) => b.textContent === "S");
  assert.ok(sBtn);
  await sBtn.onclick();
  assert.equal(batchModal.previewSize, "sm");
  assert.equal(batchModal.contentEl.hasClass("is-size-sm"), true);
  assert.equal(savedCalls.some((c) => c && c.clearCache === false), true);

  await openPromise;
  const progressBar = batchModal.contentEl.querySelector(".mifm-batch-progress-bar");
  assert.equal(progressBar.value, 2);
  batchModal.onClose();
});
