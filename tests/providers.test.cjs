"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const PLUGIN_DIR = path.resolve(__dirname, "..");

function loadPlugin(requestUrlMock) {
  const originalLoad = Module._load;
  const notices = [];
  class MockPlugin {
    constructor(app, manifest) { this.app = app; this.manifest = manifest; }
  }
  class MockItemView {}
  class MockModal {}
  class MockSetting {}
  class MockSettingTab {}
  class MockTFile {
    constructor(p) { this.path = p; this.basename = path.basename(p, ".md"); this.extension = "md"; }
  }
  class MockMarkdownView {}
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
    return { PluginClass, notices, MockTFile };
  } finally {
    Module._load = originalLoad;
  }
}

test("BrightDataProvider requires API key and parses wrapped SERP Full JSON images", async () => {
  const requests = [];
  const { PluginClass } = loadPlugin(async (opts) => {
    requests.push(opts);
    return {
      status: 200,
      json: {
        status_code: 200,
        body: JSON.stringify({
          images: [
            {
              title: "Radiopaedia",
              source: "Calot triangle diagramRadiopaedia",
              image: "https://encrypted-tbn0.gstatic.com/images?q=tbn:123",
              original_image: "https://cdn.radiopaedia.org/calot.png",
              link: "https://www.google.com/url?q=https://radiopaedia.org/articles/calot-triangle&sa=U",
              original_width: 1200,
              original_height: 900
            }
          ]
        })
      }
    };
  });

  const { BrightDataProvider } = PluginClass._internals;
  await assert.rejects(() => new BrightDataProvider("").search("calot"), /API Key/i);
  assert.deepEqual(await new BrightDataProvider("bd_key").search("   "), []);

  const provider = new BrightDataProvider("bd_key_123", "serp_api1");
  const results = await provider.search("Calot triangle");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.brightdata.com/request");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers.Authorization, "Bearer bd_key_123");
  const payload = JSON.parse(requests[0].body);
  assert.equal(payload.zone, "serp_api1");
  assert.ok(payload.url.includes("udm=2"));

  assert.equal(results.length, 1);
  assert.equal(results[0].imageUrl, "https://cdn.radiopaedia.org/calot.png");
  assert.equal(results[0].thumbnailUrl, "https://encrypted-tbn0.gstatic.com/images?q=tbn:123");
  assert.equal(results[0].sourceUrl, "https://radiopaedia.org/articles/calot-triangle");
  assert.equal(results[0].domain, "cdn.radiopaedia.org");
  assert.equal(results[0].width, 1200);
  assert.equal(results[0].height, 900);
});

test("BrightDataProvider supports images_results, organic, HTML fallback, empty results, and Full JSON hint", async () => {
  let mode = "images_results";
  const { PluginClass } = loadPlugin(async (opts) => {
    if (mode === "images_results") {
      return {
        status: 200,
        json: {
          images_results: [
            {
              title: "Double bubble &amp; radiology",
              original: "https://example.org/double.jpg",
              thumbnail: "https://example.org/double-t.jpg",
              link: "https://example.org/case",
              source: "Example"
            }
          ]
        }
      };
    }
    if (mode === "organic") {
      return {
        status: 200,
        json: { organic: [{ title: "Organic", image: "https://example.org/org.png", link: "https://www.med.org/a" }] }
      };
    }
    if (mode === "html") {
      return {
        status: 200,
        json: {
          body: '<html><img src="https://encrypted-tbn0.gstatic.com/images?q=tbn:abc\\u0026s=1"/></html>'
        }
      };
    }
    if (mode === "empty") {
      return { status: 200, json: { images: [] } };
    }
    if (mode === "light_json") {
      return { status: 200, json: { general: {}, organic: [{ title: "No img" }] } };
    }
    if (mode === "serp_fail_dataset_ok") {
      if (opts.url.includes("/request")) throw new Error("SERP 502");
      return {
        status: 200,
        json: [{ title: "Dataset item", image_url: "https://example.org/ds.png", url: "https://www.nih.gov/img" }]
      };
    }
    return { status: 401, text: "Invalid token" };
  });

  const { BrightDataProvider } = PluginClass._internals;
  const p = new BrightDataProvider("bd_secret", "custom_zone");

  const r1 = await p.search("double bubble");
  assert.equal(r1[0].title, "Double bubble & radiology");
  assert.equal(r1[0].imageUrl, "https://example.org/double.jpg");

  mode = "organic";
  const r2 = await p.search("whipple");
  assert.equal(r2[0].imageUrl, "https://example.org/org.png");
  assert.equal(r2[0].domain, "med.org");

  mode = "html";
  const r3 = await p.search("billroth");
  assert.equal(r3.length, 1);
  assert.equal(r3[0].imageUrl, "https://encrypted-tbn0.gstatic.com/images?q=tbn:abc&s=1");

  mode = "empty";
  assert.deepEqual(await p.search("nothing"), []);

  mode = "light_json";
  await assert.rejects(() => p.search("test"), /Full JSON.*custom_zone|custom_zone.*Full JSON/);

  mode = "serp_fail_dataset_ok";
  const r4 = await p.search("fallback");
  assert.equal(r4[0].imageUrl, "https://example.org/ds.png");
  assert.equal(r4[0].domain, "nih.gov");

  mode = "auth_fail";
  await assert.rejects(() => p.search("fail"), /authentication failed/i);
});

test("BraveProvider validates key, parses Brave results, retries 429 once, and handles auth errors", async () => {
  let attemptCount = 0;
  let scenario = "ok";
  const { PluginClass } = loadPlugin(async (opts) => {
    attemptCount++;
    assert.equal(opts.headers["X-Subscription-Token"], "BSA_live_secret");
    if (scenario === "retry_429" && attemptCount === 1) {
      throw new Error("Request failed, status 429");
    }
    if (scenario === "auth_422") {
      throw new Error("Request failed, status 422");
    }
    return {
      status: 200,
      json: {
        results: [
          {
            title: "Hesselbach &amp; Inguinal Triangle",
            url: "https://www.kenhub.com/en/library/anatomy/hesselbachs-triangle",
            properties: {
              url: "https://cdn.kenhub.com/hesselbach.jpg",
              width: 1024,
              height: 768
            },
            thumbnail: {
              src: "https://imgs.search.brave.com/thumb.jpg"
            }
          }
        ]
      }
    };
  });

  const { BraveProvider } = PluginClass._internals;
  await assert.rejects(() => new BraveProvider("").search("hesselbach"), /API Key/i);
  assert.deepEqual(await new BraveProvider("BSA_live_secret").search("  "), []);

  const brave = new BraveProvider("BSA_live_secret");
  const results = await brave.search("hesselbach triangle");
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Hesselbach & Inguinal Triangle");
  assert.equal(results[0].imageUrl, "https://cdn.kenhub.com/hesselbach.jpg");
  assert.equal(results[0].thumbnailUrl, "https://imgs.search.brave.com/thumb.jpg");
  assert.equal(results[0].domain, "kenhub.com");
  assert.equal(results[0].width, 1024);

  attemptCount = 0;
  scenario = "retry_429";
  const retried = await brave.search("hesselbach triangle", 1);
  assert.equal(attemptCount, 2);
  assert.equal(retried.length, 1);

  scenario = "auth_422";
  await assert.rejects(() => brave.search("hesselbach triangle", 1), /authentication failed/i);
});

test("Plugin getProvider, searchWithCache in-flight deduplication, and safeError secret redaction", async () => {
  let networkCalls = 0;
  const { PluginClass } = loadPlugin(async ({ url }) => {
    networkCalls++;
    await new Promise((r) => setTimeout(r, 10));
    if (url.includes("api.search.brave.com")) {
      return {
        status: 200,
        json: {
          results: [
            {
              title: "Brave Result",
              url: "https://example.org/page",
              properties: { url: "https://example.org/img.png" },
              thumbnail: { src: "https://example.org/t.png" }
            }
          ]
        }
      };
    }
    return {
      status: 200,
      json: {
        images: [
          {
            title: "BD Result",
            image: "https://example.org/bd-t.png",
            original_image: "https://example.org/bd.png",
            link: "https://example.org/bd-page"
          }
        ]
      }
    };
  });

  const { normalizeSettings, safeError, SearchCache, BrightDataProvider, BraveProvider, DuckDuckGoProvider, WikimediaProvider } =
    PluginClass._internals;

  const plugin = new PluginClass({}, { id: "medical-image-finder-mobile" });
  plugin.settings = normalizeSettings({
    defaultProvider: "brightdata",
    brightDataApiKey: "super_bd_token_999",
    brightDataZone: "serp_api1",
    braveApiKey: "BSA_super_secret_888"
  });
  plugin.searchCache = new SearchCache();
  plugin.inFlightSearches = new Map();
  plugin.saveData = async () => {};
  await plugin.saveSettings({ clearCache: false });

  assert.ok(plugin.getActiveProvider() instanceof BrightDataProvider);
  assert.ok(plugin.getProvider("brave") instanceof BraveProvider);
  assert.ok(plugin.getProvider("duckduckgo") instanceof DuckDuckGoProvider);
  assert.ok(plugin.getProvider("wikimedia") instanceof WikimediaProvider);

  const bdProvider = plugin.getProvider("brightdata");
  const [a, b] = await Promise.all([
    plugin.searchWithCache(bdProvider, "Calot Triangle"),
    plugin.searchWithCache(bdProvider, "calot triangle")
  ]);
  assert.equal(networkCalls, 1);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.notEqual(a[0], b[0]);

  const braveProvider = plugin.getProvider("brave");
  const c = await plugin.searchWithCache(braveProvider, "calot triangle");
  assert.equal(networkCalls, 2);
  assert.equal(c[0].title, "Brave Result");

  const sanitized = safeError(
    new Error("Failed Bearer super_bd_token_999 and BSA_super_secret_888 at https://api.brightdata.com/request?key=abc")
  );
  assert.equal(sanitized.includes("super_bd_token_999"), false);
  assert.equal(sanitized.includes("BSA_super_secret_888"), false);
  assert.equal(sanitized.includes("https://api.brightdata.com"), false);
});

test("View, SettingsTab, and BatchImageReviewModal render provider selectors cleanly", async () => {
  function makeEl(tag = "div") {
    return {
      tagName: tag.toUpperCase(),
      children: [],
      classList: new Set(),
      style: {},
      dataset: {},
      value: "",
      checked: false,
      disabled: false,
      selected: false,
      rows: 0,
      max: 100,
      _text: "",
      _attrs: {},
      empty() { this.children = []; return this; },
      addClass(cls) { String(cls).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); return this; },
      removeClass(cls) { String(cls).split(/\s+/).filter(Boolean).forEach((c) => this.classList.delete(c)); return this; },
      setText(t) { this._text = String(t ?? ""); return this; },
      setAttribute(k, v) { this._attrs[k] = String(v); },
      addEventListener() {},
      querySelector(sel) {
        if (sel.startsWith(".") && this.classList.has(sel.slice(1))) return this;
        if (sel.startsWith("#") && this.id === sel.slice(1)) return this;
        for (const c of this.children) {
          const found = c.querySelector(sel);
          if (found) return found;
        }
        return null;
      },
      createDiv(opts = {}) { return this.createEl("div", opts); },
      createSpan(opts = {}) { return this.createEl("span", opts); },
      createEl(t, opts = {}) {
        const child = makeEl(t);
        if (opts.cls) child.addClass(opts.cls);
        if (opts.text != null) child.setText(opts.text);
        if (opts.value != null) child.value = String(opts.value);
        if (opts.type != null) child._attrs.type = opts.type;
        if (opts.attr) Object.assign(child._attrs, opts.attr);
        this.children.push(child);
        return child;
      }
    };
  }

  const originalLoad = Module._load;
  class MockSetting {
    setName() { return this; }
    setDesc() { return this; }
    addDropdown(cb) { cb({ addOption() { return this; }, setValue() { return this; }, onChange() { return this; } }); return this; }
    addText(cb) { cb({ inputEl: makeEl("input"), setPlaceholder() { return this; }, setValue() { return this; }, onChange() { return this; } }); return this; }
    addToggle(cb) { cb({ setValue() { return this; }, onChange() { return this; } }); return this; }
    addButton(cb) { cb({ setButtonText() { return this; }, setDisabled() { return this; }, onClick() { return this; } }); return this; }
  }
  class MockTFile { constructor(p) { this.path = p; this.basename = path.basename(p, ".md"); this.extension = "md"; } }

  let PluginClass;
  Module._load = function (req) {
    if (req === "obsidian") {
      return {
        Plugin: class { constructor(app, m) { this.app = app; this.manifest = m; } },
        ItemView: class { constructor(leaf) { this.leaf = leaf; this.contentEl = makeEl("div"); } },
        Modal: class { constructor(app) { this.app = app; this.contentEl = makeEl("div"); this.modalEl = makeEl("div"); this.titleEl = makeEl("div"); } open() {} close() {} },
        Notice: class {},
        Setting: MockSetting,
        PluginSettingTab: class { constructor(app, p) { this.app = app; this.plugin = p; this.containerEl = makeEl("div"); } },
        normalizePath: (p) => p,
        TFile: MockTFile,
        MarkdownView: class {},
        Platform: { isMobile: true },
        requestUrl: async () => ({ status: 200, json: { results: [], images: [] }, text: "" })
      };
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    const mainPath = path.join(PLUGIN_DIR, "main.js");
    delete require.cache[require.resolve(mainPath)];
    PluginClass = require(mainPath);
  } finally {
    Module._load = originalLoad;
  }

  const { normalizeSettings, MedicalImageFinderMobileView, MedicalImageFinderMobileSettingTab, BatchImageReviewModal, SearchCache } =
    PluginClass._internals;
  const noteFile = new MockTFile("Surgery/Cholecystitis.md");
  const app = {
    workspace: {
      getActiveViewOfType: () => ({ file: noteFile, editor: { getValue: () => "# Test", lineCount: () => 1, getLine: () => "# Test" }, leaf: {} }),
      getLeavesOfType: () => []
    },
    vault: { getAbstractFileByPath: () => noteFile }
  };
  const plugin = new PluginClass(app, { id: "medical-image-finder-mobile" });
  plugin.settings = normalizeSettings({ defaultProvider: "brave" });
  plugin.searchCache = new SearchCache();
  plugin.inFlightSearches = new Map();
  plugin.pendingActions = new Map();
  plugin.saveData = async () => {};

  const tab = new MedicalImageFinderMobileSettingTab(app, plugin);
  tab.display();
  assert.ok(tab.containerEl.children.length > 5);

  const view = new MedicalImageFinderMobileView({ view: null }, plugin);
  view.render();
  assert.ok(view.contentEl.querySelector(".mifm-provider-select"));
  view.updateTargetHeader();
  view.scanResults = {
    summary: "OK",
    suggestions: [{ heading: "Calot", line: 1, visualConcept: "Calot triangle", visualType: "diagram", rationale: "Key", recommendedQuery: "Calot triangle diagram" }]
  };
  view.currentTab = "scan";
  view.render();
  assert.ok(view.contentEl.querySelector(".mifm-scan-card"));

  const modal = new BatchImageReviewModal(app, plugin, view);
  await modal.onOpen();
  assert.ok(modal.contentEl.querySelector(".mifm-batch-provider-select"));
});
