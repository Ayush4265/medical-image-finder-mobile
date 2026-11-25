# Medical Image Finder Mobile (iPadOS & Android)

A mobile-first Obsidian community plugin (`isDesktopOnly: false`) for medical students and clinicians to search **DuckDuckGo Images** (free default, zero API keys), **Bright Data Google Images** (5,000 free/month), **Brave Images**, or **Wikimedia Commons**, scan notes with the **AI Visual Scanner**, review results in **Fast Batch Review**, and insert images at the exact bullet or paragraph point on **iPad**, **Android**, and **Desktop**.

## Why a Mobile Version?

- **100% Web & Obsidian API Core**: Zero Node.js or Electron imports (`electron`, `node:crypto`, `Buffer` removed) so it loads natively in Obsidian on **iPadOS** and **Android**.
- **Zero-Key Default + Optional Pro Engines**: Defaults to **DuckDuckGo (Free / No Key)** with silent Wikimedia Commons fallback, plus optional **Bright Data Google Images** (`serp_api1`) and **Brave Image Search API** directly in the sidebar and batch modal.
- **Touch-First UI**:
  - Explicit **`🔍 Preview`** and **`🌐 Source`** buttons on cards and batch thumbnails (no double-click or hover required).
  - `16px` input/select sizing on mobile to prevent iOS zoom-on-focus, `40px+` touch targets, and horizontal swipe carousels.
  - No background clipboard polling (avoids iOS paste permission popups).
  - **`📄 Note`** quick-jump button in the header for single-pane phones.

## Key Features

1. **Multi-Engine Medical Search**: Select text in any note and run **Find images** or use the sidebar engine switcher (`DuckDuckGo`, `Bright Data`, `Brave`, `Wikimedia`) with 7 medical mode pills (`All`, `Anatomy / Diagram`, `Radiology`, `HPE / Histology`, `Clinical / Surgical`, `Criteria / Scoring`, `Embryology / Physio`).
2. **AI Note Visual Scanner**:
   - **Copy Note & Prompt for AI App**: Generates a line-numbered `[L1]..[Ln]` prompt for Gemini, ChatGPT, or Claude on your iPad/Android, then imports the JSON or Markdown output via **Paste Response**.
   - **Offline Scan**: Built-in medical rules engine requiring zero API keys.
   - **Optional Gemini API Scan**: Enter a free Google AI Studio key in Settings for 1-tap automated scanning inside Obsidian.
3. **Fast Batch Image Review & 1-Click Auto-Pilot**: Switch search engines or retry individual cards with Bright Data / Brave / DuckDuckGo, toggle multiple images per topic, and insert **bottom-to-top** with smart list indentation and zero line drift.
4. **Offline Vault Attachments**: Saves images with SHA-256 content hashing in `Attachments/MedicalImages/` (configurable) to prevent duplicate files.

## Installation on iPad & Android

- **Via LiveSync / Folder Sync**: Copy `.obsidian/plugins/medical-image-finder-mobile/` into your vault and enable **Medical Image Finder Mobile** in **Settings → Community plugins**.
- **Via BRAT**: Push this folder to a GitHub repository with a release containing `main.js`, `manifest.json`, `styles.css`, and `versions.json`, then add the repository in BRAT on iPad/Android.
