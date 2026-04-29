// ============================================================
// 0TAB - Background Service Worker
// Handles: omnibox, context menu, bookmark sync, defaults
// ============================================================

// Uninstall feedback form — fires when the user removes the extension.
try { chrome.runtime.setUninstallURL('https://tally.so/r/1AbzB4'); } catch (e) {}

// --- Internal storage keys (prefixed to avoid conflicts) ---
// Any storage key starting with "__" is internal bookkeeping (settings,
// migration flags, stats, etc.) and must never be treated as a shortcut.
// Keeping this list explicit for known keys; the isShortcutKey helper
// also defensively rejects any "__"-prefixed key.
const INTERNAL_KEYS = ['__0tab_folders', '__0tab_settings', '__0tab_migrated_v1', '__0tab_migrated_v2', '__0tab_daily_stats', '__0tab_trash'];

function isShortcutKey(key) {
  if (!key || typeof key !== 'string') return false;
  if (key.startsWith('__')) return false;
  return !INTERNAL_KEYS.includes(key);
}

// ============================================================
// AI MODULE - Gemini Nano via Offscreen Document
// The Prompt API is only available in web contexts, not extension
// service workers. We use an offscreen document as a bridge.
// ============================================================
let aiAvailability = null; // 'readily' | 'after-download' | 'no' | null
let offscreenCreated = false;

async function ensureOffscreen() {
  if (offscreenCreated) return true;
  try {
    // Check if one already exists
    let existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')]
    });
    if (existingContexts.length > 0) {
      offscreenCreated = true;
      return true;
    }
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Gemini Nano Prompt API requires a web context'
    });
    offscreenCreated = true;
    return true;
  } catch (e) {
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

// Prompt the AI via the offscreen document
async function aiPrompt(promptText) {
  if (aiAvailability === 'no') return null;
  if (!aiAvailability) await checkAiAvailability();
  if (aiAvailability === 'no') return null;
  let ok = await ensureOffscreen();
  if (!ok) return null;
  let resp = await sendToOffscreen('ai:prompt', { prompt: promptText }, 30000);
  if (resp && resp.result) return resp.result;
  return null;
}

// --- AI Feature: Smart Auto-Tagging ---
async function aiGenerateTags(title, url) {
  try {
    let prompt = `Generate 3-5 short tags (1-2 words each, lowercase) for this bookmark.
Title: "${title}"
URL: ${url}

Return ONLY a JSON array of strings. Example: ["dev","react","github"]`;

    let response = await aiPrompt(prompt);
    if (!response) return null;
    let cleaned = response.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
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
      return `${s.key}|${title}|${url}|${tags}`;
    }).slice(0, 50).join('\n');

    let prompt = `Given these bookmarks (format: shortcut|title|url|tags):
${shortcutList}

The user searched: "${query}"

Return a JSON array of the top 5 matching shortcut names, best match first. Match by meaning, not just keywords.
Example: ["desk","admin","docs"]`;

    let response = await aiPrompt(prompt);
    if (!response) return null;
    let cleaned = response.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
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
    let existingList = existingKeys.slice(0, 30).join(', ');
    let prompt = `Generate a very short 0tab keyboard shortcut name (2-3 letters) for this bookmark.
Title: "${title}"
URL: ${url}

Rules:
- Lowercase only, no spaces, EXACTLY 2-3 characters
- Should be an abbreviation or initials related to the site
- Must NOT be any of these existing names: ${existingList}

Return ONLY a JSON string. Example: "fig" or "gd" or "jr"`;

    let response = await aiPrompt(prompt);
    if (!response) return null;
    let cleaned = response.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
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
Title: "${title}"
URL: ${url}

Return ONLY a JSON string. Example: "Project management tool for agile teams"`;

    let response = await aiPrompt(prompt);
    if (!response) return null;
    let cleaned = response.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
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
      return `${s.key}|${title}|${url}`;
    }).slice(0, 40).join('\n');

    let prompt = `I'm about to save a new bookmark:
Title: "${newTitle}"
URL: ${newUrl}

Here are existing bookmarks (shortcut|title|url):
${existing}

Are any of these duplicates or very similar? Return a JSON array of matching shortcut names, or empty array if none.
Example: ["desk"] or []`;

    let response = await aiPrompt(prompt);
    if (!response) return null;
    let cleaned = response.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
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

// --- Safely wrap chrome.storage calls ---
// Storage moved from chrome.storage.sync to chrome.storage.local to avoid
// sync quota failures. Existing sync data is migrated once.
let __0tabMigrationPromise = null;
function __0tabEnsureMigrated() {
  if (__0tabMigrationPromise) return __0tabMigrationPromise;
  __0tabMigrationPromise = new Promise(function (resolve) {
    try {
      chrome.storage.local.get('__0tab_migrated_v1', function (flagRes) {
        if (chrome.runtime.lastError || (flagRes && flagRes.__0tab_migrated_v1)) {
          resolve(); return;
        }
        chrome.storage.sync.get(null, function (syncData) {
          if (chrome.runtime.lastError || !syncData || Object.keys(syncData).length === 0) {
            chrome.storage.local.set({ '__0tab_migrated_v1': true }, function () { resolve(); });
            return;
          }
          chrome.storage.local.get(null, function (localData) {
            let toCopy = {};
            Object.keys(syncData).forEach(function (k) {
              if (!(k in localData)) toCopy[k] = syncData[k];
            });
            if (Object.keys(toCopy).length === 0) {
              chrome.storage.local.set({ '__0tab_migrated_v1': true }, function () { resolve(); });
              return;
            }
            chrome.storage.local.set(toCopy, function () {
              chrome.storage.local.set({ '__0tab_migrated_v1': true }, function () { resolve(); });
            });
          });
        });
      });
    } catch (e) { resolve(); }
  });
  return __0tabMigrationPromise;
}
__0tabEnsureMigrated();

// v2 migration: rebrand from Tab0 AI → 0tab AI. Renames the legacy `__ssg_*`
// and `__tab0_*` storage keys to `__0tab_*`. Idempotent and gated by
// `__0tab_migrated_v2`. Runs once per install after the v1 sync→local
// migration completes.
const __0TAB_KEY_RENAME_MAP = {
  '__ssg_folders': '__0tab_folders',
  '__ssg_settings': '__0tab_settings',
  '__ssg_trash': '__0tab_trash',
  '__tab0_migrated_v1': '__0tab_migrated_v1',
  '__tab0_daily_stats': '__0tab_daily_stats',
  '__tab0_history_imported_v1': '__0tab_history_imported_v1',
  '__tab0_history_dismissed_v1': '__0tab_history_dismissed_v1'
};
let __0tabMigrationV2Promise = null;
function __0tabEnsureMigratedV2() {
  if (__0tabMigrationV2Promise) return __0tabMigrationV2Promise;
  __0tabMigrationV2Promise = __0tabEnsureMigrated().then(function () {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get('__0tab_migrated_v2', function (flagRes) {
          if (chrome.runtime.lastError || (flagRes && flagRes.__0tab_migrated_v2)) {
            resolve(); return;
          }
          chrome.storage.local.get(null, function (all) {
            if (chrome.runtime.lastError) { resolve(); return; }
            all = all || {};
            let writes = {};
            let removes = [];
            Object.keys(__0TAB_KEY_RENAME_MAP).forEach(function (oldK) {
              let newK = __0TAB_KEY_RENAME_MAP[oldK];
              if (oldK in all) {
                if (!(newK in all)) writes[newK] = all[oldK];
                removes.push(oldK);
              }
            });
            // Order: writes → removes → flag. The migrated_v2 flag is set
            // ONLY after both writes and removes succeed without lastError;
            // if either fails we resolve without setting the flag so the
            // next load retries. Old keys may briefly co-exist with new
            // keys mid-migration — readers go through the rename map.
            function finish() {
              chrome.storage.local.set({ '__0tab_migrated_v2': true }, function () { resolve(); });
            }
            function doRemove() {
              if (removes.length === 0) { finish(); return; }
              chrome.storage.local.remove(removes, function () {
                if (chrome.runtime.lastError) { resolve(); return; }
                finish();
              });
            }
            if (Object.keys(writes).length === 0) {
              doRemove();
            } else {
              chrome.storage.local.set(writes, function () {
                if (chrome.runtime.lastError) { resolve(); return; }
                doRemove();
              });
            }
          });
        });
      } catch (e) { resolve(); }
    });
  });
  return __0tabMigrationV2Promise;
}
__0tabEnsureMigratedV2();

function storageGet(keys) {
  return __0tabEnsureMigratedV2().then(function () {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.get(keys, function (result) {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result);
      });
    });
  });
}

function storageSet(data) {
  return __0tabEnsureMigratedV2().then(function () {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.set(data, function () {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  });
}

function storageRemove(keys) {
  return __0tabEnsureMigratedV2().then(function () {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.remove(keys, function () {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  });
}

// One-shot catch-up sweep so every existing Chrome bookmark — not just
// those created after this build was installed — picks up a 0tab
// shortcut. Gated by a session flag so we run it once per browser
// session, not every time the service worker wakes.
const _SESSION_RECONCILE_KEY = '__0tab_session_reconciled';
async function _maybeReconcileExistingBookmarks() {
  try {
    if (!chrome.storage.session) return;
    let flag = await new Promise(function (resolve) {
      chrome.storage.session.get(_SESSION_RECONCILE_KEY, function (r) { resolve(r && r[_SESSION_RECONCILE_KEY]); });
    });
    if (flag) return;
    // Mark BEFORE running so two near-simultaneous wakes don't double-run.
    await new Promise(function (resolve) {
      chrome.storage.session.set({ [_SESSION_RECONCILE_KEY]: true }, function () { resolve(); });
    });
    let res = await storageGet(['__0tab_settings']);
    let s = res['__0tab_settings'] || {};
    if (s.bookmarkSync === false) return;
    await saveAllBookmarksAsShortcuts();
  } catch (e) { /* silent */ }
}
// Defer slightly so the migration helpers and folder rename complete first.
setTimeout(_maybeReconcileExistingBookmarks, 1500);


// ============================================================
// SYNC LOCK - Prevents infinite loops between bookmark and
// storage listeners triggering each other
// ============================================================
let syncLock = false;

function withSyncLock(fn) {
  if (syncLock) return Promise.resolve();
  syncLock = true;
  return fn().finally(() => {
    setTimeout(() => { syncLock = false; }, 2000);
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

        // STEP 3: Remove old bookmark-linked shortcuts and re-import all bookmarks cleanly
        let refreshed = await storageGet(null);
        let toRemove = [];
        Object.keys(refreshed).filter(isShortcutKey).forEach(k => {
          let data = refreshed[k];
          if (typeof data === 'object' && data.bookmarkId) {
            toRemove.push(k);
          }
        });
        if (toRemove.length > 0) {
          await storageRemove(toRemove);
        }

        // STEP 4: Re-import all Chrome bookmarks as shortcuts (with clean names)
        await saveAllBookmarksAsShortcuts();

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
        let urls = shortcutData.urls;
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
        if (disposition === 'currentTab') {
          chrome.tabs.update({ url: shortcutData.url });
        } else {
          chrome.tabs.create({ url: shortcutData.url });
        }
      } else {
        let newData = { url: shortcutData, count: 1, lastAccessed: Date.now(), folder: '' };
        await storageSet({ [text]: newData });
        logAccess(text, newData.url);
        if (disposition === 'currentTab') {
          chrome.tabs.update({ url: newData.url });
        } else {
          chrome.tabs.create({ url: newData.url });
        }
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
          let urls = bestData.urls;
          if (urls.length > 0) {
            if (disposition === 'currentTab') {
              chrome.tabs.update({ url: urls[0] });
            } else {
              chrome.tabs.create({ url: urls[0] });
            }
            for (let i = 1; i < urls.length; i++) {
              chrome.tabs.create({ url: urls[i] });
            }
          }
        } else {
          let bestUrl = typeof bestData === 'object' ? bestData.url : bestData;
          if (bestUrl) {
            logAccess(bestKey, bestUrl);
            if (disposition === 'currentTab') {
              chrome.tabs.update({ url: bestUrl });
            } else {
              chrome.tabs.create({ url: bestUrl });
            }
          }
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
              let urls = aiData.urls;
              if (urls.length > 0) {
                if (disposition === 'currentTab') chrome.tabs.update({ url: urls[0] });
                else chrome.tabs.create({ url: urls[0] });
                for (let i = 1; i < urls.length; i++) chrome.tabs.create({ url: urls[i] });
              }
            } else {
              let aiUrl = typeof aiData === 'object' ? aiData.url : aiData;
              if (aiUrl) {
                if (disposition === 'currentTab') chrome.tabs.update({ url: aiUrl });
                else chrome.tabs.create({ url: aiUrl });
              }
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

    // Get existing children in the 0tab folder
    let children = await new Promise(resolve => {
      chrome.bookmarks.getChildren(folder.id, (result) => {
        if (chrome.runtime.lastError) { resolve([]); return; }
        resolve(result || []);
      });
    });

    // Remove all existing children (clean slate for 0tab folder only)
    for (let child of children) {
      try {
        if (child.url) {
          await new Promise(resolve => chrome.bookmarks.remove(child.id, resolve));
        } else {
          await new Promise(resolve => chrome.bookmarks.removeTree(child.id, resolve));
        }
      } catch (e) { /* ignore */ }
    }

    // Only sync shortcuts that are NOT linked to real bookmarks and NOT folder shortcuts
    let keys = Object.keys(items).filter(isShortcutKey);
    let standaloneKeys = keys.filter(key => {
      let data = items[key];
      if (typeof data === 'object' && data.type === 'folder') return false; // Skip folder shortcuts
      return !(typeof data === 'object' && data.bookmarkId);
    });

    // Put all standalone shortcuts directly in the 0tab Shortcuts folder (flat, no subfolders)
    for (let key of standaloneKeys) {
      let data = items[key];
      let url = typeof data === 'object' ? (data.url || '') : (data || '');
      if (url) {
        await new Promise(resolve => {
          chrome.bookmarks.create({
            parentId: folder.id,
            title: key,
            url: url
          }, resolve);
        });
      }
    }

    return { success: true, count: standaloneKeys.length };
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

    function processNode(node, category) {
      if (node.url) {
        let name = node.title.replace(/^\//, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 3);
        if (name && node.url) {
          shortcuts[name] = {
            url: node.url, count: 0, folder: category || '',
            bookmarkId: node.id, bookmarkTitle: node.title,
            tags: [], createdAt: Date.now()
          };
          imported++;
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

    if (imported > 0) {
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

// Helper: check if a bookmark node is inside the 0tab folder
async function isInsideTab0Folder(bookmarkId) {
  try {
    let tab0Folder = await getOrCreateBookmarkFolder();
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

      let name = bookmark.title.replace(/^\//, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 3);
      if (!name) return;

      await storageSet({ [name]: { url: bookmark.url, count: 0, folder: folderName, bookmarkId: bookmark.id, bookmarkTitle: bookmark.title, tags: [], createdAt: Date.now() } });

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

// When a bookmark is moved (between folders)
chrome.bookmarks.onMoved.addListener((id, moveInfo) => {
  withSyncLock(async () => {
    // Reimport to pick up the folder change
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

    let bookmarks = [];
    function walk(node) {
      if (node.url) bookmarks.push(node);
      if (node.children) node.children.forEach(walk);
    }
    tree.forEach(walk);

    let created = 0;
    let toSave = {};

    for (let bm of bookmarks) {
      if (!bm.url || !bm.title) continue;
      // Skip if this bookmark already has a shortcut linked
      if (linkedBookmarkIds[bm.id]) continue;

      // Generate shortcut name: lowercase, remove spaces and special chars
      let baseName = bm.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!baseName) baseName = 'bookmark';
      baseName = baseName.substring(0, 3);

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
          tags: autoTags
        };
        usedNames[finalName] = true;
        created++;
      }
    }

    if (Object.keys(toSave).length > 0) {
      // Protect against exceeding chrome.storage.sync limits
      // Max: 512 items total, 102,400 bytes total, 8,192 bytes per item
      let currentItems = await storageGet(null);
      let currentCount = Object.keys(currentItems).length;
      let toSaveKeys = Object.keys(toSave);
      let availableSlots = Math.max(0, 500 - currentCount); // Leave 12 slots as buffer

      if (toSaveKeys.length > availableSlots) {
        console.warn('0tab: Limiting bookmark import from ' + toSaveKeys.length + ' to ' + availableSlots + ' to avoid quota limits');
        let limited = {};
        toSaveKeys.slice(0, availableSlots).forEach(k => { limited[k] = toSave[k]; });
        toSave = limited;
        created = availableSlots;
      }

      // Save in batches to avoid per-call size limits
      let batchSize = 50;
      let allKeys = Object.keys(toSave);
      for (let i = 0; i < allKeys.length; i += batchSize) {
        let batch = {};
        allKeys.slice(i, i + batchSize).forEach(k => { batch[k] = toSave[k]; });
        try {
          await storageSet(batch);
        } catch (e) {
          console.error('0tab: Batch save failed at index ' + i + ':', e.message);
          break; // Stop saving if we hit quota
        }
      }
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
            return typeof d === 'object' && d.type === 'folder' && d.bmFolderId === node.id;
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
      let currentCount = Object.keys(await storageGet(null)).length;
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

    return { success: true, count: created };
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
  // Update shortcut key (rename) for a bookmark-linked shortcut
  if (request.action === 'updateShortcutKey') {
    let oldKey = request.oldKey;
    let newKey = request.newKey;
    let extraData = request.extraData || {};
    storageGet(oldKey).then(function (result) {
      let data = (result && result[oldKey]) || {};
      Object.assign(data, extraData);
      if (oldKey === newKey) {
        return storageSet({ [newKey]: data }).then(function () { sendResponse({ success: true }); });
      }
      return storageRemove(oldKey).then(function () {
        return storageSet({ [newKey]: data }).then(function () { sendResponse({ success: true }); });
      });
    }).catch(function (e) { sendResponse({ success: false, error: e && e.message }); });
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
    let urls = request.urls || [];
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
    aiAvailability = null;
    checkAiAvailability().then(function (status) {
      sendResponse({ available: status !== 'no', status: status });
    });
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
    aiGenerateTags(request.title || '', request.url || '').then(tags => {
      sendResponse({ tags: tags });
    });
    return true;
  }
  if (request.action === 'ai:search') {
    storageGet(null).then(async items => {
      let shortcuts = Object.keys(items).filter(isShortcutKey).map(k => ({ key: k, data: items[k] }));
      let results = await aiSearchShortcuts(request.query || '', shortcuts);
      sendResponse({ results: results });
    });
    return true;
  }
  if (request.action === 'ai:description') {
    aiGenerateDescription(request.title || '', request.url || '').then(desc => {
      sendResponse({ description: desc });
    });
    return true;
  }
  if (request.action === 'ai:detectDuplicates') {
    storageGet(null).then(async items => {
      let shortcuts = Object.keys(items).filter(isShortcutKey).map(k => ({ key: k, data: items[k] }));
      let dupes = await aiDetectDuplicates(request.title || '', request.url || '', shortcuts);
      sendResponse({ duplicates: dupes });
    });
    return true;
  }
  if (request.action === 'ai:generateShortcutName') {
    storageGet(null).then(async items => {
      let existingKeys = Object.keys(items).filter(isShortcutKey);
      let name = await aiGenerateShortcutName(request.title || '', request.url || '', existingKeys);
      sendResponse({ name: name });
    });
    return true;
  }

  // AI free-form chat (for Ask 0tab)
  if (request.action === 'ai:chat') {
    (async () => {
      try {
        let result = await aiPrompt(request.prompt || '');
        sendResponse({ text: result });
      } catch (e) {
        console.warn('0tab AI chat error:', e.message);
        sendResponse({ text: null });
      }
    })();
    return true;
  }
});
