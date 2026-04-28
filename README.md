# 0tab AI — AI-powered bookmark shortcuts for the Chrome address bar

> Type `0` + `Tab` in the Chrome address bar, type a shortcut name, hit Enter — and you're on the page. A keyboard-first bookmark manager for Chrome with on-device AI (Gemini Nano), bidirectional bookmark sync, smart tags, folders that open as tab groups, a built-in AI chat assistant, and detailed usage insights.

**0tab AI** is a free, open-source Chrome extension that turns your bookmarks into instant keyboard shortcuts you trigger from the Chrome omnibox. No more hunting through bookmark folders, no more long URLs, no more "where did I save that?". Bookmark a page, give it a 2–3 letter shortcut like `gh`, `gm`, `nb`, and from then on `0` `Tab` `gh` `Enter` lands you on GitHub.

It runs entirely in your browser. AI features use Chrome's on-device Gemini Nano model — your bookmarks, tags, and chat history never leave your machine.

---

## Table of contents

- [Why 0tab AI](#why-0tab-ai)
- [Features](#features)
  - [Omnibox shortcuts](#omnibox-shortcuts)
  - [Bookmark management](#bookmark-management)
  - [Folders that open as tab groups](#folders-that-open-as-tab-groups)
  - [Bidirectional Chrome bookmark sync](#bidirectional-chrome-bookmark-sync)
  - [Tags](#tags)
  - [On-device AI (Gemini Nano)](#on-device-ai-gemini-nano)
  - [Ask 0tab AI — conversational bookmark chat](#ask-0tab-ai--conversational-bookmark-chat)
  - [Insights dashboard](#insights-dashboard)
  - [Quick jump (Cmd/Ctrl + K spotlight)](#quick-jump-cmdctrl--k-spotlight)
  - [Pin, drag-to-reorder, list/grid view](#pin-drag-to-reorder-listgrid-view)
  - [Import / Export](#import--export)
  - [Trash with 30-day retention](#trash-with-30-day-retention)
- [How to use](#how-to-use)
- [Installation](#installation)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Permissions and what they're used for](#permissions-and-what-theyre-used-for)
- [Privacy](#privacy)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Development](#development)
- [License](#license)

---

## Why 0tab AI

Bookmark bars run out of space. Bookmark folders are slow to navigate. Pinned tabs eat memory. Search-by-typing-the-title only works if you remember the title. **0tab AI replaces all of that with one short sequence in the address bar.**

Built for people who:

- Live in the keyboard and want zero clicks to open a site.
- Bookmark hundreds of sites and need a way to actually find them.
- Want lightweight on-device AI for tagging, naming, and search — without sending data to a cloud LLM.
- Use tab groups and want to open a whole project (5+ tabs) with one keystroke.
- Care about privacy: nothing is uploaded; AI runs in Chrome itself.

---

## Features

### Omnibox shortcuts

The core feature. Type `0` in the Chrome address bar, press `Tab`, then type the shortcut name (e.g. `gh`, `notion`, `lin`) and press `Enter` to open the bookmarked page. The omnibox shows live suggestions as you type — fuzzy-matched against shortcut names, titles, and tags — ranked by how often you open them.

- 2–3 letter shortcuts work best (`yt`, `gm`, `lin`, `fig`).
- Most-used shortcut is suggested first when you press `0` `Tab` with no query.
- If you type a shortcut that doesn't exist, 0tab offers to create one inline or fall back to a Google search.

### Bookmark management

- **Save the current page in two clicks** from the toolbar popup, or via the right-click context menu ("Create 0tab shortcut for this page"), or from the dashboard.
- **Edit anything later**: rename the shortcut, change the target URL, move folders, change tags, set a description.
- **Pinned tiles** stay at the top of the popup grid in your custom order.
- **Drag-and-drop reordering** in the popup grid using native HTML5 drag.
- **Grid view or compact list view** — toggle in the popup, the choice is remembered.

### Folders that open as tab groups

A "folder shortcut" is a single shortcut name (e.g. `work`) that opens multiple URLs at once — and groups them into a Chrome tab group named after the shortcut. Perfect for project switchers: type `0 Tab work Enter` and your Jira, Slack, Notion, GitHub, and design Figma all open as a labeled tab group in one keystroke.

### Bidirectional Chrome bookmark sync

Toggle on in Settings (default: on). Then:

- Every Chrome bookmark you create gets a 0tab shortcut suggestion.
- Every 0tab shortcut you create lands as a real Chrome bookmark inside the canonical **0tab AI** bookmark folder, so your bookmarks remain portable, syncable across devices via Chrome Sync, and visible in the bookmark bar.
- Renames, deletions, and folder moves propagate both ways.

### Tags

Free-form tags on every shortcut. Type-ahead chip input in the popup, full tag cloud in the Insights view, and tag-aware fuzzy search in the omnibox and Quick Jump.

### On-device AI (Gemini Nano)

Optional. Toggle on in Settings → "Chrome Gemini Nano". Requires Chrome 131+ with the on-device-model flag. Once enabled, 0tab AI uses Chrome's built-in `LanguageModel` API to:

- **Auto-generate tags** from a page's title and URL when you save it.
- **Suggest a short shortcut name** (2–3 letters) based on the page.
- **Write a one-line description** for each bookmark.
- **Detect duplicates** across your saved set (close-but-not-identical URLs and titles).
- **Power conversational queries** in Ask 0tab AI (see below).

Everything runs in an offscreen document inside the extension — no data leaves your machine, no API key required, no usage caps.

### Ask 0tab AI — conversational bookmark chat

A chat panel inside the dashboard. Talk to your bookmarks in plain English:

- "Find that article about React server components I saved last month"
- "Show me my design tools"
- "Save the current tab and tag it research"
- "What do I open most on Mondays?"
- "Clean up bookmarks I haven't touched in 90 days"

The chat classifies your intent on-device, runs the appropriate action against your storage, and replies with bookmark cards you can click to open or edit. Falls back to keyword search when AI is unavailable.

### Insights dashboard

A full analytics view of how you use the web through your bookmarks:

- **84-day daily-opens heatmap** (GitHub-contribution-style).
- **Top shortcuts** ranked by opens.
- **Tag landscape** — most-used tags as a sized cloud.
- **Recently trending** — opened in the last 7 days.
- **Gone cold** — used before, idle for 30+ days. Archive or pin reminders.
- **Dead pile** — saved but never opened. One-click cleanup.
- **Day streak** — consecutive days you've opened at least one shortcut.
- **KPI cards** — bookmarks, shortcuts, folders, with week-over-week deltas.

### Quick jump (Cmd/Ctrl + K spotlight)

Press `⌘K` (or `Ctrl+K`) anywhere in the dashboard for a global jump-to-anything launcher. Search shortcuts, bookmarks, folders, and quick actions by name, tag, or URL. Arrow keys to navigate, `Enter` to open in a new tab, `⌘ + Enter` to replace the current tab.

### Pin, drag-to-reorder, list/grid view

- **Pin** a shortcut from the popup dropdown (the thumbtack icon) to lock it to the top of your grid.
- **Drag pinned tiles** to set the exact order — pinOrder is persisted.
- **Drag any unpinned tile to the top** to pin it on the fly.
- **List view** for power users who want URL + tags inline.

### Import / Export

- **CSV export**: download every shortcut with name, URL, count, folder.
- **CSV import**: bulk-restore from a CSV (`shortcut_name, url, count, folder`).
- **Import from browsing history**: scan your Chrome history for sites you visit often that aren't yet saved, suggest shortcut names, let you uncheck/edit any, and bulk-create them. Auto-popup is gated on having ≥10 fresh suggestions so you're never interrupted with an empty modal; manual run is always available from Settings.
- **Sync bookmarks ↔ shortcuts**: one-click reconcile to ensure every Chrome bookmark has a 0tab shortcut and vice-versa.

### Trash with 30-day retention

Deletes go to a trash store, not straight to the void. Restore anything within 30 days from Settings → Trash. After 30 days items are pruned automatically.

---

## How to use

### 1. Save your first shortcut

Open any site. Click the 0tab AI toolbar icon. The popup pre-fills the URL and bookmark name from the current tab. Type a 2-3 letter shortcut name (e.g. `gh` for github.com) and click **Save**. That's it — the bookmark is saved and a Chrome bookmark is created in the **0tab AI** folder.

### 2. Use the shortcut

In any Chrome address bar:

```
0    [Tab]    gh    [Enter]
```

You're on github.com. Total keystrokes after `Cmd+L`: 5.

### 3. Make a folder shortcut

In the popup or dashboard, create a new shortcut, switch to "Folder" mode, and add multiple URLs. Use the shortcut as normal — it'll open all URLs as a Chrome tab group.

### 4. Search your library

Open the dashboard (Cmd+Shift+0 or click "Dashboard" in the popup). Use the search bar, the Quick Jump (⌘K), or the Ask 0tab AI chat panel.

---

## Installation

### From the Chrome Web Store

The published listing is available at [Chrome Web Store — 0tab AI](https://chromewebstore.google.com/detail/tab0/ejcaloplfaackbkpdiidjgakbogilcdf). Click **Add to Chrome**.

### From source (developer mode)

```bash
git clone https://github.com/kavilrawat/0tab-AI.git
```

Then in Chrome:

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and pick the cloned folder.
4. The 0tab AI icon appears in your toolbar.

To enable the on-device AI features, also enable Chrome's on-device model:

1. Go to `chrome://flags/#optimization-guide-on-device-model` and set it to **Enabled BypassPerfRequirement**.
2. Restart Chrome.
3. Visit `chrome://on-device-internals/` to verify the model is downloaded (this takes a few minutes the first time).
4. In the 0tab AI dashboard → Settings → toggle on **Chrome Gemini Nano**.

---

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Open dashboard | `Ctrl+Shift+0` (Win/Linux) · `Cmd+Shift+0` (Mac) |
| Activate omnibox | `0` then `Tab` in the address bar |
| Quick jump (in dashboard) | `Cmd+K` / `Ctrl+K` |
| Open in new tab from spotlight | `Enter` |
| Replace current tab from spotlight | `Cmd+Enter` / `Ctrl+Enter` |

---

## Permissions and what they're used for

| Permission | Used for |
|---|---|
| `bookmarks` | Two-way sync with the Chrome bookmark tree (the **0tab AI** folder). |
| `tabs`, `activeTab` | Read the current tab's URL/title for the popup, open shortcut targets, group multi-URL shortcuts into tab groups. |
| `tabGroups` | Create named Chrome tab groups when opening folder shortcuts. |
| `storage` | Persist your shortcuts, settings, daily stats, and trash in `chrome.storage.local`. |
| `history` | (Optional) Suggest unsaved frequently-visited sites in the history-import flow. |
| `contextMenus` | "Create 0tab shortcut for this page" right-click action. |
| `notifications` | Surface confirmations and errors that happen outside the popup. |
| `webNavigation` | Track shortcut-driven opens for the Insights heatmap. |
| `offscreen` | Host the offscreen document that runs Gemini Nano (the Prompt API isn't available in service workers). |
| `favicon` | Use Chrome's internal favicon API for fast, locally-cached favicons in the popup and dashboard. |
| `identity` | Reserved for future cross-device sync; currently unused. |

No host permissions, no `<all_urls>` access, no remote code, no analytics.

---

## Privacy

- **All data is stored locally** in `chrome.storage.local`. Optionally synced across devices via Chrome's bookmark sync (since shortcuts are mirrored as bookmarks).
- **AI runs on-device.** The Gemini Nano model is downloaded by Chrome and executed in the browser. 0tab AI never sends your bookmarks, tags, queries, or chat messages to any server.
- **No analytics, telemetry, or tracking.** Open the network panel — there are no outbound requests apart from optional favicon fetches from `google.com/s2/favicons`.
- **Uninstall feedback** points at a Tally form to ask why you're leaving — completely optional, no data attached.

---

## Tech stack

- **Manifest V3** Chrome extension (service worker, no persistent background page).
- **Vanilla JavaScript**, no framework — fast cold-start, small bundle.
- **Chrome Prompt API** (`LanguageModel` / `self.ai.languageModel`) for on-device AI, run inside an `offscreen` document.
- **Self-hosted Inter webfont** (woff2, latin subset) — no `fonts.googleapis.com` request blocking the popup paint.
- **Chrome Bookmarks API**, **Tabs API**, **Tab Groups API**, **History API**, **Context Menus API**, **Omnibox API**.
- **`chrome.storage.local`** with a one-shot migration helper that handles upgrades from prior key namespaces.

---

## Project structure

```
0tab-AI/
├── manifest.json          MV3 manifest
├── background.js          Service worker: omnibox, context menu, bookmark sync, AI bridge
├── popup.html / popup.js  Toolbar popup
├── manage.html / manage.js  Full dashboard (Home, Library, Insights, Settings)
├── tab0-chat.js           Ask 0tab AI chat engine
├── offscreen.html / offscreen.js  Offscreen doc that hosts Gemini Nano
├── style.css              Popup styles
├── manage.css             Dashboard styles
├── marked.min.js          Markdown rendering for chat replies
├── fonts/                 Self-hosted Inter woff2 (400/500/600/700/800)
├── images/                UI SVG icons
├── icon16.png / icon48.png / icon128.png  Extension icons
└── LICENSE
```

---

## Development

```bash
# clone and load in Chrome (see Installation → From source)
git clone https://github.com/kavilrawat/0tab-AI.git
```

The extension has no build step — edit any file, hit reload in `chrome://extensions`. Use Chrome DevTools on:

- **The popup** — right-click the extension icon → Inspect popup.
- **The dashboard** — open `chrome-extension://<id>/manage.html` and use regular DevTools.
- **The service worker** — `chrome://extensions` → 0tab AI → Inspect "service worker".
- **The offscreen doc** — `chrome://extensions` → Inspect "offscreen document".

For testing AI flows without the model installed, AI features degrade gracefully: tag generation falls back to keyword extraction, chat falls back to keyword search, etc.

---

## Keywords

Chrome extension, bookmark manager, AI bookmarks, browser productivity, omnibox shortcuts, address bar shortcuts, keyboard shortcuts, tab management, tab groups, Chrome bookmarks sync, on-device AI, Gemini Nano, Chrome Prompt API, LanguageModel API, conversational bookmark search, fuzzy bookmark search, bookmark tags, bookmark folders, browsing history import, productivity tools, developer tools, web shortcuts, browser bookmarks search, manifest v3 extension, open source chrome extension.

---

## License

See [LICENSE](LICENSE).

Built by [Kavil Rawat](https://www.linkedin.com/in/kavilrawat/).
