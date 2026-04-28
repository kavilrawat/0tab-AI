// ============================================================
// 0TAB - Popup Script (Redesigned with theme + bookmark fields)
// ============================================================

const INTERNAL_KEYS = ['__0tab_folders', '__0tab_settings', '__0tab_migrated_v1', '__0tab_migrated_v2', '__0tab_daily_stats', '__0tab_trash'];
function isShortcutKey(key) {
  if (!key || typeof key !== 'string') return false;
  if (key.startsWith('__')) return false;
  return !INTERNAL_KEYS.includes(key);
}

// --- AI helpers (talk to background service worker) ---
let aiEnabled = null; // cached status

async function isAiAvailable() {
  if (aiEnabled !== null) return aiEnabled;
  try {
    // Check if user has enabled AI in settings
    let settings = await storageGet(['__0tab_settings']);
    let s = settings['__0tab_settings'] || {};
    if (s.aiEnabled !== true) { aiEnabled = false; return false; }
    // Check if browser supports AI
    let response = await new Promise((resolve) => {
      let timeout = setTimeout(() => resolve({ available: false }), 2000);
      chrome.runtime.sendMessage({ action: 'ai:status' }, (r) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) { resolve({ available: false }); return; }
        resolve(r || { available: false });
      });
    });
    aiEnabled = response.available;
    return aiEnabled;
  } catch (e) {
    aiEnabled = false;
    return false;
  }
}

async function aiGenerateTags(title, url) {
  try {
    let response = await new Promise((resolve) => {
      let timeout = setTimeout(() => resolve({ tags: null }), 5000);
      chrome.runtime.sendMessage({ action: 'ai:generateTags', title, url }, (r) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) { resolve({ tags: null }); return; }
        resolve(r || { tags: null });
      });
    });
    return response.tags;
  } catch (e) { return null; }
}

async function aiDetectDuplicates(title, url) {
  try {
    let response = await new Promise((resolve) => {
      let timeout = setTimeout(() => resolve({ duplicates: null }), 5000);
      chrome.runtime.sendMessage({ action: 'ai:detectDuplicates', title, url }, (r) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) { resolve({ duplicates: null }); return; }
        resolve(r || { duplicates: null });
      });
    });
    return response.duplicates;
  } catch (e) { return null; }
}

async function aiGenerateDescription(title, url) {
  try {
    let response = await new Promise((resolve) => {
      let timeout = setTimeout(() => resolve({ description: null }), 5000);
      chrome.runtime.sendMessage({ action: 'ai:description', title, url }, (r) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) { resolve({ description: null }); return; }
        resolve(r || { description: null });
      });
    });
    return response.description;
  } catch (e) { return null; }
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
            function finish() {
              chrome.storage.local.set({ '__0tab_migrated_v2': true }, function () { resolve(); });
            }
            function doRemove() {
              if (removes.length) chrome.storage.local.remove(removes, finish);
              else finish();
            }
            if (Object.keys(writes).length) chrome.storage.local.set(writes, doRemove);
            else doRemove();
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

// --- Toast ---
function showToast(message, type) {
  type = type || 'info';
  let toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast toast-' + type;
  setTimeout(() => toast.classList.add('toast-visible'), 10);
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.className = 'toast hidden', 300);
  }, 2500);
}

// --- Modal ---
function showModal(options) {
  let overlay = document.getElementById('modalOverlay');
  document.getElementById('modalTitle').textContent = options.title || '';
  document.getElementById('modalBody').textContent = options.body || '';
  let inputsEl = document.getElementById('modalInputs');
  let actionsEl = document.getElementById('modalActions');
  inputsEl.innerHTML = '';
  actionsEl.innerHTML = '';

  if (options.inputs) {
    options.inputs.forEach(function (inp) {
      let label = document.createElement('label');
      label.textContent = inp.label;

      let input;
      if (inp.type === 'select') {
        input = document.createElement('select');
        input.id = 'modal-input-' + inp.id;
        input.className = 'modal-input folder-select';
        let opts = inp.selectOptions || [];
        opts.forEach(function (opt) {
          let o = document.createElement('option');
          o.value = opt.value;
          o.textContent = opt.label;
          if (String(opt.value) === String(inp.value)) o.selected = true;
          input.appendChild(o);
        });
      } else if (inp.type === 'tags') {
        input = document.createElement('div');
        input.id = 'modal-input-' + inp.id;
        input.className = 'tags-input-container';
      } else {
        input = document.createElement('input');
        input.type = inp.type || 'text';
        input.id = 'modal-input-' + inp.id;
        input.value = inp.value || '';
        input.placeholder = inp.placeholder || '';
        input.className = 'modal-input';
      }

      inputsEl.appendChild(label);
      inputsEl.appendChild(input);
    });
  }

  // Render tags inputs after DOM is ready
  if (options._tagsInputs) {
    options._tagsInputs.forEach(function (tagConf) {
      tagConf.instance = createPopupTagsInput('modal-input-' + tagConf.id, tagConf.tags.slice());
    });
  }

  if (options.buttons) {
    options.buttons.forEach(function (btn) {
      let button = document.createElement('button');
      button.textContent = btn.text;
      button.className = 'modal-btn ' + (btn.className || '');
      button.addEventListener('click', function () {
        hideModal();
        if (btn.onClick) btn.onClick();
      });
      actionsEl.appendChild(button);
    });
  }

  overlay.classList.remove('hidden');
  let firstInput = inputsEl.querySelector('input, select');
  if (firstInput) setTimeout(() => firstInput.focus(), 50);
}

function hideModal() {
  document.getElementById('modalOverlay').classList.add('hidden');
}

document.getElementById('modalOverlay').addEventListener('click', function (e) {
  if (e.target !== this) return;
  // If the modal has a cancel-style button, click it so any awaiting
  // promise resolves. Otherwise fall back to plain hide.
  let actions = document.getElementById('modalActions');
  let cancelBtn = actions && (actions.querySelector('.modal-btn-cancel') || actions.querySelector('button'));
  if (cancelBtn) { cancelBtn.click(); return; }
  hideModal();
});

// --- URL validation ---
function isValidUrl(str) {
  try {
    let url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
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
  try {
    new URL(str);
    return true;
  } catch (e) {
    return false;
  }
}

// --- Debounce ---
function debounce(fn, delay) {
  let timer;
  return function () { clearTimeout(timer); timer = setTimeout(fn, delay); };
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
// 1. Shows Google favicon immediately (fast, works for most sites)
// 2. Chrome's _favicon API checks in background:
//    - If Chrome has a REAL favicon → swap to Chrome's (proves it's real, better quality)
//    - If Chrome has NO real favicon → replace with letter avatar
//    - If _favicon fails → keep Google image as safe fallback
function createFaviconEl(url, name, cssClass, size) {
  size = size || 18;
  let wrapper = document.createElement('span');
  wrapper.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:' + size + 'px;height:' + size + 'px;flex-shrink:0;';
  if (cssClass) wrapper.className = cssClass;

  if (!url) {
    wrapper.appendChild(createLetterAvatar(name, size));
    return wrapper;
  }

  // Step 1: Show Google favicon immediately as placeholder
  let googleUrl = getFaviconUrl(url);
  let img = document.createElement('img');
  img.src = googleUrl;
  img.width = size;
  img.height = size;
  img.alt = '';
  img.style.cssText = 'border-radius:4px;display:block;';
  img.onerror = function () {
    wrapper.innerHTML = '';
    wrapper.appendChild(createLetterAvatar(name, size));
  };
  wrapper.appendChild(img);

  // Step 2: Chrome's _favicon API as the authority (same-origin → canvas-readable)
  let chromeFavUrl = getChromeFaviconUrl(url, size > 16 ? 32 : 16);
  if (chromeFavUrl) {
    let checkImg = new Image();
    checkImg.onload = function () {
      if (isRealFavicon(checkImg)) {
        // Chrome has a REAL favicon → use it directly (replaces Google globe/default)
        checkImg.width = size;
        checkImg.height = size;
        checkImg.style.cssText = 'border-radius:4px;display:block;';
        wrapper.innerHTML = '';
        wrapper.appendChild(checkImg);
      } else {
        // Chrome confirms no real favicon → show letter avatar
        wrapper.innerHTML = '';
        wrapper.appendChild(createLetterAvatar(name, size));
      }
    };
    checkImg.onerror = function () {
      // _favicon failed → keep Google image as fallback
    };
    checkImg.src = chromeFavUrl;
  }
  return wrapper;
}

// --- Tag generation (same logic as manage.js) ---
function generateTagsFromBookmark(title, url) {
  let tags = [];
  try {
    let hostname = new URL(url).hostname.replace('www.', '');
    let domainTag = hostname.split('.')[0];
    if (domainTag && domainTag.length > 1) tags.push(domainTag);
  } catch (e) {}
  let titleWords = (title || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the', 'and', 'for', 'com', 'www', 'http', 'https', 'org', 'net'].includes(w));
  titleWords.forEach(function (w) {
    if (tags.length < 3 && !tags.includes(w)) tags.push(w);
  });
  let urlStr = (url || '').toLowerCase();
  if (tags.length < 3) {
    if (urlStr.includes('github') || urlStr.includes('gitlab')) { if (!tags.includes('dev')) tags.push('dev'); }
    else if (urlStr.includes('docs.') || urlStr.includes('/docs') || urlStr.includes('wiki')) { if (!tags.includes('docs')) tags.push('docs'); }
    else if (urlStr.includes('mail.') || urlStr.includes('gmail') || urlStr.includes('outlook')) { if (!tags.includes('email')) tags.push('email'); }
    else if (urlStr.includes('drive.') || urlStr.includes('dropbox') || urlStr.includes('cloud')) { if (!tags.includes('cloud')) tags.push('cloud'); }
    else if (urlStr.includes('youtube') || urlStr.includes('vimeo') || urlStr.includes('video')) { if (!tags.includes('video')) tags.push('video'); }
    else if (urlStr.includes('slack') || urlStr.includes('discord') || urlStr.includes('teams')) { if (!tags.includes('chat')) tags.push('chat'); }
    else if (urlStr.includes('figma') || urlStr.includes('canva') || urlStr.includes('design')) { if (!tags.includes('design')) tags.push('design'); }
    else if (urlStr.includes('support') || urlStr.includes('desk') || urlStr.includes('helpdesk')) { if (!tags.includes('support')) tags.push('support'); }
  }
  return tags.slice(0, 3);
}

// --- Tags input widget (same as dashboard) ---
let popupTagsWidget = null;
let popupTags = [];

function createPopupTagsInput(containerId, existingTags) {
  let wrapper = document.getElementById(containerId);
  if (!wrapper) return null;
  existingTags = existingTags || [];

  function render() {
    wrapper.innerHTML = '';
    wrapper.className = 'tags-input-wrapper';

    let tagsRow = document.createElement('div');
    tagsRow.className = 'tags-input-tags';

    existingTags.forEach(function (tag, idx) {
      let pill = document.createElement('span');
      pill.className = 'tag-pill tag-pill-editable';
      pill.textContent = tag;

      let removeBtn = document.createElement('button');
      removeBtn.className = 'tag-pill-remove';
      removeBtn.innerHTML = '&times;';
      removeBtn.title = 'Remove tag';
      removeBtn.addEventListener('click', function (e) {
        e.preventDefault();
        existingTags.splice(idx, 1);
        render();
      });
      pill.appendChild(removeBtn);
      tagsRow.appendChild(pill);
    });

    wrapper.appendChild(tagsRow);

    if (existingTags.length < 5) {
      let addInput = document.createElement('input');
      addInput.type = 'text';
      addInput.className = 'tags-input-field';
      addInput.placeholder = existingTags.length === 0 ? 'Add a tag...' : 'Add another...';
      addInput.maxLength = 30;
      addInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          let val = this.value.trim().toLowerCase().replace(/[^a-z0-9- ]/g, '').replace(/\s+/g, ' ').trim();
          if (val && !existingTags.includes(val) && existingTags.length < 5) {
            existingTags.push(val);
            render();
          } else {
            this.value = '';
          }
        }
      });
      wrapper.appendChild(addInput);
    }
  }

  render();
  return { getTags: function () { return existingTags.slice(); }, setTags: function (tags) { existingTags.length = 0; tags.forEach(t => existingTags.push(t)); render(); } };
}

// ============================================================
// THEME SYNC (from dashboard localStorage via storage.sync)
// ============================================================
function applyTheme() {
  // Read theme from localStorage (shared with manage page)
  let theme = localStorage.getItem('tab0_theme') || 'dark';
  document.body.className = theme === 'dark' ? 'theme-dark' : '';
}
applyTheme();

// ============================================================
// VIEW MODE TOGGLE (grid / list)
// ============================================================
let currentViewMode = localStorage.getItem('tab0_view_mode') || 'grid';

function applyViewMode() {
  let list = document.getElementById('shortcutList');
  let toggleBtn = document.getElementById('viewToggle');
  let icon = document.getElementById('viewToggleIcon');

  if (currentViewMode === 'list') {
    list.className = 'shortcuts-list';
    toggleBtn.title = 'Switch to grid view';
    // Grid icon (switch TO grid)
    icon.innerHTML = '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>';
  } else {
    list.className = 'shortcuts-grid';
    toggleBtn.title = 'Switch to list view';
    // List icon (switch TO list)
    icon.innerHTML = '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>';
  }
}

// ============================================================
// SHOW CURRENT TAB INFO
// ============================================================
let currentTabUrl = '';
let currentTabTitle = '';
let existingShortcutKey = ''; // Track if current URL already has a shortcut (edit mode)

// Generate a smart short shortcut name (max 5 chars, unique)
function generateSmartShortName(title, url, existingKeys) {
  let candidates = [];

  // 1. Try domain-based short name (first 3 chars, e.g. "des" from desk.zoho.com)
  try {
    let hostname = new URL(url).hostname.replace('www.', '');
    let domain = hostname.split('.')[0];
    if (domain && domain.length > 1) {
      candidates.push(domain.substring(0, 3));
      if (domain.length >= 2) candidates.push(domain.substring(0, 2));
    }
  } catch (e) {}

  // 2. Try first 3 letters of meaningful words from the title
  let words = (title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !['the', 'and', 'for', 'com', 'www', 'http', 'https', 'org', 'net', 'pvt', 'ltd'].includes(w));
  words.forEach(function (w) {
    candidates.push(w.substring(0, 3));
  });

  // 3. Try combining first letters of title words (initials, max 3)
  if (words.length >= 2) {
    let initials = words.map(w => w[0]).join('').substring(0, 3);
    if (initials.length >= 2) candidates.push(initials);
  }

  // Find first candidate not in existingKeys
  for (let i = 0; i < candidates.length; i++) {
    let name = candidates[i].replace(/[^a-z0-9]/g, '');
    if (name && name.length >= 2 && name.length <= 3 && !existingKeys.includes(name)) {
      return name;
    }
  }

  // Fallback: first 3 chars + number
  let base = candidates[0] || 'lnk';
  base = base.substring(0, 3);
  for (let n = 1; n <= 99; n++) {
    let attempt = base + n;
    if (!existingKeys.includes(attempt)) return attempt;
  }
  return '';
}

async function showCurrentTabInfo() {
  try {
    let tabs = await new Promise(resolve => chrome.tabs.query({ active: true, currentWindow: true }, resolve));
    let tab = tabs[0];
    currentTabUrl = tab ? tab.url : '';
    currentTabTitle = tab ? tab.title : '';
    // Detect New Tab / blank pages
    let newTabUrls = ['about:blank', 'about:newtab', 'chrome://newtab/', 'chrome://new-tab-page/', 'edge://newtab/'];
    let isNewTab = !currentTabUrl || newTabUrls.includes(currentTabUrl) || currentTabUrl.startsWith('chrome://newtab');

    document.getElementById('urlDisplay').value = isNewTab ? '' : (currentTabUrl || '');
    document.getElementById('bookmarkName').value = isNewTab ? '' : (currentTabTitle || '');

    let shortcutInput = document.getElementById('shortcutName');

    if (isNewTab) {
      // Don't suggest a shortcut name or tags for New Tab pages
      shortcutInput.value = '';
      shortcutInput.placeholder = 'e.g. desk';
      popupTagsWidget = createPopupTagsInput('popupTagsContainer', []);
      document.getElementById('savedBanner').classList.add('hidden');
      loadFolderDropdown(); // Default to 0tab AI folder
      return;
    }

    // Check if this URL already has a shortcut saved
    let allItems = await storageGet(null);
    let existingKeys = Object.keys(allItems).filter(isShortcutKey);
    let existingShortcutName = '';

    for (let i = 0; i < existingKeys.length; i++) {
      let data = allItems[existingKeys[i]];
      let savedUrl = typeof data === 'object' ? data.url : data;
      if (savedUrl === currentTabUrl) {
        existingShortcutName = existingKeys[i];
        break;
      }
    }

    let savedBanner = document.getElementById('savedBanner');
    let savedBannerText = document.getElementById('savedBannerText');
    let savedBannerFolder = document.getElementById('savedBannerFolder');

    if (existingShortcutName) {
      // URL already saved — switch to edit mode
      existingShortcutKey = existingShortcutName;
      shortcutInput.value = existingShortcutName;
      shortcutInput.placeholder = 'e.g. ' + existingShortcutName;
      document.getElementById('saveButton').textContent = 'Update';

      // Show "already saved" banner
      savedBannerText.textContent = 'Saved as "' + existingShortcutName + '"';
      savedBanner.classList.remove('hidden');

      // Look up the bookmark folder name and pre-select it in dropdown
      let existingData = allItems[existingShortcutName];
      let preselectFolderId = '';
      if (typeof existingData === 'object' && existingData.bookmarkId) {
        try {
          let bmNode = await new Promise(resolve => {
            chrome.bookmarks.get(existingData.bookmarkId, (results) => {
              if (chrome.runtime.lastError) { resolve(null); return; }
              resolve(results ? results[0] : null);
            });
          });
          if (bmNode && bmNode.parentId) {
            preselectFolderId = bmNode.parentId;
            let parentNode = await new Promise(resolve => {
              chrome.bookmarks.get(bmNode.parentId, (results) => {
                if (chrome.runtime.lastError) { resolve(null); return; }
                resolve(results ? results[0] : null);
              });
            });
            if (parentNode && parentNode.title) {
              savedBannerFolder.textContent = parentNode.title;
            } else {
              savedBannerFolder.textContent = '';
            }
          } else {
            savedBannerFolder.textContent = '';
          }
        } catch (e) {
          savedBannerFolder.textContent = '';
        }
      } else {
        savedBannerFolder.textContent = '';
      }

      // Load folder dropdown with the existing bookmark's folder pre-selected
      loadFolderDropdown(preselectFolderId);

      // Prefill tags from existing data
      let existingTags = (typeof existingData === 'object' && Array.isArray(existingData.tags)) ? existingData.tags : generateTagsFromBookmark(currentTabTitle, currentTabUrl);
      popupTagsWidget = createPopupTagsInput('popupTagsContainer', existingTags);
    } else {
      // Not saved — reset to create mode
      existingShortcutKey = '';
      document.getElementById('saveButton').textContent = 'Save';
      savedBanner.classList.add('hidden');
      savedBannerFolder.textContent = '';

      // Load folder dropdown with 0tab AI folder as default
      loadFolderDropdown();

      // Generate smart short name suggestion
      let smartName = generateSmartShortName(currentTabTitle, currentTabUrl, existingKeys);
      shortcutInput.value = smartName;
      shortcutInput.placeholder = smartName ? 'e.g. ' + smartName : 'e.g. desk';

      // Auto-generate tags — use AI if available, fall back to keyword-based
      let tags = generateTagsFromBookmark(currentTabTitle, currentTabUrl);
      popupTagsWidget = createPopupTagsInput('popupTagsContainer', tags);

      // Async AI enhancement: replace tags if AI gives better ones
      isAiAvailable().then(available => {
        if (!available) return;
        aiGenerateTags(currentTabTitle, currentTabUrl).then(aiTags => {
          if (aiTags && aiTags.length > 0 && popupTagsWidget) {
            popupTagsWidget.setTags(aiTags);
          }
        });
      });
    }
  } catch (e) {
    // Silently fail
  }
}

// ============================================================
// LOAD BOOKMARK FOLDERS (for folder dropdown)
// ============================================================
async function loadFolderDropdown(preselectFolderId) {
  try {
    let timeout = setTimeout(() => {
      console.warn('0tab: loadFolderDropdown timed out');
    }, 3000);
    chrome.runtime.sendMessage({ action: 'getBookmarkFolders' }, function (folders) {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        console.warn('0tab: getBookmarkFolders failed:', chrome.runtime.lastError.message);
        return;
      }
      let select = document.getElementById('folderSelect');
      select.innerHTML = '<option value="">Select folder...</option>';
      if (!folders || !Array.isArray(folders)) return;

      let zerotabFolderId = '';
      folders.forEach(function (f) {
        let opt = document.createElement('option');
        opt.value = f.id;
        let indent = '';
        for (let i = 0; i < f.depth; i++) indent += '\u00A0\u00A0';
        opt.textContent = indent + (f.title || '(Untitled)');
        select.appendChild(opt);

        // Track the canonical 0tab AI folder ID (also catch legacy names so
        // first-run after rename still preselects the right folder).
        if (!zerotabFolderId && (f.title === '0tab AI' || f.title === 'Tab0 AI' || f.title === 'Tab0 Shortcuts')) {
          zerotabFolderId = f.id;
        }
      });

      // Auto-select: use preselectFolderId if given, otherwise default to 0tab AI
      let targetId = preselectFolderId || zerotabFolderId;
      if (targetId) {
        select.value = targetId;
      }
    });
  } catch (e) {
    console.warn('0tab: loadFolderDropdown error:', e.message);
  }
}

// ============================================================
// SAVE (creates both a Chrome bookmark + 0tab shortcut)
// ============================================================
async function saveShortcut() {

  let bookmarkTitle = document.getElementById('bookmarkName').value.trim();
  let shortcutName = document.getElementById('shortcutName').value.trim().toLowerCase().replace(/\s+/g, '');
  let folderId = document.getElementById('folderSelect').value || undefined;


  if (!shortcutName && !bookmarkTitle) { showToast('Enter a name.', 'error'); return; }
  if (shortcutName && shortcutName.length > 15) { showToast('Shortcut name must be 15 chars or less.', 'error'); return; }
  if (shortcutName && /\s/.test(shortcutName)) { showToast('No spaces in shortcut name.', 'error'); return; }

  try {
    let url = document.getElementById('urlDisplay').value.trim();

    if (!url) { showToast('Enter a URL.', 'error'); return; }
    if (!isSaveableUrl(url)) {
      showToast('Enter a valid URL.', 'error'); return;
    }

    // Get tags from widget
    let tags = popupTagsWidget ? popupTagsWidget.getTags() : [];

    let items = await storageGet(null);
    let isEditMode = !!existingShortcutKey;

    // Strict duplicate checks — only block on exact matches, never on AI
    // "looks similar" heuristics. Two ways we count as a real duplicate:
    //   1. The exact shortcut name is already taken (must be a collision,
    //      not a case-insensitive near-match).
    //   2. The exact normalized URL is already saved under a different
    //      shortcut (trailing-slash-insensitive, host-lowercased).
    if (shortcutName && !isEditMode && items[shortcutName] && isShortcutKey(shortcutName)) {
      showToast('Shortcut "' + shortcutName + '" already exists.', 'error');
      return;
    }
    if (!isEditMode) {
      let normalize = function (u) {
        if (!u || typeof u !== 'string') return '';
        try {
          let parsed = new URL(u);
          let host = parsed.hostname.replace(/^www\./, '').toLowerCase();
          let path = parsed.pathname.replace(/\/+$/, '') || '/';
          return parsed.protocol + '//' + host + path + parsed.search + parsed.hash;
        } catch (e) { return u.replace(/\/+$/, '').toLowerCase(); }
      };
      let normalizedNew = normalize(url);
      let dupedKey = Object.keys(items).filter(isShortcutKey).find(function (k) {
        let d = items[k];
        let u = typeof d === 'object' ? (d.url || '') : (typeof d === 'string' ? d : '');
        return u && normalize(u) === normalizedNew;
      });
      if (dupedKey) {
        showToast('This URL is already saved as "' + dupedKey + '".', 'error');
        return;
      }
    }

    // If no folder selected, default to the canonical 0tab AI folder
    if (!folderId) {
      try {
        folderId = await new Promise((resolve, reject) => {
          let timeout = setTimeout(() => resolve(undefined), 3000); // Prevent hanging if service worker is asleep
          chrome.runtime.sendMessage({ action: 'getTab0FolderId' }, (response) => {
            clearTimeout(timeout);
            if (chrome.runtime.lastError) {
              console.warn('0tab: getTab0FolderId failed:', chrome.runtime.lastError.message);
              resolve(undefined);
            } else {
              resolve(response);
            }
          });
        });
      } catch (e) { /* fallback: no folder */ }
    }

    // Validate folderId is actually a folder before using it
    if (folderId) {
      try {
        let folderCheck = await new Promise((resolve) => {
          chrome.bookmarks.get(folderId, (results) => {
            if (chrome.runtime.lastError || !results || results.length === 0) {
              resolve(null);
            } else {
              resolve(results[0]);
            }
          });
        });
        // If the ID doesn't exist or points to a bookmark (has a URL), discard it
        if (!folderCheck || folderCheck.url) {
          console.warn('0tab: folderId', folderId, 'is not a valid folder, ignoring');
          folderId = undefined;
        }
      } catch (e) {
        console.warn('0tab: folderId validation failed:', e.message);
        folderId = undefined;
      }
    }

    // Create Chrome bookmark if title provided (skip in edit mode — handled later)
    let bookmarkId = undefined;
    if (bookmarkTitle && !isEditMode) {
      try {
        let createOpts = { title: bookmarkTitle, url: url };
        if (folderId) createOpts.parentId = folderId;
        let bm = await new Promise((resolve, reject) => {
          let timeout = setTimeout(() => {
            console.warn('0tab: Bookmark creation timed out');
            resolve(null);
          }, 5000);
          chrome.bookmarks.create(createOpts, (result) => {
            clearTimeout(timeout);
            if (chrome.runtime.lastError) {
              console.warn('0tab: Bookmark creation failed:', chrome.runtime.lastError.message);
              resolve(null); // Don't reject — still save the shortcut
            } else {
              resolve(result);
            }
          });
        });
        if (bm) bookmarkId = bm.id;
      } catch (e) {
        console.warn('0tab: Bookmark creation error:', e.message);
        // Bookmark creation might fail — still save the shortcut
      }
    }

    // Save or update shortcut
    if (isEditMode && existingShortcutKey) {
      // --- Edit mode: update existing shortcut ---
      let existingData = items[existingShortcutKey] || {};
      let updatedData = Object.assign({}, typeof existingData === 'object' ? existingData : { url: existingData });
      updatedData.url = url;
      updatedData.tags = tags;
      updatedData.bookmarkTitle = bookmarkTitle;
      if (bookmarkId) updatedData.bookmarkId = bookmarkId;

      // Update Chrome bookmark if we have one
      if (updatedData.bookmarkId) {
        try {
          await new Promise((res, rej) => {
            chrome.bookmarks.update(updatedData.bookmarkId, { title: bookmarkTitle, url: url }, (result) => {
              if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
              else res(result);
            });
          });
          // Move to new folder if changed
          if (folderId) {
            await new Promise((res, rej) => {
              chrome.bookmarks.move(updatedData.bookmarkId, { parentId: folderId }, (result) => {
                if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
                else res(result);
              });
            });
          }
        } catch (bmErr) {
          console.warn('0tab: Bookmark update error:', bmErr.message);
        }
      }

      // Handle shortcut name change
      if (shortcutName && shortcutName !== existingShortcutKey) {
        // Check if new name conflicts
        if (items[shortcutName] && isShortcutKey(shortcutName)) {
          showToast(shortcutName + ' already exists!', 'error'); return;
        }
        await storageRemove(existingShortcutKey);
        await storageSet({ [shortcutName]: updatedData });
        existingShortcutKey = shortcutName;
      } else {
        let saveKey = shortcutName || existingShortcutKey;
        await storageSet({ [saveKey]: updatedData });
      }

      // Update banner
      let bannerText = document.getElementById('savedBannerText');
      if (bannerText) bannerText.textContent = 'Saved as "' + (shortcutName || existingShortcutKey) + '"';
      let savedBanner = document.getElementById('savedBanner');
      if (savedBanner) savedBanner.classList.remove('hidden');

      showToast('Updated ' + (shortcutName || existingShortcutKey), 'success');
    } else if (shortcutName) {
      // --- Create mode: new shortcut ---
      let shortcutData = { url: url, count: 0, tags: tags, createdAt: Date.now() };
      if (bookmarkId) {
        shortcutData.bookmarkId = bookmarkId;
        shortcutData.bookmarkTitle = bookmarkTitle;
      }

      await storageSet({ [shortcutName]: shortcutData });

      // Switch to edit mode now that it's saved
      existingShortcutKey = shortcutName;
      document.getElementById('saveButton').textContent = 'Update';

      // Update banner
      let bannerText = document.getElementById('savedBannerText');
      if (bannerText) bannerText.textContent = 'Saved as "' + shortcutName + '"';
      let savedBanner = document.getElementById('savedBanner');
      if (savedBanner) savedBanner.classList.remove('hidden');

      // AI: generate a description asynchronously (non-blocking)
      isAiAvailable().then(available => {
        if (!available) return;
        aiGenerateDescription(bookmarkTitle || shortcutName, url).then(desc => {
          if (desc) {
            storageGet(shortcutName).then(result => {
              let d = result[shortcutName];
              if (d && typeof d === 'object') {
                d.aiDescription = desc;
                storageSet({ [shortcutName]: d });
              }
            });
          }
        });
      });

      showToast('Saved ' + shortcutName, 'success');
    } else if (bookmarkTitle) {
      // Bookmark-only path (user provided a title but no shortcut name).
      // Still surface the saved banner so the user gets the same instant
      // confirmation as the shortcut path.
      let bannerTextEl = document.getElementById('savedBannerText');
      if (bannerTextEl) bannerTextEl.textContent = 'Saved as "' + bookmarkTitle + '"';
      let savedBannerEl = document.getElementById('savedBanner');
      if (savedBannerEl) savedBannerEl.classList.remove('hidden');
      showToast('Bookmark saved!', 'success');
    }

    // Keep field values — just reload the list
    loadShortcuts();
  } catch (err) {
    console.error('0tab: saveShortcut error:', err);
    showToast('Error: ' + err.message, 'error');
  }
}

// ============================================================
// LOAD SHORTCUTS (with favicons)
// ============================================================
// Search scoring: higher score = better match
// Priority: Shortcut Name (4) > Bookmark Name (3) > Tags (2) > URL (1)
function getSearchScore(key, data, searchValue) {
  if (!searchValue) return 100; // No search = show all
  let isFolder = typeof data === 'object' && data.type === 'folder';
  let url = isFolder ? '' : ((typeof data === 'object') ? (data.url || '') : (data || ''));
  let bookmarkTitle = (typeof data === 'object') ? (data.bookmarkTitle || data.folderTitle || '') : '';
  let tags = (typeof data === 'object' && Array.isArray(data.tags)) ? data.tags : [];
  let score = 0;

  let lowerKey = key.toLowerCase();
  let lowerTitle = bookmarkTitle.toLowerCase();
  let lowerUrl = url.toLowerCase();

  // Shortcut name matches (highest priority)
  if (lowerKey === searchValue) score += 400; // Exact match
  else if (lowerKey.startsWith(searchValue)) score += 300; // Starts with
  else if (lowerKey.includes(searchValue)) score += 200; // Contains

  // Bookmark name matches
  if (lowerTitle === searchValue) score += 150;
  else if (lowerTitle.startsWith(searchValue)) score += 120;
  else if (lowerTitle.includes(searchValue)) score += 100;
  else {
    // Check individual words in bookmark title
    let words = lowerTitle.split(/\s+/);
    if (words.some(w => w.startsWith(searchValue))) score += 90;
  }

  // Tag matches
  for (let t of tags) {
    if (t === searchValue) { score += 80; break; }
    if (t.startsWith(searchValue)) { score += 60; break; }
    if (t.includes(searchValue)) { score += 40; break; }
  }

  // URL matches
  if (lowerUrl.includes(searchValue)) score += 20;

  return score;
}

// Helper: open all URLs in a folder shortcut (with optional tab group)
async function openFolderShortcutUrls(urls, shortcutKey, data) {
  if (!urls || urls.length === 0) return;

  // Increment access count
  if (shortcutKey && data && typeof data === 'object') {
    data.count = (data.count || 0) + 1;
    data.lastAccessed = Date.now();
    storageSet({ [shortcutKey]: data });
  }

  // Read tab group setting
  let result = await storageGet(['__0tab_settings']);
  let settings = result['__0tab_settings'] || {};
  let useTabGroup = settings.tabGroupFolders !== false; // default true
  let groupName = shortcutKey || 'Folder';

  // Get current tab BEFORE the popup closes
  let tabs = await new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
  let currentTab = tabs[0];

  // Navigate current tab to first URL
  if (currentTab) {
    chrome.tabs.update(currentTab.id, { url: urls[0] });
  }

  // Open remaining URLs in new tabs. Guard each create — if Chrome
  // rate-limits or rejects one, keep going instead of crashing the loop
  // and leaving the rest of the folder unopened.
  let allTabIds = currentTab ? [currentTab.id] : [];
  for (let i = 1; i < urls.length; i++) {
    try {
      let newTab = await new Promise(r => chrome.tabs.create({ url: urls[i], active: false }, r));
      if (newTab && newTab.id) allTabIds.push(newTab.id);
    } catch (e) {
      console.warn('0tab: tabs.create failed for', urls[i], ':', e && e.message);
    }
  }

  // Create tab group if enabled and we have tabs
  if (useTabGroup && allTabIds.length > 0) {
    try {
      let groupId = await new Promise(r => chrome.tabs.group({ tabIds: allTabIds }, r));
      if (groupId !== undefined) {
        chrome.tabGroups.update(groupId, { title: groupName, collapsed: false });
      }
    } catch (gErr) {
      console.warn('0tab: Tab group creation failed:', gErr.message);
    }
  }

  window.close();
}

// Helper: get truncated URL for list view display
function getDisplayUrl(url) {
  try {
    let u = new URL(url);
    let display = u.hostname.replace('www.', '');
    if (u.pathname && u.pathname !== '/') display += u.pathname;
    return display.length > 40 ? display.substring(0, 40) + '...' : display;
  } catch (e) {
    return url;
  }
}

// ============================================================
// PIN / DRAG-TO-PIN HELPERS
// Pinned tiles bypass usage-based sort and live at the top of the
// popup grid, in user-defined order (pinOrder ascending).
// ============================================================
async function togglePin(key, makePinned) {
  try {
    let items = await storageGet(null);
    let data = items[key];
    if (typeof data === 'string') data = { url: data, count: 0 };
    if (!data || typeof data !== 'object') return;
    if (makePinned) {
      // New pin goes to the end of the pinned list
      let maxOrder = 0;
      Object.keys(items).filter(isShortcutKey).forEach(function (k) {
        let d = items[k];
        if (d && typeof d === 'object' && d.pinned && typeof d.pinOrder === 'number' && d.pinOrder > maxOrder) {
          maxOrder = d.pinOrder;
        }
      });
      data.pinned = true;
      data.pinOrder = maxOrder + 1;
    } else {
      delete data.pinned;
      delete data.pinOrder;
    }
    await storageSet({ [key]: data });
    showToast(makePinned ? 'Pinned ' + key : 'Unpinned ' + key, 'success');
    loadShortcuts();
  } catch (e) {
    showToast('Could not update pin state.', 'error');
  }
}

// Reorder when an item is dropped relative to a target tile.
// Rules:
//   - Drop before a pinned target → dragged becomes pinned, slotted in
//   - Drop after a pinned target  → dragged becomes pinned, slotted after
//   - Drop relative to an unpinned target → dragged becomes unpinned
async function handlePinDrop(draggedKey, targetKey, dropBefore) {
  try {
    let items = await storageGet(null);
    let dragged = items[draggedKey];
    let target = items[targetKey];
    if (typeof dragged === 'string') dragged = { url: dragged, count: 0 };
    if (typeof target === 'string') target = { url: target, count: 0 };
    if (!dragged || typeof dragged !== 'object' || !target || typeof target !== 'object') return;

    let targetPinned = target.pinned === true;
    if (!targetPinned) {
      // Dropped onto an unpinned tile → unpin (if pinned)
      if (dragged.pinned) {
        delete dragged.pinned;
        delete dragged.pinOrder;
        await storageSet({ [draggedKey]: dragged });
        loadShortcuts();
      }
      return;
    }

    // Build current pinned list, sorted, excluding the dragged item.
    let pinList = Object.keys(items)
      .filter(isShortcutKey)
      .filter(function (k) { return k !== draggedKey; })
      .map(function (k) { return { key: k, data: items[k] }; })
      .filter(function (x) { return x.data && typeof x.data === 'object' && x.data.pinned === true; })
      .sort(function (a, b) {
        return (a.data.pinOrder || 0) - (b.data.pinOrder || 0);
      });

    // Insert dragged before/after target
    let targetIdx = pinList.findIndex(function (x) { return x.key === targetKey; });
    if (targetIdx < 0) return;
    let insertAt = dropBefore ? targetIdx : targetIdx + 1;
    pinList.splice(insertAt, 0, { key: draggedKey, data: dragged });

    // Renumber pinOrder densely so future inserts have headroom
    let writes = {};
    pinList.forEach(function (x, idx) {
      x.data.pinned = true;
      x.data.pinOrder = (idx + 1) * 10;
      writes[x.key] = x.data;
    });
    await storageSet(writes);
    loadShortcuts();
  } catch (e) {
    /* silent */
  }
}

async function loadShortcuts() {
  let searchValue = document.getElementById('searchShortcuts').value.toLowerCase().trim();

  try {
    let items = await storageGet(null);
    let list = document.getElementById('shortcutList');
    list.innerHTML = '';

    // Apply the current view mode class
    list.className = currentViewMode === 'list' ? 'shortcuts-list' : 'shortcuts-grid';

    let keys = Object.keys(items).filter(isShortcutKey);

    // Score and filter
    let scored = keys.map(function (key) {
      let data = items[key];
      let score = getSearchScore(key, data, searchValue);
      return { key: key, data: data, score: score };
    }).filter(s => s.score > 0);

    // Helpers for pin-aware sorting
    function isPinned(d) { return typeof d === 'object' && d && d.pinned === true; }
    function pinOrderOf(d) { return typeof d === 'object' && d && typeof d.pinOrder === 'number' ? d.pinOrder : 0; }
    function countOf(d) { return typeof d === 'object' && d ? (d.count || 0) : 0; }

    // Sort: pinned tiles always first (by pinOrder ASC), then either
    // search-relevance or usage. Search ignores pin grouping so the most
    // relevant result is still on top.
    if (searchValue) {
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return countOf(b.data) - countOf(a.data);
      });
    } else {
      scored.sort((a, b) => {
        let ap = isPinned(a.data), bp = isPinned(b.data);
        if (ap !== bp) return ap ? -1 : 1;
        if (ap && bp) return pinOrderOf(a.data) - pinOrderOf(b.data);
        return countOf(b.data) - countOf(a.data);
      });
    }

    let shown = 0;
    for (let i = 0; i < scored.length; i++) {
      let key = scored[i].key;
      let data = scored[i].data;
      let isFolder = typeof data === 'object' && data.type === 'folder';
      let url = isFolder ? '' : ((typeof data === 'object') ? data.url : data);
      let urls = isFolder ? (data.urls || []) : [];
      let count = (typeof data === 'object') ? (data.count || 0) : 0;
      let tags = (typeof data === 'object' && Array.isArray(data.tags)) ? data.tags : [];

      shown++;
      let pinned = typeof data === 'object' && data && data.pinned === true;
      let li = document.createElement('li');
      li.dataset.shortcutKey = key;
      if (pinned) li.classList.add('shortcut-pinned');
      // Native HTML5 drag — used both for reordering pinned tiles and
      // for "drag to top to pin" an unpinned tile.
      li.draggable = true;

      let inner = document.createElement('div');
      inner.className = 'shortcut-inner';
      inner.style.cursor = 'pointer';

      if (isFolder) {
        // Click folder shortcut → toggle accordion to show/hide child links
        inner.addEventListener('click', function () {
          let childContainer = li.querySelector('.folder-children');
          if (childContainer) {
            let isOpen = childContainer.style.display !== 'none';
            childContainer.style.display = isOpen ? 'none' : 'block';
            li.classList.toggle('folder-open', !isOpen);
          }
        });
      } else {
        // Click single shortcut → open in same tab
        inner.addEventListener('click', function () {
          chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            if (tabs[0]) {
              chrome.tabs.update(tabs[0].id, { url: url });
              window.close();
            }
          });
        });
      }

      // Favicon / folder icon
      if (isFolder) {
        let folderSvg = document.createElement('span');
        folderSvg.className = 'shortcut-favicon';
        folderSvg.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
        folderSvg.style.display = 'flex';
        folderSvg.style.alignItems = 'center';
        folderSvg.style.justifyContent = 'center';
        inner.appendChild(folderSvg);
      } else {
        inner.appendChild(createFaviconEl(url, key, 'shortcut-favicon', 18));
      }

      // Name
      let name = document.createElement('span');
      name.className = 'shortcut-name';
      name.textContent = key;
      // AI description as tooltip
      if (typeof data === 'object' && data.aiDescription) {
        inner.title = data.aiDescription;
      }
      inner.appendChild(name);

      // Pin badge — visible on pinned tiles, click to unpin
      if (pinned) {
        let pinBadge = document.createElement('button');
        pinBadge.className = 'shortcut-pin-badge';
        pinBadge.title = 'Pinned — click to unpin';
        pinBadge.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" fill="currentColor"/></svg>';
        pinBadge.addEventListener('click', function (e) {
          e.stopPropagation();
          togglePin(key, false);
        });
        inner.appendChild(pinBadge);
      }

      // URL text (visible in list view only, hidden in grid via CSS)
      let urlText = document.createElement('span');
      urlText.className = 'shortcut-url-text';
      if (isFolder) {
        urlText.textContent = urls.length + ' tab' + (urls.length !== 1 ? 's' : '');
      } else {
        urlText.textContent = getDisplayUrl(url);
      }
      inner.appendChild(urlText);

      // Folder badge (visible in list view for folder shortcuts)
      if (isFolder) {
        let badge = document.createElement('span');
        badge.className = 'shortcut-folder-badge';
        badge.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' + urls.length + ' tabs';
        inner.appendChild(badge);
      }

      li.appendChild(inner);

      // Dropdown actions (order: Pin, Edit, Go to, Copy, Delete)
      let dropdown = document.createElement('div');
      dropdown.className = 'dropdown-menu';

      let pinBtn = document.createElement('button');
      pinBtn.className = 'pin-icon' + (pinned ? ' pin-icon-active' : '');
      pinBtn.title = pinned ? 'Unpin' : 'Pin to top';
      pinBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"' + (pinned ? ' fill="currentColor"' : '') + '/></svg>';
      pinBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePin(key, !pinned); });
      dropdown.appendChild(pinBtn);

      let edit = document.createElement('button');
      edit.className = 'edit-icon';
      edit.title = 'Edit';
      edit.addEventListener('click', (e) => { e.stopPropagation(); editShortcut(key, url || ('folder:' + key)); });
      dropdown.appendChild(edit);

      if (isFolder) {
        let openAll = document.createElement('button');
        openAll.className = 'go-to-icon';
        openAll.title = 'Open all in tab group';
        openAll.addEventListener('click', (e) => {
          e.stopPropagation();
          openFolderShortcutUrls(urls, key, data);
        });
        dropdown.appendChild(openAll);
      } else {
        let go = document.createElement('button');
        go.className = 'go-to-icon';
        go.title = 'Open in new tab';
        go.addEventListener('click', (e) => { e.stopPropagation(); chrome.tabs.create({ url: url }); });
        dropdown.appendChild(go);
      }

      let copy = document.createElement('button');
      copy.className = 'copy-icon';
      copy.title = 'Copy URL';
      copy.addEventListener('click', (e) => {
        e.stopPropagation();
        let textToCopy = isFolder ? (key + '\n' + urls.map((u, i) => (i + 1) + '. ' + u).join('\n')) : url;
        navigator.clipboard.writeText(textToCopy).then(() => {
          copy.title = 'Copied!';
          setTimeout(() => { copy.title = 'Copy URL'; }, 1500);
        });
      });
      dropdown.appendChild(copy);

      let del = document.createElement('button');
      del.className = 'delete-icon';
      del.title = 'Delete';
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteShortcut(key, url || ('folder:' + key)); });
      dropdown.appendChild(del);

      li.appendChild(dropdown);

      // --- Drag-to-pin / reorder ---
      // Drag any tile. Drop on top of another tile to:
      //   • land *before* a pinned tile  → pin (or reorder pins)
      //   • land *after* an unpinned tile → unpin (if was pinned)
      li.addEventListener('dragstart', function (ev) {
        ev.dataTransfer.effectAllowed = 'move';
        try { ev.dataTransfer.setData('text/tab0-shortcut', key); } catch (e) {}
        li.classList.add('dragging');
      });
      li.addEventListener('dragend', function () {
        li.classList.remove('dragging');
        document.querySelectorAll('.shortcut-drop-before, .shortcut-drop-after')
          .forEach(function (el) { el.classList.remove('shortcut-drop-before', 'shortcut-drop-after'); });
      });
      li.addEventListener('dragover', function (ev) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        let rect = li.getBoundingClientRect();
        let before = (ev.clientY - rect.top) < rect.height / 2;
        li.classList.toggle('shortcut-drop-before', before);
        li.classList.toggle('shortcut-drop-after', !before);
      });
      li.addEventListener('dragleave', function () {
        li.classList.remove('shortcut-drop-before', 'shortcut-drop-after');
      });
      li.addEventListener('drop', function (ev) {
        ev.preventDefault();
        let draggedKey = '';
        try { draggedKey = ev.dataTransfer.getData('text/tab0-shortcut') || ''; } catch (e) {}
        if (!draggedKey || draggedKey === key) return;
        let rect = li.getBoundingClientRect();
        let before = (ev.clientY - rect.top) < rect.height / 2;
        handlePinDrop(draggedKey, key, before);
      });

      // Accordion: render child links for folder shortcuts
      if (isFolder && urls.length > 0) {
        let childContainer = document.createElement('div');
        childContainer.className = 'folder-children';
        childContainer.style.display = 'none';

        // Get bookmark titles for each URL if available
        let urlTitles = (typeof data === 'object' && Array.isArray(data.urlTitles)) ? data.urlTitles : [];

        urls.forEach(function (childUrl, idx) {
          let childRow = document.createElement('div');
          childRow.className = 'folder-child-item';

          // Favicon
          let childDisplayTitle = (urlTitles[idx] && urlTitles[idx].trim()) ? urlTitles[idx] : getDisplayUrl(childUrl);
          childRow.appendChild(createFaviconEl(childUrl, childDisplayTitle, 'shortcut-favicon', 18));

          // Title / name
          let childName = document.createElement('span');
          childName.className = 'shortcut-name';
          let displayTitle = childDisplayTitle;
          childName.textContent = displayTitle;
          childName.title = childUrl;
          childRow.appendChild(childName);

          // URL text
          let childUrlText = document.createElement('span');
          childUrlText.className = 'shortcut-url-text';
          childUrlText.textContent = getDisplayUrl(childUrl);
          childRow.appendChild(childUrlText);

          // Click child → open in current tab
          childRow.style.cursor = 'pointer';
          childRow.addEventListener('click', function (e) {
            e.stopPropagation();
            chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
              if (tabs[0]) {
                chrome.tabs.update(tabs[0].id, { url: childUrl });
                window.close();
              }
            });
          });

          // Child action buttons: Edit, Go to, Copy, Delete
          let childActions = document.createElement('div');
          childActions.className = 'folder-child-actions';

          let childEdit = document.createElement('button');
          childEdit.className = 'edit-icon';
          childEdit.title = 'Edit';
          childEdit.addEventListener('click', function (e) {
            e.stopPropagation();
            let currentTitle = (urlTitles[idx] && urlTitles[idx].trim()) ? urlTitles[idx] : '';

            // Load folders for dropdown
            chrome.runtime.sendMessage({ action: 'getBookmarkFolders' }, function (cFolders) {
              if (chrome.runtime.lastError) cFolders = [];
              cFolders = cFolders || [];
              let cFolderData = [{ value: '', label: 'No folder' }].concat(
                cFolders.map(function (f) {
                  let indent = '';
                  for (let i = 0; i < f.depth; i++) indent += '\u00A0\u00A0';
                  return { value: f.id, label: indent + (f.title || '(Untitled)') };
                })
              );
              let cCurrentFolderId = data.folderId || '';
              let cTagsConf = { id: 'tags', tags: [] };

              showModal({
                title: 'Edit Bookmark',
                inputs: [
                  { id: 'bmname', label: 'BOOKMARK NAME', value: currentTitle, placeholder: 'Chrome bookmark title' },
                  { id: 'shortcut', label: '0TAB SHORTCUT', value: '', placeholder: 'e.g. yt (leave empty to skip)' },
                  { id: 'url', label: 'URL', value: childUrl, placeholder: 'https://...' },
                  { id: 'folder', label: 'FOLDER', type: 'select', selectOptions: cFolderData, value: cCurrentFolderId },
                  { id: 'tags', label: 'TAGS', type: 'tags' }
                ],
                _tagsInputs: [cTagsConf],
                buttons: [
                  { text: 'Cancel', className: 'modal-btn-cancel' },
                  {
                    text: 'Save', className: 'modal-btn-save', onClick: function () {
                      let newTitle = document.getElementById('modal-input-bmname').value.trim();
                      let newUrl = document.getElementById('modal-input-url').value.trim();
                      if (!newUrl) { showToast('URL required.', 'error'); return; }
                      // Update URL and title in the folder data
                      data.urls[idx] = newUrl;
                      if (!data.urlTitles) data.urlTitles = urls.map(function () { return ''; });
                      data.urlTitles[idx] = newTitle;
                      storageSet({ [key]: data }).then(function () {
                        showToast('Updated!', 'success');
                        loadShortcuts();
                      });
                    }
                  }
                ]
              });
            });
          });
          childActions.appendChild(childEdit);

          let childGo = document.createElement('button');
          childGo.className = 'go-to-icon';
          childGo.title = 'Open in new tab';
          childGo.addEventListener('click', function (e) {
            e.stopPropagation();
            chrome.tabs.create({ url: childUrl });
          });
          childActions.appendChild(childGo);

          let childCopy = document.createElement('button');
          childCopy.className = 'copy-icon';
          childCopy.title = 'Copy URL';
          childCopy.addEventListener('click', function (e) {
            e.stopPropagation();
            navigator.clipboard.writeText(childUrl).then(() => {
              childCopy.title = 'Copied!';
              setTimeout(() => { childCopy.title = 'Copy URL'; }, 1500);
            });
          });
          childActions.appendChild(childCopy);

          let childDel = document.createElement('button');
          childDel.className = 'delete-icon';
          childDel.title = 'Remove from folder';
          childDel.addEventListener('click', function (e) {
            e.stopPropagation();
            // Remove this URL from the folder shortcut
            let newUrls = urls.filter(function (u, i) { return i !== idx; });
            let newTitles = urlTitles.filter(function (t, i) { return i !== idx; });
            data.urls = newUrls;
            if (data.urlTitles) data.urlTitles = newTitles;
            storageSet({ [key]: data }).then(function () {
              childRow.remove();
              // Update the tab count badge
              let badge = li.querySelector('.shortcut-folder-badge');
              if (badge) badge.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' + newUrls.length + ' tab' + (newUrls.length !== 1 ? 's' : '');
              let urlTextEl = li.querySelector('.shortcut-url-text');
              if (urlTextEl) urlTextEl.textContent = newUrls.length + ' tab' + (newUrls.length !== 1 ? 's' : '');
              // If folder is now empty, remove the entire folder shortcut
              if (newUrls.length === 0) {
                deleteShortcut(key, 'folder:' + key);
              }
            });
          });
          childActions.appendChild(childDel);

          childRow.appendChild(childActions);
          childContainer.appendChild(childRow);
        });

        li.appendChild(childContainer);
      }

      list.appendChild(li);
    }

    if (shown === 0 && searchValue && keys.length > 0) {
      // No keyword matches — try AI search as fallback
      let aiAvail = await isAiAvailable();
      if (aiAvail) {
        let aiHint = document.createElement('li');
        aiHint.className = 'empty-state';
        aiHint.textContent = 'Searching with AI...';
        list.appendChild(aiHint);

        try {
          let response = await new Promise((resolve) => {
            let timeout = setTimeout(() => resolve({ results: null }), 5000);
            chrome.runtime.sendMessage({ action: 'ai:search', query: searchValue }, (r) => {
              clearTimeout(timeout);
              if (chrome.runtime.lastError) { resolve({ results: null }); return; }
              resolve(r || { results: null });
            });
          });

          if (response.results && response.results.length > 0) {
            list.innerHTML = '';
            // Re-render only AI-matched shortcuts in order
            let aiMatched = response.results.filter(k => items[k] && isShortcutKey(k));
            for (let key of aiMatched) {
              let data = items[key];
              let isFolder = typeof data === 'object' && data.type === 'folder';
              let url = isFolder ? '' : ((typeof data === 'object') ? data.url : data);
              let urls = isFolder ? (data.urls || []) : [];

              let li = document.createElement('li');
              let inner = document.createElement('div');
              inner.className = 'shortcut-inner';
              inner.style.cursor = 'pointer';

              if (isFolder) {
                inner.addEventListener('click', function () {
                  openFolderShortcutUrls(urls, key, data);
                });
              } else {
                inner.addEventListener('click', function () {
                  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
                    if (tabs[0]) { chrome.tabs.update(tabs[0].id, { url: url }); window.close(); }
                  });
                });
              }

              if (isFolder) {
                let folderSvg = document.createElement('span');
                folderSvg.className = 'shortcut-favicon';
                folderSvg.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
                folderSvg.style.display = 'flex'; folderSvg.style.alignItems = 'center'; folderSvg.style.justifyContent = 'center';
                inner.appendChild(folderSvg);
              } else {
                inner.appendChild(createFaviconEl(url, key, 'shortcut-favicon', 18));
              }

              let name = document.createElement('span');
              name.className = 'shortcut-name';
              name.textContent = key;
              inner.appendChild(name);

              // AI badge
              let aiBadge = document.createElement('span');
              aiBadge.className = 'shortcut-ai-badge';
              aiBadge.textContent = 'AI';
              inner.appendChild(aiBadge);

              li.appendChild(inner);
              list.appendChild(li);
            }

            if (aiMatched.length === 0) {
              list.innerHTML = '';
              let empty = document.createElement('li');
              empty.className = 'empty-state';
              empty.textContent = 'No matches found.';
              list.appendChild(empty);
            }
          } else {
            list.innerHTML = '';
            let empty = document.createElement('li');
            empty.className = 'empty-state';
            empty.textContent = 'No matches found.';
            list.appendChild(empty);
          }
        } catch (e) {
          list.innerHTML = '';
          let empty = document.createElement('li');
          empty.className = 'empty-state';
          empty.textContent = 'No matches found.';
          list.appendChild(empty);
        }
      } else {
        let empty = document.createElement('li');
        empty.className = 'empty-state';
        empty.textContent = 'No matches found.';
        list.appendChild(empty);
      }
    } else if (shown === 0) {
      let empty = document.createElement('li');
      empty.className = 'empty-state';
      empty.textContent = keys.length === 0 ? 'No shortcuts yet. Create one above!' : 'No matches found.';
      list.appendChild(empty);
    }
  } catch (err) {
    showToast('Error loading: ' + err.message, 'error');
  }
}

// ============================================================
// DELETE & EDIT (modal-based)
// ============================================================
async function addToTrashPopup(name, data) {
  try {
    let result = await storageGet(['__0tab_trash']);
    let trash = result['__0tab_trash'] || [];
    let trashItem = { name: name, url: data.url || '', tags: data.tags || [], count: data.count || 0, bookmarkTitle: data.bookmarkTitle || '', deletedAt: Date.now() };
    if (data.type === 'folder') {
      trashItem.type = 'folder';
      trashItem.urls = data.urls || [];
      trashItem.urlTitles = data.urlTitles || [];
      trashItem.folderId = data.folderId || '';
      trashItem.folderTitle = data.folderTitle || '';
    }
    trash.push(trashItem);
    let cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    trash = trash.filter(function (t) { return t.deletedAt > cutoff; });
    await storageSet({ '__0tab_trash': trash });
  } catch (e) { /* silently fail */ }
}

function deleteShortcut(name, url) {
  showModal({
    title: 'Delete ' + name + '?',
    body: 'This will remove this shortcut. You can restore it from trash.',
    buttons: [
      { text: 'Cancel', className: 'modal-btn-cancel' },
      {
        text: 'Delete', className: 'modal-btn-danger', onClick: async function () {
          try {
            let existing = await storageGet(name);
            let data = existing[name] || {};
            if (typeof data === 'string') data = { url: data };
            await addToTrashPopup(name, data);
            await storageRemove(name);
            showToast('Deleted ' + name, 'success');
            loadShortcuts();
          } catch (err) { showToast('Error: ' + err.message, 'error'); }
        }
      }
    ]
  });
}

function editShortcut(key, url) {
  // Load existing shortcut data including tags
  storageGet(key).then(function (result) {
    let data = result[key] || {};
    let isFolder = typeof data === 'object' && data.type === 'folder';
    let existingTags = (typeof data === 'object' && Array.isArray(data.tags)) ? data.tags : generateTagsFromBookmark('', url);
    let editTagsConf = { id: 'tags', tags: existingTags.slice() };
    let bookmarkTitle = (typeof data === 'object') ? (data.bookmarkTitle || '') : '';

    // Load folders for the dropdown
    chrome.runtime.sendMessage({ action: 'getBookmarkFolders' }, function (folders) {
      if (chrome.runtime.lastError) folders = [];
      folders = folders || [];

      let folderSelectData = [{ value: '', label: 'No folder' }].concat(
        folders.map(function (f) {
          let indent = '';
          for (let i = 0; i < f.depth; i++) indent += '\u00A0\u00A0';
          return { value: f.id, label: indent + (f.title || '(Untitled)') };
        })
      );

      let currentFolderId = (typeof data === 'object' && data.folderId) ? data.folderId : '';

      // Consistent fields for all shortcut types: Bookmark Name, 0tab Shortcut, URL, Folder, Tags
      let inputs = [
        { id: 'bmname', label: 'BOOKMARK NAME', value: bookmarkTitle, placeholder: 'Chrome bookmark title' },
        { id: 'shortcut', label: '0TAB SHORTCUT', value: key, placeholder: 'e.g. yt (lowercase, no spaces)' }
      ];

      if (!isFolder) {
        inputs.push({ id: 'url', label: 'URL', value: url, placeholder: 'https://example.com' });
      }

      inputs.push({ id: 'folder', label: 'FOLDER', type: 'select', selectOptions: folderSelectData, value: currentFolderId });
      inputs.push({ id: 'tags', label: 'TAGS', type: 'tags' });

      showModal({
        title: 'Edit Bookmark',
        inputs: inputs,
        _tagsInputs: [editTagsConf],
        buttons: [
          { text: 'Cancel', className: 'modal-btn-cancel' },
          {
            text: 'Save', className: 'modal-btn-save', onClick: async function () {
              let newBmName = document.getElementById('modal-input-bmname').value.trim();
              let newShortcut = document.getElementById('modal-input-shortcut').value.trim().toLowerCase().replace(/\s+/g, '');
              let tags = editTagsConf.instance ? editTagsConf.instance.getTags() : [];
              let folderSelect = document.getElementById('modal-input-folder');
              let folderId = folderSelect ? folderSelect.value : '';

              if (!newShortcut) { showToast('Shortcut name required.', 'error'); return; }
              if (newShortcut.length > 15) { showToast('Shortcut too long (max 15).', 'error'); return; }

              try {
                let items = await storageGet(null);
                if (items[newShortcut] && newShortcut !== key) { showToast(newShortcut + ' already exists!', 'error'); return; }

                if (isFolder) {
                  // Folder shortcut save
                  await storageRemove(key);
                  await storageSet({ [newShortcut]: {
                    type: 'folder',
                    urls: data.urls || [],
                    urlTitles: data.urlTitles || [],
                    folderId: folderId || data.folderId,
                    folderTitle: newBmName || data.folderTitle || newShortcut,
                    bookmarkTitle: newBmName,
                    count: data.count || 0,
                    tags: tags,
                    createdAt: data.createdAt || Date.now()
                  }});
                } else {
                  // Regular shortcut save
                  let newUrl = document.getElementById('modal-input-url').value.trim();
                  if (!newUrl) { showToast('URL required.', 'error'); return; }
                  if (!isSaveableUrl(newUrl)) { showToast('Invalid URL.', 'error'); return; }

                  let oldData = items[key] || {};
                  let preserved = typeof oldData === 'object' ? oldData : {};

                  // Update associated Chrome bookmark if it exists
                  if (preserved.bookmarkId) {
                    chrome.runtime.sendMessage({
                      action: 'updateBookmark',
                      id: preserved.bookmarkId,
                      title: newBmName || preserved.bookmarkTitle || newShortcut,
                      url: newUrl,
                      parentId: folderId || undefined
                    });
                  }

                  await storageRemove(key);
                  await storageSet({ [newShortcut]: {
                    url: newUrl,
                    count: preserved.count || 0,
                    tags: tags,
                    bookmarkId: preserved.bookmarkId,
                    bookmarkTitle: newBmName || preserved.bookmarkTitle,
                    folderId: folderId || preserved.folderId || '',
                    folderTitle: preserved.folderTitle || '',
                    aiDescription: preserved.aiDescription || '',
                    createdAt: preserved.createdAt || Date.now(),
                    lastAccessed: preserved.lastAccessed || 0
                  }});
                }

                showToast('Updated ' + newShortcut, 'success');
                loadShortcuts();
              } catch (err) { showToast('Error: ' + err.message, 'error'); }
            }
          }
        ]
      });
    });
  });
}

// ============================================================
// SAVE FOLDER AS SHORTCUT
// Opens a modal listing all bookmark folders, user picks one and gives it a shortcut name
// ============================================================
async function saveFolderShortcut() {
  try {
    // Get all bookmark folders
    let folders = await new Promise((resolve) => {
      let timeout = setTimeout(() => resolve([]), 3000);
      chrome.runtime.sendMessage({ action: 'getBookmarkFolders' }, function (result) {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) { resolve([]); return; }
        resolve(result || []);
      });
    });

    if (folders.length === 0) {
      showToast('No bookmark folders found.', 'error');
      return;
    }

    let folderSelectData = folders.map(function (f) {
      let indent = '';
      for (let i = 0; i < f.depth; i++) indent += '\u00A0\u00A0';
      return { value: f.id, label: indent + (f.title || '(Untitled)') };
    });

    showModal({
      title: 'Create Folder Shortcut',
      body: 'Pick a bookmark folder. All links inside it will open when you use this shortcut.',
      inputs: [
        { id: 'folder', label: 'Bookmark Folder', type: 'select', selectOptions: folderSelectData, value: '' },
        { id: 'name', label: 'Shortcut Name', placeholder: 'e.g. work', value: '' }
      ],
      buttons: [
        { text: 'Cancel', className: 'modal-btn-cancel' },
        {
          text: 'Save', className: 'modal-btn-save', onClick: async function () {
            let folderId = document.getElementById('modal-input-folder').value;
            let shortcutName = document.getElementById('modal-input-name').value.trim().toLowerCase().replace(/\s+/g, '');

            if (!folderId) { showToast('Select a folder.', 'error'); return; }
            if (!shortcutName) { showToast('Enter a shortcut name.', 'error'); return; }
            if (shortcutName.length > 15) { showToast('Name must be 15 chars or less.', 'error'); return; }

            try {
              // Check if name already taken
              let items = await storageGet(null);
              if (items[shortcutName] && isShortcutKey(shortcutName)) {
                showToast(shortcutName + ' already exists!', 'error');
                return;
              }

              // Get all URLs inside this folder
              let children = await new Promise((resolve) => {
                chrome.bookmarks.getSubTree(folderId, (result) => {
                  if (chrome.runtime.lastError) { resolve([]); return; }
                  resolve(result || []);
                });
              });

              let urls = [];
              let folderTitle = '';
              function collectUrls(node) {
                if (!folderTitle && !node.url && node.title) folderTitle = node.title;
                if (node.url) urls.push(node.url);
                if (node.children) node.children.forEach(collectUrls);
              }
              if (children[0]) collectUrls(children[0]);

              if (urls.length === 0) {
                showToast('This folder has no bookmarks.', 'error');
                return;
              }

              // Save as folder-type shortcut
              await storageSet({
                [shortcutName]: {
                  type: 'folder',
                  urls: urls,
                  folderId: folderId,
                  folderTitle: folderTitle || shortcutName,
                  count: 0,
                  tags: ['folder'],
                  createdAt: Date.now()
                }
              });

              showToast('Saved ' + shortcutName + ' (' + urls.length + ' tabs)', 'success');
              loadShortcuts();
            } catch (err) {
              showToast('Error: ' + err.message, 'error');
            }
          }
        }
      ]
    });
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ============================================================
// EVENT LISTENERS
// ============================================================
document.getElementById('saveButton').addEventListener('click', saveShortcut);
document.getElementById('cancelButton').addEventListener('click', () => window.close());
document.getElementById('shortcutName').addEventListener('keypress', (e) => { if (e.key === 'Enter') saveShortcut(); });

// Auto-fill bookmark name & shortcut when URL is entered manually
(function () {
  let urlField = document.getElementById('urlDisplay');
  function autoFillFromUrl() {
    let urlVal = urlField.value.trim();
    if (!urlVal) return;
    if (!/^https?:\/\//i.test(urlVal)) urlVal = 'https://' + urlVal;
    try {
      let hostname = new URL(urlVal).hostname.replace(/^www\./, '');
      let domain = hostname.split('.')[0];
      let bmField = document.getElementById('bookmarkName');
      let scField = document.getElementById('shortcutName');
      if (bmField && !bmField.value.trim()) bmField.value = domain.charAt(0).toUpperCase() + domain.slice(1);
      if (scField && !scField.value.trim()) scField.value = domain.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 3);
    } catch (e) {}
  }
  urlField.addEventListener('blur', autoFillFromUrl);
  urlField.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); autoFillFromUrl(); document.getElementById('bookmarkName').focus(); }
  });
})();

document.getElementById('searchShortcuts').addEventListener('keyup', debounce(loadShortcuts, 300));

// View toggle
document.getElementById('viewToggle').addEventListener('click', function () {
  currentViewMode = currentViewMode === 'grid' ? 'list' : 'grid';
  localStorage.setItem('tab0_view_mode', currentViewMode);
  applyViewMode();
  loadShortcuts();
});

document.getElementById('shareButton').addEventListener('click', function () {
  chrome.tabs.create({ url: 'https://chrome.google.com/webstore/detail/slash-space-go/ejcaloplfaackbkpdiidjgakbogilcdf/' });
});

document.getElementById('manageBtn').addEventListener('click', function () {
  chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
});

chrome.runtime.onMessage.addListener(function (request) {
  if (request.action === 'createShortcut') {
    document.getElementById('shortcutName').value = request.url;
  }
});

// ============================================================
// INIT
// ============================================================
applyViewMode();
showCurrentTabInfo(); // This also calls loadFolderDropdown() with the right preselection
loadShortcuts();

// ============================================================
// POPUP CHAT — Opens dashboard with Ask 0tab chat panel
// ============================================================
(function () {
  let pcToggle = document.getElementById('popupChatToggle');
  if (!pcToggle) return;
  pcToggle.addEventListener('click', function () {
    chrome.tabs.create({ url: chrome.runtime.getURL('manage.html?openChat=1') });
  });
})();
