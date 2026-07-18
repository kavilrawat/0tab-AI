// ============================================================
// 0TAB - Shared helpers (shared.js)
// Loaded by: popup.html (before popup.js), manage.html (before
// marked.min.js / tab0-chat.js / manage.js), and background.js
// (via importScripts). offscreen.js does NOT load this file.
//
// Contents:
//   - INTERNAL_KEYS, isShortcutKey
//   - Storage migrations: __0tabEnsureMigrated (v1 sync→local),
//     __0tabEnsureMigratedV2 (key rename) + __0TAB_KEY_RENAME_MAP
//     (localStorage fast-path is a no-op in the service worker —
//     the try/catch swallows the missing-localStorage error)
//   - storageGet / storageSet / storageRemove (migration-gated
//     promise wrappers around chrome.storage.local)
//   - sanitizeForPrompt (AI prompt-injection guard)
//   - debounce, runWhenIdle
//   - URL helpers: isValidUrl, isSaveableUrl
//   - escapeHtml
//   - Favicon/avatar UI helpers (DOM pages only; the service
//     worker must never call these): getFaviconUrl, AVATAR_COLORS,
//     createLetterAvatar, getChromeFaviconUrl, isRealFavicon,
//     createFaviconEl
// ============================================================

const INTERNAL_KEYS = ['__0tab_folders', '__0tab_settings', '__0tab_migrated_v1', '__0tab_migrated_v2', '__0tab_daily_stats', '__0tab_trash'];
function isShortcutKey(key) {
  if (!key || typeof key !== 'string') return false;
  if (key.startsWith('__')) return false;
  return !INTERNAL_KEYS.includes(key);
}

// --- Storage helpers ---
// Storage moved from chrome.storage.sync to chrome.storage.local to avoid
// the 102KB/8KB-per-item/120-writes-per-minute sync quotas that were
// silently dropping saves. Existing sync data is migrated once below.
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

// v2 migration: rebrand from Tab0 AI → 0tab AI. Renames legacy `__ssg_*` /
// `__tab0_*` storage keys to `__0tab_*`. Idempotent, gated on flag.
const __0TAB_KEY_RENAME_MAP = {
  '__ssg_folders': '__0tab_folders',
  '__ssg_settings': '__0tab_settings',
  '__ssg_trash': '__0tab_trash',
  '__tab0_migrated_v1': '__0tab_migrated_v1',
  '__tab0_daily_stats': '__0tab_daily_stats',
  '__tab0_history_imported_v1': '__0tab_history_imported_v1',
  '__tab0_history_dismissed_v1': '__0tab_history_dismissed_v1'
};
// Fast path: once both migrations are done on this profile, a synchronous
// localStorage flag lets every later popup open skip the storage.local
// flag reads (two IPC roundtrips that otherwise gate the first paint).
const __0TAB_MIGRATED_LS_KEY = '__0tab_migrations_done';
let __0tabMigrationV2Promise = null;
function __0tabEnsureMigratedV2() {
  if (__0tabMigrationV2Promise) return __0tabMigrationV2Promise;
  try {
    if (localStorage.getItem(__0TAB_MIGRATED_LS_KEY) === '1') {
      __0tabMigrationV2Promise = Promise.resolve();
      return __0tabMigrationV2Promise;
    }
  } catch (e) {}
  __0tabMigrationV2Promise = __0tabEnsureMigrated().then(function () {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get('__0tab_migrated_v2', function (flagRes) {
          if (chrome.runtime.lastError || (flagRes && flagRes.__0tab_migrated_v2)) {
            if (flagRes && flagRes.__0tab_migrated_v2) {
              try { localStorage.setItem(__0TAB_MIGRATED_LS_KEY, '1'); } catch (e) {}
            }
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
            // Order: writes → removes → flag. Set migrated_v2 ONLY after
            // both succeeded without lastError; if either fails we resolve
            // without flagging so the next load retries.
            function finish() {
              chrome.storage.local.set({ '__0tab_migrated_v2': true }, function () {
                try { localStorage.setItem(__0TAB_MIGRATED_LS_KEY, '1'); } catch (e) {}
                resolve();
              });
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
      chrome.storage.local.get(keys, function (r) {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(r);
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

// Strip newlines, quotes/backticks/backslashes and cap length so
// user-controlled titles/URLs/tags can't inject instructions into prompts.
function sanitizeForPrompt(str, maxLen = 200) {
  return String(str || '').replace(/[\r\n]+/g, ' ').replace(/[`"\\]/g, '').slice(0, maxLen);
}

// --- URL validation ---
function isValidUrl(str) {
  try {
    let url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

// Scheme check for anything the extension will OPEN via chrome.tabs.
// Blocklist (not whitelist) so existing shortcuts to custom schemes keep
// working — users legitimately save deep links like slack:// or vscode://.
// Only script-execution vectors are blocked.
function isOpenableUrl(url) {
  try {
    let scheme = new URL(String(url)).protocol;
    return !['javascript:', 'data:', 'vbscript:', 'blob:', 'filesystem:'].includes(scheme);
  } catch (e) {
    return false;
  }
}

// Broader check: anything that can be bookmarked (http, https, chrome-extension, file, ftp, etc.)
function isSaveableUrl(str) {
  if (!str) return false;
  // Block truly unsaveable pages
  let blocked = ['about:blank', 'about:newtab', 'chrome://newtab/', 'chrome://new-tab-page/'];
  if (blocked.includes(str)) return false;
  // Same scheme whitelist as opening — a URL we'd refuse to open must not
  // be saveable in the first place (blocks javascript:/data: at the door).
  return isOpenableUrl(str);
}

// --- Debounce ---
function debounce(fn, delay) {
  let timer;
  return function () { clearTimeout(timer); timer = setTimeout(fn, delay); };
}

function runWhenIdle(fn, timeout) {
  try {
    if (window.requestIdleCallback) {
      window.requestIdleCallback(fn, { timeout: timeout || 1000 });
      return;
    }
  } catch (e) {}
  setTimeout(fn, 75);
}

// --- Get favicon URL ---
function getFaviconUrl(url) {
  try {
    let domain = new URL(url).hostname;
    return 'https://www.google.com/s2/favicons?domain=' + domain + '&sz=32';
  } catch (e) {
    return '';
  }
}

// --- First-letter avatar colors (consistent per letter) ---
var AVATAR_COLORS = [
  '#4A90D9', '#E06C75', '#98C379', '#D19A66', '#C678DD',
  '#56B6C2', '#E5C07B', '#BE5046', '#61AFEF', '#EF596F',
  '#89CA78', '#D4BC7D', '#2BBAC5', '#D55FDE', '#E8696A', '#7BC276'
];

function createLetterAvatar(name, size) {
  size = size || 18;
  let letter = (name || '?').charAt(0).toUpperCase();
  let colorIndex = letter.charCodeAt(0) % AVATAR_COLORS.length;
  let el = document.createElement('span');
  el.textContent = letter;
  el.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:' + size + 'px;height:' + size + 'px;border-radius:50%;background:' + AVATAR_COLORS[colorIndex] + ';color:#fff;font-size:' + Math.round(size * 0.55) + 'px;font-weight:600;flex-shrink:0;line-height:1;';
  return el;
}

// Get Chrome's internal favicon URL (same-origin, cached, no network needed)
function getChromeFaviconUrl(pageUrl, size) {
  size = size || 32;
  try {
    return chrome.runtime.getURL('_favicon/?pageUrl=' + encodeURIComponent(pageUrl) + '&size=' + size);
  } catch (e) {
    return '';
  }
}

// Check if an image is a real favicon vs Chrome's default placeholder.
// Works because _favicon URLs are same-origin (chrome-extension://) so canvas is not tainted.
// Detects both colorful AND monochrome (black/white/gray) real favicons.
function isRealFavicon(img) {
  try {
    let c = document.createElement('canvas');
    let s = img.naturalWidth || 16;
    c.width = s;
    c.height = s;
    let ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, s, s);
    let data = ctx.getImageData(0, 0, s, s).data;
    let opaquePixels = 0;
    let hasColor = false;
    let brightnessSet = new Set();
    for (let i = 0; i < data.length; i += 4) {
      let r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a > 128) {
        opaquePixels++;
        // Check for chromatic color (not gray)
        if (!hasColor && (Math.abs(r - g) > 15 || Math.abs(g - b) > 15 || Math.abs(r - b) > 15)) {
          hasColor = true;
        }
        // Track quantized brightness for monochrome diversity check
        brightnessSet.add(Math.floor((r * 0.299 + g * 0.587 + b * 0.114) / 16));
      }
    }
    let totalPixels = (s * s);
    // Mostly transparent → not a real favicon
    if (opaquePixels < totalPixels * 0.05) return false;
    // Has chromatic color → real favicon
    if (hasColor) return true;
    // Monochrome but with many distinct shades → real favicon (logos, text, etc)
    // Chrome's default placeholder has very few shade levels (< 4)
    return brightnessSet.size > 4;
  } catch (e) {
    return true; // If canvas fails, assume it's real
  }
}

// Creates a favicon element with smart fallback:
// 1. Shows Chrome's _favicon immediately — same-origin, served from the
//    local favicon cache, zero network. 80 tiles paint with no requests.
// 2. Off the hot path, canvas-checks whether Chrome served a real icon or
//    its gray-globe placeholder. Placeholder → try the Google favicon
//    service; if that also fails → letter avatar.
function createFaviconEl(url, name, cssClass, size) {
  size = size || 18;
  let wrapper = document.createElement('span');
  wrapper.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:' + size + 'px;height:' + size + 'px;flex-shrink:0;';
  if (cssClass) wrapper.className = cssClass;

  if (!url) {
    wrapper.appendChild(createLetterAvatar(name, size));
    return wrapper;
  }

  function showLetterAvatar() {
    wrapper.innerHTML = '';
    wrapper.appendChild(createLetterAvatar(name, size));
  }

  function showGoogleFavicon() {
    let googleUrl = getFaviconUrl(url);
    if (!googleUrl) { showLetterAvatar(); return; }
    let gimg = document.createElement('img');
    gimg.src = googleUrl;
    gimg.width = size;
    gimg.height = size;
    gimg.alt = '';
    gimg.loading = 'lazy';
    gimg.decoding = 'async';
    gimg.style.cssText = 'border-radius:4px;display:block;';
    gimg.onerror = showLetterAvatar;
    wrapper.innerHTML = '';
    wrapper.appendChild(gimg);
  }

  let chromeFavUrl = getChromeFaviconUrl(url, size > 16 ? 32 : 16);
  if (!chromeFavUrl) { showGoogleFavicon(); return wrapper; }

  let img = document.createElement('img');
  img.src = chromeFavUrl;
  img.width = size;
  img.height = size;
  img.alt = '';
  img.decoding = 'async';
  img.style.cssText = 'border-radius:4px;display:block;';
  img.onerror = showGoogleFavicon;
  img.onload = function () {
    // _favicon never 404s — unknown sites get a gray-globe placeholder.
    // Verify off the hot path and only those tiles hit the network.
    runWhenIdle(function () {
      if (!isRealFavicon(img)) showGoogleFavicon();
    }, 1500);
  };
  wrapper.appendChild(img);
  return wrapper;
}


// --- Shortcut-name input guard ---
// Shortcut keys can't contain whitespace. Instead of rejecting at save time,
// typing Space inserts '-' at the caret, and pasted/IME whitespace becomes
// dashes. DOM pages only — never call from the service worker.
function enforceShortcutNameInput(inputEl) {
  if (!inputEl) return;
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      let start = inputEl.selectionStart;
      let end = inputEl.selectionEnd;
      let v = inputEl.value;
      inputEl.value = v.slice(0, start) + '-' + v.slice(end);
      inputEl.setSelectionRange(start + 1, start + 1);
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  inputEl.addEventListener('input', function () {
    if (/\s/.test(inputEl.value)) {
      let start = inputEl.selectionStart;
      inputEl.value = inputEl.value.replace(/\s+/g, '-');
      try { inputEl.setSelectionRange(start, start); } catch (e) {}
    }
  });
}

// --- HTML escaping (covers all 5 entities including quotes for attribute safety) ---
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
