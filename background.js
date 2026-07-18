// ============================================================
// 0TAB - Background Service Worker
// Handles: omnibox, context menu, bookmark sync, defaults
// ============================================================

// Shared helpers (INTERNAL_KEYS, isShortcutKey, storage migrations,
// storageGet/Set/Remove, sanitizeForPrompt, ...) — must load first.
importScripts('shared.js');

// Uninstall feedback form — fires when the user removes the extension.
try { chrome.runtime.setUninstallURL('https://tally.so/r/1AbzB4'); } catch (e) {}

// ============================================================
// AI MODULE - Gemini Nano via Offscreen Document
// The Prompt API is only available in web contexts, not extension
// service workers. We use an offscreen document as a bridge.
// ============================================================
let aiAvailability = null; // 'readily' | 'after-download' | 'no' | null
let offscreenCreated = false;

async function ensureOffscreen() {
  try {
    let existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')]
    });
    if (existingContexts.length > 0) {
      offscreenCreated = true;
      return true;
    }
    offscreenCreated = false;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Gemini Nano Prompt API requires a web context'
    });
    offscreenCreated = true;
    return true;
  } catch (e) {
    offscreenCreated = false;
    console.warn('0tab: Failed to create offscreen document:', e.message);
    return false;
  }
}

// Send a message to the offscreen document and wait for response
function sendToOffscreen(action, data, timeoutMs) {
  timeoutMs = timeoutMs || 15000;
  return new Promise(function (resolve) {
    let timer = setTimeout(function () { resolve(null); }, timeoutMs);
    try {
      chrome.runtime.sendMessage(
        Object.assign({ target: 'offscreen', action: action }, data || {}),
        function (response) {
          clearTimeout(timer);
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(response);
        }
      );
    } catch (e) {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

async function checkAiAvailability() {
  try {
    let ok = await ensureOffscreen();
    if (!ok) { aiAvailability = 'no'; return 'no'; }
    let resp = await sendToOffscreen('ai:check', {}, 10000);
    aiAvailability = (resp && resp.status) ? resp.status : 'no';
    return aiAvailability;
  } catch (e) {
    aiAvailability = 'no';
    return 'no';
  }
}

// --- AI provider settings (Chrome Gemini Nano vs ChatGPT/OpenAI) ---
// One provider is active at a time (settings.aiProvider), and each AI
// feature can be individually enabled/disabled (settings.aiFeatures).
const OPENAI_MODELS = ['gpt-4o-mini', 'gpt-4o', 'gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-5.4'];
const AI_FEATURE_DEFAULTS = {
  tags: true,         // Smart tag generation
  search: true,       // AI search fallback
  name: true,         // Shortcut name suggestion
  description: true,  // AI description
  chat: true,         // Ask 0tab chat
  duplicates: false   // Duplicate detection (off by default — advisory only)
};
let _aiSettingsCache = null;
try {
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes['__0tab_settings']) {
      _aiSettingsCache = null;
      // Also drop the Nano availability cache: a stale 'no' from a prior
      // Nano check would otherwise suppress AI paths (e.g. omnibox search)
      // after the user switches provider, until the worker recycles.
      aiAvailability = null;
    }
  });
} catch (e) {}

async function getAiSettings() {
  if (_aiSettingsCache) return _aiSettingsCache;
  let result = await storageGet('__0tab_settings');
  let s = result['__0tab_settings'] || {};
  _aiSettingsCache = {
    enabled: s.aiEnabled === true,
    provider: s.aiProvider === 'openai' ? 'openai' : 'nano',
    openaiKey: typeof s.openaiApiKey === 'string' ? s.openaiApiKey.trim() : '',
    openaiModel: OPENAI_MODELS.includes(s.openaiModel) ? s.openaiModel : 'gpt-4o-mini',
    features: Object.assign({}, AI_FEATURE_DEFAULTS, s.aiFeatures || {})
  };
  return _aiSettingsCache;
}

async function aiFeatureEnabled(feature) {
  let s = await getAiSettings();
  return s.enabled && s.features[feature] !== false;
}

// ChatGPT path: straight fetch from the service worker. Uses
// max_completion_tokens (not max_tokens) and default temperature so the
// same request shape works for both the gpt-4o and gpt-5.x families.
async function openaiPrompt(promptText, settings, opts) {
  let controller = new AbortController();
  let timer = setTimeout(function () { controller.abort(); }, 30000);
  // Structured features (tags/search/name/dupes) parse JSON out of the reply;
  // chat wants natural language. Pick the system prompt accordingly —
  // otherwise GPT dutifully wraps chat replies in {"response":"..."}.
  let systemMsg = (opts && opts.plain)
    ? 'You are 0tab, a friendly bookmark assistant inside a Chrome extension. Respond in plain conversational text — no JSON, no markdown code fences, no key-value wrappers. Be concise. Only when the user prompt explicitly asks for a specific output format (like a single intent word), follow that format exactly.'
    : 'You are 0tab, a bookmark assistant inside a Chrome extension. Always respond with valid JSON only — no markdown, no explanation, no extra text. Be concise and accurate.';
  try {
    let res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + settings.openaiKey
      },
      body: JSON.stringify({
        model: settings.openaiModel,
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: promptText }
        ],
        max_completion_tokens: 1000
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      let errMsg = '';
      try { let ej = await res.json(); errMsg = (ej && ej.error && ej.error.message) || ''; } catch (e) {}
      console.warn('0tab AI: OpenAI request failed:', res.status, errMsg);
      return null;
    }
    let data = await res.json();
    let content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return typeof content === 'string' && content.trim() ? content : null;
  } catch (e) {
    console.warn('0tab AI: OpenAI request error:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Prompt the active AI provider. Every AI feature funnels through here.
// opts.plain: natural-language reply (chat) instead of JSON-only.
async function aiPrompt(promptText, opts) {
  let settings = await getAiSettings();
  if (!settings.enabled) return null;
  if (settings.provider === 'openai') {
    if (!settings.openaiKey) return null;
    return openaiPrompt(promptText, settings, opts);
  }
  // Gemini Nano path (offscreen document)
  if (aiAvailability && aiAvailability !== 'readily') return null;
  if (!aiAvailability) await checkAiAvailability();
  // Anything but 'readily' (incl. 'downloadable') must not prompt — a
  // create() on an undownloaded model can implicitly start a huge download.
  if (aiAvailability !== 'readily') return null;
  let ok = await ensureOffscreen();
  if (!ok) return null;
  let resp = await sendToOffscreen('ai:prompt', { prompt: promptText }, 30000);
  if (resp && resp.result) return resp.result;
  return null;
}

// Strip markdown code fences that models wrap around JSON output.
function cleanAiJson(response) {
  return String(response || '').replace(/```json?\s*/g, '').replace(/```/g, '').trim();
}

// --- AI Feature: Smart Auto-Tagging ---
async function aiGenerateTags(title, url) {
  try {
    let prompt = `Generate 3-5 short tags (1-2 words each, lowercase) for this bookmark.
Title: "${sanitizeForPrompt(title)}"
URL: ${sanitizeForPrompt(url)}

Return ONLY a JSON array of strings. Example: ["dev","react","github"]`;

    let response = await aiPrompt(prompt);
    if (!response) return null;
    let cleaned = cleanAiJson(response);
    let tags = JSON.parse(cleaned);
    if (Array.isArray(tags)) {
      return tags
        .map(t => String(t).toLowerCase().replace(/[^a-z0-9- ]/g, '').trim().substring(0, 30))
        .filter(t => t.length > 1)
        .slice(0, 5);
    }
    return null;
  } catch (e) {
    console.warn('0tab AI: Tag generation failed:', e.message);
    return null;
  }
}

// --- AI Feature: Natural Language Search ---
async function aiSearchShortcuts(query, shortcuts) {
  try {
    let shortcutList = shortcuts.map(s => {
      let data = s.data;
      let url = typeof data === 'object' ? (data.url || '') : (data || '');
      let tags = typeof data === 'object' && Array.isArray(data.tags) ? data.tags.join(',') : '';
      let title = typeof data === 'object' ? (data.bookmarkTitle || data.folderTitle || '') : '';
      return `${sanitizeForPrompt(s.key, 30)}|${sanitizeForPrompt(title)}|${sanitizeForPrompt(url)}|${sanitizeForPrompt(tags)}`;
    }).slice(0, 50).join('\n');

    let prompt = `Given these bookmarks (format: shortcut|title|url|tags):
${shortcutList}

The user searched: "${sanitizeForPrompt(query)}"

Return a JSON array of the top 5 matching shortcut names, best match first. Match by meaning, not just keywords.
Example: ["desk","admin","docs"]`;

    let response = await aiPrompt(prompt);
    if (!response) return null;
    let cleaned = cleanAiJson(response);
    let results = JSON.parse(cleaned);
    if (Array.isArray(results)) {
      return results.map(String).slice(0, 5);
    }
    return null;
  } catch (e) {
    console.warn('0tab AI: Search failed:', e.message);
    return null;
  }
}

// --- AI Feature: Generate Shortcut Name ---
async function aiGenerateShortcutName(title, url, existingKeys) {
  try {
    let existingList = existingKeys.slice(0, 30).map(k => sanitizeForPrompt(k, 30)).join(', ');
    let prompt = `Generate a very short 0tab keyboard shortcut name (2-3 letters) for this bookmark.
Title: "${sanitizeForPrompt(title)}"
URL: ${sanitizeForPrompt(url)}

Rules:
- Lowercase only, no spaces, EXACTLY 2-3 characters
- Should be an abbreviation or initials related to the site
- Must NOT be any of these existing names: ${existingList}

Return ONLY a JSON string. Example: "fig" or "gd" or "jr"`;

    let response = await aiPrompt(prompt);
    if (!response) return null;
    let cleaned = cleanAiJson(response);
    let name = JSON.parse(cleaned);
    if (typeof name === 'string') {
      name = name.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 3);
      if (name.length > 1 && !existingKeys.includes(name)) return name;
    }
    return null;
  } catch (e) {
    console.warn('0tab AI: Shortcut name generation failed:', e.message);
    return null;
  }
}

// --- AI Feature: Bookmark Description ---
async function aiGenerateDescription(title, url) {
  try {
    let prompt = `Write a one-line description (max 80 chars) for this bookmark.
Title: "${sanitizeForPrompt(title)}"
URL: ${sanitizeForPrompt(url)}

Return ONLY a JSON string. Example: "Project management tool for agile teams"`;

    let response = await aiPrompt(prompt);
    if (!response) return null;
    let cleaned = cleanAiJson(response);
    let desc = JSON.parse(cleaned);
    if (typeof desc === 'string') {
      return desc.substring(0, 100);
    }
    return null;
  } catch (e) {
    console.warn('0tab AI: Description generation failed:', e.message);
    return null;
  }
}

// --- AI Feature: Duplicate Detection ---
async function aiDetectDuplicates(newTitle, newUrl, existingShortcuts) {
  try {
    let existing = existingShortcuts.map(s => {
      let data = s.data;
      let url = typeof data === 'object' ? (data.url || '') : (data || '');
      let title = typeof data === 'object' ? (data.bookmarkTitle || '') : '';
      return `${sanitizeForPrompt(s.key, 30)}|${sanitizeForPrompt(title)}|${sanitizeForPrompt(url)}`;
    }).slice(0, 40).join('\n');

    let prompt = `I'm about to save a new bookmark:
Title: "${sanitizeForPrompt(newTitle)}"
URL: ${sanitizeForPrompt(newUrl)}

Here are existing bookmarks (shortcut|title|url):
${existing}

Are any of these duplicates or very similar? Return a JSON array of matching shortcut names, or empty array if none.
Example: ["desk"] or []`;

    let response = await aiPrompt(prompt);
    if (!response) return null;
    let cleaned = cleanAiJson(response);
    let dupes = JSON.parse(cleaned);
    if (Array.isArray(dupes)) {
      return dupes.map(String).slice(0, 3);
    }
    return null;
  } catch (e) {
    console.warn('0tab AI: Duplicate detection failed:', e.message);
    return null;
  }
}

// AI availability is checked lazily — only when settings page requests ai:status
// or when an AI feature is used. This avoids creating the offscreen document
// (and triggering LanguageModel warnings) on browsers that don't need it.


// Do not run a full bookmark sweep every time the MV3 service worker wakes.
// That sweep can be very expensive for large bookmark collections and used to
// generate shortcut keys opportunistically in the background. Reconciliation
// still runs from explicit dashboard/install flows and bookmark create events.


// ============================================================
// SYNC LOCK - Prevents infinite loops between bookmark and
// storage listeners triggering each other
// ============================================================
let syncLock = false;
let syncPendingFn = null;

function withSyncLock(fn) {
  if (syncLock) {
    syncPendingFn = fn;
    // Marker so message handlers can tell "queued behind a running sync"
    // apart from "ran and found nothing to do".
    return Promise.resolve({ queued: true });
  }
  syncLock = true;
  let safetyTimer = setTimeout(() => { syncLock = false; }, 30000);
  return fn().finally(() => {
    clearTimeout(safetyTimer);
    // Short grace period after settling so echoed bookmark/storage events
    // from our own writes don't immediately re-trigger the listeners.
    setTimeout(() => {
      syncLock = false;
      if (syncPendingFn) {
        let next = syncPendingFn;
        syncPendingFn = null;
        withSyncLock(next);
      }
    }, 2000);
  });
}

// ============================================================
// ACCESS LOGGING — tracks daily open counts for stats
// Rapid successive opens previously raced: each call read the same stale
// dailyStats, incremented, wrote, and a concurrent call would overwrite
// with its own stale-base value, losing increments. We now chain all writes
// through a single promise queue so each read-modify-write completes
// serially, and coalesce in-memory increments between disk flushes.
// ============================================================
let _logPendingIncrements = 0;
let _logFlushInFlight = null;
let _logFlushScheduled = null;

function _flushAccessLog() {
  // One flush at a time. Any increments that land while we're flushing are
  // coalesced into _logPendingIncrements and picked up by the re-schedule.
  if (_logFlushInFlight) return _logFlushInFlight;
  if (_logPendingIncrements === 0) return Promise.resolve();
  let toAdd = _logPendingIncrements;
  _logPendingIncrements = 0;
  _logFlushInFlight = (async function () {
    try {
      let result = await new Promise(r => chrome.storage.local.get('__0tab_daily_stats', r));
      let dailyStats = result['__0tab_daily_stats'] || {};
      let today = new Date().toISOString().slice(0, 10);
      if (!dailyStats[today]) dailyStats[today] = { opens: 0 };
      dailyStats[today].opens = (dailyStats[today].opens || 0) + toAdd;

      // Prune entries older than 365 days. The heatmap only renders 84 days
      // but the rolling year buys headroom for future "year in review" type
      // views without unbounded growth in chrome.storage.local.
      let cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 365);
      let cutoffStr = cutoff.toISOString().slice(0, 10);
      Object.keys(dailyStats).forEach(d => { if (d < cutoffStr) delete dailyStats[d]; });

      await new Promise(r => chrome.storage.local.set({ '__0tab_daily_stats': dailyStats }, r));
    } catch (e) {
      // If the write failed, put the counts back so we try again next flush
      _logPendingIncrements += toAdd;
    } finally {
      _logFlushInFlight = null;
      // If more increments queued up during flush, schedule another soon
      if (_logPendingIncrements > 0 && !_logFlushScheduled) {
        _logFlushScheduled = setTimeout(function () {
          _logFlushScheduled = null;
          _flushAccessLog();
        }, 150);
      }
    }
  })();
  return _logFlushInFlight;
}

function logAccess(shortcutKey, url) {
  // Coalesce: bump the in-memory counter and schedule a single disk flush.
  _logPendingIncrements++;
  if (_logFlushScheduled || _logFlushInFlight) return;
  _logFlushScheduled = setTimeout(function () {
    _logFlushScheduled = null;
    _flushAccessLog();
  }, 150);
}

// ============================================================
// BOOKMARK BAR CLICK TRACKING
// Uses webNavigation to detect bookmark-triggered navigations
// Safely guarded — some browsers/environments may not support it
// ============================================================
if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
chrome.webNavigation.onCommitted.addListener(async (details) => {
  // Only track main frame, bookmark-triggered navigations
  if (details.frameId !== 0) return;
  if (details.transitionType !== 'auto_bookmark') return;

  let url = details.url;
  if (!url || url === 'about:blank' || url.startsWith('chrome://')) return;

  try {
    let items = await storageGet(null);
    let keys = Object.keys(items).filter(isShortcutKey);

    // Find the shortcut that matches this URL
    for (let key of keys) {
      let data = items[key];
      let savedUrl = typeof data === 'object' ? data.url : data;
      if (savedUrl === url) {
        if (typeof data === 'object') {
          data.count = (data.count || 0) + 1;
          data.lastAccessed = Date.now();
          await storageSet({ [key]: data });
        } else {
          await storageSet({ [key]: { url: data, count: 1, lastAccessed: Date.now() } });
        }
        logAccess(key, url);
        break;
      }
    }
  } catch (e) { /* ignore */ }
});
} // end webNavigation guard

// ============================================================
// KEYBOARD SHORTCUT: Ctrl+0 / Cmd+0 opens Dashboard
// ============================================================
chrome.commands.onCommand.addListener(function (command) {
  if (command === 'open-dashboard') {
    let dashUrl = chrome.runtime.getURL('manage.html');
    // Check if dashboard is already open, focus it instead of opening a new tab
    chrome.tabs.query({}, function (tabs) {
      if (chrome.runtime.lastError) {
        chrome.tabs.create({ url: dashUrl });
        return;
      }
      let existing = tabs.find(t => t.url && t.url.startsWith(dashUrl));
      if (existing) {
        chrome.tabs.update(existing.id, { active: true });
        chrome.windows.update(existing.windowId, { focused: true });
      } else {
        chrome.tabs.create({ url: dashUrl });
      }
    });
  }
});

// ============================================================
// CONTEXT MENU
// ============================================================
chrome.runtime.onInstalled.addListener(function (details) {
  chrome.contextMenus.create({
    id: 'createShortcut',
    title: 'Create 0tab shortcut for this page',
    contexts: ['page']
  });

  // Read via the migration-aware helper so sync → local data is preserved
  // before defaults get written. Using chrome.storage.local directly here
  // would race with the one-shot migration above.
  storageGet(null).then(function (items) {
    items = items || {};
    let shortcuts = Object.keys(items).filter(isShortcutKey);
    if (shortcuts.length === 0) {
      // No default shortcuts — bookmarks are synced automatically
    }

    if (!items['__0tab_folders']) {
      storageSet({ '__0tab_folders': ['Work', 'Social', 'Dev Tools', 'Other'] });
    }

    if (!items['__0tab_settings']) {
      storageSet({ '__0tab_settings': { bookmarkSync: true, tabGroupFolders: true } });
    }

    // Run migration after a short delay to let storage settle
    setTimeout(async () => {
      try {
        let all = await storageGet(null);

        // STEP 1: Migrate existing standalone shortcuts into "0tab Shortcuts" bookmark folder
        // These are shortcuts from Slash Space Go (or created without a folder) that have no bookmarkId
        let standaloneKeys = Object.keys(all).filter(isShortcutKey).filter(k => {
          let data = all[k];
          return typeof data === 'object' && !data.bookmarkId && data.url;
        });

        if (standaloneKeys.length > 0) {
          let tab0Folder = await getOrCreateBookmarkFolder();
          if (tab0Folder && tab0Folder.id) {
            for (let key of standaloneKeys) {
              let data = all[key];
              try {
                let bm = await new Promise((resolve, reject) => {
                  chrome.bookmarks.create({
                    parentId: tab0Folder.id,
                    title: data.bookmarkTitle || key,
                    url: data.url
                  }, (result) => {
                    if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                    else resolve(result);
                  });
                });
                // Link the bookmark to the shortcut
                data.bookmarkId = bm.id;
                if (!data.bookmarkTitle) data.bookmarkTitle = key;
                if (!data.tags) data.tags = [];
                if (!data.createdAt) data.createdAt = Date.now();
                await storageSet({ [key]: data });
              } catch (e) {
                console.warn('0tab: Migration step 1 - bookmark creation failed for', key, ':', e.message);
              }
            }
          } else {
            console.warn('0tab: Migration step 1 skipped - could not get/create bookmark folder');
          }
        }

        // STEP 2: Also handle old string-format shortcuts (url as plain string, not object)
        let oldFormatKeys = Object.keys(all).filter(isShortcutKey).filter(k => {
          return typeof all[k] === 'string';
        });

        if (oldFormatKeys.length > 0) {
          let tab0Folder = await getOrCreateBookmarkFolder();
          if (tab0Folder && tab0Folder.id) {
            for (let key of oldFormatKeys) {
              let url = all[key];
              try {
                let bm = await new Promise((resolve, reject) => {
                  chrome.bookmarks.create({
                    parentId: tab0Folder.id,
                    title: key,
                    url: url
                  }, (result) => {
                    if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                    else resolve(result);
                  });
                });
                // Upgrade to object format with bookmark link
                await storageSet({ [key]: {
                  url: url, count: 0, bookmarkId: bm.id, bookmarkTitle: key,
                  tags: [], createdAt: Date.now()
                }});
              } catch (e) {
                console.warn('0tab: Migration step 2 - bookmark creation failed for', key, ':', e.message);
              }
            }
          } else {
            console.warn('0tab: Migration step 2 skipped - could not get/create bookmark folder');
          }
        }

        // STEP 3: Non-destructive reconcile. Existing storage keys are user
        // shortcut names and must be preserved; only missing links/shortcuts
        // are added.
        await reconcileBookmarksShortcuts();

      } catch (e) {
        console.error('0tab: Migration error:', e);
      }
    }, 1000);
  });
});

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId === 'createShortcut') {
    let dashboardUrl = chrome.runtime.getURL('manage.html') + '?newurl=' + encodeURIComponent(tab.url) + '&newtitle=' + encodeURIComponent(tab.title);
    chrome.tabs.create({ url: dashboardUrl });
  }
});

// ============================================================
// OMNIBOX
// ============================================================

// Escape XML special characters for omnibox descriptions
function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Build sorted suggestions from storage items, optionally filtered by text
function buildSuggestions(items, filterText) {
  let suggestions = [];
  let keys = Object.keys(items).filter(isShortcutKey);
  let search = (filterText || '').toLowerCase();

  for (let i = 0; i < keys.length; i++) {
    let key = keys[i];
    let data = items[key];
    // Defensive: drop any entry that isn't a string URL or a shortcut
    // object. Prevents a TypeError if a stray boolean/number slips into
    // storage (e.g. a future internal flag not yet in INTERNAL_KEYS).
    if (data == null) continue;
    if (typeof data !== 'string' && typeof data !== 'object') continue;
    let isFolder = typeof data === 'object' && data.type === 'folder';
    let url = isFolder ? '' : (typeof data === 'object' ? (data.url || '') : data);
    if (typeof url !== 'string') url = '';
    let count = typeof data === 'object' ? (data.count || 0) : 0;
    let tags = typeof data === 'object' && Array.isArray(data.tags) ? data.tags.filter(function (t) { return typeof t === 'string'; }) : [];
    let folderTitle = (isFolder && typeof data.folderTitle === 'string') ? data.folderTitle : '';

    let searchableText = key + ' ' + url.toLowerCase() + ' ' + folderTitle.toLowerCase() + ' ' + tags.join(' ');
    if (search && !searchableText.includes(search)) continue;

    let lastAccessed = typeof data === 'object' ? (data.lastAccessed || 0) : 0;
    let tagLabel = tags.length > 0 ? ' [' + tags.join(', ') + ']' : '';

    let description;
    if (isFolder) {
      let urlCount = Array.isArray(data.urls) ? data.urls.length : 0;
      description = escapeXml(key) + ' <dim>' + escapeXml(tagLabel) + ' (' + urlCount + ' tabs)</dim> - <dim>' + escapeXml(folderTitle) + '</dim>';
    } else {
      description = escapeXml(key) + ' <dim>' + escapeXml(tagLabel) + '</dim> - <url>' + escapeXml(url) + '</url>';
    }

    suggestions.push({
      content: key,
      description: description,
      count: count,
      lastAccessed: lastAccessed
    });
  }

  // Sort: most used first, then most recently accessed, then alphabetical
  suggestions.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (b.lastAccessed !== a.lastAccessed) return (b.lastAccessed || 0) - (a.lastAccessed || 0);
    return a.content.localeCompare(b.content);
  });
  return suggestions;
}

// Cache shortcuts in memory so we can serve them instantly on omnibox activation
let cachedShortcuts = null;

function refreshShortcutCache() {
  storageGet(null).then(function (items) {
    cachedShortcuts = items;
  }).catch(function () { /* ignore */ });
}

// Refresh cache on startup and only when shortcut-keys actually change.
// Previously this re-read all storage on every __0tab_daily_stats write
// (fires on every shortcut open), pointlessly hitting local storage N×.
refreshShortcutCache();
chrome.storage.onChanged.addListener(function (changes, areaName) {
  if (areaName !== 'local') return;
  let shortcutChanged = Object.keys(changes).some(isShortcutKey);
  if (shortcutChanged) refreshShortcutCache();
});

// When omnibox is first activated (user presses Tab after typing "0")
chrome.omnibox.onInputStarted.addListener(() => {
  let items = cachedShortcuts;
  if (!items) {
    chrome.omnibox.setDefaultSuggestion({
      description: '0tab: Type a shortcut name to go'
    });
    return;
  }
  let suggestions = buildSuggestions(items, '');
  if (suggestions.length > 0) {
    // Show the most-visited shortcut as the default action
    let top = suggestions[0];
    chrome.omnibox.setDefaultSuggestion({
      description: '0tab: <dim>Top shortcut:</dim> <match>' + escapeXml(top.content) + '</match> <dim>(' + suggestions.length + ' total) — type to filter</dim>'
    });
  } else {
    chrome.omnibox.setDefaultSuggestion({
      description: '0tab: No shortcuts yet — create one from the popup'
    });
  }
});

// isOpenableUrl (safe-scheme whitelist) is provided by shared.js.

function openUrlInTab(url, disposition) {
  if (!url || !isOpenableUrl(url)) {
    if (url) console.warn('0tab: Omnibox blocked unsafe URL scheme:', url);
    return;
  }
  if (disposition === 'currentTab') chrome.tabs.update({ url: url });
  else chrome.tabs.create({ url: url });
}

function openFolderUrlsSimple(urls, disposition) {
  let safe = urls.filter(isOpenableUrl);
  if (!safe.length) return;
  if (disposition === 'currentTab') chrome.tabs.update({ url: safe[0] });
  else chrome.tabs.create({ url: safe[0] });
  for (let i = 1; i < safe.length; i++) chrome.tabs.create({ url: safe[i] });
}

chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  text = text.toLowerCase().trim();

  // If user presses Enter with empty text, open dashboard
  if (!text) {
    let dashUrl = chrome.runtime.getURL('manage.html');
    if (disposition === 'currentTab') {
      chrome.tabs.update({ url: dashUrl });
    } else {
      chrome.tabs.create({ url: dashUrl });
    }
    return;
  }

  try {
    let result = await storageGet(text);
    if (result[text] && isShortcutKey(text)) {
      let shortcutData = result[text];

      // Handle folder-type shortcuts: open all URLs
      if (typeof shortcutData === 'object' && shortcutData.type === 'folder' && Array.isArray(shortcutData.urls)) {
        shortcutData.count = (shortcutData.count || 0) + 1;
        shortcutData.lastAccessed = Date.now();
        await storageSet({ [text]: shortcutData });
        let urls = shortcutData.urls.filter(u => {
          if (isOpenableUrl(u)) return true;
          console.warn('0tab: Omnibox blocked unsafe URL scheme:', u);
          return false;
        });
        if (urls.length > 0) {
          // Check tab group setting
          let settingsResult = await storageGet(['__0tab_settings']);
          let settings = settingsResult['__0tab_settings'] || {};
          let useTabGroup = settings.tabGroupFolders !== false;

          // Open first in current tab, rest in new tabs
          let tabIds = [];
          let [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (activeTab) {
            if (disposition === 'currentTab') {
              try { await chrome.tabs.update(activeTab.id, { url: urls[0] }); }
              catch (uErr) { console.warn('0tab: Omnibox tabs.update failed:', uErr && uErr.message); }
            } else {
              try {
                let t = await chrome.tabs.create({ url: urls[0] });
                if (t && t.id) tabIds.push(t.id);
              } catch (tErr) {
                console.warn('0tab: Omnibox tabs.create failed:', tErr && tErr.message);
              }
              activeTab = null; // don't include original tab
            }
            if (activeTab) tabIds.push(activeTab.id);
          }
          for (let i = 1; i < urls.length; i++) {
            try {
              let t = await chrome.tabs.create({ url: urls[i], active: false });
              if (t && t.id) tabIds.push(t.id);
            } catch (tErr) {
              console.warn('0tab: Omnibox tabs.create failed for', urls[i], ':', tErr && tErr.message);
            }
          }

          // Create tab group if enabled
          if (useTabGroup && tabIds.length > 0) {
            try {
              let groupId = await chrome.tabs.group({ tabIds: tabIds });
              await chrome.tabGroups.update(groupId, { title: text, collapsed: false });
            } catch (gErr) {
              console.warn('0tab: Omnibox tab group creation failed:', gErr.message);
            }
          }
        }
      } else if (typeof shortcutData === 'object' && shortcutData !== null && 'url' in shortcutData) {
        shortcutData.count = (shortcutData.count || 0) + 1;
        shortcutData.lastAccessed = Date.now();
        await storageSet({ [text]: shortcutData });
        logAccess(text, shortcutData.url);
        openUrlInTab(shortcutData.url, disposition);
      } else {
        let newData = { url: shortcutData, count: 1, lastAccessed: Date.now(), folder: '' };
        await storageSet({ [text]: newData });
        logAccess(text, newData.url);
        openUrlInTab(newData.url, disposition);
      }
    } else {
      // No exact shortcut match. If the user typed what looks like a
      // shortcut name (single token, ≤15 chars, no whitespace), respect
      // that intent and send them to the dashboard "not found" flow —
      // don't auto-open some random fuzzy/AI match they didn't ask for.
      let looksLikeShortcutName = text.length > 0 && text.length <= 15 && !/\s/.test(text);
      if (looksLikeShortcutName) {
        let dashUrl = chrome.runtime.getURL('manage.html') + '?notfound=' + encodeURIComponent(text);
        if (disposition === 'currentTab') chrome.tabs.update({ url: dashUrl });
        else chrome.tabs.create({ url: dashUrl });
        return;
      }

      // Multi-word / search-style query — fall back to fuzzy + AI.
      let allItems = await storageGet(null);
      let matches = buildSuggestions(allItems, text);

      if (matches.length > 0) {
        // Open the best match (first result, sorted by most used)
        let bestKey = matches[0].content;
        let bestData = allItems[bestKey];

        // Update access count
        if (typeof bestData === 'object') {
          bestData.count = (bestData.count || 0) + 1;
          bestData.lastAccessed = Date.now();
          await storageSet({ [bestKey]: bestData });
        }

        // Handle folder-type shortcuts
        if (typeof bestData === 'object' && bestData.type === 'folder' && Array.isArray(bestData.urls)) {
          openFolderUrlsSimple(bestData.urls, disposition);
        } else {
          let bestUrl = typeof bestData === 'object' ? bestData.url : bestData;
          logAccess(bestKey, bestUrl);
          openUrlInTab(bestUrl, disposition);
        }
      } else {
        // No keyword matches — try AI search before giving up
        let aiResult = null;
        if (aiAvailability !== 'no') {
          let shortcuts = Object.keys(allItems).filter(isShortcutKey).map(k => ({ key: k, data: allItems[k] }));
          aiResult = await aiSearchShortcuts(text, shortcuts);
        }

        if (aiResult && aiResult.length > 0) {
          let aiKey = aiResult[0];
          let aiData = allItems[aiKey];
          if (aiData) {
            if (typeof aiData === 'object') {
              aiData.count = (aiData.count || 0) + 1;
              aiData.lastAccessed = Date.now();
              await storageSet({ [aiKey]: aiData });
            }
            if (typeof aiData === 'object' && aiData.type === 'folder' && Array.isArray(aiData.urls)) {
              openFolderUrlsSimple(aiData.urls, disposition);
            } else {
              let aiUrl = typeof aiData === 'object' ? aiData.url : aiData;
              openUrlInTab(aiUrl, disposition);
            }
          }
        } else {
          // Absolutely no results — open dashboard
          let dashUrl = chrome.runtime.getURL('manage.html') + '?notfound=' + encodeURIComponent(text);
          if (disposition === 'currentTab') chrome.tabs.update({ url: dashUrl });
          else chrome.tabs.create({ url: dashUrl });
        }
      }
    }
  } catch (err) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon128.png',
      title: '0tab - Error',
      message: 'Storage error: ' + err.message
    });
  }
});

chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  // Use cached data first for instant response, then refresh from storage
  let respondWithItems = (items) => {
    let suggestions = buildSuggestions(items, text);

    // Update default suggestion text
    if (text.trim() === '') {
      if (suggestions.length > 0) {
        let top = suggestions[0];
        chrome.omnibox.setDefaultSuggestion({
          description: '0tab: <dim>Most visited:</dim> <match>' + escapeXml(top.content) + '</match> <dim>(' + suggestions.length + ' shortcuts) — type to filter</dim>'
        });
      } else {
        chrome.omnibox.setDefaultSuggestion({
          description: '0tab: No shortcuts yet'
        });
      }
    } else {
      let trimmed = text.trim();
      let exactMatch = suggestions.find(s => s.content === trimmed.toLowerCase());
      // A short, alphanumeric, no-space input is what the user types as a
      // shortcut name. Mirror the omnibox handler in onInputEntered: if
      // there's no exact match for that, we'll route to the dashboard
      // "create new" flow — show that explicitly here so the user knows
      // pressing Enter will create, not search.
      let looksLikeShortcutName = trimmed.length > 0 && trimmed.length <= 15 && !/\s/.test(trimmed);
      if (exactMatch) {
        chrome.omnibox.setDefaultSuggestion({
          description: '0tab: Go to <match>' + escapeXml(exactMatch.content) + '</match>'
        });
      } else if (looksLikeShortcutName) {
        chrome.omnibox.setDefaultSuggestion({
          description: '0tab: <dim>No shortcut</dim> <match>' + escapeXml(trimmed) + '</match> <dim>— press Enter to → create new</dim>'
        });
      } else {
        chrome.omnibox.setDefaultSuggestion({
          description: '0tab: Search for <match>' + escapeXml(text) + '</match> <dim>(' + suggestions.length + ' matches)</dim>'
        });
      }
    }

    suggest(suggestions.map(s => ({ content: s.content, description: s.description })));
  };

  // Use cache for instant response, fall back to fresh fetch
  if (cachedShortcuts) {
    respondWithItems(cachedShortcuts);
  } else {
    storageGet(null).then(function (items) {
      cachedShortcuts = items;
      respondWithItems(items);
    }).catch(function () { suggest([]); });
  }
});

// ============================================================
// BOOKMARK SYNC - Core functions
// ============================================================

// Helper: verify a bookmark ID exists and is a folder (not a bookmark with a URL)
async function isValidFolderId(id) {
  if (!id) return false;
  try {
    let nodes = await new Promise((resolve) => {
      chrome.bookmarks.get(id, (results) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(results);
      });
    });
    if (!nodes || nodes.length === 0) return false;
    return !nodes[0].url; // Folders have no URL property
  } catch (e) {
    return false;
  }
}

// Helper: find the "Other Bookmarks" folder ID dynamically instead of hardcoding '2'
async function getOtherBookmarksFolderId() {
  try {
    let tree = await new Promise(resolve => chrome.bookmarks.getTree(resolve));
    if (tree && tree[0] && tree[0].children) {
      // "Other Bookmarks" is typically the second child of the root
      for (let child of tree[0].children) {
        if (child.title === 'Other Bookmarks' || child.title === 'Other bookmarks') {
          return child.id;
        }
      }
      // Fallback: return second child if it exists and is a folder
      if (tree[0].children.length >= 2 && !tree[0].children[1].url) {
        return tree[0].children[1].id;
      }
    }
  } catch (e) {
    console.error('0tab: Could not find Other Bookmarks folder:', e);
  }
  return '2'; // Last resort fallback
}

// Canonical folder name. Older installs may still have "Tab0 AI",
// "Tab0 Shortcuts", or the legacy "Tab0" — we find and rename them on access.
const TAB0_FOLDER_NAME = '0tab AI';

async function getOrCreateBookmarkFolder() {
  try {
    // Step 1: Look for the canonical "0tab AI" folder
    let aiHits = await new Promise(r => { chrome.bookmarks.search({ title: TAB0_FOLDER_NAME }, r); });
    let folder = aiHits.find(b => !b.url);
    if (folder) return folder;

    // Step 2: Migrate older names in-place
    let otherBmId = await getOtherBookmarksFolderId();
    let legacyNames = ['Tab0 AI', 'Tab0 Shortcuts', 'Tab0'];
    for (let nm of legacyNames) {
      let hits = await new Promise(r => { chrome.bookmarks.search({ title: nm }, r); });
      let legacy = hits.find(b => !b.url && (b.parentId === otherBmId || nm === 'Tab0 Shortcuts' || nm === 'Tab0 AI'));
      if (legacy) {
        return await new Promise((resolve) => {
          chrome.bookmarks.update(legacy.id, { title: TAB0_FOLDER_NAME }, (updated) => {
            if (chrome.runtime.lastError) {
              console.warn('0tab: Failed to rename legacy folder:', chrome.runtime.lastError.message);
              resolve(legacy); // fall back to the un-renamed folder
              return;
            }
            resolve(updated || legacy);
          });
        });
      }
    }

    // Step 3: Create new folder — verify otherBmId is actually a folder first
    let isValid = await isValidFolderId(otherBmId);
    if (!isValid) {
      console.error('0tab: Other Bookmarks folder ID', otherBmId, 'is not valid, using root');
      otherBmId = '0';
    }

    return await new Promise((resolve) => {
      chrome.bookmarks.create({ title: TAB0_FOLDER_NAME, parentId: otherBmId }, (newFolder) => {
        if (chrome.runtime.lastError) {
          console.error('0tab: Failed to create ' + TAB0_FOLDER_NAME + ' folder:', chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(newFolder);
        }
      });
    });
  } catch (e) {
    console.error('0tab: getOrCreateBookmarkFolder error:', e);
    return null;
  }
}

// Get or create a subfolder inside the 0tab folder
async function getOrCreateSubfolder(parentId, title) {
  let children = await new Promise(resolve => {
    chrome.bookmarks.getChildren(parentId, (result) => {
      if (chrome.runtime.lastError) { resolve([]); return; }
      resolve(result || []);
    });
  });
  let existing = children.find(c => !c.url && c.title === title);
  if (existing) return existing;
  return new Promise(resolve => {
    chrome.bookmarks.create({ parentId: parentId, title: title }, (result) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(result);
    });
  });
}

function normalizeUrlForMatch(url) {
  return (url || '').replace(/\/+$/, '').toLowerCase();
}

function shortcutBaseFromTitle(title, fallback) {
  let base = String(title || fallback || 'bookmark')
    .replace(/^\//, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 3);
  return base || 'bm';
}

function uniqueShortcutNameFromBase(baseName, usedNames, pendingNames) {
  let base = String(baseName || 'bm').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 15) || 'bm';
  if (!usedNames[base] && !(pendingNames && pendingNames[base])) return base;
  let counter = 2;
  let finalName = base;
  while (usedNames[finalName] || (pendingNames && pendingNames[finalName])) {
    let suffix = String(counter);
    finalName = base.substring(0, 15 - suffix.length) + suffix;
    counter++;
    if (counter > 999) break;
  }
  return finalName;
}

function findShortcutKeyForBookmark(items, bookmarkId) {
  if (!bookmarkId) return '';
  let keys = Object.keys(items || {}).filter(isShortcutKey);
  for (let i = 0; i < keys.length; i++) {
    let data = items[keys[i]];
    if (data && typeof data === 'object' && data.bookmarkId === bookmarkId) return keys[i];
  }
  return '';
}

function findShortcutKeyForUrl(items, url) {
  let normalized = normalizeUrlForMatch(url);
  if (!normalized) return '';
  let keys = Object.keys(items || {}).filter(isShortcutKey);
  for (let i = 0; i < keys.length; i++) {
    let data = items[keys[i]];
    let savedUrl = typeof data === 'object' ? (data.url || '') : (data || '');
    if (normalizeUrlForMatch(savedUrl) === normalized) return keys[i];
  }
  return '';
}

// Full sync: push all shortcuts to bookmarks
// Sync only standalone shortcuts (not linked to existing bookmarks) to the 0tab folder.
// Bookmarks that already exist in the browser stay in their original location.
async function syncShortcutsToBookmarks() {
  try {
    let folder = await getOrCreateBookmarkFolder();
    if (!folder || !folder.id) {
      console.warn('0tab: syncShortcutsToBookmarks skipped - no valid folder');
      return { success: false, error: 'No valid bookmark folder' };
    }
    let items = await storageGet(null);

    // Get existing children in the 0tab folder. This sync is intentionally
    // non-destructive: user-created bookmark children must never be removed
    // just because a shortcut changed.
    let children = await new Promise(resolve => {
      chrome.bookmarks.getChildren(folder.id, (result) => {
        if (chrome.runtime.lastError) { resolve([]); return; }
        resolve(result || []);
      });
    });
    let childByUrl = {};
    children.forEach(function (child) {
      if (child && child.url) childByUrl[normalizeUrlForMatch(child.url)] = child;
    });

    // Only sync shortcuts that are NOT linked to real bookmarks and NOT folder shortcuts
    let keys = Object.keys(items).filter(isShortcutKey);
    let standaloneKeys = keys.filter(key => {
      let data = items[key];
      if (typeof data === 'object' && data.type === 'folder') return false; // Skip folder shortcuts
      return !(typeof data === 'object' && data.bookmarkId);
    });

    // Put standalone shortcuts directly in the 0tab AI folder (flat), then
    // write the bookmarkId back under the same shortcut key.
    let writes = {};
    let created = 0;
    for (let key of standaloneKeys) {
      let data = items[key];
      let url = typeof data === 'object' ? (data.url || '') : (data || '');
      if (!url) continue;
      let normalized = normalizeUrlForMatch(url);
      let bm = childByUrl[normalized];
      if (!bm) {
        bm = await new Promise(resolve => {
          chrome.bookmarks.create({
            parentId: folder.id,
            title: (typeof data === 'object' && data.bookmarkTitle) ? data.bookmarkTitle : key,
            url: url
          }, resolve);
        });
        if (bm && bm.url) {
          childByUrl[normalized] = bm;
          created++;
        }
      }
      if (bm && bm.id) {
        let nextData = (typeof data === 'object' && data !== null) ? Object.assign({}, data) : { url: url, count: 0 };
        nextData.url = url;
        nextData.bookmarkId = bm.id;
        if (!nextData.bookmarkTitle) nextData.bookmarkTitle = bm.title || key;
        if (!nextData.tags) nextData.tags = [];
        if (!nextData.createdAt) nextData.createdAt = Date.now();
        writes[key] = nextData;
      }
    }

    if (Object.keys(writes).length > 0) await storageSet(writes);

    return { success: true, count: created };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Import from 0tab bookmarks folder
async function importBookmarksAsShortcuts() {
  try {
    let folder = await getOrCreateBookmarkFolder();
    if (!folder || !folder.id) {
      console.warn('0tab: importBookmarksAsShortcuts skipped - no valid folder');
      return { success: false, error: 'No valid bookmark folder' };
    }
    let children = await new Promise(resolve => {
      chrome.bookmarks.getSubTree(folder.id, (result) => {
        if (chrome.runtime.lastError) { resolve([]); return; }
        resolve(result || []);
      });
    });

    let imported = 0;
    let shortcuts = {};
    let existing = await storageGet(null);
    let usedNames = {};
    Object.keys(existing).filter(isShortcutKey).forEach(k => { usedNames[k] = true; });

    function processNode(node, category) {
      if (node.url) {
        let existingKey = findShortcutKeyForBookmark(existing, node.id) || findShortcutKeyForUrl(existing, node.url);
        let name = existingKey || uniqueShortcutNameFromBase(shortcutBaseFromTitle(node.title, 'bm'), usedNames, shortcuts);
        if (name && node.url) {
          let oldData = existingKey ? existing[existingKey] : {};
          let nextData = (oldData && typeof oldData === 'object') ? Object.assign({}, oldData) : {};
          nextData.url = node.url;
          nextData.folder = category || nextData.folder || '';
          nextData.bookmarkId = node.id;
          nextData.bookmarkTitle = node.title;
          if (!nextData.tags) nextData.tags = [];
          if (!nextData.createdAt) nextData.createdAt = Date.now();
          if (typeof nextData.count !== 'number') nextData.count = 0;
          shortcuts[name] = nextData;
          if (!existingKey) {
            usedNames[name] = true;
            imported++;
          }
        }
      }
      if (node.children) {
        let cat = (node.id !== folder.id) ? node.title : '';
        node.children.forEach(child => processNode(child, cat));
      }
    }

    if (children && children[0] && children[0].children) {
      children[0].children.forEach(child => processNode(child, ''));
    }

    if (Object.keys(shortcuts).length > 0) {
      await storageSet(shortcuts);
    }

    return { success: true, count: imported };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================
// BIDIRECTIONAL SYNC - Storage → Bookmarks
// When shortcuts change in 0tab, update the 0tab bookmark folder
// ============================================================
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  // Check if any shortcut keys changed (not just internal keys)
  let shortcutChanged = Object.keys(changes).some(isShortcutKey);
  if (!shortcutChanged) return;

  // Debounce: wait a bit then do a full sync
  withSyncLock(async () => {
    await syncShortcutsToBookmarks();
  });
});

// ============================================================
// BIDIRECTIONAL SYNC - Bookmarks → Storage
// When bookmarks inside the 0tab folder change, update shortcuts
// ============================================================

// Read-only lookup for the 0tab bookmark folder (never creates or renames).
// Mirrors getOrCreateBookmarkFolder's search — global, legacy names included —
// so the two never disagree about whether the folder exists (e.g. when the
// user has nested it or still has a pre-rebrand name).
async function getTab0Folder() {
  try {
    let hits = await new Promise(r => { chrome.bookmarks.search({ title: TAB0_FOLDER_NAME }, r); });
    let folder = (hits || []).find(b => !b.url);
    if (folder) return folder;
    let otherBmId = await getOtherBookmarksFolderId();
    for (let nm of ['Tab0 AI', 'Tab0 Shortcuts', 'Tab0']) {
      let legacyHits = await new Promise(r => { chrome.bookmarks.search({ title: nm }, r); });
      let legacy = (legacyHits || []).find(b => !b.url && (b.parentId === otherBmId || nm === 'Tab0 Shortcuts' || nm === 'Tab0 AI'));
      if (legacy) return legacy;
    }
    return null;
  } catch (e) { return null; }
}

// Helper: check if a bookmark node is inside the 0tab folder
async function isInsideTab0Folder(bookmarkId) {
  try {
    let tab0Folder = await getTab0Folder();
    if (!tab0Folder || !tab0Folder.id) return false;
    let node = await new Promise(resolve => {
      chrome.bookmarks.get(bookmarkId, (results) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(results ? results[0] : null);
      });
    });
    if (!node) return false;

    // Walk up the parent chain
    let currentId = node.parentId;
    while (currentId) {
      if (currentId === tab0Folder.id) return true;
      try {
        let parent = await new Promise(resolve => {
          chrome.bookmarks.get(currentId, (results) => resolve(results ? results[0] : null));
        });
        if (!parent) return false;
        currentId = parent.parentId;
      } catch (e) {
        return false;
      }
    }
    return false;
  } catch (e) {
    return false;
  }
}

// Debounced "every bookmark should have a 0tab shortcut" reconcile.
// Coalesces bursts (CSV imports, Chrome Sync) into a single sweep.
let _reconcileShortcutsTimer = null;
function _scheduleReconcileShortcuts() {
  if (_reconcileShortcutsTimer) clearTimeout(_reconcileShortcutsTimer);
  _reconcileShortcutsTimer = setTimeout(async function () {
    _reconcileShortcutsTimer = null;
    try {
      let res = await storageGet(['__0tab_settings']);
      let s = res['__0tab_settings'] || {};
      if (s.bookmarkSync === false) return; // user opted out of auto-shortcutting
      await saveAllBookmarksAsShortcuts();
      notifyDashboard('bookmarkChanged');
    } catch (e) {}
  }, 500);
}

// When a bookmark is created anywhere in the tree, ensure it has a 0tab
// shortcut. Bookmarks inside the 0tab folder still take the existing
// fast path (which preserves the parent-folder name on the shortcut);
// everything else triggers the debounced reconcile so it picks up a
// shortcut on the next tick.
chrome.bookmarks.onCreated.addListener((id, bookmark) => {
  if (!bookmark.url) return; // Ignore folder creation

  withSyncLock(async () => {
    if (await isInsideTab0Folder(id)) {
      // Determine the folder name from the parent
      let tab0Folder = await getOrCreateBookmarkFolder();
      if (!tab0Folder || !tab0Folder.id) return;
      let parentNode = await new Promise(resolve => {
        chrome.bookmarks.get(bookmark.parentId, (results) => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(results ? results[0] : null);
        });
      });
      let folderName = (parentNode && parentNode.id !== tab0Folder.id) ? parentNode.title : '';

      let items = await storageGet(null);
      let existingKey = findShortcutKeyForBookmark(items, bookmark.id) || findShortcutKeyForUrl(items, bookmark.url);
      let name = existingKey;
      if (!name) {
        let usedNames = {};
        Object.keys(items).filter(isShortcutKey).forEach(k => { usedNames[k] = true; });
        name = uniqueShortcutNameFromBase(shortcutBaseFromTitle(bookmark.title, 'bm'), usedNames, {});
      }
      if (!name) return;

      let oldData = existingKey ? items[existingKey] : {};
      let nextData = (oldData && typeof oldData === 'object') ? Object.assign({}, oldData) : {};
      nextData.url = bookmark.url;
      nextData.count = typeof nextData.count === 'number' ? nextData.count : 0;
      nextData.folder = folderName || nextData.folder || '';
      nextData.bookmarkId = bookmark.id;
      nextData.bookmarkTitle = bookmark.title;
      if (!nextData.tags) nextData.tags = [];
      if (!nextData.createdAt) nextData.createdAt = Date.now();

      await storageSet({ [name]: nextData });

      notifyDashboard('bookmarkChanged');
    } else {
      // Outside the 0tab folder — reconcile so this (and any sibling
      // bookmarks created in the same burst) gets a shortcut.
      _scheduleReconcileShortcuts();
    }
  });
});

// When a bookmark is removed from 0tab folder
chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
  withSyncLock(async () => {
    // The bookmark is already removed so we can't check isInsideTab0Folder.
    // Check if any shortcut references this bookmark ID and remove it.
    try {
      let items = await storageGet(null);
      let keysToRemove = Object.keys(items).filter(isShortcutKey).filter(k => {
        let data = items[k];
        return typeof data === 'object' && data.bookmarkId === id;
      });
      if (keysToRemove.length > 0) {
        await storageRemove(keysToRemove);
        notifyDashboard('bookmarkChanged');
      }
    } catch (e) { /* ignore */ }
  });
});

// When a bookmark is changed (title/url) inside 0tab folder
chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
  withSyncLock(async () => {
    if (!(await isInsideTab0Folder(id))) return;
    // Reimport to pick up changes
    await importBookmarksAsShortcuts();
    notifyDashboard('bookmarkChanged');
  });
});

// When a bookmark is moved (between folders) — only act if it involves the 0tab folder
chrome.bookmarks.onMoved.addListener((id, moveInfo) => {
  withSyncLock(async () => {
    let tab0Folder = await getTab0Folder();
    if (!tab0Folder) return;
    let isInside = await isInsideTab0Folder(id);
    let wasInParent = moveInfo.oldParentId === tab0Folder.id;
    if (!isInside && !wasInParent) return;
    await importBookmarksAsShortcuts();
    notifyDashboard('bookmarkChanged');
  });
});

// Notify dashboard tabs to refresh
function notifyDashboard(action) {
  chrome.runtime.sendMessage({ action: action }, () => {
    // Suppress error if no listeners (dashboard not open)
    void chrome.runtime.lastError;
  });
}

// ============================================================
// AUTO-SAVE ALL BOOKMARKS AS 0TAB SHORTCUTS
// Converts bookmark name to lowercase no-space form.
// If clashing, appends 1, 2, etc.
// ============================================================
// Auto-save all existing bookmarks as 0tab shortcuts in storage only.
// Does NOT copy bookmarks into the 0tab folder — they stay in place.
// Each shortcut stores bookmarkId so we know it's linked to a real bookmark.
async function saveAllBookmarksAsShortcuts() {
  try {
    let tree = await new Promise(resolve => chrome.bookmarks.getTree(resolve));
    let existing = await storageGet(null);
    let usedNames = {};
    Object.keys(existing).filter(isShortcutKey).forEach(k => { usedNames[k] = true; });

    // Also build a set of bookmark IDs that already have shortcuts
    let linkedBookmarkIds = {};
    Object.keys(existing).filter(isShortcutKey).forEach(k => {
      let data = existing[k];
      if (typeof data === 'object' && data.bookmarkId) {
        linkedBookmarkIds[data.bookmarkId] = true;
      }
    });

    let existingUrlToKey = {};
    Object.keys(existing).filter(isShortcutKey).forEach(k => {
      let data = existing[k];
      if (data && typeof data === 'object' && data.type === 'folder') return;
      let url = typeof data === 'object' ? (data.url || '') : (data || '');
      let normalized = normalizeUrlForMatch(url);
      if (normalized && !existingUrlToKey[normalized]) existingUrlToKey[normalized] = k;
    });

    let bookmarks = [];
    function walk(node) {
      if (node.url) bookmarks.push(node);
      if (node.children) node.children.forEach(walk);
    }
    tree.forEach(walk);

    let created = 0;
    let importSkipped = 0;
    let toSave = {};

    for (let bm of bookmarks) {
      if (!bm.url || !bm.title) continue;
      // Skip if this bookmark already has a shortcut linked
      if (linkedBookmarkIds[bm.id]) continue;

      // If the user already saved this URL under a custom shortcut name,
      // link that key to the bookmark instead of creating a generated key.
      let normalizedUrl = normalizeUrlForMatch(bm.url);
      let existingUrlKey = existingUrlToKey[normalizedUrl];
      if (existingUrlKey) {
        let oldData = existing[existingUrlKey];
        let nextData = (oldData && typeof oldData === 'object') ? Object.assign({}, oldData) : { url: bm.url, count: 0 };
        nextData.url = bm.url;
        nextData.bookmarkId = bm.id;
        if (!nextData.bookmarkTitle) nextData.bookmarkTitle = bm.title;
        if (!nextData.tags) nextData.tags = [];
        if (!nextData.createdAt) nextData.createdAt = Date.now();
        toSave[existingUrlKey] = nextData;
        linkedBookmarkIds[bm.id] = true;
        continue;
      }

      // Generate shortcut name: lowercase, remove spaces and special chars
      let baseName = shortcutBaseFromTitle(bm.title, 'bookmark');

      let finalName = baseName;

      // Only add number suffix if the EXACT same name is taken by a DIFFERENT bookmark/shortcut
      if (usedNames[finalName] || toSave[finalName]) {
        // Check if the existing shortcut with this name is actually linked to THIS bookmark
        let existingData = existing[finalName];
        if (existingData && typeof existingData === 'object' && existingData.bookmarkId === bm.id) {
          // Already linked to this bookmark, skip
          continue;
        }
        // True clash with a different bookmark — add number suffix
        let counter = 2;
        while (usedNames[finalName] || toSave[finalName]) {
          let suffix = String(counter);
          finalName = baseName.substring(0, 15 - suffix.length) + suffix;
          counter++;
          if (counter > 999) break;
        }
      }

      if (finalName && finalName.length <= 15) {
        // Auto-generate tags from bookmark title and URL
        let autoTags = [];
        try {
          let hostname = new URL(bm.url).hostname.replace('www.', '');
          let domainTag = hostname.split('.')[0];
          if (domainTag && domainTag.length > 1) autoTags.push(domainTag);
        } catch (e) {}
        let titleWords = (bm.title || '').toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 2 && !['the', 'and', 'for', 'com', 'www', 'http', 'https', 'org', 'net'].includes(w));
        titleWords.forEach(w => {
          if (autoTags.length < 3 && !autoTags.includes(w)) autoTags.push(w);
        });
        let urlStr = (bm.url || '').toLowerCase();
        if (autoTags.length < 3) {
          if (urlStr.includes('github') || urlStr.includes('gitlab')) { if (!autoTags.includes('dev')) autoTags.push('dev'); }
          else if (urlStr.includes('docs.') || urlStr.includes('/docs') || urlStr.includes('wiki')) { if (!autoTags.includes('docs')) autoTags.push('docs'); }
          else if (urlStr.includes('mail.') || urlStr.includes('gmail') || urlStr.includes('outlook')) { if (!autoTags.includes('email')) autoTags.push('email'); }
          else if (urlStr.includes('drive.') || urlStr.includes('dropbox') || urlStr.includes('cloud')) { if (!autoTags.includes('cloud')) autoTags.push('cloud'); }
          else if (urlStr.includes('youtube') || urlStr.includes('vimeo') || urlStr.includes('video')) { if (!autoTags.includes('video')) autoTags.push('video'); }
          else if (urlStr.includes('slack') || urlStr.includes('discord') || urlStr.includes('teams')) { if (!autoTags.includes('chat')) autoTags.push('chat'); }
          else if (urlStr.includes('figma') || urlStr.includes('canva') || urlStr.includes('design')) { if (!autoTags.includes('design')) autoTags.push('design'); }
          else if (urlStr.includes('support') || urlStr.includes('desk') || urlStr.includes('helpdesk')) { if (!autoTags.includes('support')) autoTags.push('support'); }
        }
        autoTags = autoTags.slice(0, 3);

        toSave[finalName] = {
          url: bm.url,
          count: 0,
          bookmarkId: bm.id,
          bookmarkTitle: bm.title,
          tags: autoTags,
          createdAt: Date.now()
        };
        usedNames[finalName] = true;
        existingUrlToKey[normalizedUrl] = finalName;
        created++;
      }
    }

    if (Object.keys(toSave).length > 0) {
      // Protect against excessive shortcut creation. Existing-key metadata
      // updates are always kept because they preserve user shortcut names.
      let currentCount = Object.keys(existing).length;
      let toSaveKeys = Object.keys(toSave);
      let updateKeys = toSaveKeys.filter(k => k in existing);
      let createKeys = toSaveKeys.filter(k => !(k in existing));
      let availableSlots = Math.max(0, 500 - currentCount); // Leave 12 slots as buffer

      if (createKeys.length > availableSlots) {
        // Refuse the overflow BEFORE writing so we never report items as
        // imported that were silently dropped.
        importSkipped = createKeys.length - availableSlots;
        console.warn('0tab: Limiting bookmark import from ' + createKeys.length + ' to ' + availableSlots + ' to avoid quota limits (' + importSkipped + ' skipped)');
        createKeys = createKeys.slice(0, availableSlots);
        let limited = {};
        updateKeys.forEach(k => { limited[k] = toSave[k]; });
        createKeys.forEach(k => { limited[k] = toSave[k]; });
        toSave = limited;
      }

      // Save in batches to avoid per-call size limits, counting only what
      // was actually written so the returned result is accurate.
      let createKeySet = {};
      createKeys.forEach(k => { createKeySet[k] = true; });
      let savedCreated = 0;
      let batchSize = 50;
      let allKeys = Object.keys(toSave);
      for (let i = 0; i < allKeys.length; i += batchSize) {
        let batchKeys = allKeys.slice(i, i + batchSize);
        let batch = {};
        batchKeys.forEach(k => { batch[k] = toSave[k]; });
        try {
          await storageSet(batch);
          batchKeys.forEach(k => { if (createKeySet[k]) savedCreated++; });
        } catch (e) {
          console.error('0tab: Batch save failed at index ' + i + ':', e.message);
          // Everything from this batch onward was not written — count it as skipped
          allKeys.slice(i).forEach(k => { if (createKeySet[k]) importSkipped++; });
          break; // Stop saving if we hit quota
        }
      }
      created = savedCreated;
    }

    // STEP 5: Auto-generate folder-type shortcuts for Chrome bookmark folders
    let freshItems = await storageGet(null);
    let folderUsedNames = {};
    Object.keys(freshItems).filter(isShortcutKey).forEach(k => { folderUsedNames[k] = true; });

    let bmTree = await new Promise(resolve => chrome.bookmarks.getTree(resolve));
    let folderShortcuts = {};

    function walkForFolders(node, depth) {
      if (node.children && node.title && depth > 0) {
        let childUrls = node.children.filter(c => c.url);
        if (childUrls.length > 0) {
          // Check if a folder shortcut already exists for this bookmark folder
          let alreadyExists = Object.keys(freshItems).filter(isShortcutKey).some(k => {
            let d = freshItems[k];
            return typeof d === 'object' && d.type === 'folder' &&
              (String(d.folderId || '') === String(node.id) || String(d.bmFolderId || '') === String(node.id));
          });

          if (!alreadyExists) {
            // Generate short name from folder title
            let baseName = node.title.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (!baseName) baseName = 'folder';
            baseName = baseName.substring(0, 3);
            let finalName = baseName;
            let counter = 2;
            while (folderUsedNames[finalName] || folderShortcuts[finalName]) {
              let suffix = String(counter);
              finalName = baseName.substring(0, 3) + suffix;
              counter++;
              if (counter > 999) break;
            }

            folderShortcuts[finalName] = {
              type: 'folder',
              folderTitle: node.title,
              folderId: node.id,
              bmFolderId: node.id,
              urls: childUrls.map(c => c.url),
              urlTitles: childUrls.map(c => c.title || ''),
              count: 0,
              tags: [],
              createdAt: Date.now()
            };
            folderUsedNames[finalName] = true;
          }
        }
        // Walk sub-folders
        node.children.filter(c => !c.url && c.children).forEach(sf => walkForFolders(sf, depth + 1));
      } else if (node.children) {
        node.children.forEach(child => walkForFolders(child, depth + 1));
      }
    }
    if (bmTree[0]) walkForFolders(bmTree[0], 0);

    if (Object.keys(folderShortcuts).length > 0) {
      let currentCount = Object.keys(freshItems).length;
      let availSlots = Math.max(0, 500 - currentCount);
      let fKeys = Object.keys(folderShortcuts).slice(0, availSlots);
      let fBatch = {};
      fKeys.forEach(k => { fBatch[k] = folderShortcuts[k]; });
      if (Object.keys(fBatch).length > 0) {
        try { await storageSet(fBatch); } catch (e) {
          console.warn('0tab: Folder shortcut auto-gen failed:', e.message);
        }
      }
    }

    return {
      success: true,
      count: created, // kept for backward compatibility with existing callers
      imported: created,
      skipped: importSkipped,
      reason: importSkipped > 0 ? 'quota' : null
    };
  } catch (err) {
    console.error('0tab: saveAllBookmarksAsShortcuts error:', err.message);
    return { success: false, error: err.message };
  }
}

// ============================================================
// RECONCILIATION — full two-way sync between bookmarks and shortcuts.
//   1) Every Chrome bookmark gets a 0tab shortcut (if not already linked).
//   2) Every 0tab shortcut (with a URL) that has no linked bookmark gets
//      a bookmark created inside the canonical 0tab AI folder.
// Idempotent — safe to run on every dashboard load.
// ============================================================
async function reconcileBookmarksShortcuts() {
  let result = { shortcutsCreated: 0, bookmarksCreated: 0, folderId: null };
  try {
    // Part 1 — make sure every bookmark has a shortcut
    let fromBm = await saveAllBookmarksAsShortcuts();
    if (fromBm && fromBm.count) result.shortcutsCreated = fromBm.count;

    // Part 2 — make sure every URL-style shortcut has a bookmark
    let folder = await getOrCreateBookmarkFolder();
    if (!folder || !folder.id) return result;
    result.folderId = folder.id;

    let items = await storageGet(null);
    let shortcutKeys = Object.keys(items).filter(isShortcutKey);

    // Build a set of existing bookmark URLs so we don't duplicate when a
    // shortcut's bookmarkId is stale but the same URL is bookmarked elsewhere.
    let existingBmByUrl = {};
    let existingBmByIdValid = {};
    let tree = await new Promise(function (r) { chrome.bookmarks.getTree(function (t) { r(t || []); }); });
    function walk(node) {
      if (!node) return;
      if (node.url) {
        let key = node.url.replace(/\/+$/, '').toLowerCase();
        existingBmByUrl[key] = node;
        existingBmByIdValid[node.id] = true;
      }
      if (node.children) node.children.forEach(walk);
    }
    if (tree[0]) (tree[0].children || []).forEach(walk);

    let writes = {};
    for (let key of shortcutKeys) {
      let data = items[key];
      if (typeof data === 'string') data = { url: data };
      if (!data || typeof data !== 'object') continue;
      if (data.type === 'folder') continue; // folder-type shortcuts have their own ID
      let url = data.url || '';
      if (!url) continue;

      // If the stored bookmarkId no longer exists in the tree, null it
      if (data.bookmarkId && !existingBmByIdValid[data.bookmarkId]) {
        data.bookmarkId = undefined;
      }

      if (data.bookmarkId) continue; // already linked and valid

      let normalized = url.replace(/\/+$/, '').toLowerCase();
      let existingBm = existingBmByUrl[normalized];
      if (existingBm) {
        // Link to an existing bookmark rather than create a duplicate
        data.bookmarkId = existingBm.id;
        if (!data.bookmarkTitle) data.bookmarkTitle = existingBm.title || key;
        writes[key] = data;
        continue;
      }

      // Create a new bookmark inside the 0tab AI folder
      try {
        let bm = await new Promise(function (resolve, reject) {
          chrome.bookmarks.create({
            parentId: folder.id,
            title: data.bookmarkTitle || key,
            url: url
          }, function (node) {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(node);
          });
        });
        data.bookmarkId = bm.id;
        if (!data.bookmarkTitle) data.bookmarkTitle = key;
        writes[key] = data;
        result.bookmarksCreated++;
        // Update cache for subsequent iterations
        existingBmByUrl[normalized] = bm;
        existingBmByIdValid[bm.id] = true;
      } catch (e) {
        console.warn('0tab: reconcile bookmark create failed for', key, ':', e && e.message);
      }
    }

    if (Object.keys(writes).length > 0) {
      try { await storageSet(writes); } catch (e) {
        console.warn('0tab: reconcile storage write failed:', e && e.message);
      }
    }
  } catch (e) {
    console.warn('0tab: reconcile error:', e && e.message);
  }
  return result;
}

// ============================================================
// MESSAGE LISTENER
// ============================================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'syncToBookmarks') {
    withSyncLock(() => syncShortcutsToBookmarks()).then(sendResponse);
    return true;
  }
  if (request.action === 'importFromBookmarks') {
    withSyncLock(() => importBookmarksAsShortcuts()).then(sendResponse);
    return true;
  }
  if (request.action === 'getTab0FolderId') {
    getOrCreateBookmarkFolder().then(folder => sendResponse(folder ? folder.id : undefined));
    return true;
  }
  if (request.action === 'getBookmarkTree') {
    chrome.bookmarks.getTree((tree) => sendResponse(tree));
    return true;
  }
  if (request.action === 'moveBookmark') {
    chrome.bookmarks.move(request.id, { parentId: request.parentId, index: request.index }, (result) => {
      if (chrome.runtime.lastError) { sendResponse({ error: chrome.runtime.lastError.message }); return; }
      sendResponse(result);
    });
    return true;
  }
  if (request.action === 'updateBookmark') {
    let changes = {};
    if (request.title !== undefined) changes.title = request.title;
    if (request.url !== undefined) changes.url = request.url;
    chrome.bookmarks.update(request.id, changes, (result) => {
      if (chrome.runtime.lastError) { sendResponse({ error: chrome.runtime.lastError.message }); return; }
      // If a parentId move is also requested, do that too
      if (request.parentId) {
        chrome.bookmarks.move(request.id, { parentId: request.parentId }, (moveResult) => {
          if (chrome.runtime.lastError) { sendResponse({ error: chrome.runtime.lastError.message }); return; }
          sendResponse(moveResult);
        });
      } else {
        sendResponse(result);
      }
    });
    return true;
  }
  if (request.action === 'removeBookmark') {
    chrome.bookmarks.remove(request.id, () => {
      if (chrome.runtime.lastError) { sendResponse({ error: chrome.runtime.lastError.message }); return; }
      sendResponse({ success: true });
    });
    return true;
  }
  if (request.action === 'saveAllBookmarksAsShortcuts') {
    saveAllBookmarksAsShortcuts().then(sendResponse);
    return true;
  }
  // Full two-way reconcile: bookmarks ↔ shortcuts, and gather loose
  // shortcuts into the 0tab AI folder.
  if (request.action === 'reconcileBookmarksShortcuts') {
    withSyncLock(function () { return reconcileBookmarksShortcuts(); })
      .then(function (res) {
        if (res && res.queued) {
          // Another sync holds the lock; the reconcile will run after it.
          // Zero counts keep older callers rendering sanely.
          sendResponse({ queued: true, shortcutsCreated: 0, bookmarksCreated: 0 });
          return;
        }
        sendResponse(res || { shortcutsCreated: 0, bookmarksCreated: 0 });
      })
      .catch(function (e) {
        // Without this, a rejected promise would leave the caller's
        // sendMessage hanging forever (port stays open until service
        // worker recycles).
        sendResponse({ shortcutsCreated: 0, bookmarksCreated: 0, error: (e && e.message) || 'unknown' });
      });
    return true;
  }
  // Get the shortcut key linked to a specific bookmark ID
  if (request.action === 'getShortcutForBookmark') {
    storageGet(null).then(function (items) {
      items = items || {};
      let found = null;
      Object.keys(items).filter(isShortcutKey).forEach(function (key) {
        let data = items[key];
        if (typeof data === 'object' && data.bookmarkId === request.bookmarkId) {
          found = { key: key, data: data };
        }
      });
      sendResponse(found);
    }).catch(function () { sendResponse(null); });
    return true;
  }
  // Batch version: get shortcut keys for multiple bookmark IDs in one call
  if (request.action === 'getShortcutsForBookmarks') {
    storageGet(null).then(function (items) {
      items = items || {};
      let result = {};
      let bookmarkIds = request.bookmarkIds || [];
      Object.keys(items).filter(isShortcutKey).forEach(function (key) {
        let data = items[key];
        if (typeof data === 'object' && bookmarkIds.includes(data.bookmarkId)) {
          result[data.bookmarkId] = { key: key, data: data };
        }
      });
      sendResponse(result);
    }).catch(function () { sendResponse({}); });
    return true;
  }
  // Update shortcut key (rename) for a bookmark-linked shortcut
  if (request.action === 'updateShortcutKey') {
    let oldKey = request.oldKey;
    let newKey = request.newKey;
    let extraData = request.extraData || {};
    // Run the read-modify-write under the sync lock so it can't interleave
    // with bookmark-sync writes and lose/duplicate shortcut keys.
    let responded = false;
    let respond = function (payload) { responded = true; sendResponse(payload); };
    withSyncLock(function () {
      return storageGet(oldKey).then(function (result) {
        let data = (result && result[oldKey]) || {};
        Object.assign(data, extraData);
        if (oldKey === newKey) {
          return storageSet({ [newKey]: data }).then(function () { respond({ success: true }); });
        }
        return storageRemove(oldKey).then(function () {
          return storageSet({ [newKey]: data }).then(function () { respond({ success: true }); });
        });
      }).catch(function (e) { respond({ success: false, error: e && e.message }); });
    }).then(function () {
      // withSyncLock skips fn entirely when a sync is already in progress;
      // still answer the caller instead of leaving the message hanging.
      if (!responded) sendResponse({ success: false, error: 'Sync in progress, try again' });
    });
    return true;
  }
  if (request.action === 'getDailyStats') {
    chrome.storage.local.get('__0tab_daily_stats', (result) => {
      sendResponse(result['__0tab_daily_stats'] || {});
    });
    return true;
  }
  if (request.action === 'getBookmarkFolders') {
    chrome.bookmarks.getTree((tree) => {
      let folders = [];
      function walkFolders(node, depth) {
        if (!node.url && node.title !== undefined) {
          folders.push({ id: node.id, title: node.title, depth: depth });
        }
        if (node.children) {
          node.children.forEach(child => walkFolders(child, depth + 1));
        }
      }
      if (tree[0] && tree[0].children) {
        tree[0].children.forEach(root => walkFolders(root, 0));
      }
      sendResponse(folders);
    });
    return true;
  }
  if (request.action === 'getBookmarkFoldersWithChildren') {
    chrome.bookmarks.getTree((tree) => {
      let folders = [];
      function walkFolders(node, depth) {
        // Skip root nodes (id "0") and top-level containers without titles
        if (node.children && node.title && depth > 0) {
          let children = node.children.filter(c => c.url); // only bookmarks, not sub-folders
          let subFolders = node.children.filter(c => !c.url && c.children);
          if (children.length > 0) {
            folders.push({
              id: node.id,
              title: node.title,
              depth: depth,
              children: children.map(c => ({ id: c.id, title: c.title, url: c.url }))
            });
          }
          // Also walk sub-folders
          subFolders.forEach(sf => walkFolders(sf, depth + 1));
        } else if (node.children) {
          node.children.forEach(child => walkFolders(child, depth + 1));
        }
      }
      if (tree[0]) {
        walkFolders(tree[0], 0);
      }
      sendResponse(folders);
    });
    return true;
  }
  // Open folder URLs in a tab group
  if (request.action === 'openFolderInTabGroup') {
    let urls = (request.urls || []).filter(isOpenableUrl);
    let groupName = request.groupName || 'Folder';
    let useTabGroup = request.useTabGroup !== false;

    (async () => {
      try {
        if (urls.length === 0) { sendResponse({ success: false }); return; }

        // Open first URL in current tab
        let [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        let tabIds = [];

        if (activeTab) {
          try {
            await chrome.tabs.update(activeTab.id, { url: urls[0] });
            tabIds.push(activeTab.id);
          } catch (uErr) {
            console.warn('0tab: openFolder tabs.update failed:', uErr && uErr.message);
          }
        } else {
          // No active tab — open the first URL as a new tab too
          try {
            let firstTab = await chrome.tabs.create({ url: urls[0], active: true });
            if (firstTab && firstTab.id) tabIds.push(firstTab.id);
          } catch (tErr) {
            console.warn('0tab: openFolder first tabs.create failed:', tErr && tErr.message);
          }
        }

        // Open rest in new tabs
        for (let i = 1; i < urls.length; i++) {
          try {
            let newTab = await chrome.tabs.create({ url: urls[i], active: false });
            if (newTab && newTab.id) tabIds.push(newTab.id);
          } catch (tErr) {
            console.warn('0tab: openFolder tabs.create failed for', urls[i], ':', tErr && tErr.message);
          }
        }

        // Create tab group if enabled
        if (useTabGroup && tabIds.length > 0) {
          try {
            let groupId = await chrome.tabs.group({ tabIds: tabIds });
            await chrome.tabGroups.update(groupId, { title: groupName, collapsed: false });
          } catch (gErr) {
            console.warn('0tab: Tab group creation failed:', gErr.message);
          }
        }

        sendResponse({ success: true });
      } catch (e) {
        console.warn('0tab: openFolderInTabGroup error:', e.message);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }
  // --- AI Feature Handlers ---
  if (request.action === 'ai:status') {
    // Always re-check (don't use cached) so settings page gets fresh status.
    // IMPORTANT: never mutate aiEnabled from here — doing so would override
    // the user's explicit off/on choice whenever any component polled the
    // status (e.g. the chat AI pill). The toggle in Settings is the only
    // writer; we just report availability.
    (async function () {
      let settings = await getAiSettings();
      if (settings.provider === 'openai') {
        // ChatGPT provider: usable iff an API key is configured.
        let hasKey = !!settings.openaiKey;
        sendResponse({
          available: hasKey,
          status: hasKey ? 'readily' : 'no-key',
          provider: 'openai',
          model: settings.openaiModel,
          features: settings.features
        });
        return;
      }
      aiAvailability = null;
      let status = await checkAiAvailability();
      // Only 'readily' means prompts will actually work — 'downloadable' /
      // 'downloading' surface the download UI but must not enable AI calls.
      sendResponse({ available: status === 'readily', status: status, provider: 'nano', features: settings.features });
    })();
    return true;
  }
  // Validate an OpenAI API key with a cheap models-list call (never stored here;
  // the settings page persists it separately).
  if (request.action === 'ai:testKey') {
    (async function () {
      let key = String(request.key || '').trim();
      if (!key) { sendResponse({ ok: false, error: 'No API key provided' }); return; }
      let controller = new AbortController();
      let timer = setTimeout(function () { controller.abort(); }, 15000);
      try {
        let res = await fetch('https://api.openai.com/v1/models', {
          headers: { 'Authorization': 'Bearer ' + key },
          signal: controller.signal
        });
        if (res.ok) sendResponse({ ok: true });
        else if (res.status === 401) sendResponse({ ok: false, error: 'Invalid API key' });
        else if (res.status === 429) sendResponse({ ok: false, error: 'Key is valid but rate-limited or out of quota' });
        else sendResponse({ ok: false, error: 'OpenAI returned HTTP ' + res.status });
      } catch (e) {
        sendResponse({ ok: false, error: 'Network error: ' + (e && e.message) });
      } finally {
        clearTimeout(timer);
      }
    })();
    return true;
  }
  if (request.action === 'ai:download') {
    (async function () {
      let ok = await ensureOffscreen();
      if (!ok) { sendResponse({ error: 'Cannot create offscreen document' }); return; }
      let resp = await sendToOffscreen('ai:download', {}, 300000); // 5 min timeout for download
      if (resp && resp.ok) {
        // Model downloaded — auto-enable AI
        aiAvailability = 'readily';
        try {
          let result = await storageGet('__0tab_settings');
          let settings = result['__0tab_settings'] || {};
          settings.aiEnabled = true;
          await storageSet({ '__0tab_settings': settings });
        } catch (e) { /* ignore */ }
        sendResponse({ ok: true });
      } else {
        sendResponse({ error: (resp && resp.error) || 'Download failed' });
      }
    })();
    return true;
  }
  if (request.action === 'ai:generateTags') {
    (async () => {
      if (!(await aiFeatureEnabled('tags'))) { sendResponse({ tags: null, disabled: true }); return; }
      let tags = await aiGenerateTags(request.title || '', request.url || '');
      sendResponse({ tags: tags });
    })();
    return true;
  }
  if (request.action === 'ai:search') {
    (async () => {
      if (!(await aiFeatureEnabled('search'))) { sendResponse({ results: null, disabled: true }); return; }
      let items = await storageGet(null);
      let shortcuts = Object.keys(items).filter(isShortcutKey).map(k => ({ key: k, data: items[k] }));
      let results = await aiSearchShortcuts(request.query || '', shortcuts);
      sendResponse({ results: results });
    })();
    return true;
  }
  if (request.action === 'ai:description') {
    (async () => {
      if (!(await aiFeatureEnabled('description'))) { sendResponse({ description: null, disabled: true }); return; }
      let desc = await aiGenerateDescription(request.title || '', request.url || '');
      sendResponse({ description: desc });
    })();
    return true;
  }
  if (request.action === 'ai:detectDuplicates') {
    (async () => {
      if (!(await aiFeatureEnabled('duplicates'))) { sendResponse({ duplicates: null, disabled: true }); return; }
      let items = await storageGet(null);
      let shortcuts = Object.keys(items).filter(isShortcutKey).map(k => ({ key: k, data: items[k] }));
      let dupes = await aiDetectDuplicates(request.title || '', request.url || '', shortcuts);
      sendResponse({ duplicates: dupes });
    })();
    return true;
  }
  if (request.action === 'ai:generateShortcutName') {
    (async () => {
      if (!(await aiFeatureEnabled('name'))) { sendResponse({ name: null, disabled: true }); return; }
      let items = await storageGet(null);
      let existingKeys = Object.keys(items).filter(isShortcutKey);
      let name = await aiGenerateShortcutName(request.title || '', request.url || '', existingKeys);
      sendResponse({ name: name });
    })();
    return true;
  }

  // AI free-form chat (for Ask 0tab)
  if (request.action === 'ai:chat') {
    (async () => {
      try {
        if (!(await aiFeatureEnabled('chat'))) { sendResponse({ text: null, disabled: true }); return; }
        let settings = await getAiSettings();
        let result = await aiPrompt(request.prompt || '', { plain: true });
        // Provider metadata lets the chat UI color its AI badge and show
        // the model on hover (green = ChatGPT, blue = Gemini Nano).
        sendResponse({
          text: result,
          provider: settings.provider,
          model: settings.provider === 'openai' ? settings.openaiModel : 'gemini-nano'
        });
      } catch (e) {
        console.warn('0tab AI chat error:', e.message);
        sendResponse({ text: null });
      }
    })();
    return true;
  }
});
