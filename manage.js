// ============================================================
// 0TAB - Dashboard Script (Restructured)
// Home, Bookmarks+Shortcuts, Statistics, Settings
// ============================================================

const INTERNAL_KEYS = ['__0tab_folders', '__0tab_settings', '__0tab_migrated_v1', '__0tab_migrated_v2', '__0tab_daily_stats', '__0tab_trash'];
function isShortcutKey(key) {
  if (!key || typeof key !== 'string') return false;
  if (key.startsWith('__')) return false;
  return !INTERNAL_KEYS.includes(key);
}

// MV3 CSP blocks inline onerror="" handlers, so favicon HTML carries a
// data-hide-on-error attribute and we hide failed images with one
// document-level capture-phase listener (the `error` event doesn't bubble).
document.addEventListener('error', function (e) {
  let t = e.target;
  if (!t || t.tagName !== 'IMG') return;
  let mode = t.getAttribute('data-hide-on-error');
  if (mode === 'display') t.style.display = 'none';
  else if (mode === 'visibility') t.style.visibility = 'hidden';
}, true);

// --- First-letter avatar fallback for missing favicons ---
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

function applyFaviconFallback(img, name, size) {
  img.onerror = function () {
    let avatar = createLetterAvatar(name, size || img.width || 18);
    avatar.className = img.className;
    if (img.parentNode) img.parentNode.replaceChild(avatar, img);
  };
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
// Works because _favicon URLs are same-origin so canvas is not tainted.
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
    return true;
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
  let googleUrl;
  try { googleUrl = 'https://www.google.com/s2/favicons?domain=' + new URL(url).hostname + '&sz=' + (size > 16 ? 32 : 16); }
  catch (e) { wrapper.appendChild(createLetterAvatar(name, size)); return wrapper; }

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

// --- Storage helpers ---
// Storage moved from chrome.storage.sync to chrome.storage.local to avoid
// the sync quotas that were silently dropping saves. Existing sync data
// is migrated once via __0tabEnsureMigrated below.
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
  let blocked = ['about:blank', 'about:newtab', 'chrome://newtab/', 'chrome://new-tab-page/'];
  if (blocked.includes(str)) return false;
  try { new URL(str); return true; } catch (e) { return false; }
}

function debounce(fn, delay) {
  let timer;
  return function () {
    clearTimeout(timer);
    timer = setTimeout(fn, delay);
  };
}

function escapeHtml(text) {
  let div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================
// TAG GENERATION
// ============================================================
function generateTagsFromBookmark(title, url) {
  let tags = [];
  // 1. Extract domain-based tag
  try {
    let hostname = new URL(url).hostname.replace('www.', '');
    let domainTag = hostname.split('.')[0]; // e.g. "google" from "google.com"
    if (domainTag && domainTag.length > 1) tags.push(domainTag);
  } catch (e) {}
  // 2. Extract meaningful words from the title
  let titleWords = (title || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the', 'and', 'for', 'com', 'www', 'http', 'https', 'org', 'net'].includes(w));
  titleWords.forEach(function (w) {
    if (tags.length < 3 && !tags.includes(w)) tags.push(w);
  });
  // 3. Add a category tag based on URL pattern
  let urlStr = (url || '').toLowerCase();
  if (tags.length < 3) {
    if (urlStr.includes('github') || urlStr.includes('gitlab')) { if (!tags.includes('dev')) tags.push('dev'); }
    else if (urlStr.includes('docs.') || urlStr.includes('/docs') || urlStr.includes('wiki')) { if (!tags.includes('docs')) tags.push('docs'); }
    else if (urlStr.includes('mail.') || urlStr.includes('gmail') || urlStr.includes('outlook')) { if (!tags.includes('email')) tags.push('email'); }
    else if (urlStr.includes('drive.') || urlStr.includes('dropbox') || urlStr.includes('cloud')) { if (!tags.includes('cloud')) tags.push('cloud'); }
    else if (urlStr.includes('youtube') || urlStr.includes('vimeo') || urlStr.includes('video')) { if (!tags.includes('video')) tags.push('video'); }
    else if (urlStr.includes('chat') || urlStr.includes('slack') || urlStr.includes('discord') || urlStr.includes('teams')) { if (!tags.includes('chat')) tags.push('chat'); }
    else if (urlStr.includes('figma') || urlStr.includes('canva') || urlStr.includes('design')) { if (!tags.includes('design')) tags.push('design'); }
    else if (urlStr.includes('support') || urlStr.includes('desk') || urlStr.includes('helpdesk') || urlStr.includes('ticket')) { if (!tags.includes('support')) tags.push('support'); }
  }
  return tags.slice(0, 3);
}

// Build a tags input widget inside the modal
function createTagsInput(containerId, existingTags) {
  let wrapper = document.getElementById(containerId);
  if (!wrapper) return;
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
  return {
    getTags: function () { return existingTags.slice(); },
    addTag: function (tag) {
      tag = String(tag).trim().toLowerCase().replace(/[^a-z0-9- ]/g, '').replace(/\s+/g, ' ').trim();
      if (tag && !existingTags.includes(tag) && existingTags.length < 5) {
        existingTags.push(tag);
        render();
        return true;
      }
      return false;
    }
  };
}

// ============================================================
// TOAST
// ============================================================
function showToast(message, type) {
  type = type || 'info';
  let toast = document.getElementById('dashToast');
  toast.textContent = message;
  toast.className = 'toast toast-' + type;
  setTimeout(() => toast.classList.add('toast-visible'), 10);
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.className = 'toast hidden', 300);
  }, 3000);
}

// ============================================================
// MODAL
// ============================================================
function showModal(options) {
  let overlay = document.getElementById('dashModalOverlay');
  document.getElementById('dashModalTitle').textContent = options.title || '';
  document.getElementById('dashModalBody').textContent = options.body || '';

  let inputsEl = document.getElementById('dashModalInputs');
  let actionsEl = document.getElementById('dashModalActions');
  inputsEl.innerHTML = '';
  actionsEl.innerHTML = '';

  if (options.inputs) {
    options.inputs.forEach(function (inp) {
      let label = document.createElement('label');
      label.textContent = inp.label;
      label.setAttribute('for', 'dm-input-' + inp.id);

      let input;
      if (inp.type === 'select') {
        input = document.createElement('select');
        input.id = 'dm-input-' + inp.id;
        input.className = 'dm-input';
        let opts = inp.selectOptions || (inp.options || []).map(o => ({ value: o, label: o || '(None)' }));
        opts.forEach(function (opt) {
          let o = document.createElement('option');
          o.value = opt.value;
          o.textContent = opt.label;
          if (String(opt.value) === String(inp.value)) o.selected = true;
          input.appendChild(o);
        });
      } else if (inp.type === 'checkbox') {
        // Checkbox input: rendered inline with label
        let wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0 8px;';
        input = document.createElement('input');
        input.type = 'checkbox';
        input.id = 'dm-input-' + inp.id;
        input.checked = !!inp.checked;
        input.style.cssText = 'width:16px;height:16px;accent-color:var(--accent);cursor:pointer;';
        let cbLabel = document.createElement('label');
        cbLabel.setAttribute('for', 'dm-input-' + inp.id);
        cbLabel.textContent = inp.checkboxLabel || inp.label;
        cbLabel.style.cssText = 'cursor:pointer;font-size:13px;color:var(--text-secondary);user-select:none;';
        wrapper.appendChild(input);
        wrapper.appendChild(cbLabel);
        // Skip normal label/input append — use wrapper instead
        inputsEl.appendChild(wrapper);
        return;
      } else if (inp.type === 'tags') {
        // Tags input: renders as a container, filled after DOM insertion
        input = document.createElement('div');
        input.id = 'dm-input-' + inp.id;
        input.className = 'tags-input-container';
      } else {
        input = document.createElement('input');
        input.type = inp.type || 'text';
        input.id = 'dm-input-' + inp.id;
        input.value = inp.value || '';
        input.placeholder = inp.placeholder || '';
        input.className = 'dm-input';
      }

      inputsEl.appendChild(label);
      inputsEl.appendChild(input);
    });
  }

  // Render tags inputs after DOM is ready
  if (options._tagsInputs) {
    options._tagsInputs.forEach(function (tagConf) {
      tagConf.instance = createTagsInput('dm-input-' + tagConf.id, tagConf.tags.slice());
    });
  }

  if (options.buttons) {
    options.buttons.forEach(function (btn) {
      let button = document.createElement('button');
      button.textContent = btn.text;
      button.className = 'dm-btn ' + (btn.className || '');
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
  if (options.afterRender) setTimeout(() => options.afterRender(), 60);
}

function hideModal() {
  document.getElementById('dashModalOverlay').classList.add('hidden');
}

document.getElementById('dashModalOverlay').addEventListener('click', function (e) {
  if (e.target !== this) return;
  // Click the cancel-style button so any awaiting promise resolves,
  // instead of silently hiding and leaving the caller stuck.
  let actions = document.getElementById('dashModalActions');
  let cancelBtn = actions && (actions.querySelector('.dm-btn-cancel') || actions.querySelector('.dm-btn-outline') || actions.querySelector('button'));
  if (cancelBtn) { cancelBtn.click(); return; }
  hideModal();
});

// ============================================================
// THEME
// ============================================================
function applyTheme(theme) {
  document.body.className = theme === 'light' ? 'theme-light' : 'theme-dark';
  localStorage.setItem('tab0_theme', theme);
  // Update theme toggle buttons
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-theme') === theme);
  });
}

// Init theme
(function () {
  let saved = localStorage.getItem('tab0_theme') || 'dark';
  applyTheme(saved);
})();

document.querySelectorAll('.theme-btn').forEach(btn => {
  btn.addEventListener('click', function () {
    applyTheme(this.getAttribute('data-theme'));
  });
});

// ============================================================
// SIDEBAR TOGGLE
// ============================================================
document.getElementById('sidebarToggle').addEventListener('click', function () {
  let sidebar = document.getElementById('sidebar');
  let main = document.querySelector('.main');
  sidebar.classList.toggle('collapsed');
  main.classList.toggle('sidebar-collapsed');
  localStorage.setItem('tab0_sidebar_collapsed', sidebar.classList.contains('collapsed'));
});

document.querySelector('.sidebar-logo-wrapper').addEventListener('click', function () {
  let sidebar = document.getElementById('sidebar');
  if (sidebar.classList.contains('collapsed')) {
    sidebar.classList.remove('collapsed');
    document.querySelector('.main').classList.remove('sidebar-collapsed');
    localStorage.setItem('tab0_sidebar_collapsed', 'false');
  }
});

if (localStorage.getItem('tab0_sidebar_collapsed') === 'true') {
  document.getElementById('sidebar').classList.add('collapsed');
  document.querySelector('.main').classList.add('sidebar-collapsed');
}

// ============================================================
// NAVIGATION
// ============================================================
document.querySelectorAll('.nav-item').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    let viewId = btn.getAttribute('data-view');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + viewId).classList.add('active');

    if (viewId === 'bookmarks') { loadBookmarksView(); loadShortcutsTable(); }
    if (viewId === 'stats') loadStatsView();
    if (viewId === 'settings') loadSettingsState();
  });
});

// Bookmark subtab switching
document.querySelectorAll('.tab-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    let subtabId = btn.getAttribute('data-subtab');
    document.querySelectorAll('.subtab').forEach(s => s.classList.remove('active'));
    document.getElementById('subtab-' + subtabId).classList.add('active');
  });
});

// ============================================================
// (Home view removed — Bookmarks is now the main section)
// ============================================================


// ============================================================
// SHORTCUTS TABLE (now under Bookmarks tab)
// ============================================================
let activeTagFilters = [];

// Search scoring for dashboard: Shortcut Name > Bookmark Name > Tags > URL
function getDashSearchScore(key, data, searchVal) {
  if (!searchVal) return 100;
  let url = typeof data === 'object' ? (data.url || '') : (data || '');
  let bookmarkTitle = typeof data === 'object' ? (data.bookmarkTitle || '') : '';
  let tags = typeof data === 'object' && Array.isArray(data.tags) ? data.tags : [];
  let score = 0;

  let lk = key.toLowerCase();
  let lt = bookmarkTitle.toLowerCase();
  let lu = url.toLowerCase();

  if (lk === searchVal) score += 400;
  else if (lk.startsWith(searchVal)) score += 300;
  else if (lk.includes(searchVal)) score += 200;

  if (lt === searchVal) score += 150;
  else if (lt.startsWith(searchVal)) score += 120;
  else if (lt.includes(searchVal)) score += 100;
  else { let words = lt.split(/\s+/); if (words.some(w => w.startsWith(searchVal))) score += 90; }

  for (let t of tags) {
    if (t === searchVal) { score += 80; break; }
    if (t.startsWith(searchVal)) { score += 60; break; }
    if (t.includes(searchVal)) { score += 40; break; }
  }

  if (lu.includes(searchVal)) score += 20;
  return score;
}

async function loadShortcutsTable() {
  let searchVal = (document.getElementById('bookmarkSearchInput').value || '').toLowerCase().trim();
  let filterVal = document.getElementById('shortcutFilter') ? document.getElementById('shortcutFilter').value : 'most-used';

  try {
    let items = await storageGet(null);
    let tbody = document.getElementById('shortcutsTableBody');
    tbody.innerHTML = '';

    // Collect all unique tags for the filter bar
    let allTags = {};
    Object.keys(items).filter(isShortcutKey).forEach(function (k) {
      let d = items[k];
      if (typeof d === 'object' && Array.isArray(d.tags)) {
        d.tags.forEach(function (t) { allTags[t] = (allTags[t] || 0) + 1; });
      }
    });

    // Render tag filter bar
    let existingBar = document.getElementById('tagFilterBar');
    if (existingBar) existingBar.remove();
    let sortedTags = Object.keys(allTags).sort((a, b) => allTags[b] - allTags[a]).slice(0, 20);
    if (sortedTags.length > 0) {
      let bar = document.createElement('div');
      bar.id = 'tagFilterBar';
      bar.className = 'tag-filter-bar';
      sortedTags.forEach(function (tag) {
        let pill = document.createElement('button');
        pill.className = 'tag-filter-pill' + (activeTagFilters.includes(tag) ? ' active' : '');
        pill.textContent = tag;
        pill.addEventListener('click', function () {
          let idx = activeTagFilters.indexOf(tag);
          if (idx > -1) activeTagFilters.splice(idx, 1);
          else activeTagFilters.push(tag);
          loadShortcutsTable();
        });
        bar.appendChild(pill);
      });
      // Insert before the card table
      let shortcutsSubtab = document.getElementById('subtab-bm-shortcuts');
      let card = shortcutsSubtab.querySelector('.card');
      if (card) shortcutsSubtab.insertBefore(bar, card);
    }

    let keys = Object.keys(items).filter(isShortcutKey);

    // Sort: if searching, prioritize by search score; otherwise use filter
    if (searchVal) {
      keys.sort((a, b) => {
        let scoreA = getDashSearchScore(a, items[a], searchVal);
        let scoreB = getDashSearchScore(b, items[b], searchVal);
        if (scoreB !== scoreA) return scoreB - scoreA;
        return ((typeof items[b] === 'object' ? items[b].count : 0) || 0) - ((typeof items[a] === 'object' ? items[a].count : 0) || 0);
      });
    } else if (filterVal === 'most-used') {
      keys.sort((a, b) => ((typeof items[b] === 'object' ? items[b].count : 0) || 0) - ((typeof items[a] === 'object' ? items[a].count : 0) || 0));
    } else if (filterVal === 'recently-accessed') {
      keys.sort((a, b) => {
        let aTime = typeof items[a] === 'object' ? (items[a].lastAccessed || 0) : 0;
        let bTime = typeof items[b] === 'object' ? (items[b].lastAccessed || 0) : 0;
        return bTime - aTime;
      });
    } else if (filterVal === 'time-created') {
      keys.sort((a, b) => {
        let aTime = typeof items[a] === 'object' ? (items[a].createdAt || 0) : 0;
        let bTime = typeof items[b] === 'object' ? (items[b].createdAt || 0) : 0;
        return bTime - aTime;
      });
    } else if (filterVal === 'alphabetical') {
      keys.sort((a, b) => a.localeCompare(b));
    }

    let visibleCount = 0;

    keys.forEach(function (key) {
      let data = items[key];
      let isFolder = typeof data === 'object' && data.type === 'folder';
      let url = typeof data === 'object' ? (data.url || '') : (data || '');
      let count = typeof data === 'object' ? (data.count || 0) : 0;
      let tags = typeof data === 'object' && Array.isArray(data.tags) ? data.tags : [];

      // Search scoring
      if (searchVal && getDashSearchScore(key, data, searchVal) === 0) return;
      // Tag filter: must have ALL active filter tags
      if (activeTagFilters.length > 0 && !activeTagFilters.every(ft => tags.includes(ft))) return;
      visibleCount++;

      let tr = document.createElement('tr');

      let tdFav = document.createElement('td');
      tdFav.className = 'favicon-cell';
      if (isFolder) {
        tdFav.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
      } else {
        tdFav.appendChild(createFaviconEl(url, key, '', 16));
      }
      tr.appendChild(tdFav);

      let tdName = document.createElement('td');
      let nameStrong = document.createElement('strong');
      nameStrong.textContent = key;
      tdName.appendChild(nameStrong);
      // Show tags inline next to the name
      if (tags.length > 0) {
        let tagsSpan = document.createElement('span');
        tagsSpan.className = 'shortcut-tags-inline';
        tags.forEach(function (tag) {
          let pill = document.createElement('span');
          pill.className = 'tag-pill tag-pill-sm';
          pill.textContent = tag;
          pill.setAttribute('data-tooltip', tag);
          tagsSpan.appendChild(pill);
        });
        tdName.appendChild(tagsSpan);
      }
      tr.appendChild(tdName);

      let tdUrl = document.createElement('td');
      tdUrl.className = 'url-cell';
      if (isFolder) {
        let folderLabel = document.createElement('span');
        folderLabel.className = 'folder-url-label';
        let urlCount = Array.isArray(data.urls) ? data.urls.length : 0;
        folderLabel.textContent = (data.folderTitle || key) + ' (' + urlCount + ' tab' + (urlCount !== 1 ? 's' : '') + ')';
        tdUrl.appendChild(folderLabel);
      } else {
        let urlLink = document.createElement('a');
        urlLink.href = url;
        urlLink.target = '_blank';
        urlLink.textContent = url.length > 50 ? url.substring(0, 50) + '...' : url;
        urlLink.title = url;
        tdUrl.appendChild(urlLink);
      }
      tr.appendChild(tdUrl);

      let tdCount = document.createElement('td');
      let countBadge = document.createElement('span');
      countBadge.className = 'count-badge';
      countBadge.textContent = count;
      tdCount.appendChild(countBadge);
      tr.appendChild(tdCount);

      let tdActions = document.createElement('td');
      tdActions.className = 'actions-cell';

      let editBtn = document.createElement('button');
      editBtn.className = 'btn btn-sm btn-edit';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => editShortcutDash(key, url, count));
      tdActions.appendChild(editBtn);

      let deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-sm btn-delete';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => deleteShortcutDash(key, url));
      tdActions.appendChild(deleteBtn);

      tr.appendChild(tdActions);
      tbody.appendChild(tr);
    });

    let emptyState = document.getElementById('emptyState');
    emptyState.classList.toggle('hidden', visibleCount > 0);
  } catch (err) {
    showToast('Error loading shortcuts: ' + err.message, 'error');
  }
}

document.getElementById('addShortcutBtn').addEventListener('click', async function () {
  let params = new URLSearchParams(window.location.search);
  let prefillUrl = params.get('newurl') || '';
  let prefillTitle = params.get('newtitle') || '';
  let suggestedName = prefillTitle ? prefillTitle.toLowerCase().replace(/[^a-z0-9]+/g, '').substring(0, 3) : '';
  let autoTags = (prefillUrl && prefillTitle) ? generateTagsFromBookmark(prefillTitle, prefillUrl) : [];

  // Try AI-powered tag & shortcut name generation (non-blocking, fills in after modal opens)
  let aiTagsPromise = null;
  let aiNamePromise = null;
  if (prefillUrl && prefillTitle) {
    aiTagsPromise = new Promise(function (resolve) {
      let timeout = setTimeout(function () { resolve(null); }, 6000);
      chrome.runtime.sendMessage({ action: 'ai:generateTags', title: prefillTitle, url: prefillUrl }, function (r) {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(r && r.tags ? r.tags : null);
      });
    });
    aiNamePromise = new Promise(function (resolve) {
      let timeout = setTimeout(function () { resolve(null); }, 6000);
      chrome.runtime.sendMessage({ action: 'ai:generateShortcutName', title: prefillTitle, url: prefillUrl }, function (r) {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(r && r.name ? r.name : null);
      });
    });
  }

  let newShortcutTagsConf = { id: 'tags', tags: autoTags.slice() };

  // Load folders for folder dropdown
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

    showModal({
      title: 'New Shortcut',
      inputs: [
        { id: 'url', label: 'URL', value: prefillUrl, placeholder: 'https://example.com' },
        { id: 'name', label: '0tab Shortcut (max 15 chars, no spaces)', value: suggestedName, placeholder: 'e.g. yt' },
        { id: 'folder', label: 'Bookmark Folder', type: 'select', selectOptions: folderSelectData, value: '' },
        { id: 'tags', label: 'Tags (optional, up to 5, press Enter to add)', type: 'tags' }
      ],
      _tagsInputs: [newShortcutTagsConf],
      buttons: [
        { text: 'Cancel', className: 'dm-btn-cancel' },
        {
          text: 'Save', className: 'dm-btn-save', onClick: async function () {
            let name = document.getElementById('dm-input-name').value.trim().toLowerCase();
            let url = document.getElementById('dm-input-url').value.trim();
            let tags = newShortcutTagsConf.instance ? newShortcutTagsConf.instance.getTags() : [];
            let folderSelect = document.getElementById('dm-input-folder');
            let folderId = folderSelect ? folderSelect.value : '';
            if (!name) { showToast('Name required.', 'error'); return; }
            if (name.length > 15) { showToast('Name too long (max 15).', 'error'); return; }
            if (/\s/.test(name)) { showToast('No spaces in name.', 'error'); return; }
            if (!url || !isSaveableUrl(url)) { showToast('Valid URL required.', 'error'); return; }
            try {
              let all = await storageGet(null);
              if (all[name] && isShortcutKey(name)) { showToast(name + ' already exists!', 'error'); return; }
              // Default to 0tab Shortcuts folder if none selected
              if (!folderId) {
                try {
                  folderId = await new Promise(resolve => {
                    chrome.runtime.sendMessage({ action: 'getTab0FolderId' }, resolve);
                  });
                } catch (e) {}
              }
              // Create Chrome bookmark
              let bookmarkId, bookmarkTitle;
              if (folderId) {
                try {
                  let bm = await new Promise((resolve, reject) => {
                    chrome.bookmarks.create({ title: name, url: url, parentId: folderId }, (result) => {
                      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                      else resolve(result);
                    });
                  });
                  bookmarkId = bm.id;
                  bookmarkTitle = name;
                } catch (e) { /* bookmark creation failed, still save shortcut */ }
              }
              let shortcutData = { url: url, count: 0, tags: tags, createdAt: Date.now() };
              if (bookmarkId) { shortcutData.bookmarkId = bookmarkId; shortcutData.bookmarkTitle = bookmarkTitle; }
              await storageSet({ [name]: shortcutData });
              showToast('Created ' + name, 'success');
              if (prefillUrl) window.history.replaceState({}, '', 'manage.html');
              loadShortcutsTable();
            } catch (err) {
              showToast('Error: ' + err.message, 'error');
            }
          }
        }
      ],
      afterRender: function () {
        // Fill in AI-generated tags and shortcut name when they arrive
        if (aiNamePromise) {
          aiNamePromise.then(function (aiName) {
            if (!aiName) return;
            let nameInput = document.getElementById('dm-input-name');
            if (nameInput && !nameInput.value.trim()) {
              nameInput.value = aiName;
              nameInput.style.borderColor = 'var(--accent)';
              setTimeout(function () { nameInput.style.borderColor = ''; }, 2000);
            }
          });
        }
        if (aiTagsPromise) {
          aiTagsPromise.then(function (aiTags) {
            if (!aiTags || aiTags.length === 0) return;
            if (newShortcutTagsConf.instance) {
              let currentTags = newShortcutTagsConf.instance.getTags();
              if (currentTags.length === 0 || (currentTags.length <= 3 && autoTags.length > 0)) {
                // Replace basic tags with AI tags if user hasn't manually edited
                aiTags.forEach(function (t) {
                  if (currentTags.length < 5 && !currentTags.includes(t)) {
                    newShortcutTagsConf.instance.addTag(t);
                  }
                });
              }
            }
          });
        }
      }
    });
  });
});

function editShortcutDash(key, url, count) {
  // Load existing data including tags
  storageGet(key).then(function (result) {
    let data = result[key] || {};
    let isFolder = typeof data === 'object' && data.type === 'folder';
    let existingTags = (typeof data === 'object' && data.tags) ? data.tags : generateTagsFromBookmark('', url);
    let editTagsConf = { id: 'tags', tags: existingTags.slice() };

    // For folder shortcuts, show simpler edit modal
    if (isFolder) {
      showModal({
        title: 'Edit Folder Shortcut',
        inputs: [
          { id: 'name', label: 'Shortcut name', value: key, placeholder: 'e.g. work' },
          { id: 'tags', label: 'Tags (up to 5, press Enter to add)', type: 'tags' }
        ],
        _tagsInputs: [editTagsConf],
        buttons: [
          { text: 'Cancel', className: 'dm-btn-cancel' },
          {
            text: 'Save', className: 'dm-btn-save', onClick: async function () {
              let newName = document.getElementById('dm-input-name').value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
              let tags = editTagsConf.instance ? editTagsConf.instance.getTags() : [];
              if (!newName) { showToast('Name required.', 'error'); return; }
              if (newName.length > 15) { showToast('Name too long.', 'error'); return; }
              try {
                let all = await storageGet(null);
                if (all[newName] && newName !== key) { showToast(newName + ' already exists!', 'error'); return; }
                await storageRemove(key);
                await storageSet({ [newName]: { type: 'folder', urls: data.urls || [], folderId: data.folderId, folderTitle: data.folderTitle || newName, count: data.count || 0, tags: tags, createdAt: data.createdAt || Date.now() } });
                showToast('Updated ' + newName, 'success');
                loadShortcutsTable();
              } catch (err) { showToast('Error: ' + err.message, 'error'); }
            }
          }
        ]
      });
      return;
    }

    // Load folders for folder dropdown (regular shortcuts only)
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

      showModal({
        title: 'Edit ' + key,
        inputs: [
          { id: 'name', label: 'Shortcut name', value: key, placeholder: 'e.g. yt' },
          { id: 'url', label: 'URL', value: url, placeholder: 'https://example.com' },
          { id: 'tags', label: 'Tags (up to 5, press Enter to add)', type: 'tags' },
          { id: 'folder', label: 'Folder', type: 'select', selectOptions: folderSelectData, value: '' }
        ],
        _tagsInputs: [editTagsConf],
        buttons: [
          { text: 'Cancel', className: 'dm-btn-cancel' },
          {
            text: 'Save', className: 'dm-btn-save', onClick: async function () {
              let newName = document.getElementById('dm-input-name').value.trim().toLowerCase();
              let newUrl = document.getElementById('dm-input-url').value.trim();
              let tags = editTagsConf.instance ? editTagsConf.instance.getTags() : [];
              let folderSelect = document.getElementById('dm-input-folder');
              let folderId = folderSelect ? folderSelect.value : '';
              if (!newName) { showToast('Name required.', 'error'); return; }
              if (newName.length > 15) { showToast('Name too long.', 'error'); return; }
              if (/\s/.test(newName)) { showToast('No spaces.', 'error'); return; }
              if (!newUrl || !isSaveableUrl(newUrl)) { showToast('Invalid URL.', 'error'); return; }
              try {
                let all = await storageGet(null);
                if (all[newName] && newName !== key) { showToast(newName + ' already exists!', 'error'); return; }
                let oldData = all[key] || {};
                let preservedData = typeof oldData === 'object' ? oldData : {};

                // If there's an associated bookmark, update it too
                if (preservedData.bookmarkId) {
                  chrome.runtime.sendMessage({
                    action: 'updateBookmark', id: preservedData.bookmarkId,
                    title: preservedData.bookmarkTitle || newName, url: newUrl,
                    parentId: folderId || undefined
                  });
                }

                await storageRemove(key);
                await storageSet({ [newName]: { url: newUrl, count: count, tags: tags, bookmarkId: preservedData.bookmarkId || undefined, bookmarkTitle: preservedData.bookmarkTitle || undefined, createdAt: preservedData.createdAt || Date.now() } });
                showToast('Updated ' + newName, 'success');
                loadShortcutsTable();
              } catch (err) {
                showToast('Error: ' + err.message, 'error');
              }
            }
          }
        ]
      });
    });
  });
}

async function addToTrashManage(name, data) {
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

function deleteShortcutDash(key) {
  showModal({
    title: 'Delete Shortcut',
    body: 'Permanently delete "' + key + '"?',
    buttons: [
      { text: 'Cancel', className: 'dm-btn-cancel' },
      {
        text: 'Delete', className: 'dm-btn-danger', onClick: async function () {
          try {
            let existing = await storageGet(key);
            let data = existing[key] || {};
            if (typeof data === 'string') data = { url: data };
            await addToTrashManage(key, data);
            await storageRemove(key);
            showToast(key + ' deleted. Check trash to restore.', 'success');
            loadShortcutsTable();
          } catch (err) {
            showToast('Error: ' + err.message, 'error');
          }
        }
      }
    ]
  });
}

// ============================================================
// STATS VIEW (enhanced)
// ============================================================
// Helper: format relative time
function formatTimeAgo(timestamp) {
  if (!timestamp) return 'Never';
  let diff = Date.now() - timestamp;
  let mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return mins + 'm ago';
  let hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  let days = Math.floor(hrs / 24);
  if (days < 30) return days + 'd ago';
  let months = Math.floor(days / 30);
  if (months < 12) return months + 'mo ago';
  return Math.floor(months / 12) + 'y ago';
}

let _statsCurrentPeriod = 'daily';

// ============================================================
// INSIGHTS VIEW — narrative-driven analytics
// Pulls from: chrome.storage.local shortcut metadata (count, lastAccessed,
// createdAt, tags) + chrome.storage.local '__0tab_daily_stats' (daily
// aggregate open counts).
// ============================================================

function insightsDateKey(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (matches logAccess format)
}
function insightsDaysAgo(n) {
  let d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}
function insightsSumInRange(dailyStats, startDate, endDate) {
  let total = 0;
  let cur = new Date(startDate);
  while (cur <= endDate) {
    let k = insightsDateKey(cur);
    if (dailyStats[k] && dailyStats[k].opens) total += dailyStats[k].opens;
    cur.setDate(cur.getDate() + 1);
  }
  return total;
}

function insightsBuildSparkline(values, width, height, color) {
  if (!values || values.length === 0) return '';
  width = width || 100;
  height = height || 24;
  let max = Math.max.apply(null, values);
  if (max === 0) max = 1;
  let step = values.length > 1 ? width / (values.length - 1) : 0;
  let points = values.map(function (v, i) {
    let x = (i * step).toFixed(1);
    let y = (height - (v / max) * (height - 2) - 1).toFixed(1);
    return x + ',' + y;
  }).join(' ');
  let area = 'M0,' + height + ' L' + points.split(' ').join(' L') + ' L' + width + ',' + height + ' Z';
  return '<svg class="insights-kpi-sparkline" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none">' +
    '<path d="' + area + '" fill="' + (color || 'var(--accent)') + '" opacity="0.15"></path>' +
    '<polyline points="' + points + '" fill="none" stroke="' + (color || 'var(--accent)') + '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"></polyline>' +
    '</svg>';
}

function insightsDeltaEl(delta) {
  if (delta === null || delta === undefined) return '<span class="insights-kpi-delta insights-kpi-delta-flat">new</span>';
  if (delta > 0) return '<span class="insights-kpi-delta insights-kpi-delta-up">▲ ' + delta + '%</span>';
  if (delta < 0) return '<span class="insights-kpi-delta insights-kpi-delta-down">▼ ' + Math.abs(delta) + '%</span>';
  return '<span class="insights-kpi-delta insights-kpi-delta-flat">• flat</span>';
}

function insightsPctDelta(thisPeriod, prevPeriod) {
  if (!prevPeriod || prevPeriod === 0) return thisPeriod > 0 ? null : 0;
  return Math.round(((thisPeriod - prevPeriod) / prevPeriod) * 100);
}

function insightsFavicon(url, size) {
  try { return 'https://www.google.com/s2/favicons?domain=' + new URL(url).hostname + '&sz=' + (size || 16); }
  catch (e) { return ''; }
}

async function loadStatsView() {
  try {
    // ---- Data gathering ----
    let items = await storageGet(null);
    let keys = Object.keys(items).filter(isShortcutKey);
    let shortcuts = keys.map(function (k) {
      let d = items[k]; if (typeof d === 'string') d = { url: d, count: 0 };
      return Object.assign({ name: k }, d || {});
    });
    let dailyStats = {};
    try {
      dailyStats = await new Promise(function (r) {
        chrome.runtime.sendMessage({ action: 'getDailyStats' }, r);
      }) || {};
    } catch (e) {}

    let now = new Date();
    now.setHours(0, 0, 0, 0);

    // Week windows
    let weekStart = insightsDaysAgo(6);  // last 7 days including today
    let weekEnd = now;
    let prevWeekStart = insightsDaysAgo(13);
    let prevWeekEnd = insightsDaysAgo(7);
    let monthStart = insightsDaysAgo(29);

    let opensThisWeek = insightsSumInRange(dailyStats, weekStart, weekEnd);
    let opensPrevWeek = insightsSumInRange(dailyStats, prevWeekStart, prevWeekEnd);
    let opensThisMonth = insightsSumInRange(dailyStats, monthStart, weekEnd);

    // Active shortcuts — any with lastAccessed in last 30 days
    let thirtyDaysAgoTs = insightsDaysAgo(29).getTime();
    let activeShortcuts = shortcuts.filter(function (s) {
      return s.lastAccessed && s.lastAccessed >= thirtyDaysAgoTs;
    });
    // Same window, previous 30 days, for delta
    let sixtyDaysAgoTs = insightsDaysAgo(59).getTime();
    let prevActiveShortcuts = shortcuts.filter(function (s) {
      return s.lastAccessed && s.lastAccessed >= sixtyDaysAgoTs && s.lastAccessed < thirtyDaysAgoTs;
    });

    // New shortcuts this month
    let newThisMonth = shortcuts.filter(function (s) {
      return s.createdAt && s.createdAt >= monthStart.getTime();
    });
    let prevMonthStart = insightsDaysAgo(59).getTime();
    let newPrevMonth = shortcuts.filter(function (s) {
      return s.createdAt && s.createdAt >= prevMonthStart && s.createdAt < monthStart.getTime();
    });

    // Dead pile — saved but never opened, >7 days old
    let weekAgoTs = insightsDaysAgo(6).getTime();
    let deadPile = shortcuts.filter(function (s) {
      return (s.count || 0) === 0 && s.type !== 'folder' && s.createdAt && s.createdAt < weekAgoTs;
    });

    let totalShortcuts = shortcuts.length;
    let top = shortcuts.slice().sort(function (a, b) { return (b.count || 0) - (a.count || 0); })[0];

    // ---- Hero narrative ----
    let headlineEl = document.getElementById('insightsHeadline');
    let heroSubEl = document.getElementById('insightsHeroSub');
    if (headlineEl) {
      if (opensThisWeek === 0 && opensPrevWeek === 0) {
        headlineEl.textContent = totalShortcuts === 0
          ? 'Save your first shortcut to start seeing insights.'
          : 'No shortcuts opened yet. Your data will grow as you use them.';
      } else {
        let delta = insightsPctDelta(opensThisWeek, opensPrevWeek);
        let trendWord = delta === null ? 'first active week' : (delta > 0 ? 'up ' + delta + '%' : (delta < 0 ? 'down ' + Math.abs(delta) + '%' : 'flat'));
        headlineEl.innerHTML = 'You opened <strong>' + opensThisWeek + '</strong> shortcut' + (opensThisWeek !== 1 ? 's' : '') + ' this week — ' + trendWord + ' vs last week.';
      }
    }
    if (heroSubEl) {
      let parts = [];
      if (top && (top.count || 0) > 0) parts.push('Most used: <strong>' + tab0EscapeHtml(top.name) + '</strong> (' + top.count + ' opens)');
      if (activeShortcuts.length > 0) parts.push(activeShortcuts.length + ' active shortcut' + (activeShortcuts.length !== 1 ? 's' : '') + ' in last 30 days');
      heroSubEl.innerHTML = parts.length > 0 ? parts.join(' · ') : 'Tip: the dashboard updates live as you open shortcuts.';
    }

    // ---- Streak: consecutive days with at least 1 open, ending today ----
    let streak = 0;
    let d = new Date(); d.setHours(0, 0, 0, 0);
    while (true) {
      let k = insightsDateKey(d);
      if (dailyStats[k] && dailyStats[k].opens > 0) { streak++; d.setDate(d.getDate() - 1); }
      else { break; }
    }
    let streakNumEl = document.getElementById('insightsStreakNum');
    if (streakNumEl) streakNumEl.textContent = streak;

    // ---- KPI cards ----
    // 1) Opens this week + sparkline last 8 weeks
    let weeklyTotals = [];
    for (let i = 7; i >= 0; i--) {
      let ws = insightsDaysAgo(i * 7 + 6);
      let we = insightsDaysAgo(i * 7);
      weeklyTotals.push(insightsSumInRange(dailyStats, ws, we));
    }
    let kpis = [
      {
        label: 'Opens this week',
        value: opensThisWeek,
        delta: insightsPctDelta(opensThisWeek, opensPrevWeek),
        spark: weeklyTotals
      },
      {
        label: 'Active shortcuts',
        value: activeShortcuts.length,
        delta: insightsPctDelta(activeShortcuts.length, prevActiveShortcuts.length),
        sub: 'last 30 days'
      },
      {
        label: 'New this month',
        value: newThisMonth.length,
        delta: insightsPctDelta(newThisMonth.length, newPrevMonth.length),
        sub: 'created recently'
      },
      {
        label: 'Dead pile',
        value: deadPile.length,
        delta: null,
        sub: deadPile.length > 0 ? 'never opened' : 'clean',
        tone: 'muted'
      }
    ];
    let kpiRow = document.getElementById('insightsKpiRow');
    if (kpiRow) {
      kpiRow.innerHTML = '';
      kpis.forEach(function (k) {
        let card = document.createElement('div');
        card.className = 'insights-kpi';
        let sparkHtml = k.spark ? insightsBuildSparkline(k.spark, 140, 24) : '';
        let deltaHtml = insightsDeltaEl(k.delta);
        let subHtml = k.sub ? '<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">' + tab0EscapeHtml(k.sub) + '</div>' : '';
        card.innerHTML =
          '<div class="insights-kpi-label">' + tab0EscapeHtml(k.label) + '</div>' +
          '<div class="insights-kpi-value">' + k.value + '</div>' +
          deltaHtml + subHtml + sparkHtml;
        kpiRow.appendChild(card);
      });
    }

    // ---- Heatmap: last 84 days (12 weeks), 7 rows × 12 columns ----
    let heatEl = document.getElementById('insightsHeatmap');
    let heatSubEl = document.getElementById('insightsHeatmapSub');
    if (heatEl) {
      heatEl.innerHTML = '';
      let totalPeriod = 84;
      let dayValues = [];
      for (let i = totalPeriod - 1; i >= 0; i--) {
        let day = insightsDaysAgo(i);
        let k = insightsDateKey(day);
        dayValues.push({ date: day, count: (dailyStats[k] && dailyStats[k].opens) || 0, key: k });
      }
      let maxOpens = Math.max.apply(null, dayValues.map(function (x) { return x.count; }));
      if (maxOpens === 0) maxOpens = 1;
      dayValues.forEach(function (dv) {
        let cell = document.createElement('div');
        cell.className = 'insights-heat-cell';
        let level = 0;
        if (dv.count > 0) {
          let ratio = dv.count / maxOpens;
          if (ratio > 0.75) level = 4;
          else if (ratio > 0.5) level = 3;
          else if (ratio > 0.25) level = 2;
          else level = 1;
        }
        cell.setAttribute('data-level', String(level));
        cell.setAttribute('title', dv.key + ' · ' + dv.count + ' open' + (dv.count !== 1 ? 's' : ''));
        heatEl.appendChild(cell);
      });
      let activeDays = dayValues.filter(function (x) { return x.count > 0; }).length;
      if (heatSubEl) heatSubEl.textContent = activeDays + ' active day' + (activeDays !== 1 ? 's' : '') + ' out of ' + totalPeriod + ' · longest streak ' + streak + ' day' + (streak !== 1 ? 's' : '');
    }

    // ---- Top shortcuts bar chart ----
    let topChart = document.getElementById('insightsTopChart');
    let topMeta = document.getElementById('insightsTopMeta');
    if (topChart) {
      let topList = shortcuts.slice().sort(function (a, b) { return (b.count || 0) - (a.count || 0); }).filter(function (s) { return (s.count || 0) > 0; }).slice(0, 10);
      if (topList.length === 0) {
        topChart.innerHTML = '<div class="insights-empty">No opens tracked yet. Your most-used shortcuts will appear here.</div>';
        if (topMeta) topMeta.textContent = '—';
      } else {
        let maxC = topList[0].count || 1;
        topChart.innerHTML = '';
        topList.forEach(function (s) {
          let row = document.createElement('div');
          row.className = 'insights-bar-row';
          row.innerHTML =
            '<div class="insights-bar-name" title="' + tab0EscapeHtml(s.url || '') + '">' + tab0EscapeHtml(s.name) + '</div>' +
            '<div class="insights-bar-track"><div class="insights-bar-fill" style="width:' + Math.max(2, Math.round((s.count / maxC) * 100)) + '%;"></div></div>' +
            '<div class="insights-bar-count">' + (s.count || 0) + '</div>';
          topChart.appendChild(row);
        });
        if (topMeta) topMeta.textContent = 'Top ' + topList.length + ' of ' + shortcuts.filter(function (s) { return (s.count || 0) > 0; }).length;
      }
    }

    // ---- Tag landscape ----
    let tagCloud = document.getElementById('insightsTagCloud');
    let tagMeta = document.getElementById('insightsTagMeta');
    if (tagCloud) {
      let tagMap = {};
      shortcuts.forEach(function (s) {
        if (Array.isArray(s.tags)) s.tags.forEach(function (t) {
          if (typeof t !== 'string' || !t) return;
          tagMap[t] = (tagMap[t] || 0) + 1;
        });
      });
      let tagEntries = Object.keys(tagMap).map(function (t) { return { tag: t, n: tagMap[t] }; }).sort(function (a, b) { return b.n - a.n; });
      if (tagEntries.length === 0) {
        tagCloud.innerHTML = '<div class="insights-empty">No tags yet. Tags make shortcuts easier to find — try saving with some.</div>';
        if (tagMeta) tagMeta.textContent = '0 tags';
      } else {
        tagCloud.innerHTML = '';
        tagEntries.slice(0, 20).forEach(function (e) {
          let chip = document.createElement('span');
          chip.className = 'insights-tag-chip';
          chip.innerHTML = '#' + tab0EscapeHtml(e.tag) + ' <b>' + e.n + '</b>';
          tagCloud.appendChild(chip);
        });
        let untagged = shortcuts.filter(function (s) { return (!s.tags || s.tags.length === 0) && s.type !== 'folder'; }).length;
        if (tagMeta) tagMeta.textContent = tagEntries.length + ' unique · ' + untagged + ' untagged';
      }
    }

    // ---- Recently trending (opened in last 7 days, ranked by recent-activity) ----
    let trendingEl = document.getElementById('insightsTrendingList');
    if (trendingEl) {
      let sevenDaysAgo = insightsDaysAgo(6).getTime();
      let trending = shortcuts.filter(function (s) {
        return s.lastAccessed && s.lastAccessed >= sevenDaysAgo && s.url;
      }).sort(function (a, b) {
        // Rank by recency first, then count
        if (b.lastAccessed !== a.lastAccessed) return b.lastAccessed - a.lastAccessed;
        return (b.count || 0) - (a.count || 0);
      }).slice(0, 6);
      if (trending.length === 0) {
        trendingEl.innerHTML = '<div class="insights-empty">Nothing opened in the last 7 days.</div>';
      } else {
        trendingEl.innerHTML = '';
        trending.forEach(function (s) {
          let row = document.createElement('div');
          row.className = 'insights-list-row';
          let ago = tab0TimeAgo(s.lastAccessed);
          row.innerHTML =
            '<img class="insights-list-row-fav" src="' + insightsFavicon(s.url, 32) + '" data-hide-on-error="visibility">' +
            '<div class="insights-list-row-main">' +
              '<div class="insights-list-row-name">' + tab0EscapeHtml(s.name) + '</div>' +
              '<div class="insights-list-row-meta">' + ago + ' · ' + (s.count || 0) + ' opens</div>' +
            '</div>' +
            '<span class="insights-list-row-delta insights-list-row-delta-up">active</span>';
          row.style.cursor = 'pointer';
          row.addEventListener('click', function (ev) {
            // Default: open in new tab so the dashboard stays put.
            // Cmd/Ctrl+click replaces the current tab instead.
            if (ev.metaKey || ev.ctrlKey) chrome.tabs.update({ url: s.url });
            else chrome.tabs.create({ url: s.url });
          });
          trendingEl.appendChild(row);
        });
      }
    }

    // ---- Gone cold (used before, idle 30+ days) ----
    let coldEl = document.getElementById('insightsColdList');
    if (coldEl) {
      let thirty = insightsDaysAgo(29).getTime();
      let cold = shortcuts.filter(function (s) {
        return (s.count || 0) > 0 && s.lastAccessed && s.lastAccessed < thirty && s.url;
      }).sort(function (a, b) { return (a.lastAccessed || 0) - (b.lastAccessed || 0); }).slice(0, 6);
      if (cold.length === 0) {
        coldEl.innerHTML = '<div class="insights-empty">Nothing has gone cold. Good hygiene.</div>';
      } else {
        coldEl.innerHTML = '';
        cold.forEach(function (s) {
          let row = document.createElement('div');
          row.className = 'insights-list-row';
          let ago = tab0TimeAgo(s.lastAccessed);
          row.innerHTML =
            '<img class="insights-list-row-fav" src="' + insightsFavicon(s.url, 32) + '" data-hide-on-error="visibility">' +
            '<div class="insights-list-row-main">' +
              '<div class="insights-list-row-name">' + tab0EscapeHtml(s.name) + '</div>' +
              '<div class="insights-list-row-meta">last: ' + ago + ' · ' + (s.count || 0) + ' opens</div>' +
            '</div>' +
            '<span class="insights-list-row-delta insights-list-row-delta-down">idle</span>';
          row.style.cursor = 'pointer';
          row.addEventListener('click', function (ev) {
            // Default: open in new tab so the dashboard stays put.
            // Cmd/Ctrl+click replaces the current tab instead.
            if (ev.metaKey || ev.ctrlKey) chrome.tabs.update({ url: s.url });
            else chrome.tabs.create({ url: s.url });
          });
          coldEl.appendChild(row);
        });
      }
    }

    // ---- Dead pile ----
    let deadEl = document.getElementById('insightsDeadList');
    let deadSubEl = document.getElementById('insightsDeadSub');
    let deadBtn = document.getElementById('insightsDeadCleanupBtn');
    if (deadEl) {
      if (deadPile.length === 0) {
        deadEl.innerHTML = '<div class="insights-empty">Clean slate — everything saved has been opened.</div>';
        if (deadSubEl) deadSubEl.textContent = 'Shortcuts saved but never opened.';
        if (deadBtn) deadBtn.style.display = 'none';
      } else {
        if (deadBtn) deadBtn.style.display = '';
        if (deadSubEl) deadSubEl.textContent = deadPile.length + ' shortcut' + (deadPile.length !== 1 ? 's' : '') + ' saved more than a week ago and never opened.';
        deadEl.innerHTML = '';
        deadPile.slice(0, 20).forEach(function (s) {
          let row = document.createElement('div');
          row.className = 'insights-list-row';
          row.innerHTML =
            '<img class="insights-list-row-fav" src="' + insightsFavicon(s.url, 32) + '" data-hide-on-error="visibility">' +
            '<div class="insights-list-row-main">' +
              '<div class="insights-list-row-name">' + tab0EscapeHtml(s.name) + '</div>' +
              '<div class="insights-list-row-meta">' + (s.url ? tab0EscapeHtml((new URL(s.url).hostname || '').replace(/^www\./, '')) : 'no url') + '</div>' +
            '</div>';
          row.style.cursor = s.url ? 'pointer' : 'default';
          if (s.url) row.addEventListener('click', function (ev) {
            // Default: new tab. Cmd/Ctrl+click replaces current tab.
            if (ev.metaKey || ev.ctrlKey) chrome.tabs.update({ url: s.url });
            else chrome.tabs.create({ url: s.url });
          });
          deadEl.appendChild(row);
        });
      }
    }
    if (deadBtn && !deadBtn._wired) {
      deadBtn._wired = true;
      deadBtn.addEventListener('click', function () {
        openAskChatWith('Clean up unused bookmarks');
      });
    }
  } catch (e) {
    console.warn('0tab Insights render failed:', e && e.message);
  }
}

// ============================================================
// SETTINGS
// ============================================================
async function loadSettingsState() {
  try {
    let result = await storageGet('__0tab_settings');
    let settings = result['__0tab_settings'] || {};
    document.getElementById('settingBookmarkSync').checked = settings.bookmarkSync !== false;
    document.getElementById('settingTabGroupFolders').checked = settings.tabGroupFolders !== false;

    // AI settings — auto-enabled when model is ready
    let aiToggle = document.getElementById('settingAiFeatures');
    if (aiToggle) {
      aiToggle.checked = settings.aiEnabled === true;
      // Check actual AI availability and update UI
      chrome.runtime.sendMessage({ action: 'ai:status' }, function (response) {
        if (chrome.runtime.lastError) return;
        let statusEl = document.getElementById('aiStatusText');
        let downloadArea = document.getElementById('aiDownloadArea');
        let helpLinks = document.getElementById('aiHelpLinks');
        if (!statusEl || !response) return;

        if (response.status === 'readily') {
          statusEl.textContent = 'Gemini Nano is ready';
          statusEl.style.color = 'var(--success)';
          if (downloadArea) downloadArea.style.display = 'none';
          // Auto-check the toggle since model is ready
          if (!aiToggle.checked) {
            aiToggle.checked = true;
            // Save the setting
            storageGet('__0tab_settings').then(function (r) {
              let s = r['__0tab_settings'] || {};
              s.aiEnabled = true;
              storageSet({ '__0tab_settings': s });
            });
          }
        } else if (response.status === 'after-download') {
          statusEl.textContent = 'Model available — download to enable';
          statusEl.style.color = 'var(--accent-primary)';
          if (downloadArea) downloadArea.style.display = 'block';
          if (helpLinks) helpLinks.style.display = 'block';
          // Auto-disable if toggle was on but model not downloaded
          if (aiToggle.checked) {
            aiToggle.checked = false;
            storageGet('__0tab_settings').then(function (r) {
              let s = r['__0tab_settings'] || {};
              s.aiEnabled = false;
              storageSet({ '__0tab_settings': s });
            });
          }
        } else {
          statusEl.textContent = 'Not available on this browser';
          statusEl.style.color = 'var(--text-muted)';
          if (downloadArea) downloadArea.style.display = 'none';
          if (helpLinks) helpLinks.style.display = 'block';
          // Auto-disable if toggle was on but AI not available
          if (aiToggle.checked) {
            aiToggle.checked = false;
            storageGet('__0tab_settings').then(function (r) {
              let s = r['__0tab_settings'] || {};
              s.aiEnabled = false;
              storageSet({ '__0tab_settings': s });
            });
          }
        }
      });
    }
  } catch (e) {}
}

document.getElementById('settingBookmarkSync').addEventListener('change', async function () {
  try {
    let result = await storageGet('__0tab_settings');
    let settings = result['__0tab_settings'] || {};
    settings.bookmarkSync = this.checked;
    await storageSet({ '__0tab_settings': settings });
    showToast('Bookmark sync ' + (this.checked ? 'enabled' : 'disabled'), 'success');
  } catch (e) {
    showToast('Error saving setting.', 'error');
  }
});

// Tab group folders toggle
document.getElementById('settingTabGroupFolders').addEventListener('change', async function () {
  try {
    let result = await storageGet('__0tab_settings');
    let settings = result['__0tab_settings'] || {};
    settings.tabGroupFolders = this.checked;
    await storageSet({ '__0tab_settings': settings });
    showToast('Tab groups ' + (this.checked ? 'enabled' : 'disabled'), 'success');
  } catch (e) {
    showToast('Error saving setting.', 'error');
  }
});

// AI features toggle — prevent enabling when browser doesn't support it
let aiToggleGlobal = document.getElementById('settingAiFeatures');
if (aiToggleGlobal) {
  aiToggleGlobal.addEventListener('change', async function () {
    let toggle = this;
    try {
      if (toggle.checked) {
        // Check AI availability before allowing enable
        let aiStatus = await new Promise(function (resolve) {
          let timeout = setTimeout(function () { resolve({ available: false, status: 'no' }); }, 3000);
          chrome.runtime.sendMessage({ action: 'ai:status' }, function (r) {
            clearTimeout(timeout);
            if (chrome.runtime.lastError) { resolve({ available: false, status: 'no' }); return; }
            resolve(r || { available: false, status: 'no' });
          });
        });
        if (!aiStatus.available) {
          toggle.checked = false;
          if (aiStatus.status === 'after-download') {
            showToast('Click the Download Model button below to get started.', 'error');
          } else {
            showToast('Gemini Nano is not available. Check the setup guide below for instructions.', 'error');
          }
          return;
        }
      }
      let result = await storageGet('__0tab_settings');
      let settings = result['__0tab_settings'] || {};
      settings.aiEnabled = toggle.checked;
      await storageSet({ '__0tab_settings': settings });
      showToast('AI features ' + (toggle.checked ? 'enabled' : 'disabled'), 'success');
    } catch (e) {
      showToast('Error saving setting.', 'error');
    }
  });
}

// AI Download Model button
let aiDownloadBtn = document.getElementById('aiDownloadBtn');
if (aiDownloadBtn) {
  aiDownloadBtn.addEventListener('click', function () {
    let btn = this;
    let progressEl = document.getElementById('aiDownloadProgress');
    btn.disabled = true;
    btn.textContent = 'Downloading...';
    if (progressEl) progressEl.textContent = 'This may take a few minutes';

    chrome.runtime.sendMessage({ action: 'ai:download' }, function (response) {
      if (chrome.runtime.lastError) {
        btn.disabled = false;
        btn.textContent = 'Download Model';
        if (progressEl) progressEl.textContent = '';
        showToast('Download failed. Please try again.', 'error');
        return;
      }
      if (response && response.ok) {
        btn.textContent = 'Downloaded!';
        if (progressEl) progressEl.textContent = '';
        let downloadArea = document.getElementById('aiDownloadArea');
        if (downloadArea) downloadArea.style.display = 'none';
        // Update status and toggle
        let statusEl = document.getElementById('aiStatusText');
        if (statusEl) {
          statusEl.textContent = 'Gemini Nano is ready';
          statusEl.style.color = 'var(--success)';
        }
        let toggle = document.getElementById('settingAiFeatures');
        if (toggle) toggle.checked = true;
        showToast('Gemini Nano downloaded and enabled!', 'success');
      } else {
        btn.disabled = false;
        btn.textContent = 'Download Model';
        if (progressEl) progressEl.textContent = '';
        showToast('Download failed: ' + ((response && response.error) || 'Unknown error'), 'error');
      }
    });
  });
}

// chrome:// links need to be opened via chrome.tabs.create
document.querySelectorAll('.chrome-link').forEach(function (link) {
  link.addEventListener('click', function (e) {
    e.preventDefault();
    let url = this.getAttribute('data-url');
    if (url && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: url });
    }
  });
});

// ============================================================
// ADD NEW BOOKMARK / ADD NEW FOLDER buttons
// ============================================================
document.getElementById('addNewBookmarkBtn').addEventListener('click', function () {
  chrome.runtime.sendMessage({ action: 'getBookmarkFolders' }, function (folders) {
    folders = folders || [];
    let folderSelectData = folders.map(function (f) {
      let indent = '';
      for (let i = 0; i < f.depth; i++) indent += '\u00A0\u00A0';
      return { value: f.id, label: indent + (f.title || '(Untitled)') };
    });

    let addBmTagsConf = { id: 'tags', tags: [] };
    showModal({
      title: 'Add Bookmark',
      inputs: [
        { id: 'url', label: 'URL', value: '', placeholder: 'https://example.com' },
        { id: 'bmname', label: 'Bookmark Name', value: '', placeholder: 'e.g. Book Fusion' },
        { id: 'shortcut', label: '0tab Shortcut (lowercase, no spaces)', value: '', placeholder: 'e.g. bookfusion' },
        { id: 'folder', label: 'Bookmark Folder', type: 'select', selectOptions: folderSelectData, value: '' },
        { id: 'tags', label: 'Tags (up to 5, press Enter to add)', type: 'tags' }
      ],
      _tagsInputs: [addBmTagsConf],
      afterRender: function () {
        let urlInput = document.getElementById('dm-input-url');
        if (urlInput) {
          urlInput.addEventListener('blur', function () {
            let urlVal = urlInput.value.trim();
            if (!urlVal) return;
            if (!/^https?:\/\//i.test(urlVal)) urlVal = 'https://' + urlVal;
            let nameField = document.getElementById('dm-input-bmname');
            let shortcutField = document.getElementById('dm-input-shortcut');
            try {
              let hostname = new URL(urlVal).hostname.replace(/^www\./, '');
              let domain = hostname.split('.')[0];
              if (nameField && !nameField.value.trim()) nameField.value = domain.charAt(0).toUpperCase() + domain.slice(1);
              if (shortcutField && !shortcutField.value.trim()) shortcutField.value = domain.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 3);
            } catch (e) {}

            // Auto-generate basic tags immediately
            let bmTitle = (nameField ? nameField.value : '') || '';
            if (addBmTagsConf.instance && addBmTagsConf.instance.getTags().length === 0) {
              let basicTags = generateTagsFromBookmark(bmTitle, urlVal);
              basicTags.forEach(function (t) { addBmTagsConf.instance.addTag(t); });
            }

            // Try AI-powered generation (fills in asynchronously)
            chrome.runtime.sendMessage({ action: 'ai:generateTags', title: bmTitle, url: urlVal }, function (r) {
              if (chrome.runtime.lastError || !r || !r.tags) return;
              if (addBmTagsConf.instance) {
                let current = addBmTagsConf.instance.getTags();
                r.tags.forEach(function (t) {
                  if (current.length < 5 && !current.includes(t)) {
                    addBmTagsConf.instance.addTag(t);
                    current.push(t);
                  }
                });
              }
            });
            chrome.runtime.sendMessage({ action: 'ai:generateShortcutName', title: bmTitle, url: urlVal }, function (r) {
              if (chrome.runtime.lastError || !r || !r.name) return;
              if (shortcutField && !shortcutField.value.trim()) {
                shortcutField.value = r.name;
                shortcutField.style.borderColor = 'var(--accent)';
                setTimeout(function () { shortcutField.style.borderColor = ''; }, 2000);
              }
            });
          });
        }
      },
      buttons: [
        { text: 'Cancel', className: 'dm-btn-cancel' },
        {
          text: 'Save', className: 'dm-btn-save', onClick: async function () {
            let name = document.getElementById('dm-input-bmname').value.trim();
            let shortcutInput = document.getElementById('dm-input-shortcut').value.trim().toLowerCase().replace(/\s+/g, '');
            let url = document.getElementById('dm-input-url').value.trim();
            let folderId = document.getElementById('dm-input-folder').value;
            let tags = addBmTagsConf.instance ? addBmTagsConf.instance.getTags() : [];
            if (!name) { showToast('Name required.', 'error'); return; }
            if (!url || !isSaveableUrl(url)) { showToast('Valid URL required.', 'error'); return; }
            // Auto-generate tags if none were added
            if (tags.length === 0) tags = generateTagsFromBookmark(name, url);
            let shortcutName = shortcutInput || name.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 3);
            let createData = { title: name, url: url };
            if (folderId) createData.parentId = folderId;
            chrome.bookmarks.create(createData, function (newBm) {
              if (chrome.runtime.lastError) {
                showToast('Error: ' + chrome.runtime.lastError.message, 'error');
                return;
              }
              if (shortcutName) {
                storageGet(null).then(function (all) {
                  if (all[shortcutName] && isShortcutKey(shortcutName)) {
                    showToast('Bookmark added! Shortcut "' + shortcutName + '" already exists.', 'info');
                  } else {
                    storageSet({ [shortcutName]: { url: url, count: 0, bookmarkId: newBm.id, bookmarkTitle: name, tags: tags, createdAt: Date.now() } }).then(function () {
                      showToast('Bookmark & shortcut added!', 'success');
                    });
                  }
                });
              } else {
                showToast('Bookmark added!', 'success');
              }
              loadBookmarksView(true);
              if (openPanels.length > 0) refreshOpenPanels();
            });
          }
        }
      ]
    });
  });
});

/**
 * Generate a unique shortcut name from a folder title that doesn't conflict with existing shortcuts.
 */
/**
 * Generate a unique shortcut name (max 3 letters) from a folder title that doesn't conflict with existing shortcuts.
 */
function generateFolderShortcutName(folderTitle, allData) {
  let words = (folderTitle || '').toLowerCase().replace(/[^a-z0-9\s]+/g, '').trim().split(/\s+/).filter(Boolean);
  let base = '';
  if (words.length >= 3) {
    // Use first letter of each of the first 3 words (e.g. "Chrome Extensions Dev" → "ced")
    base = words[0][0] + words[1][0] + words[2][0];
  } else if (words.length === 2) {
    // First letter of word1 + first 2 letters of word2 (e.g. "My Work" → "mwo")
    base = words[0][0] + words[1].substring(0, 2);
  } else if (words[0]) {
    // First 3 letters of the single word (e.g. "Jadu" → "jad")
    base = words[0].substring(0, 3);
  }
  if (base.length < 2) base = 'fld';
  base = base.substring(0, 3);
  let candidate = base;
  let suffix = 1;
  while (allData && allData[candidate]) {
    candidate = base + suffix;
    suffix++;
  }
  return candidate;
}

// Ask the AI to propose a short (≤4 chars) shortcut key + 1-line description
// for a folder name. Falls back to the rule-based generator if AI isn't ready.
async function aiProposeFolderNaming(folderName, allData) {
  let base = generateFolderShortcutName(folderName, allData);
  let fallback = { shortcut: base, description: '' };
  try {
    let aiStatus = await new Promise(function (resolve) {
      let timeout = setTimeout(function () { resolve({ available: false }); }, 1500);
      chrome.runtime.sendMessage({ action: 'ai:status' }, function (r) {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) { resolve({ available: false }); return; }
        resolve(r || { available: false });
      });
    });
    if (!aiStatus || !aiStatus.available) return fallback;

    let prompt = 'You suggest a short keyboard shortcut and a one-line description for a bookmark folder.\n' +
      'Folder name: "' + folderName + '"\n\n' +
      'Reply in this EXACT JSON format, no other text:\n' +
      '{"shortcut":"wrk","description":"Work projects and docs"}\n\n' +
      'Rules:\n' +
      '- shortcut: 2-4 lowercase letters/digits, memorable (first letters, abbreviation, or domain-like)\n' +
      '- description: 3-8 words, under 60 chars, no period\n' +
      '- Avoid these taken shortcuts: ' + Object.keys(allData || {}).filter(isShortcutKey).slice(0, 40).join(', ');

    let response = await new Promise(function (resolve) {
      let timeout = setTimeout(function () { resolve(null); }, 5000);
      chrome.runtime.sendMessage({ action: 'ai:chat', prompt: prompt }, function (r) {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(r);
      });
    });
    if (!response || !response.text) return fallback;
    // Extract JSON from response text (model may wrap it)
    let match = response.text.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    let parsed;
    try { parsed = JSON.parse(match[0]); } catch (e) { return fallback; }
    let sc = (parsed.shortcut || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15);
    let desc = (parsed.description || '').toString().replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
    if (!sc || sc.length < 2) sc = base;
    if (allData && allData[sc]) {
      // Pick a free variant using the existing generator seeded with our pick
      let suffix = 1;
      while (allData[sc + suffix]) suffix++;
      sc = sc + suffix;
    }
    return { shortcut: sc, description: desc };
  } catch (e) {
    return fallback;
  }
}

document.getElementById('addNewFolderBtn').addEventListener('click', async function () {
  // Load all existing data first so we can check for shortcut conflicts
  let allData = await storageGet(null);

  chrome.runtime.sendMessage({ action: 'getBookmarkFolders' }, function (folders) {
    folders = folders || [];
    let folderSelectData = folders.map(function (f) {
      let indent = '';
      for (let i = 0; i < f.depth; i++) indent += '\u00A0\u00A0';
      return { value: f.id, label: indent + (f.title || '(Untitled)') };
    });

    // Default to Bookmarks bar (ID "1" in Chrome)
    let defaultParentId = '1';

    showModal({
      title: 'Add Folder',
      inputs: [
        { id: 'foldername', label: 'FOLDER NAME', value: '', placeholder: 'e.g. Work' },
        { id: 'foldershortcut', label: '0TAB SHORTCUT', value: '', placeholder: 'auto-generated as you type' },
        { id: 'folderdesc', label: 'DESCRIPTION (optional)', value: '', placeholder: 'One-line hint, auto-filled by AI when available' },
        { id: 'parent', label: 'PARENT FOLDER', type: 'select', selectOptions: folderSelectData, value: defaultParentId }
      ],
      buttons: [
        { text: 'Cancel', className: 'dm-btn-cancel' },
        {
          text: 'Create', className: 'dm-btn-save', onClick: async function () {
            let name = document.getElementById('dm-input-foldername').value.trim();
            let shortcut = document.getElementById('dm-input-foldershortcut').value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
            let descField = document.getElementById('dm-input-folderdesc');
            let description = descField ? descField.value.trim() : '';
            let parentId = document.getElementById('dm-input-parent').value;
            if (!name) { showToast('Folder name required.', 'error'); return; }

            // Auto-generate shortcut if left empty
            if (!shortcut) {
              shortcut = generateFolderShortcutName(name, allData);
            }

            // Check for shortcut conflict
            if (shortcut && allData[shortcut]) {
              showToast('Shortcut "' + shortcut + '" already exists. Choose another.', 'error');
              return;
            }

            let createData = { title: name };
            if (parentId) createData.parentId = parentId;
            chrome.bookmarks.create(createData, async function (newFolder) {
              if (chrome.runtime.lastError) {
                showToast('Error: ' + chrome.runtime.lastError.message, 'error');
                return;
              }

              // Save the folder shortcut — pinned to top of popup by default
              // (folder shortcuts are the user's most intentional saves)
              if (shortcut && newFolder) {
                // Compute next pinOrder so this tile lands at the end of
                // the existing pinned set rather than overlapping.
                let latestAll = await storageGet(null);
                let maxPinOrder = 0;
                Object.keys(latestAll).filter(isShortcutKey).forEach(function (k) {
                  let d = latestAll[k];
                  if (d && typeof d === 'object' && d.pinned && typeof d.pinOrder === 'number' && d.pinOrder > maxPinOrder) {
                    maxPinOrder = d.pinOrder;
                  }
                });
                await storageSet({
                  [shortcut]: {
                    type: 'folder',
                    urls: [],
                    folderId: newFolder.id,
                    folderTitle: name,
                    count: 0,
                    tags: ['folder'],
                    createdAt: Date.now(),
                    aiDescription: description || '',
                    pinned: true,
                    pinOrder: maxPinOrder + 10
                  }
                });
              }

              showToast('Folder "' + name + '" created · shortcut "' + shortcut + '" · pinned to popup', 'success');
              loadBookmarksView(true);
              if (openPanels.length > 0) refreshOpenPanels();
            });
          }
        }
      ]
    });

    // Auto-fill shortcut + description when folder name is typed. Debounced AI call.
    setTimeout(function () {
      let nameInput = document.getElementById('dm-input-foldername');
      let shortcutInput = document.getElementById('dm-input-foldershortcut');
      let descInput = document.getElementById('dm-input-folderdesc');
      if (!nameInput || !shortcutInput) return;

      let aiTimer = null;
      let latestAiTicket = 0;

      nameInput.addEventListener('input', function () {
        let typed = nameInput.value.trim();
        // Rule-based fills fire instantly
        if (typed && !shortcutInput._userEdited) {
          shortcutInput.value = generateFolderShortcutName(typed, allData);
        }
        // AI refinement after short pause — upgrades both shortcut and desc
        if (aiTimer) clearTimeout(aiTimer);
        aiTimer = setTimeout(async function () {
          if (!typed || typed.length < 2) return;
          let ticket = ++latestAiTicket;
          let proposal = await aiProposeFolderNaming(typed, allData);
          if (ticket !== latestAiTicket) return; // user kept typing; stale
          if (!shortcutInput._userEdited && proposal.shortcut) {
            shortcutInput.value = proposal.shortcut;
          }
          if (descInput && !descInput._userEdited && proposal.description) {
            descInput.value = proposal.description;
          }
        }, 500);
      });

      shortcutInput.addEventListener('input', function () {
        shortcutInput._userEdited = shortcutInput.value.trim().length > 0;
      });
      if (descInput) {
        descInput.addEventListener('input', function () {
          descInput._userEdited = descInput.value.trim().length > 0;
        });
      }
    }, 50);
  });
});

// Shortcut filter change handler
document.getElementById('shortcutFilter').addEventListener('change', function () {
  loadShortcutsTable();
});

// ============================================================
// CSV IMPORT/EXPORT (now under Settings)
// ============================================================
document.getElementById('dashExportBtn').addEventListener('click', async function () {
  try {
    let items = await storageGet(null);
    let keys = Object.keys(items).filter(isShortcutKey);
    if (keys.length === 0) { showToast('No shortcuts to export.', 'error'); return; }

    let csvContent = 'shortcut_name,url,count,folder\n';
    keys.forEach(function (key) {
      let data = items[key];
      let url = typeof data === 'object' ? data.url : data;
      let count = typeof data === 'object' ? (data.count || 0) : 0;
      let folder = typeof data === 'object' ? (data.folder || data.category || '') : '';
      csvContent += key + ',"' + url.replace(/"/g, '""') + '",' + count + ',"' + folder.replace(/"/g, '""') + '"\n';
    });

    let blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    let downloadUrl = URL.createObjectURL(blob);
    let a = document.createElement('a');
    a.href = downloadUrl;
    a.download = 'tab0-shortcuts.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);
    showToast('CSV exported!', 'success');
  } catch (err) {
    showToast('Export error: ' + err.message, 'error');
  }
});

document.getElementById('dashImportBtn').addEventListener('click', function () {
  document.getElementById('dashCsvInput').click();
});

document.getElementById('dashCsvInput').addEventListener('change', function (event) {
  let file = event.target.files[0];
  if (!file) return;

  let reader = new FileReader();
  reader.onload = async function (e) {
    let text = e.target.result;
    let lines = text.split('\n').filter(l => l.trim() !== '');
    let startIndex = (lines.length > 0 && lines[0].toLowerCase().includes('shortcut_name')) ? 1 : 0;

    if (lines.length <= startIndex) { showToast('CSV is empty.', 'error'); return; }

    let shortcuts = {};
    let skipped = 0;

    for (let i = startIndex; i < lines.length; i++) {
      let line = lines[i].trim();
      if (!line) continue;

      let parts;
      if (line.includes('"')) {
        let match = line.match(/^([^,]+),("(?:[^"]|"")*"|[^,]*),?([^,]*),?(.*)$/);
        if (match) {
          parts = [
            match[1].trim().toLowerCase(),
            match[2].replace(/^"|"$/g, '').replace(/""/g, '"').trim(),
            parseInt(match[3]) || 0,
            match[4] ? match[4].replace(/^"|"$/g, '').replace(/""/g, '"').trim() : ''
          ];
        } else { skipped++; continue; }
      } else {
        let split = line.split(',');
        parts = [
          split[0] ? split[0].trim().toLowerCase() : '',
          split[1] ? split[1].trim() : '',
          parseInt(split[2]) || 0,
          split[3] ? split[3].trim() : ''
        ];
      }

      if (!parts[0] || !parts[1] || parts[0].length > 15 || /\s/.test(parts[0])) { skipped++; continue; }
      shortcuts[parts[0]] = { url: parts[1], count: parts[2], folder: parts[3] };
    }

    let count = Object.keys(shortcuts).length;
    if (count === 0) { showToast('No valid shortcuts in CSV.', 'error'); return; }

    showModal({
      title: 'Import CSV',
      body: 'Import ' + count + ' shortcut(s)?' + (skipped > 0 ? ' (' + skipped + ' rows skipped)' : '') + ' Existing names will be overwritten.',
      buttons: [
        { text: 'Cancel', className: 'dm-btn-cancel' },
        {
          text: 'Import', className: 'dm-btn-save', onClick: async function () {
            try {
              await storageSet(shortcuts);
              showToast(count + ' shortcut(s) imported!', 'success');
              let resultEl = document.getElementById('dashImportResult');
              resultEl.className = 'result-msg result-success';
              resultEl.textContent = count + ' shortcuts imported!';
              resultEl.classList.remove('hidden');
              loadShortcutsTable();
            } catch (err) {
              showToast('Import error: ' + err.message, 'error');
            }
          }
        }
      ]
    });
  };
  reader.readAsText(file);
  event.target.value = '';
});

// ============================================================
// BOOKMARKS - Gallery View + Drag & Drop + Live Sync
// ============================================================
let allBookmarkNodes = [];
let currentOpenFolder = null; // still track for compatibility
let openPanels = []; // Array of {id, folderNode} for multi-panel

function getBookmarkTree() {
  return new Promise((resolve) => {
    chrome.bookmarks.getTree((tree) => resolve(tree));
  });
}

function flattenBookmarks(node, arr) {
  if (node.url) arr.push(node);
  if (node.children) node.children.forEach(child => flattenBookmarks(child, arr));
}

function countBookmarks(node) {
  let total = 0;
  if (node.url) total++;
  if (node.children) node.children.forEach(function (c) { total += countBookmarks(c); });
  return total;
}

async function loadBookmarksView(keepPanels) {
  let grid = document.getElementById('bmGalleryGrid');
  let emptyEl = document.getElementById('bookmarksEmpty');
  grid.innerHTML = '';
  emptyEl.classList.add('hidden');

  if (!keepPanels) {
    closeFolderDetail();
    currentOpenFolder = null;
  }

  try {
    let tree = await getBookmarkTree();
    window._tab0CachedTree = tree;
    allBookmarkNodes = [];

    let roots = tree[0].children || [];
    let hasContent = false;

    roots.forEach(function (rootFolder) {
      flattenBookmarks(rootFolder, allBookmarkNodes);
      if (!rootFolder.children || rootFolder.children.length === 0) return;
      hasContent = true;

      let card = renderGalleryCard(rootFolder);
      grid.appendChild(card);

      let subfolders = rootFolder.children.filter(c => !c.url && c.children && c.children.length > 0);
      subfolders.forEach(function (sub) {
        let subCard = renderGalleryCard(sub);
        grid.appendChild(subCard);
      });
    });

    if (!hasContent) emptyEl.classList.remove('hidden');
  } catch (err) {
    showToast('Error loading bookmarks: ' + err.message, 'error');
  }
}

// Check if targetId is a descendant of parentId in the cached tree
function isDescendantOf(targetId, ancestorId) {
  let tree = window._tab0CachedTree;
  if (!tree) return false;
  function findNode(node, id) {
    if (node.id === id) return node;
    if (node.children) {
      for (let c of node.children) {
        let found = findNode(c, id);
        if (found) return found;
      }
    }
    return null;
  }
  let ancestor = findNode(tree[0], ancestorId);
  if (!ancestor) return false;
  function hasDescendant(node, id) {
    if (node.id === id) return true;
    if (node.children) {
      for (let c of node.children) {
        if (hasDescendant(c, id)) return true;
      }
    }
    return false;
  }
  return hasDescendant(ancestor, targetId);
}

function renderGalleryCard(folderNode) {
  let card = document.createElement('div');
  card.className = 'bm-gallery-card';
  card.setAttribute('data-folder-id', folderNode.id);
  card.setAttribute('draggable', 'true');

  // --- Drag start: make this folder card draggable ---
  card.addEventListener('dragstart', function (e) {
    e.dataTransfer.setData('text/bookmark-id', folderNode.id);
    e.dataTransfer.setData('text/is-folder', 'true');
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('bm-card-dragging');
    // Highlight other cards as drop targets
    setTimeout(function () {
      document.querySelectorAll('.bm-gallery-card').forEach(function (c) {
        if (c.getAttribute('data-folder-id') !== folderNode.id) {
          c.classList.add('bm-drag-hint');
        }
      });
    }, 0);
  });
  card.addEventListener('dragend', function () {
    card.classList.remove('bm-card-dragging');
    document.querySelectorAll('.bm-gallery-card').forEach(c => c.classList.remove('bm-drag-hint', 'bm-drop-target'));
  });

  // --- Drop target: accept folders/bookmarks dropped into this card ---
  card.addEventListener('dragover', function (e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!card.classList.contains('bm-card-dragging')) {
      card.classList.add('bm-drop-target');
    }
  });
  card.addEventListener('dragleave', function () {
    card.classList.remove('bm-drop-target');
  });
  card.addEventListener('drop', function (e) {
    e.preventDefault();
    card.classList.remove('bm-drop-target');
    let bmId = e.dataTransfer.getData('text/bookmark-id');
    // Prevent dropping a folder into itself or into its own descendant
    if (bmId && bmId !== folderNode.id && !isDescendantOf(folderNode.id, bmId)) {
      chrome.runtime.sendMessage({
        action: 'moveBookmark', id: bmId, parentId: folderNode.id
      }, function () {
        loadBookmarksView(true);
        if (openPanels.length > 0) refreshOpenPanels();
      });
    }
  });

  let header = document.createElement('div');
  header.className = 'bm-gallery-header';
  let folderIcon = document.createElement('span');
  folderIcon.className = 'bm-gallery-icon';
  folderIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  header.appendChild(folderIcon);
  let title = document.createElement('span');
  title.className = 'bm-gallery-title';
  title.textContent = folderNode.title || 'Bookmarks';
  header.appendChild(title);
  card.appendChild(header);

  let preview = document.createElement('div');
  preview.className = 'bm-gallery-preview';
  let directBookmarks = (folderNode.children || []).filter(c => c.url);
  let directFolders = (folderNode.children || []).filter(c => !c.url && c.children);
  let previewItems = directBookmarks.slice(0, 5);

  previewItems.forEach(function (bm) {
    let item = document.createElement('div');
    item.className = 'bm-gallery-preview-item';
    item.appendChild(createFaviconEl(bm.url, bm.title || bm.url, '', 14));
    let name = document.createElement('span');
    name.textContent = bm.title || bm.url;
    item.appendChild(name);
    preview.appendChild(item);
  });

  if (directFolders.length > 0) {
    let foldersLine = document.createElement('div');
    foldersLine.className = 'bm-gallery-preview-item bm-gallery-subfolder-line';
    foldersLine.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    let ftext = document.createElement('span');
    ftext.textContent = directFolders.length + ' subfolder' + (directFolders.length !== 1 ? 's' : '');
    foldersLine.appendChild(ftext);
    preview.appendChild(foldersLine);
  }

  if (directBookmarks.length > 5) {
    let more = document.createElement('div');
    more.className = 'bm-gallery-more';
    more.textContent = '+ ' + (directBookmarks.length - 5) + ' more';
    preview.appendChild(more);
  }

  if (directBookmarks.length === 0 && directFolders.length === 0) {
    let empty = document.createElement('div');
    empty.className = 'bm-gallery-empty';
    empty.textContent = 'Empty folder';
    preview.appendChild(empty);
  }

  card.appendChild(preview);

  let footer = document.createElement('div');
  footer.className = 'bm-gallery-footer';
  let total = countBookmarks(folderNode);
  footer.textContent = total + ' bookmark' + (total !== 1 ? 's' : '');
  card.appendChild(footer);

  let wasDragged = false;
  card.addEventListener('dragstart', function () { wasDragged = true; });
  card.addEventListener('dragend', function () { setTimeout(function () { wasDragged = false; }, 100); });
  card.addEventListener('click', function () {
    if (wasDragged) return;
    openFolderDetail(folderNode);
  });

  return card;
}

function updatePanelMargin() {
  let main = document.querySelector('.main');
  main.classList.remove('panel-open-1', 'panel-open-2');
  if (openPanels.length === 1) main.classList.add('panel-open-1');
  else if (openPanels.length >= 2) main.classList.add('panel-open-2');
}

function closeFolderDetail() {
  let container = document.getElementById('bmPanelContainer');
  container.innerHTML = '';
  container.classList.add('hidden');
  openPanels = [];
  currentOpenFolder = null;
  updatePanelMargin();
}

// Close a specific panel by its index in the openPanels array
// Also closes any panels to its right (like miller columns)
function closePanelAt(index) {
  // Remove this panel and all panels to the right
  openPanels.splice(index);
  renderAllPanels();
}

function renderAllPanels() {
  let container = document.getElementById('bmPanelContainer');

  if (openPanels.length === 0) {
    container.innerHTML = '';
    container.classList.add('hidden');
    currentOpenFolder = null;
    updatePanelMargin();
    return;
  }

  container.classList.remove('hidden');
  currentOpenFolder = openPanels[openPanels.length - 1].folderNode;

  // Build all new panels off-screen first, then swap in one shot to avoid flicker
  let fragment = document.createDocumentFragment();
  openPanels.forEach(function (panelData, panelIndex) {
    let panel = buildPanelElement(panelData.folderNode, panelIndex);
    fragment.appendChild(panel);
  });
  container.innerHTML = '';
  container.appendChild(fragment);

  updatePanelMargin();
}

// Open folder detail: from gallery click → replace all panels; from subfolder click → add as next panel
function openFolderDetail(folderNode, options) {
  options = options || {};

  // Reduce max panels to 1 when chat side-panel is open
  let chatIsOpen = document.body.classList.contains('chat-panel-open');
  let maxPanels = chatIsOpen ? 1 : 2;

  if (options.asSubfolder && openPanels.length > 0) {
    // Opening a subfolder: close any panels after the parent panel, then add this one
    let parentIndex = options.parentPanelIndex !== undefined ? options.parentPanelIndex : openPanels.length - 1;
    // Remove panels after parent
    openPanels.splice(parentIndex + 1);
    // Add this subfolder as a new panel
    if (openPanels.length >= maxPanels) {
      // Replace the last panel
      openPanels[maxPanels - 1] = { id: folderNode.id, folderNode: folderNode };
    } else {
      openPanels.push({ id: folderNode.id, folderNode: folderNode });
    }
  } else {
    // Opening from gallery card: check if already open
    let existingIdx = openPanels.findIndex(p => p.id === folderNode.id);
    if (existingIdx >= 0) {
      // Already open, just refresh it
      openPanels[existingIdx].folderNode = folderNode;
    } else if (openPanels.length >= maxPanels) {
      // At max panels, replace the last one
      openPanels[maxPanels - 1] = { id: folderNode.id, folderNode: folderNode };
    } else {
      openPanels.push({ id: folderNode.id, folderNode: folderNode });
    }
  }

  currentOpenFolder = folderNode;
  renderAllPanels();
}

function refreshOpenPanels() {
  // Invalidate cached tree so breadcrumbs re-fetch after moves
  window._tab0CachedTree = null;
  // Pre-fetch the tree so it's ready synchronously when panels rebuild
  chrome.bookmarks.getTree(function (tree) {
    window._tab0CachedTree = tree;
  });
  // Refresh all open panels from their IDs
  let toRefresh = openPanels.map(p => p.id);
  let refreshed = 0;
  toRefresh.forEach(function (folderId, idx) {
    chrome.bookmarks.getSubTree(folderId, function (results) {
      if (results && results[0]) {
        openPanels[idx] = { id: folderId, folderNode: results[0] };
      }
      refreshed++;
      if (refreshed === toRefresh.length) {
        // Remove panels whose folders no longer exist
        openPanels = openPanels.filter(p => p.folderNode);
        renderAllPanels();
      }
    });
  });
}

// ============================================================
// FOLDER EXPORT
// ============================================================
async function exportBookmarksFromFolder(folderNode) {
  try {
    let bookmarks = (folderNode.children || []).filter(c => c.url);
    if (bookmarks.length === 0) {
      showToast('No bookmarks to export in this folder.', 'error');
      return;
    }

    // Also get 0tab shortcut data for each bookmark
    let allData = await storageGet(null);
    let allKeys = Object.keys(allData).filter(isShortcutKey);

    let exportItems = bookmarks.map(function (bm) {
      // Find matching shortcut by bookmarkId
      let shortcutKey = '';
      let tags = [];
      for (let i = 0; i < allKeys.length; i++) {
        let d = allData[allKeys[i]];
        if (typeof d === 'object' && d.bookmarkId === bm.id) {
          shortcutKey = allKeys[i];
          tags = d.tags || [];
          break;
        }
      }
      return {
        title: bm.title || '',
        url: bm.url,
        shortcutName: shortcutKey,
        tags: tags
      };
    });

    let exportObj = {
      folderName: folderNode.title || 'Bookmarks',
      exportedAt: new Date().toISOString(),
      bookmarks: exportItems
    };

    let json = JSON.stringify(exportObj, null, 2);
    let blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
    let downloadUrl = URL.createObjectURL(blob);
    let a = document.createElement('a');
    a.href = downloadUrl;
    a.download = 'tab0-' + (folderNode.title || 'bookmarks').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);
    showToast(bookmarks.length + ' bookmark(s) exported!', 'success');
  } catch (err) {
    showToast('Export error: ' + err.message, 'error');
  }
}

// ============================================================
// FOLDER IMPORT (with conflict resolution)
// ============================================================
function importBookmarksToFolder(folderNode) {
  // Create a hidden file input and trigger it
  let fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  fileInput.addEventListener('change', function (event) {
    let file = event.target.files[0];
    if (!file) { document.body.removeChild(fileInput); return; }

    let reader = new FileReader();
    reader.onload = async function (e) {
      document.body.removeChild(fileInput);
      try {
        let data = JSON.parse(e.target.result);
        if (!data.bookmarks || !Array.isArray(data.bookmarks) || data.bookmarks.length === 0) {
          showToast('No bookmarks found in file.', 'error');
          return;
        }

        let incoming = data.bookmarks.filter(b => b.url && isSaveableUrl(b.url));
        if (incoming.length === 0) {
          showToast('No valid bookmarks in file.', 'error');
          return;
        }

        // Check for conflicts: same shortcut name or same URL already in the folder
        let allData = await storageGet(null);
        let allKeys = Object.keys(allData).filter(isShortcutKey);
        let existingBookmarks = (folderNode.children || []).filter(c => c.url);

        let conflicts = [];
        let clean = [];

        incoming.forEach(function (item) {
          let nameConflict = item.shortcutName && allKeys.includes(item.shortcutName);
          let urlConflict = existingBookmarks.some(bm => bm.url === item.url);
          if (nameConflict || urlConflict) {
            conflicts.push({ item: item, nameConflict: nameConflict, urlConflict: urlConflict });
          } else {
            clean.push(item);
          }
        });

        if (conflicts.length === 0) {
          // No conflicts, just import all
          await doFolderImport(clean, [], folderNode, 'replace');
        } else {
          // Show conflict resolution modal
          showConflictModal(conflicts, clean, folderNode, allData, allKeys);
        }
      } catch (err) {
        showToast('Invalid file: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  });

  fileInput.click();
}

function showConflictModal(conflicts, clean, folderNode, allData, allKeys) {
  // Build a display of conflicts
  let conflictHtml = '<div class="conflict-list">';
  conflicts.forEach(function (c) {
    let reasons = [];
    if (c.nameConflict) reasons.push('shortcut "' + escapeHtml(c.item.shortcutName) + '" exists');
    if (c.urlConflict) reasons.push('URL already in folder');
    conflictHtml += '<div class="conflict-item">' +
      '<span class="conflict-item-name">' + escapeHtml(c.item.title || c.item.shortcutName || 'Untitled') + '</span>' +
      '<span class="conflict-item-url">' + reasons.join(', ') + '</span>' +
      '</div>';
  });
  conflictHtml += '</div>';

  showModal({
    title: 'Import Conflicts',
    body: conflicts.length + ' of ' + (conflicts.length + clean.length) + ' bookmark(s) have conflicts:',
    buttons: [
      {
        text: 'Replace', className: 'dm-btn-danger', onClick: async function () {
          await doFolderImport(clean, conflicts, folderNode, 'replace');
        }
      },
      {
        text: 'Keep Both', className: 'dm-btn-save', onClick: async function () {
          await doFolderImport(clean, conflicts, folderNode, 'keep');
        }
      },
      { text: 'Cancel', className: 'dm-btn-cancel' }
    ]
  });

  // Inject the conflict list HTML into the modal body after it renders
  setTimeout(function () {
    let bodyEl = document.getElementById('dashModalBody');
    if (bodyEl) {
      bodyEl.innerHTML = escapeHtml(bodyEl.textContent) + conflictHtml;
    }
  }, 20);
}

async function doFolderImport(cleanItems, conflictItems, folderNode, mode) {
  // mode: 'replace' = overwrite existing shortcuts, 'keep' = rename shortcut with suffix
  try {
    let allData = await storageGet(null);
    let allKeys = Object.keys(allData).filter(isShortcutKey);
    let importCount = 0;

    // Helper: create a Chrome bookmark and 0tab shortcut
    async function importOne(item, shortcutName) {
      // Create Chrome bookmark in the target folder
      let bm = await new Promise((resolve, reject) => {
        chrome.bookmarks.create({
          title: item.title || shortcutName || 'Untitled',
          url: item.url,
          parentId: folderNode.id
        }, function (result) {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(result);
        });
      });

      // Create 0tab shortcut if name provided
      if (shortcutName) {
        let shortcutData = {
          url: item.url,
          count: 0,
          tags: item.tags || generateTagsFromBookmark(item.title || '', item.url),
          bookmarkId: bm.id,
          bookmarkTitle: item.title || shortcutName,
          createdAt: Date.now()
        };
        await storageSet({ [shortcutName]: shortcutData });
      }
      importCount++;
    }

    // Import clean (no-conflict) items
    for (let i = 0; i < cleanItems.length; i++) {
      let item = cleanItems[i];
      await importOne(item, item.shortcutName || '');
    }

    // Import conflict items based on mode
    for (let i = 0; i < conflictItems.length; i++) {
      let c = conflictItems[i];
      let item = c.item;

      if (mode === 'replace') {
        // If URL conflict: remove existing bookmark with same URL in folder, then re-import
        if (c.urlConflict) {
          let existing = (folderNode.children || []).find(bm => bm.url === item.url);
          if (existing) {
            await new Promise((resolve) => {
              chrome.bookmarks.remove(existing.id, function () {
                if (chrome.runtime.lastError) { /* ignore */ }
                resolve();
              });
            });
          }
        }

        // If name conflict: remove existing shortcut data
        if (c.nameConflict && item.shortcutName) {
          await storageRemove(item.shortcutName);
        }

        await importOne(item, item.shortcutName || '');
      } else if (mode === 'keep') {
        // Keep both: add the bookmark (even if URL duplicate in folder)
        // For shortcut name conflict: append a number suffix
        let baseName = item.shortcutName || '';
        let finalName = baseName;
        if (baseName && allKeys.includes(baseName)) {
          let suffix = 1;
          while (allKeys.includes(baseName + suffix) || (await storageGet(baseName + suffix))[baseName + suffix]) {
            suffix++;
          }
          finalName = baseName + suffix;
        }
        await importOne(item, finalName);
        // Track the new key so subsequent conflicts don't collide
        if (finalName) allKeys.push(finalName);
      }
    }

    showToast(importCount + ' bookmark(s) imported!', 'success');
    refreshOpenPanels();
    loadBookmarksView(true);
    loadShortcutsTable();
  } catch (err) {
    showToast('Import error: ' + err.message, 'error');
  }
}

function renderSubfolderCard(sub, container, parentFolderNode, panelIndex) {
  let subCard = document.createElement('div');
  subCard.className = 'bm-detail-subfolder';
  subCard.setAttribute('draggable', 'true');
  subCard.setAttribute('data-folder-drag-id', sub.id);

  subCard.addEventListener('click', function () {
    if (subCard.classList.contains('bm-was-dragging')) {
      subCard.classList.remove('bm-was-dragging');
      return;
    }
    chrome.bookmarks.getSubTree(sub.id, function (results) {
      if (results && results[0]) {
        openFolderDetail(results[0], { asSubfolder: true, parentPanelIndex: panelIndex });
      }
    });
  });

  // Make subfolder draggable
  subCard.addEventListener('dragstart', function (e) {
    e.stopPropagation();
    e.dataTransfer.setData('text/bookmark-id', sub.id);
    e.dataTransfer.setData('text/is-folder', 'true');
    e.dataTransfer.effectAllowed = 'move';
    subCard.classList.add('bm-dragging');
    document.querySelectorAll('.bm-detail-dropzone').forEach(z => z.classList.add('bm-drop-visible'));
    document.querySelectorAll('.bm-gallery-card').forEach(c => c.classList.add('bm-drag-hint'));
  });
  subCard.addEventListener('dragend', function () {
    if (subCard.classList.contains('bm-dragging')) {
      subCard.classList.remove('bm-dragging');
      subCard.classList.add('bm-was-dragging');
      setTimeout(() => subCard.classList.remove('bm-was-dragging'), 100);
    }
    document.querySelectorAll('.bm-detail-dropzone').forEach(z => z.classList.remove('bm-drop-visible'));
    document.querySelectorAll('.bm-drop-target').forEach(z => z.classList.remove('bm-drop-target'));
    document.querySelectorAll('.bm-gallery-card').forEach(c => c.classList.remove('bm-drag-hint'));
    document.querySelectorAll('.bm-drop-above, .bm-drop-below').forEach(z => z.classList.remove('bm-drop-above', 'bm-drop-below'));
  });

  // Accept drops (bookmarks/folders dropped INTO this subfolder)
  subCard.addEventListener('dragover', function (e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    subCard.classList.add('bm-drop-target');
  });
  subCard.addEventListener('dragleave', function () {
    subCard.classList.remove('bm-drop-target');
  });
  subCard.addEventListener('drop', function (e) {
    e.preventDefault();
    e.stopPropagation();
    subCard.classList.remove('bm-drop-target');
    let bmId = e.dataTransfer.getData('text/bookmark-id');
    if (bmId && bmId !== sub.id && !isDescendantOf(sub.id, bmId)) {
      chrome.runtime.sendMessage({ action: 'moveBookmark', id: bmId, parentId: sub.id }, function () {
        refreshOpenPanels();
        loadBookmarksView(true);
      });
    }
  });

  // Drag handle
  let dragHandle = document.createElement('div');
  dragHandle.className = 'bm-drag-handle bm-subfolder-drag-handle';
  dragHandle.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>';
  subCard.appendChild(dragHandle);

  let folderSvg = document.createElement('span');
  folderSvg.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  subCard.appendChild(folderSvg);

  let nameSpan = document.createElement('span');
  nameSpan.className = 'bm-detail-subfolder-name';
  nameSpan.textContent = sub.title;
  subCard.appendChild(nameSpan);

  let countEl = document.createElement('span');
  countEl.className = 'bm-detail-subfolder-count';
  countEl.textContent = countBookmarks(sub);
  subCard.appendChild(countEl);

  let chevron = document.createElement('span');
  chevron.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>';
  subCard.appendChild(chevron);

  container.appendChild(subCard);
}

function buildPanelElement(folderNode, panelIndex) {
  let panel = document.createElement('div');
  panel.className = 'bm-detail-panel';
  panel.setAttribute('data-panel-index', panelIndex);

  // Header
  let header = document.createElement('div');
  header.className = 'bm-detail-panel-header';

  let titleArea = document.createElement('div');
  titleArea.className = 'bm-detail-title-area';
  titleArea.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';

  let h2 = document.createElement('h2');
  h2.textContent = folderNode.title || 'Bookmarks';
  titleArea.appendChild(h2);

  let total = countBookmarks(folderNode);
  let countSpan = document.createElement('span');
  countSpan.className = 'bm-detail-count';
  countSpan.textContent = total + ' bookmark' + (total !== 1 ? 's' : '');
  titleArea.appendChild(countSpan);

  header.appendChild(titleArea);

  // Shortcut badge — populated async, sits next to count
  let shortcutBadge = document.createElement('span');
  shortcutBadge.className = 'bm-detail-shortcut-badge';
  shortcutBadge.id = 'folderShortcutBadge-' + panelIndex;
  titleArea.appendChild(shortcutBadge);

  // Populate shortcut badge async
  populateFolderShortcutBadge(folderNode, panelIndex);

  // Header actions: more menu + close
  let headerActions = document.createElement('div');
  headerActions.className = 'bm-detail-header-actions';

  // More button (3 dots)
  let moreWrapper = document.createElement('div');
  moreWrapper.className = 'bm-more-wrapper';
  let moreBtn = document.createElement('button');
  moreBtn.className = 'bm-detail-action-icon bm-more-btn';
  moreBtn.title = 'More actions';
  moreBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';

  // Dropdown menu
  let dropdown = document.createElement('div');
  dropdown.className = 'bm-more-dropdown';

  let menuItems = [
    { label: 'Edit', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>', action: function () { openFolderEditModal(folderNode, panelIndex); } },
    { label: 'Import', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>', action: function () { importBookmarksToFolder(folderNode); } },
    { label: 'Export', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>', action: function () { exportBookmarksFromFolder(folderNode); } },
    { label: 'Delete', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>', danger: true, action: function () { confirmDeleteFolder(folderNode, panelIndex); } }
  ];

  menuItems.forEach(function (item) {
    let menuItem = document.createElement('button');
    menuItem.className = 'bm-more-item' + (item.danger ? ' bm-more-item-danger' : '');
    menuItem.innerHTML = item.icon + '<span>' + item.label + '</span>';
    menuItem.addEventListener('click', function (e) {
      e.stopPropagation();
      dropdown.classList.remove('visible');
      item.action();
    });
    dropdown.appendChild(menuItem);
  });

  moreBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    // Close any other open dropdowns
    document.querySelectorAll('.bm-more-dropdown.visible').forEach(function (d) {
      if (d !== dropdown) d.classList.remove('visible');
    });
    dropdown.classList.toggle('visible');
  });

  moreWrapper.appendChild(moreBtn);
  moreWrapper.appendChild(dropdown);
  headerActions.appendChild(moreWrapper);

  // Close button
  let closeBtn = document.createElement('button');
  closeBtn.className = 'bm-detail-close';
  closeBtn.title = 'Close';
  closeBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  closeBtn.addEventListener('click', function () {
    closePanelAt(panelIndex);
  });
  headerActions.appendChild(closeBtn);

  header.appendChild(headerActions);
  panel.appendChild(header);

  // Breadcrumb navigation — built synchronously from cached bookmark tree
  let breadcrumb = document.createElement('div');
  breadcrumb.className = 'bm-breadcrumb';

  // Walk the cached bookmark tree to find the path to this folder
  function findPathInTree(tree, targetId) {
    if (!tree) return null;
    if (tree.id === targetId) return [{ id: tree.id, title: tree.title || 'Bookmarks' }];
    if (tree.children) {
      for (let i = 0; i < tree.children.length; i++) {
        let result = findPathInTree(tree.children[i], targetId);
        if (result) {
          result.unshift({ id: tree.id, title: tree.title || 'Bookmarks' });
          return result;
        }
      }
    }
    return null;
  }

  // Use the cached tree from loadBookmarksView if available, otherwise fetch once
  function renderBreadcrumbFromTree(tree) {
    let path = null;
    if (tree && tree.length > 0) {
      // tree[0] is the root node
      path = findPathInTree(tree[0], folderNode.id);
    }
    if (!path || path.length <= 1) {
      // Just show current folder name
      let current = document.createElement('span');
      current.className = 'bm-breadcrumb-item bm-breadcrumb-current';
      current.textContent = folderNode.title || 'Bookmarks';
      breadcrumb.appendChild(current);
      return;
    }
    // Skip the invisible root node (id "0")
    let crumbs = path.filter(c => c.id !== '0');
    crumbs.forEach(function (crumb, idx) {
      if (idx > 0) {
        let sep = document.createElement('span');
        sep.className = 'bm-breadcrumb-sep';
        sep.textContent = '›';
        breadcrumb.appendChild(sep);
      }
      let link = document.createElement('span');
      link.className = 'bm-breadcrumb-item';
      link.textContent = crumb.title || 'Bookmarks';
      if (idx < crumbs.length - 1) {
        link.classList.add('bm-breadcrumb-link');
        link.addEventListener('click', function () {
          chrome.bookmarks.getSubTree(crumb.id, function (results) {
            if (results && results[0]) {
              openPanels[panelIndex] = { id: crumb.id, folderNode: results[0] };
              renderAllPanels();
            }
          });
        });
      } else {
        link.classList.add('bm-breadcrumb-current');
      }
      breadcrumb.appendChild(link);
    });
  }

  // Use cached tree if available, otherwise fetch synchronously-ish before appending
  if (window._tab0CachedTree) {
    renderBreadcrumbFromTree(window._tab0CachedTree);
  } else {
    chrome.bookmarks.getTree(function (tree) {
      window._tab0CachedTree = tree;
      renderBreadcrumbFromTree(tree);
    });
  }

  panel.appendChild(breadcrumb);

  // Content
  let content = document.createElement('div');
  content.className = 'bm-detail-content';

  if (!folderNode.children || folderNode.children.length === 0) {
    content.innerHTML = '<div class="bm-detail-empty">This folder is empty. Drag bookmarks here to add them.</div>';
    panel.appendChild(content);
    return panel;
  }

  // Render children in their original Chrome bookmark order (folders and bookmarks interleaved)
  folderNode.children.forEach(function (child) {
    if (child.url) {
      // It's a bookmark
      let row = renderDetailBookmarkItem(child, folderNode);
      content.appendChild(row);
    } else if (child.children) {
      // It's a subfolder — render inline
      let sub = child;
      renderSubfolderCard(sub, content, folderNode, panelIndex);
    }
  });

  let dropZone = document.createElement('div');
  dropZone.className = 'bm-detail-dropzone';
  dropZone.textContent = 'Drop bookmark here';
  dropZone.addEventListener('dragover', function (e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dropZone.classList.add('bm-drop-active');
  });
  dropZone.addEventListener('dragleave', function () {
    dropZone.classList.remove('bm-drop-active');
  });
  dropZone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropZone.classList.remove('bm-drop-active');
    let bmId = e.dataTransfer.getData('text/bookmark-id');
    if (bmId) {
      chrome.runtime.sendMessage({ action: 'moveBookmark', id: bmId, parentId: folderNode.id }, function () {
        refreshOpenPanels();
        loadBookmarksView(true);
      });
    }
  });
  content.appendChild(dropZone);

  panel.appendChild(content);
  return panel;
}

function renderDetailBookmarkItem(bm, parentFolder) {
  let row = document.createElement('div');
  row.className = 'bm-detail-item';
  row.setAttribute('draggable', 'true');
  row.setAttribute('data-bm-id', bm.id);
  row.setAttribute('data-bm-index', bm.index !== undefined ? bm.index : '');

  row.addEventListener('dragover', function (e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    let rect = row.getBoundingClientRect();
    let midY = rect.top + rect.height / 2;
    row.classList.remove('bm-drop-above', 'bm-drop-below');
    if (e.clientY < midY) row.classList.add('bm-drop-above');
    else row.classList.add('bm-drop-below');
  });
  row.addEventListener('dragleave', function () {
    row.classList.remove('bm-drop-above', 'bm-drop-below');
  });
  row.addEventListener('drop', function (e) {
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove('bm-drop-above', 'bm-drop-below');
    let draggedId = e.dataTransfer.getData('text/bookmark-id');
    if (!draggedId || draggedId === bm.id) return;

    let rect = row.getBoundingClientRect();
    let midY = rect.top + rect.height / 2;
    let targetIndex = bm.index !== undefined ? bm.index : 0;
    if (e.clientY >= midY) targetIndex += 1;
    let targetParentId = parentFolder ? parentFolder.id : bm.parentId;

    chrome.runtime.sendMessage({
      action: 'moveBookmark', id: draggedId, parentId: targetParentId, index: targetIndex
    }, function () {
      if (openPanels.length > 0) {
        refreshOpenPanels();
      }
      loadBookmarksView(true);
    });
  });

  let handle = document.createElement('div');
  handle.className = 'bm-drag-handle';
  handle.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>';
  row.appendChild(handle);

  row.appendChild(createFaviconEl(bm.url, bm.title || bm.url, 'bm-detail-favicon', 18));

  let info = document.createElement('div');
  info.className = 'bm-detail-info';

  let titleRow = document.createElement('div');
  titleRow.style.display = 'flex';
  titleRow.style.alignItems = 'center';
  titleRow.style.gap = '6px';

  let titleLink = document.createElement('a');
  titleLink.className = 'bm-detail-link';
  titleLink.href = bm.url;
  titleLink.target = '_blank';
  titleLink.textContent = bm.title || bm.url;
  titleLink.title = bm.url;
  titleLink.addEventListener('click', function (e) { e.stopPropagation(); });
  titleRow.appendChild(titleLink);

  // Add shortcut tag placeholder - will be filled async
  let shortcutTag = document.createElement('span');
  shortcutTag.className = 'bm-shortcut-tag';
  shortcutTag.style.display = 'none';
  titleRow.appendChild(shortcutTag);

  info.appendChild(titleRow);

  // Tags row placeholder
  let tagsRow = document.createElement('div');
  tagsRow.className = 'bm-detail-tags';
  tagsRow.style.display = 'none';

  // Look up the linked shortcut for this bookmark
  chrome.runtime.sendMessage({ action: 'getShortcutForBookmark', bookmarkId: bm.id }, function (response) {
    if (response && response.key) {
      shortcutTag.textContent = response.key;
      shortcutTag.style.display = 'inline-flex';
    }
    // Show tags
    let tags = (response && response.data && response.data.tags) ? response.data.tags : [];
    if (tags.length > 0) {
      tagsRow.style.display = 'flex';
      tags.forEach(function (tag) {
        let pill = document.createElement('span');
        pill.className = 'tag-pill';
        pill.textContent = tag;
        pill.setAttribute('data-tooltip', tag);
        tagsRow.appendChild(pill);
      });
    }
  });

  let urlText = document.createElement('span');
  urlText.className = 'bm-detail-url';
  urlText.textContent = bm.url.length > 70 ? bm.url.substring(0, 70) + '...' : bm.url;
  info.appendChild(urlText);
  info.appendChild(tagsRow);
  row.appendChild(info);

  let actions = document.createElement('div');
  actions.className = 'bm-detail-actions';

  let editBtn = document.createElement('button');
  editBtn.className = 'bm-detail-action-btn';
  editBtn.title = 'Edit bookmark';
  editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  editBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    editBookmark(bm);
  });
  actions.appendChild(editBtn);

  let deleteBtn = document.createElement('button');
  deleteBtn.className = 'bm-detail-action-btn bm-detail-action-delete';
  deleteBtn.title = 'Delete bookmark';
  deleteBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
  deleteBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    deleteBookmark(bm);
  });
  actions.appendChild(deleteBtn);

  row.appendChild(actions);

  row.addEventListener('dragstart', function (e) {
    e.dataTransfer.setData('text/bookmark-id', bm.id);
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('bm-dragging');
    document.querySelectorAll('.bm-detail-dropzone').forEach(z => z.classList.add('bm-drop-visible'));
    document.querySelectorAll('.bm-gallery-card').forEach(c => c.classList.add('bm-drag-hint'));
  });
  row.addEventListener('dragend', function () {
    row.classList.remove('bm-dragging');
    document.querySelectorAll('.bm-detail-dropzone').forEach(z => z.classList.remove('bm-drop-visible'));
    document.querySelectorAll('.bm-drop-target').forEach(z => z.classList.remove('bm-drop-target'));
    document.querySelectorAll('.bm-gallery-card').forEach(c => c.classList.remove('bm-drag-hint'));
    document.querySelectorAll('.bm-drop-above, .bm-drop-below').forEach(z => z.classList.remove('bm-drop-above', 'bm-drop-below'));
  });

  return row;
}

function editBookmark(bm) {
  // First look up the existing 0tab shortcut for this bookmark
  chrome.runtime.sendMessage({ action: 'getShortcutForBookmark', bookmarkId: bm.id }, function (shortcutResponse) {
    let existingShortcutKey = (shortcutResponse && shortcutResponse.key) ? shortcutResponse.key : '';
    let existingTags = (shortcutResponse && shortcutResponse.data && shortcutResponse.data.tags) ? shortcutResponse.data.tags : generateTagsFromBookmark(bm.title, bm.url);

    chrome.runtime.sendMessage({ action: 'getBookmarkFolders' }, function (folders) {
      folders = folders || [];

      let folderSelectData = folders.map(function (f) {
        let indent = '';
        for (let i = 0; i < f.depth; i++) indent += '\u00A0\u00A0';
        return { value: f.id, label: indent + (f.title || '(Untitled)') };
      });

      let editBmTagsConf = { id: 'tags', tags: existingTags.slice() };
      showModal({
        title: 'Edit Bookmark',
        inputs: [
          { id: 'bmname', label: 'Bookmark Name (updates Chrome bookmark)', value: bm.title || '', placeholder: 'e.g. Book Fusion' },
          { id: 'shortcut', label: '0tab Shortcut (lowercase, no spaces)', value: existingShortcutKey, placeholder: 'e.g. bookfusion or bf' },
          { id: 'url', label: 'URL', value: bm.url || '', placeholder: 'https://example.com' },
          { id: 'folder', label: 'Folder', type: 'select', selectOptions: folderSelectData, value: bm.parentId },
          { id: 'tags', label: 'Tags (up to 5, press Enter to add)', type: 'tags' }
        ],
        _tagsInputs: [editBmTagsConf],
        buttons: [
          { text: 'Cancel', className: 'dm-btn-cancel' },
          {
            text: 'Save', className: 'dm-btn-save', onClick: async function () {
              let newTitle = document.getElementById('dm-input-bmname').value.trim();
              let newUrl = document.getElementById('dm-input-url').value.trim();
              let folderSelect = document.getElementById('dm-input-folder');
              let newParentId = folderSelect.value || null;
              let newShortcutName = document.getElementById('dm-input-shortcut').value.trim().toLowerCase().replace(/\s+/g, '');
              let tags = editBmTagsConf.instance ? editBmTagsConf.instance.getTags() : [];

              if (!newTitle) { showToast('Name required.', 'error'); return; }
              if (!newUrl || !isSaveableUrl(newUrl)) { showToast('Valid URL required.', 'error'); return; }
              if (newShortcutName && newShortcutName.length > 15) { showToast('Shortcut name too long (max 15).', 'error'); return; }

              // 1. Update the Chrome bookmark
              let updateMsg = { action: 'updateBookmark', id: bm.id, title: newTitle, url: newUrl };
              if (newParentId && newParentId !== bm.parentId) {
                updateMsg.parentId = newParentId;
              }

              chrome.runtime.sendMessage(updateMsg, async function () {
                // 2. Handle 0tab shortcut rename/create
                if (newShortcutName) {
                  if (existingShortcutKey && existingShortcutKey !== newShortcutName) {
                    // Rename shortcut key
                    chrome.runtime.sendMessage({
                      action: 'updateShortcutKey',
                      oldKey: existingShortcutKey,
                      newKey: newShortcutName,
                      extraData: { url: newUrl, bookmarkId: bm.id, bookmarkTitle: newTitle, tags: tags }
                    }, function () {
                      showToast('Bookmark & shortcut updated!', 'success');
                    });
                  } else if (!existingShortcutKey) {
                    // Create new shortcut
                    try {
                      let all = await storageGet(null);
                      if (all[newShortcutName] && isShortcutKey(newShortcutName)) {
                        showToast(newShortcutName + ' already exists as a shortcut!', 'error');
                      } else {
                        await storageSet({ [newShortcutName]: { url: newUrl, count: 0, bookmarkId: bm.id, bookmarkTitle: newTitle, tags: tags, createdAt: Date.now() } });
                        showToast('Bookmark updated & shortcut created!', 'success');
                      }
                    } catch (err) {
                      showToast('Error: ' + err.message, 'error');
                    }
                  } else {
                    // Same key, just update data
                    try {
                      let all = await storageGet(null);
                      let existing = all[existingShortcutKey] || {};
                      existing.url = newUrl;
                      existing.bookmarkTitle = newTitle;
                      existing.tags = tags;
                      await storageSet({ [existingShortcutKey]: existing });
                      showToast('Bookmark updated!', 'success');
                    } catch (err) {
                      showToast('Error: ' + err.message, 'error');
                    }
                  }
                } else {
                  showToast('Bookmark updated!', 'success');
                }

                if (openPanels.length > 0) refreshOpenPanels();
                loadBookmarksView(true);
                loadShortcutsTable();
              });
            }
          }
        ]
      });
    });
  });
}

function deleteBookmark(bm) {
  showModal({
    title: 'Delete Bookmark',
    body: 'Permanently delete "' + (bm.title || bm.url) + '"?',
    buttons: [
      { text: 'Cancel', className: 'dm-btn-cancel' },
      {
        text: 'Delete', className: 'dm-btn-danger', onClick: function () {
          chrome.runtime.sendMessage({ action: 'removeBookmark', id: bm.id }, function () {
            showToast('Bookmark deleted.', 'success');
            if (openPanels.length > 0) refreshOpenPanels();
            loadBookmarksView(true);
          });
        }
      }
    ]
  });
}

// Close buttons are now on each panel (dynamic), handled in buildPanelElement

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && openPanels.length > 0) closeFolderDetail();
});

// Bookmark search (works for both subtabs)
document.getElementById('bookmarkSearchInput').addEventListener('keyup', debounce(function () {
  let query = document.getElementById('bookmarkSearchInput').value.toLowerCase().trim();
  let grid = document.getElementById('bmGalleryGrid');
  let emptyEl = document.getElementById('bookmarksEmpty');

  // Also filter shortcuts table
  loadShortcutsTable();

  // Filter bookmark gallery
  closeFolderDetail();

  if (!query) {
    loadBookmarksView();
    return;
  }

  // Score and filter bookmarks: title > url
  let scored = allBookmarkNodes.map(function (bm) {
    let score = 0;
    let lt = (bm.title || '').toLowerCase();
    let lu = (bm.url || '').toLowerCase();
    if (lt === query) score += 400;
    else if (lt.startsWith(query)) score += 300;
    else if (lt.includes(query)) score += 200;
    else { let words = lt.split(/\s+/); if (words.some(w => w.startsWith(query))) score += 150; }
    if (lu.includes(query)) score += 50;
    return { bm: bm, score: score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  let matches = scored.map(s => s.bm);

  grid.innerHTML = '';
  emptyEl.classList.add('hidden');

  if (matches.length === 0) {
    emptyEl.classList.remove('hidden');
    emptyEl.textContent = 'No bookmarks matching "' + query + '"';
    return;
  }

  let resultsCard = document.createElement('div');
  resultsCard.className = 'bm-search-results';
  let resultsHeader = document.createElement('div');
  resultsHeader.className = 'bm-search-header';
  resultsHeader.textContent = matches.length + ' result' + (matches.length !== 1 ? 's' : '');
  resultsCard.appendChild(resultsHeader);

  matches.slice(0, 50).forEach(function (bm) {
    let row = renderDetailBookmarkItem(bm, null);
    row.removeAttribute('draggable');
    row.querySelector('.bm-drag-handle').style.display = 'none';
    resultsCard.appendChild(row);
  });

  if (matches.length > 50) {
    let more = document.createElement('div');
    more.className = 'bm-more';
    more.textContent = '+ ' + (matches.length - 50) + ' more results. Refine your search.';
    resultsCard.appendChild(more);
  }

  grid.appendChild(resultsCard);
}, 300));

// Live sync: listen for bookmark changes from background
chrome.runtime.onMessage.addListener(function (request) {
  if (request.action === 'bookmarkChanged') {
    let bmView = document.getElementById('view-bookmarks');
    if (bmView.classList.contains('active')) {
      loadBookmarksView(true);
      if (openPanels.length > 0) refreshOpenPanels();
    }
    loadShortcutsTable();
  }
});

// ============================================================
// INIT
// ============================================================
function init() {
  loadBookmarksView();
  loadShortcutsTable();
  loadSettingsState();

  let params = new URLSearchParams(window.location.search);

  // If opened from context menu with a URL, switch to bookmarks + shortcuts tab
  if (params.get('newurl')) {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-view="bookmarks"]').classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-bookmarks').classList.add('active');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-subtab="bm-shortcuts"]').classList.add('active');
    document.querySelectorAll('.subtab').forEach(s => s.classList.remove('active'));
    document.getElementById('subtab-bm-shortcuts').classList.add('active');
    loadShortcutsTable();
    setTimeout(() => document.getElementById('addShortcutBtn').click(), 300);
  }

  // If opened because a shortcut was not found in omnibox
  if (params.get('notfound')) {
    let missed = decodeURIComponent(params.get('notfound'));
    // Switch to shortcuts subtab
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-view="bookmarks"]').classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-bookmarks').classList.add('active');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-subtab="bm-shortcuts"]').classList.add('active');
    document.querySelectorAll('.subtab').forEach(s => s.classList.remove('active'));
    document.getElementById('subtab-bm-shortcuts').classList.add('active');
    loadShortcutsTable();
    // Show a modal prompting the user to create the shortcut
    setTimeout(() => {
      showModal({
        title: 'Shortcut not found',
        body: 'No shortcut found for "' + missed + '". Would you like to create it?',
        buttons: [
          { text: 'Cancel', className: 'dm-btn-cancel' },
          {
            text: 'Create Shortcut', className: 'dm-btn-save', onClick: function () {
              // Open the add shortcut modal with the name pre-filled
              window.history.replaceState({}, '', 'manage.html');
              let notFoundTagsConf = { id: 'tags', tags: [] };
              // Load folders for the folder dropdown
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
                showModal({
                  title: 'New Shortcut',
                  inputs: [
                    { id: 'name', label: 'Shortcut name (max 15 chars, no spaces)', value: missed, placeholder: 'e.g. yt' },
                    { id: 'url', label: 'URL', value: '', placeholder: 'https://example.com' },
                    { id: 'tags', label: 'Tags (optional, up to 5, press Enter to add)', type: 'tags' },
                    { id: 'folder', label: 'Folder', type: 'select', selectOptions: folderSelectData, value: '' }
                  ],
                  _tagsInputs: [notFoundTagsConf],
                  buttons: [
                    { text: 'Cancel', className: 'dm-btn-cancel' },
                    {
                      text: 'Save', className: 'dm-btn-save', onClick: async function () {
                        let name = document.getElementById('dm-input-name').value.trim().toLowerCase();
                        let url = document.getElementById('dm-input-url').value.trim();
                        let tags = notFoundTagsConf.instance ? notFoundTagsConf.instance.getTags() : [];
                        let folderSelect = document.getElementById('dm-input-folder');
                        let folderId = folderSelect ? folderSelect.value : '';
                        if (!name) { showToast('Name required.', 'error'); return; }
                        if (name.length > 15) { showToast('Name too long (max 15).', 'error'); return; }
                        if (/\s/.test(name)) { showToast('No spaces in name.', 'error'); return; }
                        if (!url || !isSaveableUrl(url)) { showToast('Valid URL required.', 'error'); return; }
                        try {
                          let all = await storageGet(null);
                          if (all[name] && isShortcutKey(name)) { showToast(name + ' already exists!', 'error'); return; }
                          // Default to 0tab Shortcuts folder if none selected
                          if (!folderId) {
                            try {
                              folderId = await new Promise(resolve => {
                                chrome.runtime.sendMessage({ action: 'getTab0FolderId' }, resolve);
                              });
                            } catch (e) {}
                          }
                          // Create Chrome bookmark
                          let bookmarkId, bookmarkTitle;
                          if (folderId) {
                            try {
                              let bm = await new Promise((resolve, reject) => {
                                chrome.bookmarks.create({ title: name, url: url, parentId: folderId }, (result) => {
                                  if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                                  else resolve(result);
                                });
                              });
                              bookmarkId = bm.id;
                              bookmarkTitle = name;
                            } catch (e) { /* bookmark creation failed, still save shortcut */ }
                          }
                          let shortcutData = { url: url, count: 0, tags: tags, createdAt: Date.now() };
                          if (bookmarkId) { shortcutData.bookmarkId = bookmarkId; shortcutData.bookmarkTitle = bookmarkTitle; }
                          await storageSet({ [name]: shortcutData });
                          showToast('Created ' + name, 'success');
                          loadShortcutsTable();
                        } catch (err) {
                          showToast('Error: ' + err.message, 'error');
                        }
                      }
                    }
                  ]
                });
              });
            }
          }
        ]
      });
    }, 400);
    window.history.replaceState({}, '', 'manage.html');
  }
}

// ============================================================
// FOLDER SHORTCUT BAR & EDIT MODAL
// ============================================================

/**
 * Populates the shortcut bar below a folder panel header.
 * Shows existing folder shortcut or auto-generates one.
 */
async function populateFolderShortcutBar(folderNode, panelIndex) {
  let bar = document.getElementById('folderShortcutBar-' + panelIndex);
  if (!bar) return;
  bar.innerHTML = '';

  try {
    let allData = await storageGet(null);
    let existingKey = null;

    // Find existing folder-type shortcut matching this folder's ID
    for (let key in allData) {
      if (key.startsWith('__')) continue;
      let d = allData[key];
      if (d && typeof d === 'object' && d.type === 'folder' && d.folderId === folderNode.id) {
        existingKey = key;
        break;
      }
    }

    if (existingKey) {
      // Show existing shortcut
      bar.innerHTML =
        '<span class="folder-shortcut-label">Shortcut:</span>' +
        '<span class="folder-shortcut-value">0+[tab] ' + existingKey + '</span>';
    } else {
      let candidate = generateFolderShortcutName(folderNode.title, allData);

      // Collect URLs from this folder via bookmarks API (folderNode may not have children populated)
      let urls = [];
      try {
        let subtree = await new Promise((resolve) => {
          chrome.bookmarks.getSubTree(folderNode.id, (result) => {
            if (chrome.runtime.lastError) { resolve([]); return; }
            resolve(result || []);
          });
        });
        function collectUrls(node) {
          if (node.url) urls.push(node.url);
          if (node.children) node.children.forEach(collectUrls);
        }
        if (subtree[0]) collectUrls(subtree[0]);
      } catch (e) { /* ignore */ }

      if (urls.length > 0) {
        // Auto-save the folder shortcut
        await storageSet({
          [candidate]: {
            type: 'folder',
            urls: urls,
            folderId: folderNode.id,
            folderTitle: folderNode.title || candidate,
            count: 0,
            tags: ['folder'],
            createdAt: Date.now()
          }
        });

        bar.innerHTML =
          '<span class="folder-shortcut-label">Shortcut:</span>' +
          '<span class="folder-shortcut-value">0+[tab] ' + candidate + '</span>' +
          '<span class="folder-shortcut-auto">(auto-created)</span>';
      } else {
        bar.innerHTML = '<span class="folder-shortcut-label folder-shortcut-empty">No bookmarks in folder — shortcut will be created when bookmarks are added.</span>';
      }
    }
  } catch (err) {
    console.error('0tab: populateFolderShortcutBar error:', err);
    bar.innerHTML = '<span class="folder-shortcut-label folder-shortcut-empty">Could not load shortcut info.</span>';
  }
}

// Populate the shortcut badge in the header (compact inline display)
async function populateFolderShortcutBadge(folderNode, panelIndex) {
  let badge = document.getElementById('folderShortcutBadge-' + panelIndex);
  if (!badge) return;
  try {
    let allData = await storageGet(null);
    for (let key in allData) {
      if (key.startsWith('__')) continue;
      let d = allData[key];
      if (d && typeof d === 'object' && d.type === 'folder' && d.folderId === folderNode.id) {
        badge.textContent = key;
        badge.title = 'Shortcut: 0+Tab → ' + key;
        return;
      }
    }
    badge.textContent = '';
  } catch (e) {
    badge.textContent = '';
  }
}

// Confirm and delete a bookmark folder
function confirmDeleteFolder(folderNode, panelIndex) {
  let total = countBookmarks(folderNode);
  let msg = 'Delete folder "' + (folderNode.title || 'Untitled') + '"';
  if (total > 0) msg += ' and its ' + total + ' bookmark' + (total !== 1 ? 's' : '');
  msg += '? This cannot be undone.';

  showModal({
    title: 'Delete Folder',
    body: msg,
    buttons: [
      { text: 'Cancel', className: 'dm-btn-outline' },
      {
        text: 'Delete', className: 'dm-btn-danger', onClick: function () {
          chrome.bookmarks.removeTree(folderNode.id, function () {
            if (chrome.runtime.lastError) {
              showToast('Error: ' + chrome.runtime.lastError.message, 'error');
              return;
            }
            // Remove matching shortcut from storage (and add to trash).
            // Await the remove so the success toast reflects reality.
            (async function () {
              try {
                let allData = await storageGet(null);
                for (let key in allData) {
                  if (key.startsWith('__')) continue;
                  let d = allData[key];
                  if (d && typeof d === 'object' && d.type === 'folder' && d.folderId === folderNode.id) {
                    await addToTrashManage(key, d);
                    await storageRemove(key);
                    break;
                  }
                }
              } catch (e) {
                console.warn('0tab: folder shortcut cleanup failed:', e && e.message);
              }
              openPanels.splice(panelIndex, 1);
              renderAllPanels();
              loadBookmarksView();
              showToast('Folder "' + (folderNode.title || 'Untitled') + '" deleted. Check trash to restore.', 'success');
            })();
          });
        }
      }
    ]
  });
}

// Close more dropdown when clicking outside
document.addEventListener('click', function () {
  document.querySelectorAll('.bm-more-dropdown.visible').forEach(function (d) {
    d.classList.remove('visible');
  });
});

/**
 * Opens a modal to edit the folder name and its associated shortcut.
 */
async function openFolderEditModal(folderNode, panelIndex) {
  let allData = await storageGet(null);
  let existingKey = null;

  // Find existing folder-type shortcut for this folder
  for (let key in allData) {
    if (key.startsWith('__')) continue;
    let d = allData[key];
    if (d && typeof d === 'object') {
      // Match by folderId or by folder name
      if ((d.type === 'folder' && d.folderId === folderNode.id) ||
          (d.folder && d.folder === folderNode.title && !d.url)) {
        existingKey = key;
        break;
      }
    }
  }

  let currentShortcutName = existingKey || generateFolderShortcutName(folderNode.title, allData);

  // Build parent folder select options
  let bmTree = await new Promise(function (resolve) {
    chrome.bookmarks.getTree(function (tree) { resolve(tree || []); });
  });
  let parentFolders = [];
  function walkParents(node, depth) {
    if (!node.url && node.children && node.title) {
      // Don't include the current folder itself as a parent option
      if (node.id !== folderNode.id) {
        let indent = '';
        for (let i = 0; i < depth; i++) indent += '\u00A0\u00A0';
        parentFolders.push({ value: node.id, label: indent + node.title });
      }
    }
    if (node.children) node.children.forEach(function (c) { walkParents(c, depth + 1); });
  }
  bmTree.forEach(function (n) { walkParents(n, 0); });
  let currentParentId = folderNode.parentId || '1';

  showModal({
    title: 'Edit Folder',
    body: '',
    inputs: [
      { id: 'folderName', label: 'FOLDER NAME', type: 'text', value: folderNode.title || '', placeholder: 'Folder name' },
      { id: 'folderShortcut', label: 'FOLDER 0TAB SHORTCUT', type: 'text', value: currentShortcutName, placeholder: 'e.g. work' },
      { id: 'folderParent', label: 'PARENT FOLDER', type: 'select', selectOptions: parentFolders, value: currentParentId }
    ],
    buttons: [
      { text: 'Cancel', className: 'dm-btn-secondary' },
      {
        text: 'Save',
        className: 'dm-btn-primary',
        onClick: async function () {
          let newName = (document.getElementById('dm-input-folderName').value || '').trim();
          let newShortcut = (document.getElementById('dm-input-folderShortcut').value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
          let newParentId = (document.getElementById('dm-input-folderParent').value || '').trim();

          if (!newName) {
            showToast('Folder name cannot be empty.', 'error');
            return;
          }

          try {
            // 1. Rename folder in Chrome bookmarks if name changed
            if (newName !== folderNode.title) {
              await new Promise((resolve, reject) => {
                chrome.bookmarks.update(folderNode.id, { title: newName }, (result) => {
                  if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                  else resolve(result);
                });
              });
              folderNode.title = newName;
            }

            // 1b. Move folder to new parent if changed
            if (newParentId && newParentId !== currentParentId) {
              await new Promise((resolve, reject) => {
                chrome.bookmarks.move(folderNode.id, { parentId: newParentId }, (result) => {
                  if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                  else resolve(result);
                });
              });
              folderNode.parentId = newParentId;
            }

            // 2. Update folder shortcut in storage
            // Collect current URLs from folder
            let children = await new Promise((resolve) => {
              chrome.bookmarks.getSubTree(folderNode.id, (result) => {
                if (chrome.runtime.lastError) { resolve([]); return; }
                resolve(result || []);
              });
            });
            let urls = [];
            function collectUrls(node) {
              if (node.url) urls.push(node.url);
              if (node.children) node.children.forEach(collectUrls);
            }
            if (children[0]) collectUrls(children[0]);

            // Remove old shortcut key if it changed
            if (existingKey && newShortcut && existingKey !== newShortcut) {
              await storageRemove(existingKey);
            }
            // Remove old shortcut if user cleared the shortcut field
            if (existingKey && !newShortcut) {
              await storageRemove(existingKey);
            }

            // Save new/updated shortcut if name provided and folder has URLs
            if (newShortcut && urls.length > 0) {
              // Check for name conflict (not with itself)
              let conflictData = allData[newShortcut];
              if (conflictData && newShortcut !== existingKey) {
                showToast('Shortcut "' + newShortcut + '" already exists.', 'error');
                return;
              }

              await storageSet({
                [newShortcut]: {
                  type: 'folder',
                  urls: urls,
                  folderId: folderNode.id,
                  folderTitle: newName,
                  count: (existingKey && allData[existingKey]) ? (allData[existingKey].count || 0) : 0,
                  tags: ['folder'],
                  createdAt: (existingKey && allData[existingKey]) ? (allData[existingKey].createdAt || Date.now()) : Date.now()
                }
              });
            }

            showToast('Folder updated!', 'success');

            // Refresh UI
            refreshOpenPanels();
            loadBookmarksView(true);
            loadShortcutsTable();

            // Re-populate shortcut bar
            populateFolderShortcutBar(folderNode, panelIndex);

          } catch (err) {
            showToast('Error: ' + err.message, 'error');
          }
        }
      }
    ]
  });
}

init();

// Kick off first-run history-import nudge after the dashboard settles
setTimeout(maybeTriggerHistoryImport, 400);

// Reconcile bookmarks ↔ shortcuts once per dashboard load. This guarantees
// every bookmark has a shortcut and every shortcut has a bookmark inside
// the 0tab AI folder. Idempotent; the background locks any cascade.
setTimeout(function () {
  chrome.runtime.sendMessage({ action: 'reconcileBookmarksShortcuts' }, function (res) {
    if (chrome.runtime.lastError) return;
    if (!res) return;
    let created = (res.shortcutsCreated || 0) + (res.bookmarksCreated || 0);
    if (created > 0) {
      // Refresh views so new rows appear
      if (typeof refreshTopUtilityStats === 'function') refreshTopUtilityStats();
      if (typeof renderHomeView === 'function') renderHomeView();
      if (typeof loadShortcutsTable === 'function') loadShortcutsTable();
      if (typeof loadBookmarksView === 'function') loadBookmarksView(true);
      showToast('Synced: ' + res.shortcutsCreated + ' new shortcut' + (res.shortcutsCreated === 1 ? '' : 's') +
                ', ' + res.bookmarksCreated + ' new bookmark' + (res.bookmarksCreated === 1 ? '' : 's') + ' in 0tab AI', 'success');
    }
  });
}, 900);

// ============================================================
// HOME (Command Center) — default landing view
// ============================================================
function homeGreetingText() {
  let h = new Date().getHours();
  if (h < 5)  return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 22) return 'Good evening';
  return 'Good night';
}

async function homeFetchUserName() {
  try {
    if (chrome.identity && chrome.identity.getProfileUserInfo) {
      let info = await new Promise(function (r) { chrome.identity.getProfileUserInfo(function (i) { r(i || {}); }); });
      if (info && info.email) {
        return info.email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
      }
    }
  } catch (e) {}
  return '';
}

function homeFaviconUrl(url, size) {
  try { return 'https://www.google.com/s2/favicons?domain=' + new URL(url).hostname + '&sz=' + (size || 32); }
  catch (e) { return ''; }
}

async function homeRenderGreeting() {
  let main = document.getElementById('homeGreetingMain');
  let sub = document.getElementById('homeGreetingSub');
  if (!main || !sub) return;
  let name = await homeFetchUserName();
  main.textContent = homeGreetingText() + (name ? ', ' + name.split(' ')[0] : '') + '.';
  let items = await storageGet(null);
  let shortcuts = Object.keys(items).filter(isShortcutKey);
  let totalOpens = 0;
  let openedToday = 0;
  let todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  shortcuts.forEach(function (k) {
    let d = items[k];
    if (d && typeof d === 'object') {
      totalOpens += (d.count || 0);
      if (d.lastAccessed && d.lastAccessed >= todayStart.getTime()) openedToday++;
    }
  });
  if (openedToday > 0) {
    sub.textContent = openedToday + ' shortcut' + (openedToday !== 1 ? 's' : '') + ' opened today · ' + shortcuts.length + ' total in your dock.';
  } else if (shortcuts.length > 0) {
    sub.textContent = shortcuts.length + ' shortcut' + (shortcuts.length !== 1 ? 's' : '') + ' ready to go. Nothing opened yet today.';
  } else {
    sub.textContent = 'Your bookmarks, one keystroke away. Start by saving something you visit often.';
  }
}

// (Removed: homeRenderCurrentPage — the "Save this page" card depended on
// the active tab not being the dashboard, which is never true when the
// user is looking at the dashboard. See Settings → Save current page from
// the popup instead.)

async function homeRenderDock() {
  let grid = document.getElementById('homeDockGrid');
  let sub = document.getElementById('homeDockSub');
  if (!grid) return;
  let items = await storageGet(null);
  let rows = Object.keys(items).filter(isShortcutKey).map(function (k) {
    let d = items[k]; if (typeof d === 'string') d = { url: d, count: 0 };
    return { key: k, data: d || {} };
  }).filter(function (x) { return x.data && (x.data.url || (x.data.type === 'folder')); });

  if (rows.length === 0) {
    grid.innerHTML = '<div class="home-dock-empty">No shortcuts yet. Click the 0tab AI icon in your toolbar while on a page you want to save.</div>';
    if (sub) sub.textContent = '';
    return;
  }

  rows.sort(function (a, b) {
    let ap = a.data.pinned === true, bp = b.data.pinned === true;
    if (ap !== bp) return ap ? -1 : 1;
    if (ap && bp) return (a.data.pinOrder || 0) - (b.data.pinOrder || 0);
    return (b.data.count || 0) - (a.data.count || 0);
  });

  let pinnedCount = rows.filter(function (x) { return x.data.pinned === true; }).length;
  if (sub) sub.textContent = pinnedCount > 0
    ? pinnedCount + ' pinned · top ' + Math.min(rows.length, 12) + ' by usage'
    : 'Top ' + Math.min(rows.length, 12) + ' by usage';

  let visible = rows.slice(0, 12);
  grid.innerHTML = '';
  visible.forEach(function (r) {
    let tile = document.createElement('div');
    tile.className = 'home-dock-tile';
    tile.title = r.data.aiDescription || r.data.url || r.key;
    let isFolder = r.data.type === 'folder';
    let fav = '';
    if (isFolder) {
      fav = '<span class="home-dock-tile-fav" style="display:flex;align-items:center;justify-content:center;color:var(--accent);"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span>';
    } else {
      let src = homeFaviconUrl(r.data.url, 64);
      fav = '<img class="home-dock-tile-fav" src="' + src + '" data-hide-on-error="visibility">';
    }
    let meta = isFolder
      ? ((r.data.urls ? r.data.urls.length : 0) + ' tabs')
      : ((r.data.count || 0) + ' open' + ((r.data.count || 0) === 1 ? '' : 's'));
    let pinnedBadge = r.data.pinned === true
      ? '<span class="home-dock-tile-pin" title="Pinned"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M14 4l6 6-3 3-2-2-3 3v6l-2 2v-7l-5-5 2-2 3-3-2-2 6-2z"/></svg></span>'
      : '';
    tile.innerHTML = pinnedBadge + fav +
      '<div class="home-dock-tile-name">' + tab0EscapeHtml(r.key) + '</div>' +
      '<div class="home-dock-tile-meta">' + meta + '</div>';
    tile.addEventListener('click', function (ev) {
      if (isFolder) {
        // Open all URLs in the underlying folder
        if (r.data.folderId) {
          chrome.runtime.sendMessage({
            action: 'openFolderInTabGroup',
            urls: Array.isArray(r.data.urls) ? r.data.urls : [],
            groupName: r.data.folderTitle || r.key,
            useTabGroup: true
          });
        }
        return;
      }
      if (r.data.url) {
        // Default: open in a new tab so the dashboard stays open.
        // Cmd/Ctrl+click replaces the current tab.
        if (ev.metaKey || ev.ctrlKey) chrome.tabs.update({ url: r.data.url });
        else chrome.tabs.create({ url: r.data.url });
      }
    });
    grid.appendChild(tile);
  });
}

async function homeRenderSuggestions() {
  let host = document.getElementById('homeSuggestionCards');
  if (!host) return;
  let items = await storageGet(null);
  let shortcuts = Object.keys(items).filter(isShortcutKey).map(function (k) {
    let d = items[k]; if (typeof d === 'string') d = { url: d, count: 0 };
    return Object.assign({ name: k }, d || {});
  });
  let suggestions = [];

  // Dead shortcuts (no opens, older than a week)
  let weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let dead = shortcuts.filter(function (s) { return (s.count || 0) === 0 && s.type !== 'folder' && s.createdAt && s.createdAt < weekAgo; });
  if (dead.length >= 3) {
    suggestions.push({
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
      title: dead.length + ' shortcuts never opened',
      desc: 'Started ignoring these for a week — probably safe to clean up.',
      action: { label: 'Start cleanup', run: function () { openAskChatWith('Clean up unused bookmarks'); } }
    });
  }

  // Duplicates
  let urlMap = {};
  shortcuts.forEach(function (s) { if (s.url) { let n = tab0NormalizeUrl(s.url); if (n) urlMap[n] = (urlMap[n] || 0) + 1; } });
  let dupeCount = Object.keys(urlMap).filter(function (k) { return urlMap[k] > 1; }).length;
  if (dupeCount >= 2) {
    suggestions.push({
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
      title: dupeCount + ' duplicate URLs',
      desc: 'Same link saved under different shortcut names — consolidate them.',
      action: { label: 'Review duplicates', run: function () { openAskChatWith('Find duplicates'); } }
    });
  }

  // Untagged shortcuts
  let untagged = shortcuts.filter(function (s) { return (!s.tags || s.tags.length === 0) && s.type !== 'folder'; });
  if (untagged.length >= 5) {
    suggestions.push({
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
      title: untagged.length + ' shortcuts without tags',
      desc: 'Tagged shortcuts are easier to find. Want help tagging in bulk?',
      action: { label: 'Bulk tag', run: function () { openAskChatWith('Bulk tag my shortcuts'); } }
    });
  }

  // History import available
  try {
    let flag = await storageGet([HISTORY_IMPORT_FLAG, HISTORY_IMPORT_DISMISSED_FLAG]);
    if (!flag[HISTORY_IMPORT_FLAG] && !flag[HISTORY_IMPORT_DISMISSED_FLAG]) {
      suggestions.push({
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
        title: 'Import from your browsing history',
        desc: 'Chrome remembers the sites you visit most. Turn them into shortcuts in one click.',
        action: { label: 'Find frequent sites', run: function () { if (typeof openHistoryImportModal === 'function') openHistoryImportModal(); } }
      });
    }
  } catch (e) {}

  // Onboarding / empty state
  if (shortcuts.length === 0) {
    suggestions.unshift({
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
      title: 'Save your first shortcut',
      desc: 'Open a site you visit daily, click the 0tab AI icon in your toolbar, and save it from the popup.',
      action: { label: 'Open chat for help', run: function () { let b = document.getElementById('chatToggleBtn'); if (b) b.click(); } }
    });
  }

  // Default / evergreen card
  if (suggestions.length === 0) {
    suggestions.push({
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
      title: 'Ask 0tab AI anything',
      desc: 'Find, open, organize, or clean up your bookmarks by just typing in the chat.',
      action: { label: 'Open chat', run: function () { let b = document.getElementById('chatToggleBtn'); if (b) b.click(); } }
    });
  }

  host.innerHTML = '';
  suggestions.slice(0, 3).forEach(function (s) {
    let card = document.createElement('div');
    card.className = 'home-suggestion-card';
    card.innerHTML =
      '<div class="home-suggestion-card-icon">' + s.icon + '</div>' +
      '<h4 class="home-suggestion-card-title">' + tab0EscapeHtml(s.title) + '</h4>' +
      '<p class="home-suggestion-card-desc">' + tab0EscapeHtml(s.desc) + '</p>' +
      '<div class="home-suggestion-card-actions"></div>';
    let actions = card.querySelector('.home-suggestion-card-actions');
    let btn = document.createElement('button');
    btn.className = 'home-suggestion-btn';
    btn.textContent = s.action.label;
    btn.addEventListener('click', function () { s.action.run(); });
    actions.appendChild(btn);
    host.appendChild(card);
  });
}

function openAskChatWith(query) {
  let b = document.getElementById('chatToggleBtn');
  if (b) b.click();
  setTimeout(function () {
    let i = document.getElementById('chatInput');
    let s = document.getElementById('chatSendBtn');
    if (i && s) { i.value = query; s.click(); }
  }, 220);
}

async function homeRenderRecent() {
  let host = document.getElementById('homeRecentList');
  if (!host) return;
  let items = await storageGet(null);
  let rows = Object.keys(items).filter(isShortcutKey).map(function (k) {
    let d = items[k]; if (typeof d === 'string') d = { url: d, count: 0 };
    return Object.assign({ name: k }, d || {});
  }).filter(function (s) { return s.lastAccessed && s.url; })
    .sort(function (a, b) { return (b.lastAccessed || 0) - (a.lastAccessed || 0); })
    .slice(0, 6);
  if (rows.length === 0) {
    host.innerHTML = '<div class="home-recent-empty">Nothing opened yet today.</div>';
    return;
  }
  host.innerHTML = '';
  rows.forEach(function (r) {
    let el = document.createElement('div');
    el.className = 'home-recent-row';
    let ago = tab0TimeAgo(r.lastAccessed);
    let fav = homeFaviconUrl(r.url, 32);
    el.innerHTML =
      '<img class="home-recent-row-fav" src="' + fav + '" data-hide-on-error="visibility">' +
      '<div class="home-recent-row-main">' +
        '<div class="home-recent-row-name">' + tab0EscapeHtml(r.name) + '</div>' +
        '<div class="home-recent-row-meta">' + ago + ' · ' + (r.count || 0) + ' opens</div>' +
      '</div>';
    el.addEventListener('click', function (ev) {
      // Default: new tab. Cmd/Ctrl+click replaces the current tab.
      if (ev.metaKey || ev.ctrlKey) chrome.tabs.update({ url: r.url });
      else chrome.tabs.create({ url: r.url });
    });
    host.appendChild(el);
  });
}

function tab0TimeAgo(ts) {
  if (!ts) return '';
  let diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  let min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + 'm ago';
  let h = Math.floor(min / 60);
  if (h < 24) return h + 'h ago';
  let d = Math.floor(h / 24);
  if (d < 7) return d + 'd ago';
  return Math.floor(d / 7) + 'w ago';
}

async function homeRenderFolders() {
  let host = document.getElementById('homeFolderList');
  if (!host) return;
  let tree = await new Promise(function (r) { chrome.bookmarks.getTree(function (t) { r(t || []); }); });
  let folders = [];
  function walk(node, parentTitle) {
    if (!node) return;
    if (!node.url && node.title && node.id !== '0') {
      let childBms = (node.children || []).filter(function (c) { return c.url; }).length;
      if (childBms > 0 || (node.children || []).filter(function (c) { return !c.url; }).length > 0) {
        folders.push({ id: node.id, title: node.title, count: childBms });
      }
    }
    if (node.children) node.children.forEach(function (c) { walk(c, node.title); });
  }
  if (tree[0]) (tree[0].children || []).forEach(function (n) { walk(n, ''); });
  folders.sort(function (a, b) { return b.count - a.count; });
  folders = folders.slice(0, 6);
  if (folders.length === 0) {
    host.innerHTML = '<div class="home-recent-empty">No folders yet.</div>';
    return;
  }
  host.innerHTML = '';
  folders.forEach(function (f) {
    let el = document.createElement('div');
    el.className = 'home-folder-row';
    el.innerHTML =
      '<span class="home-folder-row-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span>' +
      '<div class="home-folder-row-main">' +
        '<div class="home-folder-row-name">' + tab0EscapeHtml(f.title) + '</div>' +
        '<div class="home-folder-row-meta">' + f.count + ' bookmark' + (f.count !== 1 ? 's' : '') + '</div>' +
      '</div>';
    el.addEventListener('click', function () {
      // Switch to Library view and open that folder panel
      let libBtn = document.querySelector('[data-view="bookmarks"]');
      if (libBtn) libBtn.click();
      setTimeout(function () {
        chrome.bookmarks.getSubTree(f.id, function (results) {
          if (results && results[0] && typeof openFolderDetail === 'function') openFolderDetail(results[0]);
        });
      }, 120);
    });
    host.appendChild(el);
  });
}

async function renderHomeView() {
  try {
    await Promise.all([
      homeRenderGreeting(),
      homeRenderDock(),
      homeRenderSuggestions(),
      homeRenderRecent(),
      homeRenderFolders()
    ]);
  } catch (e) { /* silent */ }
}

(function wireHomeView() {
  let askBtn = document.getElementById('homeAskAiBtn');
  if (askBtn) askBtn.addEventListener('click', function () {
    let b = document.getElementById('chatToggleBtn'); if (b) b.click();
  });
  let jumpBtn = document.getElementById('homeQuickJumpBtn');
  if (jumpBtn) jumpBtn.addEventListener('click', function () {
    if (typeof window.openSpotlight === 'function') window.openSpotlight();
  });

  // Render now (in case Home is the active view) and on any nav switch to Home
  renderHomeView();
  document.querySelectorAll('[data-view="home"]').forEach(function (btn) {
    btn.addEventListener('click', function () { setTimeout(renderHomeView, 50); });
  });

  // Refresh dock/recent/suggestions when storage changes (debounced)
  let homeRefreshTimer = null;
  function debouncedHomeRefresh() {
    if (homeRefreshTimer) clearTimeout(homeRefreshTimer);
    homeRefreshTimer = setTimeout(renderHomeView, 500);
  }
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local') debouncedHomeRefresh();
  });
  if (chrome.bookmarks && chrome.bookmarks.onCreated) {
    chrome.bookmarks.onCreated.addListener(debouncedHomeRefresh);
    chrome.bookmarks.onRemoved.addListener(debouncedHomeRefresh);
    chrome.bookmarks.onChanged.addListener(debouncedHomeRefresh);
  }
})();

// Settings → re-open the history import modal on demand
let _dashHistoryImportBtn = document.getElementById('dashHistoryImportBtn');
if (_dashHistoryImportBtn) {
  _dashHistoryImportBtn.addEventListener('click', function () {
    if (typeof openHistoryImportModal === 'function') openHistoryImportModal();
  });
}

// Settings → manual "Sync now" — full two-way reconcile
let _dashReconcileBtn = document.getElementById('dashReconcileBtn');
if (_dashReconcileBtn) {
  _dashReconcileBtn.addEventListener('click', function () {
    let resultEl = document.getElementById('dashReconcileResult');
    _dashReconcileBtn.disabled = true;
    let prevText = _dashReconcileBtn.textContent;
    _dashReconcileBtn.textContent = 'Syncing…';
    chrome.runtime.sendMessage({ action: 'reconcileBookmarksShortcuts' }, function (res) {
      _dashReconcileBtn.disabled = false;
      _dashReconcileBtn.textContent = prevText;
      if (chrome.runtime.lastError || !res) {
        if (resultEl) {
          resultEl.classList.remove('hidden');
          resultEl.textContent = 'Sync failed. Try again in a moment.';
        }
        return;
      }
      let sc = res.shortcutsCreated || 0;
      let bm = res.bookmarksCreated || 0;
      let msg = sc === 0 && bm === 0
        ? 'Everything is already in sync.'
        : 'Created ' + sc + ' shortcut' + (sc === 1 ? '' : 's') + ' and ' + bm + ' bookmark' + (bm === 1 ? '' : 's') + '.';
      if (resultEl) {
        resultEl.classList.remove('hidden');
        resultEl.textContent = msg;
      }
      if (typeof refreshTopUtilityStats === 'function') refreshTopUtilityStats();
      if (typeof renderHomeView === 'function') renderHomeView();
      if (typeof loadShortcutsTable === 'function') loadShortcutsTable();
      if (typeof loadBookmarksView === 'function') loadBookmarksView(true);
    });
  });
}

// ============================================================
// HISTORY-IMPORT — one-shot onboarding accelerator
// Scans browser history for frequently-visited URLs the user hasn't
// saved yet, and lets them turn the top N into shortcuts in one click.
// Shown on first run; dismissable; re-openable from Settings.
// ============================================================
const HISTORY_IMPORT_FLAG = '__0tab_history_imported_v1';
const HISTORY_IMPORT_DISMISSED_FLAG = '__0tab_history_dismissed_v1';

// Normalize URL for dedup (strip hash, query, trailing slash, 'www.')
function tab0NormalizeUrl(u) {
  if (!u || typeof u !== 'string') return '';
  try {
    let url = new URL(u);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    let host = url.hostname.replace(/^www\./, '');
    let path = url.pathname.replace(/\/+$/, '') || '/';
    return (host + path).toLowerCase();
  } catch (e) { return ''; }
}

// Generate a short shortcut name from the URL/title (no collisions with `taken`)
function tab0SuggestShortcutName(title, url, taken) {
  let tokens = [];
  try {
    let host = new URL(url).hostname.replace(/^www\./, '');
    let domain = host.split('.')[0];
    tokens.push(domain);
  } catch (e) {}
  if (title) {
    let clean = title.toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').trim();
    clean.split(/\s+/).forEach(function (w) { if (w && w.length >= 2) tokens.push(w); });
  }
  // Try, in order: first token (3 chars), first token (first 4), init of first two tokens
  let candidates = [];
  if (tokens[0]) {
    candidates.push(tokens[0].slice(0, 3));
    candidates.push(tokens[0].slice(0, 4));
    candidates.push(tokens[0].slice(0, 5));
  }
  if (tokens[0] && tokens[1]) {
    candidates.push((tokens[0][0] + tokens[1].slice(0, 2)));
    candidates.push((tokens[0].slice(0, 2) + tokens[1][0]));
  }
  if (tokens[0]) candidates.push(tokens[0].slice(0, 2));
  // Clean + unique + collision-avoid
  let seen = {};
  for (let c of candidates) {
    c = (c || '').replace(/[^a-z0-9]/g, '');
    if (!c || c.length < 2 || c.length > 15) continue;
    if (seen[c]) continue;
    seen[c] = 1;
    if (!taken[c]) { taken[c] = 1; return c; }
  }
  // Numeric suffix fallback
  let base = candidates.find(function (c) { return c && c.length >= 2; }) || 'bm';
  base = base.replace(/[^a-z0-9]/g, '').slice(0, 3) || 'bm';
  for (let i = 2; i < 99; i++) {
    let try_ = base + i;
    if (!taken[try_]) { taken[try_] = 1; return try_; }
  }
  return base + Date.now().toString(36).slice(-3);
}

async function tab0GatherHistoryCandidates(maxResults) {
  // Ask Chrome for visits in the last 90 days
  if (!chrome.history || !chrome.history.search) return [];
  let items = await storageGet(null);
  let takenKeys = {};
  let savedUrls = {};
  Object.keys(items).filter(isShortcutKey).forEach(function (k) {
    takenKeys[k] = 1;
    let d = items[k];
    let u = typeof d === 'object' ? (d.url || '') : (typeof d === 'string' ? d : '');
    let n = tab0NormalizeUrl(u);
    if (n) savedUrls[n] = 1;
  });
  // Also skip anything already in Chrome bookmarks
  try {
    let tree = await new Promise(function (r) { chrome.bookmarks.getTree(function (t) { r(t || []); }); });
    function walk(node) {
      if (!node) return;
      if (node.url) { let n = tab0NormalizeUrl(node.url); if (n) savedUrls[n] = 1; }
      if (node.children) node.children.forEach(walk);
    }
    if (tree[0]) (tree[0].children || []).forEach(walk);
  } catch (e) {}

  let startTime = Date.now() - 90 * 24 * 60 * 60 * 1000;
  let historyItems = await new Promise(function (resolve) {
    try {
      chrome.history.search({ text: '', startTime: startTime, maxResults: 5000 }, function (results) {
        if (chrome.runtime.lastError) { resolve([]); return; }
        resolve(results || []);
      });
    } catch (e) { resolve([]); }
  });

  // Group by normalized URL, pick highest visitCount per group, skip saved + trivial
  let groups = {};
  historyItems.forEach(function (h) {
    let norm = tab0NormalizeUrl(h.url);
    if (!norm) return;
    if (savedUrls[norm]) return;
    // Skip search engine pages, newtab, local, etc.
    if (/^(www\.)?(google|bing|duckduckgo|yahoo|baidu|yandex)\.[a-z.]+\/(search|imgres|images)/i.test(norm)) return;
    if (/^localhost/i.test(norm)) return;
    let existing = groups[norm];
    if (!existing || (h.visitCount || 0) > (existing.visitCount || 0)) {
      groups[norm] = {
        url: h.url,
        normalized: norm,
        title: h.title || '',
        visitCount: h.visitCount || 0,
        lastVisit: h.lastVisitTime || 0
      };
    }
  });
  let candidates = Object.values(groups);
  // Require a minimum usage signal to count as "frequently visited"
  candidates = candidates.filter(function (c) { return c.visitCount >= 3; });
  // Sort by visit count, then recency
  candidates.sort(function (a, b) {
    if (b.visitCount !== a.visitCount) return b.visitCount - a.visitCount;
    return (b.lastVisit || 0) - (a.lastVisit || 0);
  });
  candidates = candidates.slice(0, maxResults || 20);
  // Assign suggested shortcut names + title fallback
  candidates.forEach(function (c) {
    if (!c.title) {
      try { c.title = new URL(c.url).hostname.replace(/^www\./, ''); } catch (e) { c.title = c.url; }
    }
    c.suggestedName = tab0SuggestShortcutName(c.title, c.url, takenKeys);
  });
  return candidates;
}

function tab0EscapeHtml(s) {
  return (s || '').replace(/[<>&"']/g, function (c) {
    return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

async function openHistoryImportModal(options) {
  options = options || {};
  let overlay = document.getElementById('historyImportOverlay');
  let listEl = document.getElementById('historyImportList');
  let subtitle = document.getElementById('historyImportSubtitle');
  let countEl = document.getElementById('historyImportCount');
  let confirmBtn = document.getElementById('historyImportConfirm');
  let skipBtn = document.getElementById('historyImportSkip');
  let closeBtn = document.getElementById('historyImportClose');
  let selectAllBtn = document.getElementById('historyImportSelectAll');
  let selectNoneBtn = document.getElementById('historyImportSelectNone');
  let dontShowCheckbox = document.getElementById('historyImportDontShow');
  if (!overlay) return;

  overlay.classList.remove('hidden');
  listEl.innerHTML = '<div class="history-import-empty">Reading your recent history…</div>';
  subtitle.textContent = 'Finding sites you visit often…';
  if (countEl) countEl.textContent = '';

  // Wire up dismiss controls FIRST so they work even if candidate gathering
  // returns empty or throws (otherwise the early-return path below leaves
  // the user with a modal whose Skip/Close/backdrop are dead).
  function close() {
    overlay.classList.add('hidden');
  }
  if (closeBtn) closeBtn.onclick = close;
  if (skipBtn) skipBtn.onclick = async function () {
    if (dontShowCheckbox && dontShowCheckbox.checked) {
      try { await storageSet({ [HISTORY_IMPORT_FLAG]: true, [HISTORY_IMPORT_DISMISSED_FLAG]: true }); } catch (e) {}
    }
    close();
  };
  overlay.onclick = function (e) {
    if (e.target === overlay) close();
  };

  let candidates;
  try {
    candidates = await tab0GatherHistoryCandidates(20);
  } catch (e) {
    candidates = [];
  }

  if (!candidates || candidates.length === 0) {
    subtitle.textContent = 'Nothing new to import right now.';
    listEl.innerHTML = '<div class="history-import-empty">Looks like your frequent sites are already saved — nice!</div>';
    if (confirmBtn) confirmBtn.disabled = true;
    return;
  }

  subtitle.innerHTML = 'We found <strong>' + candidates.length + '</strong> site' + (candidates.length !== 1 ? 's' : '') + ' you visit often that aren\'t saved yet. Uncheck any you don\'t want.';

  // Render rows
  listEl.innerHTML = '';
  candidates.forEach(function (c, idx) {
    let row = document.createElement('label');
    row.className = 'history-import-row';
    row.setAttribute('data-idx', String(idx));
    let fav = '';
    try { fav = 'https://www.google.com/s2/favicons?domain=' + new URL(c.url).hostname + '&sz=32'; } catch (e) {}
    row.innerHTML =
      '<input type="checkbox" checked>' +
      (fav ? '<img class="history-import-row-fav" src="' + fav + '" data-hide-on-error="visibility">' : '<span class="history-import-row-fav"></span>') +
      '<div class="history-import-row-main">' +
        '<span class="history-import-row-title">' + tab0EscapeHtml(c.title) + '</span>' +
        '<span class="history-import-row-url">' + tab0EscapeHtml(c.url) + '</span>' +
      '</div>' +
      '<input type="text" class="history-import-row-name" maxlength="15" value="' + tab0EscapeHtml(c.suggestedName) + '" spellcheck="false" title="0tab shortcut name (editable)">' +
      '<span class="history-import-row-count">' + c.visitCount + '×</span>';
    listEl.appendChild(row);

    // Prevent label-click from toggling when user is editing the name
    let nameInput = row.querySelector('.history-import-row-name');
    nameInput.addEventListener('click', function (e) { e.stopPropagation(); });
    nameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') e.preventDefault(); });
  });

  function updateCount() {
    let checked = listEl.querySelectorAll('input[type="checkbox"]:checked').length;
    countEl.textContent = checked + ' selected';
  }
  listEl.addEventListener('change', updateCount);
  updateCount();

  selectAllBtn.onclick = function () {
    listEl.querySelectorAll('input[type="checkbox"]').forEach(function (cb) { cb.checked = true; });
    updateCount();
  };
  selectNoneBtn.onclick = function () {
    listEl.querySelectorAll('input[type="checkbox"]').forEach(function (cb) { cb.checked = false; });
    updateCount();
  };

  confirmBtn.disabled = false;
  confirmBtn.onclick = async function () {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Creating…';
    let created = 0;
    let skipped = 0;
    let rows = listEl.querySelectorAll('.history-import-row');
    // Fetch fresh "taken" set so we never collide
    let latest = await storageGet(null);
    let taken = {};
    Object.keys(latest).filter(isShortcutKey).forEach(function (k) { taken[k] = 1; });
    // Find/create 0tab folder once
    let tab0FolderId = null;
    try {
      tab0FolderId = await new Promise(function (resolve) {
        chrome.runtime.sendMessage({ action: 'getTab0FolderId' }, function (id) { resolve(id || null); });
      });
    } catch (e) {}

    for (let row of rows) {
      let cb = row.querySelector('input[type="checkbox"]');
      if (!cb || !cb.checked) continue;
      let idx = parseInt(row.getAttribute('data-idx'), 10);
      let c = candidates[idx];
      let nameInput = row.querySelector('.history-import-row-name');
      let name = (nameInput ? nameInput.value : c.suggestedName || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15);
      if (!name) {
        name = tab0SuggestShortcutName(c.title, c.url, taken);
      }
      if (taken[name]) {
        // Bump to a free variant
        name = tab0SuggestShortcutName(c.title, c.url, taken);
      }
      taken[name] = 1;

      // Create Chrome bookmark (best-effort)
      let bookmarkId;
      if (tab0FolderId) {
        try {
          let bm = await new Promise(function (resolve, reject) {
            chrome.bookmarks.create({ parentId: tab0FolderId, title: c.title || name, url: c.url }, function (node) {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(node);
            });
          });
          bookmarkId = bm && bm.id;
        } catch (e) { /* bookmark creation failed — still save shortcut */ }
      }

      let shortcutData = {
        url: c.url,
        count: 0,
        tags: [],
        createdAt: Date.now(),
        lastAccessed: 0,
        bookmarkTitle: c.title || name
      };
      if (bookmarkId) shortcutData.bookmarkId = bookmarkId;
      try {
        await storageSet({ [name]: shortcutData });
        created++;
      } catch (e) {
        skipped++;
      }
    }

    // Mark imported regardless of count so the modal doesn't re-open
    try { await storageSet({ [HISTORY_IMPORT_FLAG]: true }); } catch (e) {}
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Create shortcuts';
    close();
    showToast('Created ' + created + ' shortcut' + (created !== 1 ? 's' : '') + (skipped ? ' (' + skipped + ' skipped)' : ''), 'success');
    if (typeof loadShortcutsTable === 'function') loadShortcutsTable();
    if (typeof loadBookmarksView === 'function') loadBookmarksView(true);
    if (typeof refreshTopUtilityStats === 'function') refreshTopUtilityStats();
  };
}

// Expose so Settings/other entry points can re-open it
window.openHistoryImportModal = openHistoryImportModal;

// Minimum fresh history candidates required to auto-show the importer.
// Below this threshold we don't pop the modal — users can still launch it
// manually from Settings via "Find frequent sites".
const HISTORY_IMPORT_MIN_SUGGESTIONS = 10;

// First-run / idle-trigger: if we haven't shown the importer yet and the
// user has at most a handful of shortcuts, surface it. Runs once per page load.
async function maybeTriggerHistoryImport() {
  try {
    let all = await storageGet([HISTORY_IMPORT_FLAG, HISTORY_IMPORT_DISMISSED_FLAG]);
    if (all && (all[HISTORY_IMPORT_FLAG] || all[HISTORY_IMPORT_DISMISSED_FLAG])) return;
    // Only prompt if the history permission is present AND user is light on shortcuts
    if (!chrome.history || !chrome.history.search) return;
    let items = await storageGet(null);
    let shortcutCount = Object.keys(items).filter(isShortcutKey).length;
    if (shortcutCount > 8) {
      // Established user — skip auto-prompt; still re-openable from Settings.
      try { await storageSet({ [HISTORY_IMPORT_FLAG]: true }); } catch (e) {}
      return;
    }
    // Pre-flight the candidate gathering so we only auto-show the modal
    // when there are enough fresh suggestions to be worth interrupting for.
    let preview;
    try { preview = await tab0GatherHistoryCandidates(20); } catch (e) { preview = []; }
    if (!preview || preview.length < HISTORY_IMPORT_MIN_SUGGESTIONS) return;
    // Slight delay so dashboard paint finishes first
    setTimeout(function () { openHistoryImportModal(); }, 800);
  } catch (e) { /* silent */ }
}

// ============================================================
// TOP UTILITY BAR — live stats, save-current-page, spotlight launcher
// ============================================================
async function refreshTopUtilityStats() {
  try {
    let items = await storageGet(null);
    let shortcutKeys = Object.keys(items).filter(isShortcutKey);
    let bookmarkCount = 0;
    let folderCount = 0;
    let bmTree = await new Promise(function (resolve) {
      chrome.bookmarks.getTree(function (tree) { resolve(tree || []); });
    });
    function walk(node) {
      if (!node) return;
      if (node.url) bookmarkCount++;
      else if (node.title) folderCount++;
      if (node.children) node.children.forEach(walk);
    }
    if (bmTree[0]) (bmTree[0].children || []).forEach(walk);
    let bar = document.getElementById('topUtilityStats');
    if (!bar) return;
    let setStat = function (key, value) {
      let el = bar.querySelector('[data-stat="' + key + '"] .top-stat-num');
      if (el) el.textContent = value.toLocaleString();
    };
    setStat('bookmarks', bookmarkCount);
    setStat('shortcuts', shortcutKeys.length);
    setStat('folders', folderCount);
  } catch (e) { /* silent */ }
}

(function wireTopUtilityBar() {
  let spotBtn = document.getElementById('topUtilitySpotlight');
  if (spotBtn) {
    spotBtn.addEventListener('click', function () {
      if (typeof openSpotlight === 'function') openSpotlight();
    });
  }
  refreshTopUtilityStats();
  // Refresh stats on storage/bookmark changes (debounced)
  let refreshTimer = null;
  function debouncedRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshTopUtilityStats, 400);
  }
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local') debouncedRefresh();
  });
  if (chrome.bookmarks && chrome.bookmarks.onCreated) {
    chrome.bookmarks.onCreated.addListener(debouncedRefresh);
    chrome.bookmarks.onRemoved.addListener(debouncedRefresh);
  }
})();

// ============================================================
// SPOTLIGHT (Cmd+K / Ctrl+K) — global jump-to-anything
// ============================================================
(function spotlightModule() {
  let overlay = document.getElementById('spotlightOverlay');
  let input = document.getElementById('spotlightInput');
  let resultsEl = document.getElementById('spotlightResults');
  if (!overlay || !input || !resultsEl) return;

  let activeIndex = 0;
  let currentResults = [];

  // Static actions are always available
  const STATIC_ACTIONS = [
    { kind: 'action', name: 'Open Settings', meta: 'Theme, sync, AI features',
      run: function () { let b = document.querySelector('[data-view="settings"]'); if (b) b.click(); } },
    { kind: 'action', name: 'Open Statistics', meta: 'Usage charts and trends',
      run: function () { let b = document.querySelector('[data-view="stats"]'); if (b) b.click(); } },
    { kind: 'action', name: 'Open Bookmarks', meta: 'Folders & shortcuts',
      run: function () { let b = document.querySelector('[data-view="bookmarks"]'); if (b) b.click(); } },
    { kind: 'action', name: 'Ask 0tab AI', meta: 'Open the chat',
      run: function () { let b = document.getElementById('chatToggleBtn'); if (b) b.click(); } },
    { kind: 'action', name: 'Find duplicates', meta: 'Open chat with this query',
      run: function () { let b = document.getElementById('chatToggleBtn'); if (b) b.click();
        setTimeout(function () { let i = document.getElementById('chatInput');
          if (i && typeof window.tab0SendChat === 'function') { i.value = 'Find duplicates'; window.tab0SendChat(); }
          else if (i) { i.value = 'Find duplicates'; let s = document.getElementById('chatSendBtn'); if (s) s.click(); }
        }, 200); } }
  ];

  // Cache of indexed items, refreshed lazily
  let cachedIndex = null;
  let cacheStamp = 0;
  async function buildIndex() {
    if (cachedIndex && Date.now() - cacheStamp < 30 * 1000) return cachedIndex;
    let items = await storageGet(null);
    let shortcuts = Object.keys(items).filter(isShortcutKey).map(function (k) {
      let d = items[k] || {};
      return {
        kind: 'shortcut',
        name: k,
        url: typeof d === 'object' ? (d.url || '') : (typeof d === 'string' ? d : ''),
        meta: typeof d === 'object' ? (d.bookmarkTitle || d.url || '') : '',
        score: typeof d === 'object' ? (d.count || 0) : 0
      };
    });
    let bms = [];
    let folders = [];
    let tree = await new Promise(function (r) { chrome.bookmarks.getTree(function (t) { r(t || []); }); });
    function walk(node, parentTitle) {
      if (!node) return;
      if (node.url) bms.push({ kind: 'bookmark', name: node.title || node.url, meta: parentTitle || '', url: node.url, score: 0 });
      else if (node.title) folders.push({ kind: 'folder', name: node.title, meta: (node.children || []).filter(function (c) { return c.url; }).length + ' items', id: node.id, score: 0 });
      if (node.children) node.children.forEach(function (c) { walk(c, node.title || ''); });
    }
    if (tree[0]) (tree[0].children || []).forEach(function (n) { walk(n, ''); });
    cachedIndex = { shortcuts: shortcuts, bookmarks: bms, folders: folders };
    cacheStamp = Date.now();
    return cachedIndex;
  }

  function scoreMatch(item, q) {
    let n = (item.name || '').toLowerCase();
    let m = (item.meta || '').toLowerCase();
    let u = (item.url || '').toLowerCase();
    if (!q) return item.score || 0;
    let s = 0;
    if (n === q) s += 1000;
    else if (n.startsWith(q)) s += 500;
    else if (n.includes(q)) s += 200;
    if (m.includes(q)) s += 30;
    if (u.includes(q)) s += 20;
    if (s === 0) return -1;
    return s + (item.score || 0) * 0.1;
  }

  async function runSearch(rawQuery) {
    let q = (rawQuery || '').toLowerCase().trim();
    let idx = await buildIndex();
    let pools = [
      { label: 'Shortcuts', items: idx.shortcuts },
      { label: 'Folders', items: idx.folders },
      { label: 'Bookmarks', items: idx.bookmarks },
      { label: 'Actions', items: STATIC_ACTIONS }
    ];
    let combined = [];
    pools.forEach(function (pool) {
      let scored = pool.items.map(function (it) {
        return { it: it, label: pool.label, s: scoreMatch(it, q) };
      }).filter(function (x) { return x.s >= 0; });
      scored.sort(function (a, b) { return b.s - a.s; });
      // Cap each pool so the list stays scannable
      let cap = pool.label === 'Bookmarks' ? 8 : 6;
      scored.slice(0, cap).forEach(function (x) { combined.push({ it: x.it, label: pool.label }); });
    });
    currentResults = combined;
    activeIndex = 0;
    renderResults();
  }

  function renderResults() {
    if (currentResults.length === 0) {
      let q = input.value.trim();
      resultsEl.innerHTML = q
        ? '<div class="spotlight-empty">No matches for "' + q.replace(/[<>&"]/g, '') + '". Try a shorter query.</div>'
        : '';
      return;
    }
    let html = '';
    let lastLabel = null;
    currentResults.forEach(function (entry, idx) {
      if (entry.label !== lastLabel) {
        html += '<div class="spotlight-section-label">' + entry.label + '</div>';
        lastLabel = entry.label;
      }
      let it = entry.it;
      let isActive = idx === activeIndex;
      let iconHtml = '';
      if (it.kind === 'shortcut' || it.kind === 'bookmark') {
        let url = it.url || '';
        if (url) {
          try {
            let host = new URL(url).hostname;
            iconHtml = '<img src="https://www.google.com/s2/favicons?domain=' + host + '&sz=16" data-hide-on-error="display">';
          } catch (e) {}
        }
      }
      if (!iconHtml) {
        if (it.kind === 'folder') iconHtml = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
        else if (it.kind === 'action') iconHtml = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';
        else iconHtml = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>';
      }
      let name = (it.name || '').replace(/[<>&]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]; });
      let meta = (it.meta || '').replace(/[<>&]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]; });
      html += '<div class="spotlight-item' + (isActive ? ' spotlight-item-active' : '') + '" data-idx="' + idx + '">' +
              '<span class="spotlight-item-icon">' + iconHtml + '</span>' +
              '<span class="spotlight-item-name">' + name + '</span>' +
              '<span class="spotlight-item-meta">' + meta + '</span>' +
              '<span class="spotlight-item-kind">' + it.kind + '</span>' +
              '</div>';
    });
    resultsEl.innerHTML = html;
    // Click handlers
    resultsEl.querySelectorAll('.spotlight-item').forEach(function (row) {
      row.addEventListener('mouseenter', function () {
        activeIndex = parseInt(row.getAttribute('data-idx'), 10) || 0;
        updateActiveHighlight();
      });
      row.addEventListener('click', function (ev) {
        activeIndex = parseInt(row.getAttribute('data-idx'), 10) || 0;
        executeActive(ev.metaKey || ev.ctrlKey);
      });
    });
    scrollActiveIntoView();
  }

  function updateActiveHighlight() {
    resultsEl.querySelectorAll('.spotlight-item').forEach(function (row, idx) {
      row.classList.toggle('spotlight-item-active', idx === activeIndex);
    });
  }

  function scrollActiveIntoView() {
    let el = resultsEl.querySelector('.spotlight-item-active');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function executeActive(forceNewTab) {
    let entry = currentResults[activeIndex];
    if (!entry) return;
    let it = entry.it;
    closeSpotlight();
    if (it.kind === 'action' && typeof it.run === 'function') {
      it.run();
      return;
    }
    let url = it.url;
    if (it.kind === 'folder' && it.id) {
      // Open the folder panel in dashboard
      chrome.bookmarks.getSubTree(it.id, function (results) {
        if (results && results[0] && typeof openFolderDetail === 'function') {
          openFolderDetail(results[0]);
        }
      });
      return;
    }
    if (!url) return;
    // Default behavior from spotlight (Enter) = new tab, so the dashboard
    // stays open. Cmd/Ctrl+Enter (forceNewTab) replaces the current tab.
    if (forceNewTab) chrome.tabs.update({ url: url });
    else chrome.tabs.create({ url: url });
  }

  function openSpotlight() {
    overlay.classList.remove('hidden');
    input.value = '';
    currentResults = [];
    activeIndex = 0;
    resultsEl.innerHTML = '';
    setTimeout(function () { input.focus(); }, 30);
  }
  function closeSpotlight() {
    overlay.classList.add('hidden');
  }
  // Expose for the top utility button
  window.openSpotlight = openSpotlight;

  // Keyboard
  document.addEventListener('keydown', function (e) {
    let isMod = e.metaKey || e.ctrlKey;
    if (isMod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (overlay.classList.contains('hidden')) openSpotlight();
      else closeSpotlight();
      return;
    }
    if (overlay.classList.contains('hidden')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeSpotlight(); return; }
    if (e.key === 'ArrowDown') {
      if (currentResults.length > 0) {
        activeIndex = Math.min(activeIndex + 1, currentResults.length - 1);
        updateActiveHighlight();
        scrollActiveIntoView();
      }
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowUp') {
      if (currentResults.length > 0) {
        activeIndex = Math.max(activeIndex - 1, 0);
        updateActiveHighlight();
        scrollActiveIntoView();
      }
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      executeActive(e.metaKey || e.ctrlKey);
    }
  });

  let searchDebounce = null;
  input.addEventListener('input', function () {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(function () { runSearch(input.value); }, 80);
  });

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeSpotlight();
  });
})();
