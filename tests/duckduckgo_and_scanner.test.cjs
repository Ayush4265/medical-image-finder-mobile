"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const PLUGIN_DIR = path.resolve(__dirname, "..");

function loadWithNetwork(requestUrlMock) {
  const originalLoad = Module._load;
  class MockPlugin {}
  class MockItemView {}
  class MockModal {}
  class MockSetting {}
  class MockSettingTab {}
  class MockTFile {}
  class MockMarkdownView {}
  class MockNotice {}

  Module._load = function (request) {
    if (request === "obsidian") {
      return {
        Plugin: MockPlugin,
        ItemView: MockItemView,
        Modal: MockModal,
        Notice: MockNotice,
        Setting: MockSetting,
        PluginSettingTab: MockSettingTab,
        normalizePath: (p) => String(p || "").replace(/\\/g, "/"),
        TFile: MockTFile,
        MarkdownView: MockMarkdownView,
        Platform: { isMobile: true },
        requestUrl: requestUrlMock
      };
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    const mainPath = path.join(PLUGIN_DIR, "main.js");
    delete require.cache[require.resolve(mainPath)];
    return require(mainPath);
  } finally {
    Module._load = originalLoad;
  }
}

test("DuckDuckGoProvider extracts VQD token and parses i.js image results", async () => {
  const calls = [];
  const PluginClass = loadWithNetwork(async ({ url }) => {
    calls.push(url);
    if (url.includes("iax=images")) {
      return { text: `<script>vqd="4-1234567890_abc";</script>` };
    }
    if (url.includes("/i.js")) {
      return {
        json: {
          results: [
            {
              title: "Triangle of Doom &amp; Pain",
              image: "https://example.org/doom.png",
              thumbnail: "https://example.org/doom-thumb.jpg",
              url: "https://www.radiopaedia.org/cases/triangle-of-doom",
              width: 800,
              height: 600
            }
          ]
        }
      };
    }
    throw new Error("Unexpected URL: " + url);
  });

  const { DuckDuckGoProvider } = PluginClass._internals;
  const provider = new DuckDuckGoProvider();
  const res = await provider.search("triangle of doom");

  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("vqd=4-1234567890_abc"));
  assert.equal(res.length, 1);
  assert.equal(res[0].title, "Triangle of Doom & Pain");
  assert.equal(res[0].imageUrl, "https://example.org/doom.png");
  assert.equal(res[0].domain, "radiopaedia.org");
});

test("DuckDuckGoProvider silently falls back to Wikimedia Commons when VQD is missing", async () => {
  const PluginClass = loadWithNetwork(async ({ url }) => {
    if (url.includes("duckduckgo.com")) {
      return { text: "<html>No token here</html>" };
    }
    if (url.includes("commons.wikimedia.org")) {
      return {
        json: {
          query: {
            pages: {
              "1": {
                index: 1,
                title: "File:Inguinal_canal_diagram.png",
                imageinfo: [
                  {
                    url: "https://upload.wikimedia.org/inguinal.png",
                    thumburl: "https://upload.wikimedia.org/thumb.png",
                    descriptionurl: "https://commons.wikimedia.org/wiki/File:Inguinal_canal_diagram.png",
                    mime: "image/png",
                    width: 1024,
                    height: 768
                  }
                ]
              }
            }
          }
        }
      };
    }
    throw new Error("Unexpected URL");
  });

  const { DuckDuckGoProvider } = PluginClass._internals;
  const provider = new DuckDuckGoProvider();
  const res = await provider.search("inguinal canal");

  assert.equal(provider.name, "Wikimedia Commons (DuckDuckGo fallback)");
  assert.equal(res.length, 1);
  assert.equal(res[0].domain, "commons.wikimedia.org");
});

test("OfflineMedicalScanner detects clinical concepts and section headings", async () => {
  const PluginClass = loadWithNetwork(async () => ({}));
  const { OfflineMedicalScanner } = PluginClass._internals;
  const scanner = new OfflineMedicalScanner();

  const note = [
    "# Inguinal Hernia",
    "- Bounded by vas deferens and gonadal vessels: Triangle of Doom.",
    "- Triangle of Pain contains femoral nerve branch.",
    "## Laparoscopic TAPP Repair",
    "- Mesh placement over myopectineal orifice."
  ].join("\n");

  const out = await scanner.scanNote("Inguinal Hernia", note, 10);
  assert.ok(out.suggestions.length >= 2);
  assert.ok(out.suggestions.some((s) => /Triangle of Doom/i.test(s.visualConcept)));
  assert.ok(out.suggestions.some((s) => /Triangle of Pain/i.test(s.visualConcept)));
});

test("GeminiScannerService parses JSON, Markdown tables, and Markdown lists accurately", () => {
  const PluginClass = loadWithNetwork(async () => ({}));
  const { GeminiScannerService } = PluginClass._internals;

  const prompt = GeminiScannerService.buildPrompt("Pancreas", "# Acute Pancreatitis\n- Cullen sign", 15);
  assert.ok(prompt.includes("[L1] # Acute Pancreatitis"));
  assert.ok(prompt.includes("at most 15"));
  assert.equal(prompt.includes("Alt+G"), false);

  const jsonResp = '```json\n{"summary":"OK","suggestions":[{"heading":"Acute","line":2,"visualConcept":"Cullen sign","visualType":"clinical","rationale":"Ecchymosis.","recommendedQuery":"Cullen sign pancreatitis"}]}\n```';
  const p1 = GeminiScannerService.parseGeminiResponse(jsonResp, 50, 15);
  assert.equal(p1.suggestions.length, 1);
  assert.equal(p1.suggestions[0].line, 2);

  const tableResp = [
    "| Line | Heading | Visual Concept | Type | Query |",
    "| --- | --- | --- | --- | --- |",
    "| [L5] | Annular Pancreas | Double-Bubble Sign | radiology | Double bubble sign X ray |"
  ].join("\n");
  const p2 = GeminiScannerService.parseGeminiResponse(tableResp, 50, 15);
  assert.equal(p2.suggestions[0].visualType, "radiology");
  assert.equal(p2.suggestions[0].line, 5);

  const listResp = [
    "1. **Heading**: Hernia",
    "   - **Line**: [L8]",
    "   - **Concept**: Hesselbach Triangle",
    "   - **Type**: diagram",
    "   - **Query**: Hesselbach triangle boundaries diagram"
  ].join("\n");
  const p3 = GeminiScannerService.parseGeminiResponse(listResp, 50, 15);
  assert.equal(p3.suggestions[0].line, 8);
  assert.equal(p3.suggestions[0].visualConcept, "Hesselbach Triangle");
});
