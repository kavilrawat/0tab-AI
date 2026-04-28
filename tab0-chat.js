// ============================================================
// 0TAB AI - Ask 0tab AI Chat Engine
// Conversational interface for bookmark queries, help, and actions
// ============================================================

(function () {
  'use strict';

  // --- Constants ---
  let sendMessageFn = null; // Will be assigned when sendMessage is defined
  const CHAT_INTERNAL_KEYS = ['__0tab_folders', '__0tab_settings', '__0tab_trash', '__0tab_migrated_v1', '__0tab_migrated_v2', '__0tab_daily_stats'];
  function isChatShortcutKey(key) {
    if (!key || typeof key !== 'string') return false;
    if (key.startsWith('__')) return false;
    return !CHAT_INTERNAL_KEYS.includes(key);
  }

  // --- Trash System ---
  const TRASH_STORAGE_KEY = '__0tab_trash';
  const TRASH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

  async function addToTrash(item) {
    try {
      let result = await chatStorageGet([TRASH_STORAGE_KEY]);
      let trash = result[TRASH_STORAGE_KEY] || [];
      let trashItem = { name: item.name, url: item.url || '', tags: item.tags || [], count: item.count || 0, bookmarkTitle: item.bookmarkTitle || '', deletedAt: Date.now() };
      // Preserve folder-specific data
      if (item.type === 'folder') {
        trashItem.type = 'folder';
        trashItem.urls = item.urls || [];
        trashItem.urlTitles = item.urlTitles || [];
        trashItem.folderId = item.folderId || '';
        trashItem.folderTitle = item.folderTitle || '';
      }
      trash.push(trashItem);
      // Purge items older than 30 days
      let cutoff = Date.now() - TRASH_MAX_AGE_MS;
      trash = trash.filter(function (t) { return t.deletedAt > cutoff; });
      let data = {}; data[TRASH_STORAGE_KEY] = trash;
      await chatStorageSet(data);
    } catch (e) { /* silently fail */ }
  }

  async function getTrashItems() {
    try {
      let result = await chatStorageGet([TRASH_STORAGE_KEY]);
      let trash = result[TRASH_STORAGE_KEY] || [];
      let cutoff = Date.now() - TRASH_MAX_AGE_MS;
      return trash.filter(function (t) { return t.deletedAt > cutoff; });
    } catch (e) { return []; }
  }

  async function restoreFromTrash(index) {
    try {
      let result = await chatStorageGet([TRASH_STORAGE_KEY]);
      let trash = result[TRASH_STORAGE_KEY] || [];
      if (index < 0 || index >= trash.length) return false;
      let item = trash.splice(index, 1)[0];
      // Restore to chrome storage — preserve folder structure if present
      let saveData = {};
      if (item.type === 'folder') {
        saveData[item.name] = { type: 'folder', urls: item.urls || [], urlTitles: item.urlTitles || [], folderId: item.folderId || '', folderTitle: item.folderTitle || '', count: item.count || 0, tags: item.tags || [], createdAt: Date.now(), lastAccessed: 0 };
      } else {
        saveData[item.name] = { url: item.url, count: item.count || 0, tags: item.tags || [], createdAt: Date.now(), lastAccessed: 0, bookmarkTitle: item.bookmarkTitle || '' };
      }
      await chatStorageSet(saveData);
      let trashData = {}; trashData[TRASH_STORAGE_KEY] = trash;
      await chatStorageSet(trashData);
      if (typeof loadShortcutsTable === 'function') loadShortcutsTable();
      return item;
    } catch (e) { return false; }
  }

  async function clearTrash() {
    try {
      let data = {}; data[TRASH_STORAGE_KEY] = [];
      await chatStorageSet(data);
    } catch (e) {}
  }

  // --- Conversation Context ---
  // Tracks conversation history for context-aware responses
  let conversationHistory = []; // Array of {role, text, timestamp}

  function addToHistory(role, text) {
    conversationHistory.push({ role: role, text: text, timestamp: Date.now() });
    if (conversationHistory.length > 20) conversationHistory.shift();
  }

  function getConversationContext() {
    return conversationHistory.slice(-6).map(function (m) {
      return (m.role === 'user' ? 'User' : '0tab') + ': ' + m.text;
    }).join('\n');
  }

  // ============================================================
  // CONVERSATION STATE MACHINE
  // Enables multi-turn dialogue flows (confirm, clarify, workflow)
  // ============================================================
  let conversationState = {
    mode: 'idle',         // idle | awaiting_confirm | awaiting_input | workflow
    context: null,        // data specific to current state
    workflowStep: 0,      // step within a workflow
    workflowName: null,    // 'cleanup' | 'organize' | 'bulk_tag' | 'bulk_move'
    pendingAction: null,   // function to execute on 'yes'
    pendingCancel: null,   // function to execute on 'no'
    // --- Conversation memory (survives across turns within a session) ---
    // Lets the user say "open it", "delete that", "rename it to X",
    // "the second one", "undo that" without re-typing the target.
    memory: {
      lastShortcut: null,    // { name, url, type } — last opened/referenced shortcut
      lastFolder: null,      // { id, title } — last referenced folder
      lastListResults: null, // last [{name,url,...}] from a list/search query
      lastAction: null       // { type, payload, undo: fn } for "undo that"
    }
  };

  function resetConversationState() {
    conversationState.mode = 'idle';
    conversationState.context = null;
    conversationState.workflowStep = 0;
    conversationState.workflowName = null;
    conversationState.pendingAction = null;
    conversationState.pendingCancel = null;
    // NOTE: do NOT clear .memory here — memory persists across workflows.
  }

  // --- Memory helpers ---
  function rememberShortcut(s) {
    if (!s) return;
    conversationState.memory.lastShortcut = {
      name: s.name || s.key || '',
      url: s.url || '',
      type: s.type || ''
    };
  }
  function rememberFolder(f) {
    if (!f) return;
    conversationState.memory.lastFolder = {
      id: f.id || '',
      title: f.title || f.name || ''
    };
  }
  function rememberListResults(items) {
    if (!Array.isArray(items)) return;
    conversationState.memory.lastListResults = items.slice(0, 20);
  }
  function rememberAction(type, payload, undoFn) {
    conversationState.memory.lastAction = {
      type: type || '',
      payload: payload || null,
      undo: typeof undoFn === 'function' ? undoFn : null,
      ts: Date.now()
    };
  }

  // Word-to-index: "first" → 0, "second" → 1, ...
  const ORDINAL_MAP = {
    first: 0, '1st': 0, one: 0,
    second: 1, '2nd': 1, two: 1,
    third: 2, '3rd': 2, three: 2,
    fourth: 3, '4th': 3, four: 3,
    fifth: 4, '5th': 4, five: 4,
    sixth: 5, '6th': 5, six: 5,
    seventh: 6, '7th': 6, seven: 6,
    eighth: 7, '8th': 7, eight: 7,
    ninth: 8, '9th': 8, nine: 8,
    tenth: 9, '10th': 9, ten: 9,
    last: -1
  };

  // Try to resolve pronouns/ordinals to a concrete shortcut name.
  // Returns the resolved name string, or null if no resolution.
  function resolveReferenceFromMemory(query) {
    if (!query || typeof query !== 'string') return null;
    let q = query.toLowerCase().trim();
    let m = conversationState.memory;

    // Ordinal reference: "open the second one", "delete the 3rd", "the last one"
    let ordinalMatch = q.match(/\b(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th)\b/);
    if (ordinalMatch && Array.isArray(m.lastListResults) && m.lastListResults.length > 0) {
      let idx = ORDINAL_MAP[ordinalMatch[1]];
      if (idx === -1) idx = m.lastListResults.length - 1;
      if (idx >= 0 && idx < m.lastListResults.length) {
        let item = m.lastListResults[idx];
        return item && (item.name || item.key || '');
      }
    }

    // Pronoun reference: "it", "that", "this one", "that one"
    if (/\b(it|that|this|that\s+one|this\s+one)\b/.test(q) && m.lastShortcut && m.lastShortcut.name) {
      return m.lastShortcut.name;
    }

    return null;
  }

  // Check if user input is a yes/no response to a pending confirmation
  function isAffirmative(text) {
    return /^(yes|y|yeah|yep|yup|sure|ok|okay|go|do it|confirm|proceed|haan|ha|theek|si|oui|ja)[\s!.]*$/i.test(text.trim());
  }
  function isNegative(text) {
    return /^(no|n|nah|nope|cancel|stop|nevermind|never mind|skip|nahi|na|non|nein)[\s!.]*$/i.test(text.trim());
  }

  // Handle state machine input before normal intent parsing
  async function handleStateMachineInput(query) {
    if (conversationState.mode === 'idle') return null; // not in a state, proceed normally

    let q = query.trim().toLowerCase();

    // --- AWAITING CONFIRMATION (yes/no) ---
    if (conversationState.mode === 'awaiting_confirm') {
      if (isAffirmative(q)) {
        let result = conversationState.pendingAction ? await conversationState.pendingAction() : null;
        resetConversationState();
        return result || 'Done!';
      }
      if (isNegative(q)) {
        let result = conversationState.pendingCancel ? await conversationState.pendingCancel() : 'Alright, cancelled.';
        resetConversationState();
        return result;
      }
      // Check if user is asking a new question instead of confirming
      let confirmBreakout = parseIntent(query);
      if (confirmBreakout.intent !== 'unknown' && confirmBreakout.intent !== 'query:search' && confirmBreakout.intent !== 'query:smart_single') {
        resetConversationState();
        return null; // let sendMessage() handle the new question
      }
      // Not a yes/no — remind them
      return {
        text: 'I\'m waiting for your confirmation. What would you like to do?',
        options: [
          { label: 'Yes, go ahead', query: 'Yes' },
          { label: 'No, cancel', query: 'No' }
        ]
      };
    }

    // --- AWAITING FREE-TEXT INPUT ---
    if (conversationState.mode === 'awaiting_input') {
      let handler = conversationState.pendingAction;
      resetConversationState();
      if (handler) return await handler(query);
      return null;
    }

    // --- WORKFLOW MODE ---
    if (conversationState.mode === 'workflow') {
      return await handleWorkflowStep(query);
    }

    return null;
  }

  // ============================================================
  // GUIDED WORKFLOWS
  // Multi-step copilot flows for complex bookmark management
  // ============================================================

  // Workflow: Cleanup dead/unused bookmarks
  async function startCleanupWorkflow() {
    let shortcuts = await getAllShortcuts();
    let dead = shortcuts.filter(function (s) { return s.count === 0 && s.type !== 'folder'; });

    if (dead.length === 0) {
      resetConversationState();
      return {
        text: 'Great news — all your bookmarks have been used at least once! Your collection is clean.',
        options: [
          { label: 'Show most used', query: 'Show most used shortcuts' },
          { label: 'Find duplicates', query: 'Find duplicates' }
        ]
      };
    }

    conversationState.mode = 'workflow';
    conversationState.workflowName = 'cleanup';
    conversationState.workflowStep = 0;
    conversationState.context = { dead: dead, index: 0, deleted: 0, kept: 0 };

    return showNextCleanupItem();
  }

  function showNextCleanupItem() {
    let ctx = conversationState.context;
    if (ctx.index >= ctx.dead.length) {
      let summary = 'Cleanup complete! Removed <strong>' + ctx.deleted + '</strong> shortcut' + (ctx.deleted !== 1 ? 's' : '') + ', kept <strong>' + ctx.kept + '</strong>.';
      resetConversationState();
      return {
        text: summary,
        options: [
          { label: 'Show my shortcuts', query: 'List all my shortcuts' },
          { label: 'Find duplicates', query: 'Find duplicates' }
        ]
      };
    }

    let item = ctx.dead[ctx.index];
    let fav = chatGetFavicon(item.url);
    let remaining = ctx.dead.length - ctx.index;
    let html = '<div style="margin-bottom:6px;">' +
      '<span style="font-size:11px;color:var(--text-muted);">Reviewing unused bookmarks (' + remaining + ' remaining)</span>' +
      '</div>' +
      '<div class="chat-list-item"><img src="' + fav + '">' +
      '<span class="chat-list-name">' + chatEscapeHtml(item.name) + '</span>' +
      '<span class="chat-list-meta">' + chatEscapeHtml(item.url.substring(0, 40)) + (item.url.length > 40 ? '...' : '') + '</span>' +
      '</div>' +
      '<div style="font-size:12px;margin-top:4px;">Never opened. Delete it?</div>';

    return {
      text: html,
      options: [
        { label: 'Delete it', query: 'Yes' },
        { label: 'Keep it', query: 'No' },
        { label: 'Skip remaining', query: 'Skip' },
        { label: 'Delete all unused', query: 'Delete all' }
      ]
    };
  }

  // Workflow: Organize bookmarks into folders
  async function startOrganizeWorkflow() {
    let shortcuts = await getAllShortcuts();
    let unorganized = shortcuts.filter(function (s) { return !s.folderId && !s.folderTitle && s.type !== 'folder'; });

    if (unorganized.length === 0) {
      resetConversationState();
      return {
        text: 'All your shortcuts already have folder assignments. Nice organization!',
        options: [
          { label: 'Show my folders', query: 'Show my folders' },
          { label: 'Find duplicates', query: 'Find duplicates' }
        ]
      };
    }

    // Try to use AI to suggest categories
    let aiAvailable = await checkChatAi();

    conversationState.mode = 'workflow';
    conversationState.workflowName = 'organize';
    conversationState.workflowStep = 0;
    conversationState.context = { unorganized: unorganized, aiAvailable: aiAvailable, index: 0, organized: 0, recentFolders: [] };

    let html = 'I found <strong>' + unorganized.length + '</strong> shortcut' + (unorganized.length !== 1 ? 's' : '') + ' without a folder. ';
    if (aiAvailable) {
      html += 'I can use AI to suggest folders for each one. Want me to go through them?';
    } else {
      html += 'Want me to go through them one by one so you can assign folders?';
    }

    return {
      text: html,
      options: [
        { label: 'Yes, let\'s organize', query: 'Yes' },
        { label: 'No thanks', query: 'No' }
      ]
    };
  }

  // Workflow: Bulk tag shortcuts
  async function startBulkTagWorkflow() {
    conversationState.mode = 'awaiting_input';
    conversationState.pendingAction = async function (userInput) {
      let tagName = userInput.trim().toLowerCase().replace(/[^a-z0-9- ]/g, '').replace(/\s+/g, ' ').trim();
      if (!tagName) return 'That doesn\'t look like a valid tag. Tags should be simple words (e.g., <em>work</em>, <em>dev</em>, <em>social</em>).';

      let shortcuts = await getAllShortcuts();
      let untagged = shortcuts.filter(function (s) { return s.tags.length === 0 && s.type !== 'folder'; });

      if (untagged.length === 0) {
        return {
          text: 'All your shortcuts already have tags! You can filter them:',
          options: [{ label: 'Show my tags', query: 'Show my tags' }]
        };
      }

      // Ask for confirmation to tag all untagged
      conversationState.mode = 'awaiting_confirm';
      conversationState.pendingAction = async function () {
        let updates = {};
        for (let i = 0; i < untagged.length; i++) {
          let s = untagged[i];
          let newTags = s.tags.slice();
          if (newTags.indexOf(tagName) === -1) newTags.push(tagName);
          let data = {};
          data[s.name] = Object.assign({}, { url: s.url, count: s.count, tags: newTags, type: s.type, lastAccessed: s.lastAccessed, createdAt: s.createdAt, bookmarkTitle: s.bookmarkTitle });
          await chatStorageSet(data);
        }
        if (typeof loadShortcutsTable === 'function') loadShortcutsTable();
        return 'Tagged <strong>' + untagged.length + '</strong> shortcut' + (untagged.length !== 1 ? 's' : '') + ' with <strong>#' + chatEscapeHtml(tagName) + '</strong>!';
      };

      return {
        text: 'Add tag <strong>#' + chatEscapeHtml(tagName) + '</strong> to <strong>' + untagged.length + '</strong> untagged shortcut' + (untagged.length !== 1 ? 's' : '') + '?',
        options: [
          { label: 'Yes, tag them', query: 'Yes' },
          { label: 'No', query: 'No' }
        ]
      };
    };

    return 'What tag would you like to add? Type a single word (e.g., <em>work</em>, <em>personal</em>, <em>dev</em>):';
  }

  async function handleWorkflowStep(query) {
    let q = query.trim().toLowerCase();
    let ctx = conversationState.context;

    // --- CLEANUP WORKFLOW ---
    if (conversationState.workflowName === 'cleanup') {
      if (q === 'skip' || q === 'stop' || q === 'skip remaining') {
        let summary = 'Stopped early. Removed <strong>' + ctx.deleted + '</strong> shortcut' + (ctx.deleted !== 1 ? 's' : '') + ', kept <strong>' + ctx.kept + '</strong>.';
        resetConversationState();
        return summary;
      }
      if (q === 'delete all' || q === 'delete all unused') {
        let remaining = ctx.dead.slice(ctx.index);
        for (let i = 0; i < remaining.length; i++) {
          await addToTrash(remaining[i]);
          try { await chatStorageRemove(remaining[i].name); } catch (e) { /* ignore */ }
          ctx.deleted++;
        }
        let summary = 'Deleted all remaining <strong>' + remaining.length + '</strong> unused shortcut' + (remaining.length !== 1 ? 's' : '') + '. Total cleaned: <strong>' + ctx.deleted + '</strong>.';
        resetConversationState();
        if (typeof loadShortcutsTable === 'function') loadShortcutsTable();
        return {
          text: summary,
          options: [
            { label: 'Show my shortcuts', query: 'List all my shortcuts' },
            { label: 'Find duplicates', query: 'Find duplicates' }
          ]
        };
      }
      if (isAffirmative(q)) {
        // Delete current item
        let item = ctx.dead[ctx.index];
        await addToTrash(item);
        try { await chatStorageRemove(item.name); } catch (e) { /* ignore */ }
        ctx.deleted++;
        ctx.index++;
        if (typeof loadShortcutsTable === 'function') loadShortcutsTable();
        return showNextCleanupItem();
      }
      if (isNegative(q)) {
        ctx.kept++;
        ctx.index++;
        return showNextCleanupItem();
      }
      // Check if user is asking a new question unrelated to the workflow
      let breakoutIntent = parseIntent(query);
      if (breakoutIntent.intent !== 'unknown' && breakoutIntent.intent !== 'query:search' && breakoutIntent.intent !== 'query:smart_single') {
        // User asked a real question — pause workflow silently and let it through
        resetConversationState();
        return null; // returning null lets sendMessage() handle it normally
      }
      // Unrecognized — repeat question
      return showNextCleanupItem();
    }

    // --- ORGANIZE WORKFLOW ---
    if (conversationState.workflowName === 'organize') {
      if (conversationState.workflowStep === 0) {
        // Waiting for yes/no to start
        if (isAffirmative(q)) {
          conversationState.workflowStep = 1;
          return showNextOrganizeItem();
        }
        resetConversationState();
        return 'No problem! Your shortcuts are fine as they are.';
      }
      if (q === 'skip' || q === 'stop' || q === 'done') {
        let summary = 'Organized <strong>' + ctx.organized + '</strong> shortcut' + (ctx.organized !== 1 ? 's' : '') + ' into folders.';
        resetConversationState();
        return summary;
      }
      // Check if user is asking a new question unrelated to the workflow
      let orgBreakout = parseIntent(query);
      if (orgBreakout.intent !== 'unknown' && orgBreakout.intent !== 'query:search' && orgBreakout.intent !== 'query:smart_single') {
        resetConversationState();
        return null;
      }
      // User picked a folder or typed a name
      return await assignFolderToCurrentItem(query);
    }

    return null;
  }

  async function showNextOrganizeItem() {
    let ctx = conversationState.context;
    if (ctx.index >= ctx.unorganized.length) {
      let summary = 'All done! Organized <strong>' + ctx.organized + '</strong> shortcut' + (ctx.organized !== 1 ? 's' : '') + ' into folders.';
      resetConversationState();
      if (typeof loadShortcutsTable === 'function') loadShortcutsTable();
      return {
        text: summary,
        options: [
          { label: 'Show my folders', query: 'Show my folders' },
          { label: 'List all bookmarks', query: 'List all my bookmarks' }
        ]
      };
    }

    let item = ctx.unorganized[ctx.index];
    let fav = chatGetFavicon(item.url);
    let remaining = ctx.unorganized.length - ctx.index;

    // Get available folders for option pills, prioritizing recently used/created folders
    let tree = await getBookmarkTree();
    let folders = flattenFolders(tree);
    let recentNames = (ctx.recentFolders || []).map(function (n) { return n.toLowerCase(); });
    // Deduplicate folders by title (case-insensitive), keeping first occurrence
    let seenTitles = {};
    let uniqueFolders = [];
    folders.forEach(function (f) {
      let key = f.title.toLowerCase();
      if (!seenTitles[key]) {
        seenTitles[key] = true;
        uniqueFolders.push(f);
      }
    });
    // Put recent folders first, then fill remaining slots from the deduplicated list
    let recentMatches = [];
    let otherFolders = [];
    uniqueFolders.forEach(function (f) {
      if (recentNames.indexOf(f.title.toLowerCase()) >= 0) recentMatches.push(f);
      else otherFolders.push(f);
    });
    let topFolders = recentMatches.concat(otherFolders).slice(0, 5);
    let folderOptions = topFolders.map(function (f) {
      return { label: f.title, query: f.title };
    });
    folderOptions.push({ label: '+ New folder', query: '__new_folder__' });
    folderOptions.push({ label: 'Skip this one', query: 'Skip' });

    let html = '<div style="margin-bottom:6px;">' +
      '<span style="font-size:11px;color:var(--text-muted);">Organizing (' + remaining + ' remaining)</span>' +
      '</div>' +
      '<div class="chat-list-item"><img src="' + fav + '">' +
      '<span class="chat-list-name">' + chatEscapeHtml(item.name) + '</span>' +
      '<span class="chat-list-meta">' + chatEscapeHtml(item.url.substring(0, 40)) + '</span>' +
      '</div>' +
      '<div style="font-size:12px;margin-top:4px;">Which folder should this go in?</div>';

    return { text: html, options: folderOptions };
  }

  async function assignFolderToCurrentItem(folderNameOrSkip) {
    let ctx = conversationState.context;
    let q = folderNameOrSkip.trim().toLowerCase();

    if (q === 'skip' || q === 'next') {
      ctx.index++;
      return showNextOrganizeItem();
    }

    // Handle "new folder" request — open the Add Folder modal form
    if (q === '__new_folder__' || q === 'new folder' || q === 'add a new folder' || q === 'create folder' || q === 'create a new folder') {
      // Use the dashboard modal if available, otherwise fall back to chat input
      if (typeof showModal === 'function') {
        // Build folder tree for parent selection
        let modalTree = await getBookmarkTree();
        let modalFolders = [];
        function walkForModal(node, depth) {
          if (!node.url && node.children && node.title) {
            modalFolders.push({ id: node.id, title: node.title, depth: depth });
          }
          if (node.children) node.children.forEach(function (c) { walkForModal(c, depth + 1); });
        }
        modalTree.forEach(function (n) { walkForModal(n, 0); });
        let folderSelectData = modalFolders.map(function (f) {
          let indent = '';
          for (let i = 0; i < f.depth; i++) indent += '\u00A0\u00A0';
          return { value: f.id, label: indent + f.title };
        });

        // Keep a reference to the current workflow item
        let currentItem = ctx.unorganized[ctx.index];
        let currentCtx = ctx;

        showModal({
          title: 'Add Folder',
          inputs: [
            { id: 'foldername', label: 'FOLDER NAME', value: '', placeholder: 'New folder name' },
            { id: 'shortcutname', label: 'FOLDER 0TAB SHORTCUT', value: '', placeholder: 'e.g. docs (leave empty to skip)' },
            { id: 'parent', label: 'PARENT FOLDER', type: 'select', selectOptions: folderSelectData, value: '1' }
          ],
          buttons: [
            { text: 'Cancel', className: 'dm-btn-cancel', onClick: function () {
              // Resume workflow without creating folder
              showNextOrganizeItem().then(function (resp) {
                if (resp) {
                  if (typeof resp === 'object' && resp.text) addMessage('bot', resp.text, resp.options);
                  else addMessage('bot', resp);
                }
              });
            }},
            { text: 'Create', className: 'dm-btn-save', onClick: function () {
              let name = document.getElementById('dm-input-foldername').value.trim();
              let parentId = document.getElementById('dm-input-parent').value;
              let shortcutName = document.getElementById('dm-input-shortcutname').value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
              if (!name) return;
              let createData = { title: name };
              if (parentId) createData.parentId = parentId;
              chrome.bookmarks.create(createData, function (newFolder) {
                if (chrome.runtime.lastError) {
                  addMessage('bot', 'Failed to create folder: ' + chrome.runtime.lastError.message);
                  return;
                }
                // Create 0tab shortcut for the folder if specified
                if (shortcutName) {
                  let shortcutData = {};
                  shortcutData[shortcutName] = { url: '', folder: name, count: 0 };
                  chatStorageSet(shortcutData).catch(function () { /* ignore */ });
                }
                // Move current item into the new folder
                chrome.bookmarks.create({
                  parentId: newFolder.id,
                  title: currentItem.bookmarkTitle || currentItem.name,
                  url: currentItem.url
                }, function () {
                  currentCtx.organized++;
                  currentCtx.index++;
                  if (currentCtx.recentFolders && currentCtx.recentFolders.indexOf(name) < 0) currentCtx.recentFolders.push(name);
                  if (typeof loadBookmarksView === 'function') loadBookmarksView();
                  let shortcutMsg = shortcutName ? ' Shortcut <strong>' + chatEscapeHtml(shortcutName) + '</strong> created.' : '';
                  addMessage('bot', 'Created folder <strong>' + chatEscapeHtml(name) + '</strong> and moved <strong>' + chatEscapeHtml(currentItem.name) + '</strong> into it.' + shortcutMsg);
                  // Continue to next item
                  showNextOrganizeItem().then(function (resp) {
                    if (resp) {
                      if (typeof resp === 'object' && resp.text) addMessage('bot', resp.text, resp.options);
                      else addMessage('bot', resp);
                    }
                  });
                });
              });
            }}
          ]
        });
        return 'Opening the folder creation form...';
      }

      // Fallback: ask via chat if modal not available
      conversationState.mode = 'awaiting_input';
      conversationState.pendingAction = async function (userInput) {
        let newName = userInput.trim();
        if (!newName) return 'Please type a valid folder name.';
        try {
          let result = await new Promise(function (resolve, reject) {
            chrome.bookmarks.create({ parentId: '1', title: newName }, function (node) {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(node);
            });
          });
          let item = ctx.unorganized[ctx.index];
          try {
            await new Promise(function (resolve) {
              chrome.bookmarks.create({ parentId: result.id, title: item.bookmarkTitle || item.name, url: item.url }, function () { resolve(); });
            });
          } catch (e) {}
          ctx.organized++;
          ctx.index++;
          if (ctx.recentFolders && ctx.recentFolders.indexOf(newName) < 0) ctx.recentFolders.push(newName);
          if (typeof loadBookmarksView === 'function') loadBookmarksView();
          conversationState.mode = 'workflow';
          return showNextOrganizeItem();
        } catch (e) {
          conversationState.mode = 'workflow';
          return 'Failed to create folder: ' + chatEscapeHtml(e.message);
        }
      };
      return 'What should the new folder be called?';
    }

    // Find matching folder
    let tree = await getBookmarkTree();
    let folders = flattenFolders(tree);
    let match = folders.find(function (f) { return f.title.toLowerCase() === q; }) ||
                folders.find(function (f) { return f.title.toLowerCase().includes(q); });

    if (!match) {
      // Folder doesn't exist — open the Add Folder modal pre-filled
      if (typeof showModal === 'function') {
        let modalTree2 = await getBookmarkTree();
        let modalFolders2 = [];
        function walkForModal2(node, depth) {
          if (!node.url && node.children && node.title) {
            modalFolders2.push({ id: node.id, title: node.title, depth: depth });
          }
          if (node.children) node.children.forEach(function (c) { walkForModal2(c, depth + 1); });
        }
        modalTree2.forEach(function (n) { walkForModal2(n, 0); });
        let folderSelectData2 = modalFolders2.map(function (f) {
          let indent = '';
          for (let i = 0; i < f.depth; i++) indent += '\u00A0\u00A0';
          return { value: f.id, label: indent + f.title };
        });

        let currentItem2 = ctx.unorganized[ctx.index];
        let currentCtx2 = ctx;
        let prefillName = folderNameOrSkip.trim();

        showModal({
          title: 'Add Folder',
          inputs: [
            { id: 'foldername', label: 'FOLDER NAME', value: prefillName, placeholder: 'New folder name' },
            { id: 'shortcutname', label: 'FOLDER 0TAB SHORTCUT', value: prefillName.toLowerCase().replace(/[^a-z0-9]/g, ''), placeholder: 'e.g. docs (leave empty to skip)' },
            { id: 'parent', label: 'PARENT FOLDER', type: 'select', selectOptions: folderSelectData2, value: '1' }
          ],
          buttons: [
            { text: 'Cancel', className: 'dm-btn-cancel', onClick: function () {
              showNextOrganizeItem().then(function (resp) {
                if (resp) {
                  if (typeof resp === 'object' && resp.text) addMessage('bot', resp.text, resp.options);
                  else addMessage('bot', resp);
                }
              });
            }},
            { text: 'Create', className: 'dm-btn-save', onClick: function () {
              let name = document.getElementById('dm-input-foldername').value.trim();
              let parentId = document.getElementById('dm-input-parent').value;
              let shortcutName = document.getElementById('dm-input-shortcutname').value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
              if (!name) return;
              let createData = { title: name };
              if (parentId) createData.parentId = parentId;
              chrome.bookmarks.create(createData, function (newFolder) {
                if (chrome.runtime.lastError) {
                  addMessage('bot', 'Failed to create folder: ' + chrome.runtime.lastError.message);
                  return;
                }
                // Create 0tab shortcut for the folder if specified
                if (shortcutName) {
                  let shortcutData = {};
                  shortcutData[shortcutName] = { url: '', folder: name, count: 0 };
                  chatStorageSet(shortcutData).catch(function () { /* ignore */ });
                }
                chrome.bookmarks.create({
                  parentId: newFolder.id,
                  title: currentItem2.bookmarkTitle || currentItem2.name,
                  url: currentItem2.url
                }, function () {
                  currentCtx2.organized++;
                  currentCtx2.index++;
                  if (currentCtx2.recentFolders && currentCtx2.recentFolders.indexOf(name) < 0) currentCtx2.recentFolders.push(name);
                  if (typeof loadBookmarksView === 'function') loadBookmarksView();
                  let shortcutMsg2 = shortcutName ? ' Shortcut <strong>' + chatEscapeHtml(shortcutName) + '</strong> created.' : '';
                  addMessage('bot', 'Created folder <strong>' + chatEscapeHtml(name) + '</strong> and moved <strong>' + chatEscapeHtml(currentItem2.name) + '</strong> into it.' + shortcutMsg2);
                  showNextOrganizeItem().then(function (resp) {
                    if (resp) {
                      if (typeof resp === 'object' && resp.text) addMessage('bot', resp.text, resp.options);
                      else addMessage('bot', resp);
                    }
                  });
                });
              });
            }}
          ]
        });
        return 'Folder <strong>' + chatEscapeHtml(prefillName) + '</strong> doesn\'t exist. Opening the form to create it...';
      }

      // Fallback: chat-based confirmation
      conversationState.mode = 'awaiting_confirm';
      conversationState.pendingAction = async function () {
        try {
          let result = await new Promise(function (resolve, reject) {
            chrome.bookmarks.create({ parentId: '1', title: folderNameOrSkip.trim() }, function (node) {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(node);
            });
          });
          let item = ctx.unorganized[ctx.index];
          try {
            await new Promise(function (resolve) {
              chrome.bookmarks.create({ parentId: result.id, title: item.bookmarkTitle || item.name, url: item.url }, function () { resolve(); });
            });
          } catch (e) {}
          ctx.organized++;
          ctx.index++;
          if (ctx.recentFolders && ctx.recentFolders.indexOf(folderNameOrSkip.trim()) < 0) ctx.recentFolders.push(folderNameOrSkip.trim());
          if (typeof loadBookmarksView === 'function') loadBookmarksView();
          conversationState.mode = 'workflow';
          return showNextOrganizeItem();
        } catch (e) {
          conversationState.mode = 'workflow';
          return 'Failed to create folder: ' + chatEscapeHtml(e.message);
        }
      };
      conversationState.pendingCancel = async function () {
        conversationState.mode = 'workflow';
        return showNextOrganizeItem();
      };
      return {
        text: 'Folder <strong>' + chatEscapeHtml(folderNameOrSkip.trim()) + '</strong> doesn\'t exist. Create it?',
        options: [
          { label: 'Yes, create it', query: 'Yes' },
          { label: 'Skip this one', query: 'No' }
        ]
      };
    }

    // Move to matched folder
    let item = ctx.unorganized[ctx.index];
    try {
      await new Promise(function (resolve) {
        chrome.bookmarks.create({ parentId: match.id, title: item.bookmarkTitle || item.name, url: item.url }, function () { resolve(); });
      });
    } catch (e) {}
    if (ctx.recentFolders && match.title && ctx.recentFolders.indexOf(match.title) < 0) ctx.recentFolders.push(match.title);
    ctx.organized++;
    ctx.index++;
    if (typeof loadBookmarksView === 'function') loadBookmarksView();
    return showNextOrganizeItem();
  }

  // ============================================================
  // PROACTIVE INSIGHTS
  // Analyze user data and offer intelligent suggestions on chat open
  // ============================================================
  let proactiveShown = false; // Only show once per session

  // Look up the current active tab so we can suggest saving it.
  async function getCurrentTabContext() {
    try {
      let tabs = await new Promise(function (resolve) {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (t) {
          if (chrome.runtime.lastError) resolve([]);
          else resolve(t || []);
        });
      });
      let active = tabs[0];
      if (!active || !active.url) return null;
      // Skip non-saveable URLs
      if (/^(chrome|edge|about|chrome-extension):/i.test(active.url)) return null;
      if (active.url === 'about:blank') return null;
      return { url: active.url, title: active.title || '' };
    } catch (e) { return null; }
  }

  async function generateProactiveInsight() {
    if (proactiveShown) return null;
    proactiveShown = true;

    try {
      let shortcuts = await getAllShortcuts();
      let tree = await getBookmarkTree();
      let counts = countBookmarks(tree);
      let folders = flattenFolders(tree);
      let insights = [];

      // 1) Current-tab save suggestion — highest signal, most contextual.
      // If the user is on a normal page that isn't already saved, surface it.
      let currentTab = await getCurrentTabContext();
      if (currentTab) {
        let normalizedCurrent = currentTab.url.replace(/\/+$/, '').toLowerCase();
        let alreadySaved = shortcuts.some(function (s) {
          return s.url && s.url.replace(/\/+$/, '').toLowerCase() === normalizedCurrent;
        });
        if (!alreadySaved) {
          let displayTitle = (currentTab.title || currentTab.url).substring(0, 60);
          insights.push({
            text: 'Saw you\'re on <strong>' + chatEscapeHtml(displayTitle) + '</strong>. Want me to save it?',
            options: [
              { label: 'Save this page', query: 'Save this page' },
              { label: 'Not now', query: 'No thanks' }
            ],
            priority: 200 // High — user is actively on this page
          });
        }
      }

      // Check total usage to determine if user is new vs returning
      let totalUses = 0;
      shortcuts.forEach(function (s) { totalUses += s.count; });
      let isNewUser = totalUses < 5; // Fewer than 5 opens = likely just installed

      if (isNewUser) {
        // New user: show a helpful bookmark management prompt instead of "never opened" alarm
        insights.push({
          text: 'You have <strong>' + counts.bookmarks + '</strong> bookmarks across <strong>' + counts.folders + '</strong> folders. I can help you organize and manage them!',
          options: [
            { label: 'Organize bookmarks', query: 'Help me organize my bookmarks' },
            { label: 'Show my folders', query: 'Show my folders' },
            { label: 'Find duplicates', query: 'Find duplicates' }
          ],
          priority: 100
        });
      } else {
        // Returning user: show actual usage-based insights

        // Dead bookmarks — only flag ones that had a chance to be used (created > 7 days ago)
        let weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        let dead = shortcuts.filter(function (s) {
          return s.count === 0 && s.type !== 'folder' && s.createdAt && s.createdAt < weekAgo;
        });
        if (dead.length >= 3) {
          insights.push({
            text: 'You have <strong>' + dead.length + '</strong> bookmarks you haven\'t used in a while. Want me to help tidy up?',
            options: [
              { label: 'Start cleanup', query: 'Clean up unused bookmarks' },
              { label: 'Show them', query: 'Show unused bookmarks' }
            ],
            priority: dead.length
          });
        }

        // Check for duplicates
        let urlMap = {};
        shortcuts.forEach(function (s) {
          let norm = s.url.replace(/\/+$/, '').toLowerCase();
          urlMap[norm] = (urlMap[norm] || 0) + 1;
        });
        let dupeCount = Object.keys(urlMap).filter(function (u) { return urlMap[u] > 1; }).length;
        if (dupeCount >= 2) {
          insights.push({
            text: 'I spotted <strong>' + dupeCount + '</strong> duplicate URLs in your shortcuts. Want me to find them?',
            options: [
              { label: 'Find duplicates', query: 'Find duplicates' },
              { label: 'Not now', query: 'No thanks' }
            ],
            priority: dupeCount
          });
        }

        // Check for untagged shortcuts
        let untagged = shortcuts.filter(function (s) { return s.tags.length === 0 && s.type !== 'folder'; });
        if (untagged.length >= 5) {
          insights.push({
            text: '<strong>' + untagged.length + '</strong> of your shortcuts have no tags — that makes them harder to find. Want me to help tag them?',
            options: [
              { label: 'Bulk tag them', query: 'Bulk tag my shortcuts' },
              { label: 'Show untagged', query: 'Show my least used bookmarks' }
            ],
            priority: untagged.length
          });
        }

        // Milestone celebrations
        if (totalUses > 0 && totalUses % 50 < 5) {
          insights.push({
            text: 'You\'ve used your shortcuts <strong>' + totalUses + '</strong> times! Your most used is <strong>' + (shortcuts.sort(function (a, b) { return b.count - a.count; })[0] || {}).name + '</strong>.',
            options: [
              { label: 'Show top shortcuts', query: 'Show most used shortcuts' },
              { label: 'View stats', query: 'How many bookmarks do I have?' }
            ],
            priority: 1
          });
        }
      }

      if (insights.length === 0) return null;

      // Return highest priority insight
      insights.sort(function (a, b) { return b.priority - a.priority; });
      // Stash the full sorted list so showDynamicWelcome can show a
      // second, lower-priority suggestion alongside the top one.
      generateProactiveInsight._all = insights;
      return insights[0];
    } catch (e) {
      return null;
    }
  }

  // --- Language Detection ---
  // Detects if user input contains non-Latin scripts (used to show English-only notice)
  // Note: Hinglish/romanized commands (kholo, karo, etc.) use Latin script and are
  // handled by regex intent matching — they work fine and won't trigger this check
  function isNonEnglishQuery(text) {
    let t = text.toLowerCase().trim();
    // Non-Latin scripts are always non-English (except if it's a single recognized greeting)
    if (/[\u0900-\u097F]/.test(t)) return true; // Devanagari
    if (/[\u0600-\u06FF]/.test(t)) return true; // Arabic
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(t)) return true; // Japanese
    if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(t)) return true; // Korean
    if (/[\u4E00-\u9FFF]/.test(t)) return true; // Chinese
    if (/[\u0B80-\u0BFF]/.test(t)) return true; // Tamil
    if (/[\u0C00-\u0C7F]/.test(t)) return true; // Telugu
    if (/[\u0C80-\u0CFF]/.test(t)) return true; // Kannada
    if (/[\u0980-\u09FF]/.test(t)) return true; // Bengali
    return false;
  }

  // --- Storage helpers (mirrored from manage.js, self-contained) ---
  // Storage moved from chrome.storage.sync to chrome.storage.local to avoid
  // sync quotas that were silently dropping saves. Existing sync data is
  // migrated once via __chatEnsureMigrated below.
  let __chatMigrationPromise = null;
  function __chatEnsureMigrated() {
    if (__chatMigrationPromise) return __chatMigrationPromise;
    __chatMigrationPromise = new Promise(function (resolve) {
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
    return __chatMigrationPromise;
  }
  __chatEnsureMigrated();

  // v2 migration: rebrand from Tab0 AI → 0tab AI. Renames legacy `__ssg_*`
  // and `__tab0_*` storage keys to `__0tab_*`. Idempotent, gated on flag.
  const __CHAT_KEY_RENAME_MAP = {
    '__ssg_folders': '__0tab_folders',
    '__ssg_settings': '__0tab_settings',
    '__ssg_trash': '__0tab_trash',
    '__tab0_migrated_v1': '__0tab_migrated_v1',
    '__tab0_daily_stats': '__0tab_daily_stats',
    '__tab0_history_imported_v1': '__0tab_history_imported_v1',
    '__tab0_history_dismissed_v1': '__0tab_history_dismissed_v1'
  };
  let __chatMigrationV2Promise = null;
  function __chatEnsureMigratedV2() {
    if (__chatMigrationV2Promise) return __chatMigrationV2Promise;
    __chatMigrationV2Promise = __chatEnsureMigrated().then(function () {
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
              Object.keys(__CHAT_KEY_RENAME_MAP).forEach(function (oldK) {
                let newK = __CHAT_KEY_RENAME_MAP[oldK];
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
    return __chatMigrationV2Promise;
  }
  __chatEnsureMigratedV2();

  function chatStorageGet(keys) {
    return __chatEnsureMigratedV2().then(function () {
      return new Promise(function (resolve, reject) {
        chrome.storage.local.get(keys, function (result) {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(result);
        });
      });
    });
  }
  function chatStorageSet(data) {
    return __chatEnsureMigratedV2().then(function () {
      return new Promise(function (resolve, reject) {
        chrome.storage.local.set(data, function () {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
    });
  }
  function chatStorageRemove(keys) {
    return __chatEnsureMigratedV2().then(function () {
      return new Promise(function (resolve, reject) {
        chrome.storage.local.remove(keys, function () {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
    });
  }

  function chatEscapeHtml(text) {
    let div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function chatGetFavicon(url) {
    try {
      return 'https://www.google.com/s2/favicons?domain=' + new URL(url).hostname + '&sz=16';
    } catch (e) { return 'icon16.png'; }
  }

  // Letter-avatar fallback for chat favicon images. We can't use inline
  // onerror="" because MV3's default CSP blocks inline event handlers, so
  // a single document-level error listener (capture phase, since `error`
  // doesn't bubble) handles every favicon image — including those inserted
  // later via innerHTML.
  function __0tabApplyFavFallback(img) {
    if (!img || img.dataset.zerotabFallback === '1') return;
    img.dataset.zerotabFallback = '1';
    let name = img.getAttribute('data-name') || '?';
    let size = img.width || 16;
    let colors = typeof AVATAR_COLORS !== 'undefined' ? AVATAR_COLORS : ['#4A90D9','#E06C75','#98C379','#D19A66','#C678DD','#56B6C2','#E5C07B','#BE5046'];
    let letter = name.charAt(0).toUpperCase();
    let colorIdx = letter.charCodeAt(0) % colors.length;
    let avatar = document.createElement('span');
    avatar.textContent = letter;
    avatar.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:' + size + 'px;height:' + size + 'px;border-radius:50%;background:' + colors[colorIdx] + ';color:#fff;font-size:' + Math.round(size * 0.55) + 'px;font-weight:600;flex-shrink:0;line-height:1;vertical-align:middle;';
    avatar.className = img.className;
    if (img.parentNode) img.parentNode.replaceChild(avatar, img);
  }
  document.addEventListener('error', function (e) {
    let t = e.target;
    if (t && t.tagName === 'IMG' && t.hasAttribute('data-name')) __0tabApplyFavFallback(t);
  }, true);

  function chatFavImg(url, name, cssClass, size) {
    let src = chatGetFavicon(url);
    let s = size || 16;
    let cls = cssClass ? ' class="' + cssClass + '"' : '';
    let safeName = chatEscapeHtml(name || '?');
    return '<img src="' + src + '"' + cls + ' width="' + s + '" height="' + s + '" data-name="' + safeName + '">';
  }

  function chatTimeAgo(ts) {
    if (!ts) return 'never';
    let diff = Date.now() - ts;
    let mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    let hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    let days = Math.floor(hrs / 24);
    if (days < 30) return days + 'd ago';
    return Math.floor(days / 30) + 'mo ago';
  }

  // ============================================================
  // RICH MESSAGE CARD TEMPLATES
  // Reusable card components for copilot-style chat responses
  // ============================================================
  function buildBookmarkCard(item, opts) {
    opts = opts || {};
    let fav = chatGetFavicon(item.url);
    let meta = opts.meta || (item.count !== undefined ? item.count + ' opens' : '');
    let html = '<div class="chat-card chat-card-bookmark" data-url="' + chatEscapeHtml(item.url) + '" data-name="' + chatEscapeHtml(item.name || item.title || '') + '">';
    html += '<div class="chat-card-main"><img src="' + fav + '" class="chat-card-favicon">';
    html += '<div class="chat-card-info"><span class="chat-card-name">' + chatEscapeHtml(item.name || item.title || '') + '</span>';
    if (meta) html += '<span class="chat-card-meta">' + meta + '</span>';
    html += '</div></div>';
    // Inline actions
    if (opts.actions !== false) {
      html += '<div class="chat-card-actions">';
      html += '<button class="chat-card-action" data-action="open" title="Open"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>';
      if (opts.showDelete !== false) {
        html += '<button class="chat-card-action chat-card-action-danger" data-action="delete" title="Delete"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function buildFolderCard(folder) {
    let html = '<div class="chat-card chat-card-folder" data-folder-id="' + chatEscapeHtml(folder.id || '') + '" data-folder-name="' + chatEscapeHtml(folder.path || folder.title || folder.name || '') + '">';
    html += '<div class="chat-card-main"><span class="chat-card-folder-icon">&#128193;</span>';
    html += '<div class="chat-card-info"><span class="chat-card-name">' + chatEscapeHtml(folder.path || folder.title || folder.name || '') + '</span>';
    html += '<span class="chat-card-meta">' + (folder.childCount || 0) + ' items</span>';
    html += '</div></div>';
    html += '<div class="chat-card-actions">';
    html += '<button class="chat-card-action" data-action="view-folder" title="View contents"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  function buildStatsCards(stats) {
    let html = '<div class="chat-stats-grid">';
    stats.forEach(function (s) {
      html += '<div class="chat-stat-card"><span class="chat-stat-value">' + s.value + '</span><span class="chat-stat-label">' + s.label + '</span></div>';
    });
    html += '</div>';
    return html;
  }

  function wireCardActions(container) {
    container.querySelectorAll('.chat-card-action').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        let card = btn.closest('.chat-card');
        let action = btn.getAttribute('data-action');
        if (!card) return;
        if (action === 'open') {
          let url = card.getAttribute('data-url');
          if (url) chrome.tabs.create({ url: url });
        } else if (action === 'delete') {
          let name = card.getAttribute('data-name');
          if (name && sendMessageFn) {
            let input = document.getElementById('chatInput');
            if (input) input.value = 'Delete shortcut ' + name;
            sendMessageFn();
          }
        } else if (action === 'view-folder') {
          let folderName = card.getAttribute('data-folder-name');
          if (folderName && sendMessageFn) {
            let input = document.getElementById('chatInput');
            if (input) input.value = 'What\'s in ' + folderName + ' folder';
            sendMessageFn();
          }
        }
      });
    });
  }

  // ============================================================
  // DATA LAYER - Query bookmarks, shortcuts, stats
  // ============================================================
  async function getAllShortcuts() {
    let items = await chatStorageGet(null);
    let shortcuts = [];
    Object.keys(items).filter(isChatShortcutKey).forEach(function (key) {
      let d = items[key];
      if (typeof d === 'object') {
        shortcuts.push({
          name: key,
          url: d.url || '',
          count: d.count || 0,
          tags: Array.isArray(d.tags) ? d.tags : [],
          type: d.type || 'bookmark',
          lastAccessed: d.lastAccessed || 0,
          createdAt: d.createdAt || 0,
          bookmarkTitle: d.bookmarkTitle || '',
          aiDescription: d.aiDescription || '',
          folderId: d.folderId || null,
          folderTitle: d.folderTitle || '',
          urls: d.urls || []
        });
      } else if (typeof d === 'string') {
        shortcuts.push({ name: key, url: d, count: 0, tags: [], type: 'bookmark', lastAccessed: 0, createdAt: 0, bookmarkTitle: '', aiDescription: '' });
      }
    });
    return shortcuts;
  }

  async function getBookmarkTree() {
    return new Promise(function (resolve) {
      chrome.bookmarks.getTree(function (tree) {
        if (chrome.runtime.lastError) resolve([]);
        else resolve(tree || []);
      });
    });
  }

  function countBookmarks(tree) {
    let count = 0;
    let folders = 0;
    function walk(node) {
      if (node.url) count++;
      else if (node.children) { folders++; node.children.forEach(walk); }
    }
    tree.forEach(walk);
    return { bookmarks: count, folders: Math.max(0, folders - 1) }; // subtract root
  }

  function flattenBookmarks(tree) {
    let all = [];
    function walk(node, path) {
      if (node.url) {
        all.push({ title: node.title, url: node.url, folder: path, id: node.id });
      }
      if (node.children) {
        let p = node.title ? (path ? path + ' / ' + node.title : node.title) : path;
        node.children.forEach(function (c) { walk(c, p); });
      }
    }
    tree.forEach(function (n) { walk(n, ''); });
    return all;
  }

  function flattenFolders(tree) {
    let all = [];
    function walk(node, path) {
      if (!node.url && node.children) {
        let p = node.title ? (path ? path + ' / ' + node.title : node.title) : path;
        if (node.title) all.push({ title: node.title, path: p, id: node.id, childCount: node.children.length });
        node.children.forEach(function (c) { walk(c, p); });
      }
    }
    tree.forEach(function (n) { walk(n, ''); });
    return all;
  }

  async function getDailyStats() {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ action: 'getDailyStats' }, function (r) {
          if (chrome.runtime.lastError) resolve({});
          else resolve(r || {});
        });
      } catch (e) { resolve({}); }
    });
  }

  // ============================================================
  // HELP KNOWLEDGE BASE
  // ============================================================
  const HELP_TOPICS = {
    'getting-started': {
      keywords: ['start', 'begin', 'new', 'setup', 'how to use', 'how does', 'what is tab0', 'what does tab0', 'help', 'tutorial', 'guide', 'intro'],
      title: 'Getting Started with 0tab AI',
      body: '<div class="chat-help-section">' +
        '<p>0tab AI lets you create keyboard shortcuts for your bookmarks, accessible right from your Chrome search bar.</p>' +
        '<h4>Quick Start</h4>' +
        '<p>1. Type <code>0</code> + <code>Tab</code> in your Chrome search bar to activate 0tab AI</p>' +
        '<p>2. Type any shortcut name to instantly open it</p>' +
        '<p>3. Use the popup (click the 0tab AI icon) to save new shortcuts</p>' +
        '<h4>Example</h4>' +
        '<p>Save Gmail as shortcut <code>mail</code>, then type <code>0</code> <code>Tab</code> <code>mail</code> <code>Enter</code> to open it instantly!</p>' +
        '</div>'
    },
    'omnibox': {
      keywords: ['omnibox', 'address bar', 'url bar', 'search bar', 'type', 'keyboard', 'shortcut', '0 tab', 'zero tab'],
      title: 'Using the Omnibox',
      body: '<div class="chat-help-section">' +
        '<p>The omnibox is 0tab AI\'s core feature — open any bookmark in 2 keystrokes.</p>' +
        '<h4>How it works</h4>' +
        '<p>1. Press <code>0</code> then <code>Tab</code> in your Chrome search bar</p>' +
        '<p>2. Start typing your shortcut name — you\'ll see suggestions</p>' +
        '<p>3. Press <code>Enter</code> to open the top match</p>' +
        '<h4>Partial matching</h4>' +
        '<p>You don\'t need to type the full name — <code>gm</code> matches <code>gmail</code>, <code>gi</code> matches <code>github</code>.</p>' +
        '</div>'
    },
    'shortcuts': {
      keywords: ['shortcut', 'create shortcut', 'add shortcut', 'make shortcut', 'save shortcut', 'new shortcut', 'manage shortcut'],
      title: 'Managing Shortcuts',
      body: '<div class="chat-help-section">' +
        '<p>Shortcuts are the names you assign to bookmarks for quick access.</p>' +
        '<h4>Creating shortcuts</h4>' +
        '<p>Open the 0tab AI popup on any page, give it a name, and click Save.</p>' +
        '<h4>Editing & Deleting</h4>' +
        '<p>Go to the Dashboard (Ctrl+Shift+0), click the Shortcuts tab, and use the edit/delete buttons on any shortcut.</p>' +
        '<h4>Folder shortcuts</h4>' +
        '<p>Save an entire bookmark folder as a shortcut. Using it opens all URLs in the folder at once.</p>' +
        '</div>'
    },
    'tags': {
      keywords: ['tag', 'label', 'categorize', 'organize', 'category', 'tagging'],
      title: 'Tags & Organization',
      body: '<div class="chat-help-section">' +
        '<p>Tags help you categorize and find bookmarks quickly.</p>' +
        '<h4>Auto-tagging</h4>' +
        '<p>0tab AI automatically generates tags based on the page title and URL domain.</p>' +
        '<h4>AI tags</h4>' +
        '<p>If Chrome\'s built-in AI is available, 0tab AI can generate smarter context-aware tags.</p>' +
        '<h4>Filtering by tags</h4>' +
        '<p>In the Shortcuts tab, click any tag pill to filter shortcuts by that tag.</p>' +
        '</div>'
    },
    'dashboard': {
      keywords: ['dashboard', 'manage page', 'settings', 'statistics', 'stats', 'options'],
      title: 'The Dashboard',
      body: '<div class="chat-help-section">' +
        '<p>The Dashboard is your control center. Open it with <code>Ctrl+Shift+0</code> (or <code>Cmd+Shift+0</code> on Mac).</p>' +
        '<h4>Sections</h4>' +
        '<p><strong>Bookmarks</strong> — Browse folders, manage individual bookmarks</p>' +
        '<p><strong>Shortcuts</strong> — View, edit, delete, and filter all shortcuts</p>' +
        '<p><strong>Statistics</strong> — Usage charts, most opened, dead bookmarks, tags cloud</p>' +
        '<p><strong>Settings</strong> — Sync toggle, theme, AI features, import/export</p>' +
        '</div>'
    },
    'sync': {
      keywords: ['sync', 'synchronize', 'bookmark sync', 'chrome bookmarks', 'import', 'export', 'csv'],
      title: 'Bookmark Sync',
      body: '<div class="chat-help-section">' +
        '<p>0tab AI bi-directionally syncs with Chrome\'s bookmark bar.</p>' +
        '<h4>How sync works</h4>' +
        '<p>When enabled, adding a bookmark in Chrome creates a 0tab AI shortcut (and vice versa). Changes propagate both ways.</p>' +
        '<h4>Import / Export</h4>' +
        '<p>Go to Settings in the Dashboard to export all shortcuts as CSV, or import from a CSV file.</p>' +
        '</div>'
    },
    'keyboard': {
      keywords: ['keyboard shortcut', 'hotkey', 'keybind', 'ctrl', 'cmd', 'key combination'],
      title: 'Keyboard Shortcuts',
      body: '<div class="chat-help-section">' +
        '<p><code>Ctrl+Shift+0</code> / <code>Cmd+Shift+0</code> — Open the Dashboard</p>' +
        '<p><code>0</code> + <code>Tab</code> in address bar — Activate 0tab omnibox</p>' +
        '<p>Right-click any page — "Save to 0tab AI" context menu option</p>' +
        '</div>'
    },
    'ai-features': {
      keywords: ['ai', 'artificial intelligence', 'gemini', 'smart', 'ai feature', 'auto tag', 'ai search', 'duplicate detection', 'ai description'],
      title: 'AI Features',
      body: '<div class="chat-help-section">' +
        '<p>0tab AI optionally uses Chrome\'s built-in AI (Gemini Nano) for smart features:</p>' +
        '<h4>Smart Auto-Tagging</h4>' +
        '<p>AI analyzes page content to suggest accurate, context-aware tags.</p>' +
        '<h4>Natural Language Search</h4>' +
        '<p>When regular search finds nothing, AI tries to match your intent semantically.</p>' +
        '<h4>Duplicate Detection</h4>' +
        '<p>Before saving, AI checks if a similar bookmark already exists.</p>' +
        '<h4>Auto Descriptions</h4>' +
        '<p>AI generates a one-line summary for each bookmark after saving.</p>' +
        '<p>Enable in Settings → AI Features. Requires Chrome 128+ with Gemini Nano.</p>' +
        '</div>'
    }
  };

  function findHelpTopic(query) {
    let q = query.toLowerCase();
    let best = null;
    let bestScore = 0;
    Object.keys(HELP_TOPICS).forEach(function (key) {
      let topic = HELP_TOPICS[key];
      let score = 0;
      topic.keywords.forEach(function (kw) {
        if (q.includes(kw)) {
          score += kw.split(' ').length; // multi-word matches score higher
        }
      });
      if (score > bestScore) {
        bestScore = score;
        best = topic;
      }
    });
    return bestScore > 0 ? best : null;
  }

  // ============================================================
  // INTENT PARSER
  // ============================================================
  function parseIntent(query) {
    let q = query.toLowerCase().trim();

    // --- GREETINGS & CONVERSATIONAL (multi-lingual) ---
    // English, Hindi, Spanish, French, German, Portuguese, Arabic, Japanese, Korean, Chinese, Tamil, Telugu, Kannada, Bengali
    if (/^(hey|hi|hello|yo|sup|hola|howdy|what'?s?\s*up|good\s*(morning|evening|afternoon)|namaste|namaskar|namaskaram|vanakkam|bonjour|salut|hallo|ola|olá|konnichiwa|annyeong|ni\s*hao|marhaba|ahlan|assalamu\s*alaikum|kaise\s*ho|kya\s*hal\s*hai|kemcho)[\s!?.]*$/i.test(q)) return { intent: 'greeting' };
    if (/^(thanks|thank\s*you|thx|ty|cheers|cool|great|nice|awesome|ok|okay|got it|sure|perfect|wonderful|that'?s?\s+great|shukriya|dhanyavaad|dhanyawad|gracias|merci|danke|obrigado|arigato|kamsahamnida|xie\s*xie|shukran|nandri|dhanyavadagalu)[\s!?.]*$/i.test(q)) return { intent: 'thanks' };
    if (/^(huh|hmm|idk|nothing|nah|nope|kuch\s*nahi|nahi|kya)[\s!?.]*$/i.test(q)) return { intent: 'confused' };
    if (/(?:who|what)\s+(?:all\s+)?(?:are|r)\s+(?:you|u)/i.test(q) ||
        /what\s+(?:all\s+)?(?:can|could|do)\s+(?:you|u)\s+do/i.test(q) ||
        /what\s+(?:else\s+)?(?:can|could)\s+(?:you|u)\s+(?:do|help)/i.test(q) ||
        /(?:your|ur)\s+(?:capabilities|features|abilities|powers|skills)/i.test(q) ||
        /(?:help|assist)\s+me\s+with\s+what/i.test(q) ||
        /what\s+(?:all\s+)?(?:do\s+you|can\s+you|are\s+you\s+able)/i.test(q) ||
        /(?:tell\s+me\s+about\s+(?:yourself|you)|introduce\s+yourself)/i.test(q) ||
        /(?:what|anything)\s+else\s+(?:can\s+you|do\s+you|you\s+can)/i.test(q) ||
        /(?:can\s+you\s+do\s+(?:anything|something)\s+else)/i.test(q) ||
        /(?:show|list|tell)\s+(?:me\s+)?(?:all\s+)?(?:your\s+)?(?:features|options|commands|capabilities)/i.test(q) ||
        q === 'help' || q === '?' || q === 'menu' || q === 'options') {
      return { intent: 'who_are_you' };
    }

    // --- INTERNAL COMMANDS (from option pill clicks) ---
    if (q.startsWith('__open_folder_all__')) {
      return { intent: 'action:open_folder_all', folderId: q.replace('__open_folder_all__', '') };
    }
    if (q.startsWith('__open_url__')) {
      return { intent: 'action:open_url', url: q.replace('__open_url__', '') };
    }

    // --- UNDO (conversation memory) ---
    if (/^(undo|undo\s+(?:that|it|this|last)|revert|take\s+(?:that|it)\s+back|unsend|wapas\s+karo)[\s!.?]*$/i.test(q)) {
      return { intent: 'action:undo' };
    }

    // --- MULTI-LINGUAL INTENT SHORTCUTS ---
    // Hindi / Hinglish common queries
    if (/(?:mera|mere|meri)\s+(?:sab|saare|sabhi|all)\s+(?:bookmark|shortcut)/i.test(q) ||
        /(?:sabhi|sab|saare)\s+(?:bookmark|shortcut)\s+(?:dikhao|batao|dikha)/i.test(q) ||
        /(?:bookmark|shortcut)\s+(?:dikhao|batao|dikha|list\s+karo)/i.test(q)) {
      return { intent: 'query:list_all', listType: 'all' };
    }
    if (/(?:kitne|kitni|total)\s+(?:bookmark|shortcut)/i.test(q) ||
        /(?:bookmark|shortcut)\s+(?:kitne|kitni)\s+(?:hain|hai|h)/i.test(q)) {
      return { intent: 'query:count' };
    }
    if (/(?:bookmark|shortcut|link)\s+(?:save|add)\s+(?:karo|kardo|kar\s*do|krdo)/i.test(q) ||
        /(?:save|add)\s+(?:karo|kardo|kar\s*do|krdo)\s+(?:ye|yeh|ek|this)/i.test(q) ||
        /(?:naya|nyi|new)\s+(?:bookmark|shortcut)\s+(?:banao|bnao|add\s+karo)/i.test(q)) {
      return { intent: 'action:save_bookmark', url: null };
    }
    // Hindi open: verb-first ("kholo dot") AND target-first ("dot kholo")
    if (/(?:kholdo|kholo|khol\s*do|open\s+karo|open\s+kardo)\s+(.+)/i.test(q)) {
      let hindiTarget = q.match(/(?:kholdo|kholo|khol\s*do|open\s+karo|open\s+kardo)\s+(.+)/i);
      return { intent: 'action:open', target: hindiTarget ? hindiTarget[1].trim() : '' };
    }
    if (/(.+)\s+(?:kholdo|kholo|khol\s*do|open\s+karo|open\s+kardo)[\s!?.]*$/i.test(q)) {
      let hindiTarget = q.match(/(.+)\s+(?:kholdo|kholo|khol\s*do|open\s+karo|open\s+kardo)/i);
      return { intent: 'action:open', target: hindiTarget ? hindiTarget[1].trim() : '' };
    }
    // Hindi delete: verb-first AND target-first ("gmail hatao", "hatao gmail")
    if (/(?:hatao|delete\s+karo|delete\s+kardo|mitao|hata\s+do)\s+(.+)/i.test(q)) {
      let hindiDelete = q.match(/(?:hatao|delete\s+karo|delete\s+kardo|mitao|hata\s+do)\s+(.+)/i);
      return { intent: 'action:delete_shortcut', shortcutName: hindiDelete ? hindiDelete[1].trim() : null };
    }
    if (/(.+)\s+(?:hatao|delete\s+karo|delete\s+kardo|mitao|hata\s+do)[\s!?.]*$/i.test(q)) {
      let hindiDelete = q.match(/(.+)\s+(?:hatao|delete\s+karo|delete\s+kardo|mitao|hata\s+do)/i);
      return { intent: 'action:delete_shortcut', shortcutName: hindiDelete ? hindiDelete[1].trim() : null };
    }
    // Hindi save: target-first ("bookmark save karo")
    if (/(.+)\s+(?:save\s+karo|save\s+kardo|add\s+karo|add\s+kardo)[\s!?.]*$/i.test(q)) {
      return { intent: 'action:save_bookmark', url: null };
    }
    // Hindi list: target-first ("bookmark dikhao", "sab dikhao")
    if (/(.+)\s+(?:dikhao|dikha\s+do|batao|bata\s+do|list\s+karo)[\s!?.]*$/i.test(q)) {
      return { intent: 'query:list_all', listType: 'all' };
    }
    if (/(?:madad|help|sahayata|sahayta)\s*(?:karo|kardo|chahiye|do)?[\s!?.]*$/i.test(q)) {
      return { intent: 'who_are_you' };
    }
    // Spanish intents
    if (/(?:abre|abrir)\s+(.+)/i.test(q)) {
      let esTarget = q.match(/(?:abre|abrir)\s+(.+)/i);
      return { intent: 'action:open', target: esTarget ? esTarget[1].trim() : '' };
    }
    if (/(?:muestra|mostrar|lista|listar)\s+(?:todos?\s+)?(?:mis\s+)?(?:marcadores?|favoritos?|atajos?)/i.test(q)) {
      return { intent: 'query:list_all', listType: 'all' };
    }
    if (/(?:cuántos|cuantos)\s+(?:marcadores?|favoritos?|atajos?)/i.test(q)) {
      return { intent: 'query:count' };
    }
    if (/(?:guardar|salvar)\s+(?:un\s+)?(?:marcador|favorito|atajo)/i.test(q)) {
      return { intent: 'action:save_bookmark', url: null };
    }
    if (/(?:eliminar|borrar|quitar)\s+(.+)/i.test(q)) {
      let esDelete = q.match(/(?:eliminar|borrar|quitar)\s+(.+)/i);
      return { intent: 'action:delete_shortcut', shortcutName: esDelete ? esDelete[1].trim() : null };
    }
    // French intents
    if (/(?:ouvre|ouvrir)\s+(.+)/i.test(q)) {
      let frTarget = q.match(/(?:ouvre|ouvrir)\s+(.+)/i);
      return { intent: 'action:open', target: frTarget ? frTarget[1].trim() : '' };
    }
    if (/(?:montre|montrer|affiche|afficher|liste)\s+(?:tous?\s+)?(?:mes\s+)?(?:signets?|favoris?|raccourcis?)/i.test(q)) {
      return { intent: 'query:list_all', listType: 'all' };
    }
    if (/(?:combien)\s+(?:de\s+)?(?:signets?|favoris?|raccourcis?)/i.test(q)) {
      return { intent: 'query:count' };
    }
    // German intents
    if (/(?:öffne|öffnen)\s+(.+)/i.test(q)) {
      let deTarget = q.match(/(?:öffne|öffnen)\s+(.+)/i);
      return { intent: 'action:open', target: deTarget ? deTarget[1].trim() : '' };
    }
    if (/(?:zeige?|zeigen|liste)\s+(?:alle\s+)?(?:meine\s+)?(?:lesezeichen|favoriten|shortcuts)/i.test(q)) {
      return { intent: 'query:list_all', listType: 'all' };
    }

    // --- COPILOT WORKFLOW INTENTS ---
    if (/(?:clean\s*up|cleanup|clear\s+out|remove)\s+(?:my\s+)?(?:unused|dead|old|stale)\s*(?:bookmark|shortcut|link)?/i.test(q) ||
        /(?:unused|dead|stale|never\s+opened)\s+(?:bookmark|shortcut|link)s?\s*(?:clean|remove|delete)?/i.test(q)) {
      return { intent: 'workflow:cleanup' };
    }
    if (/(?:organi[sz]e|sort|arrange|categori[sz]e|tidy)\s+(?:my\s+|the\s+|all\s+)?(?:bookmark|shortcut|link)/i.test(q) ||
        /(?:put|move)\s+(?:my\s+)?(?:bookmark|shortcut|link)s?\s+(?:in|into)\s+folder/i.test(q) ||
        /(?:let'?s?\s+|help\s+(?:me\s+)?)?organi[sz]e\s*(?:them|everything)?[\s!.]*$/i.test(q) ||
        /(?:let us|let'?s)\s+organi[sz]e/i.test(q)) {
      return { intent: 'workflow:organize' };
    }
    if (/(?:bulk|mass)\s+tag/i.test(q) ||
        /tag\s+(?:all\s+)?(?:my\s+)?(?:untagged|all)\s*(?:bookmark|shortcut|link)?/i.test(q)) {
      return { intent: 'workflow:bulk_tag' };
    }
    if (/(?:rename|change\s+name|update\s+name)\s+(?:the\s+)?(?:shortcut|bookmark)\s+(.+)/i.test(q)) {
      let renameMatch = q.match(/(?:rename|change\s+name|update\s+name)\s+(?:the\s+)?(?:shortcut|bookmark)\s+(.+)/i);
      return { intent: 'action:rename', target: renameMatch ? renameMatch[1].trim() : '' };
    }

    // Move/group bookmarks by domain into a folder
    // "move all zoho bookmarks to Zoho folder", "add zoho links to a Zoho folder",
    // "group all google bookmarks into Google", "which are of zoho add them to zoho folder"
    var moveByDomainMatch = q.match(/(?:move|add|put|group|collect|gather)\s+(?:all\s+)?(?:the\s+)?(?:my\s+)?([\w.-]+)\s+(?:bookmark|shortcut|link|site|page|url)s?\s+(?:to|into|in)\s+(?:a\s+|the\s+)?(?:folder\s+)?(?:called\s+|named\s+)?[\"']?(.+?)[\"']?\s*(?:folder)?$/i);
    if (moveByDomainMatch) {
      return { intent: 'action:move_by_domain', domain: moveByDomainMatch[1].trim(), folderName: moveByDomainMatch[2].trim() };
    }
    // "which are of zoho add them in a zoho folder", "all zoho ones into zoho folder"
    var whichOfMatch = q.match(/(?:which\s+(?:are|ones?)\s+(?:of|from)\s+|all\s+)([\w.-]+)\s+(?:.*?)(?:add|move|put|group)\s+(?:them\s+)?(?:to|into|in)\s+(?:a\s+|the\s+|one\s+)?(?:folder\s+)?(?:called\s+|named\s+)?[\"']?(.+?)[\"']?\s*(?:folder)?$/i);
    if (whichOfMatch) {
      return { intent: 'action:move_by_domain', domain: whichOfMatch[1].trim(), folderName: whichOfMatch[2].trim() };
    }
    // "zoho bookmarks to one folder", "put google links in google folder"
    var domainToFolderMatch = q.match(/^([\w.-]+)\s+(?:bookmark|shortcut|link|site|page|url)s?\s+(?:to|into|in)\s+(?:a\s+|the\s+|one\s+)?(?:folder|group)\s*(?:called\s+|named\s+)?[\"']?(.+?)[\"']?$/i);
    if (domainToFolderMatch) {
      return { intent: 'action:move_by_domain', domain: domainToFolderMatch[1].trim(), folderName: domainToFolderMatch[2].trim() };
    }

    // Move shortcuts with a specific tag to a folder
    // "move work tagged shortcuts to Work folder", "put all dev-tagged bookmarks in Development"
    var moveByTagMatch = q.match(/(?:move|add|put|group)\s+(?:all\s+)?(?:the\s+)?(?:my\s+)?(?:bookmark|shortcut|link)s?\s+(?:tagged|with\s+tag|labelled|labeled)\s+[\"']?([\w-]+)[\"']?\s+(?:to|into|in)\s+(?:a\s+|the\s+)?(?:folder\s+)?(?:called\s+|named\s+)?[\"']?(.+?)[\"']?\s*(?:folder)?$/i);
    if (moveByTagMatch) {
      return { intent: 'action:move_by_tag', tag: moveByTagMatch[1].trim(), folderName: moveByTagMatch[2].trim() };
    }
    // "#work to Work folder", "tag work into work folder"
    var tagToFolderMatch = q.match(/(?:#|tag\s+)([\w-]+)\s+(?:bookmark|shortcut|link)s?\s+(?:to|into|in)\s+(?:a\s+|the\s+)?(?:folder\s+)?[\"']?(.+?)[\"']?\s*(?:folder)?$/i);
    if (tagToFolderMatch) {
      return { intent: 'action:move_by_tag', tag: tagToFolderMatch[1].trim(), folderName: tagToFolderMatch[2].trim() };
    }

    // Delete/remove a folder
    // "delete folder Jadu", "remove the AI folder", "delete folder called old stuff"
    if (/(?:delete|remove|drop)\s+(?:the\s+)?(?:bookmark\s+)?folder\s+(?:called\s+|named\s+)?[\"']?(.+?)[\"']?\s*$/i.test(q)) {
      let folderMatch = q.match(/(?:delete|remove|drop)\s+(?:the\s+)?(?:bookmark\s+)?folder\s+(?:called\s+|named\s+)?[\"']?(.+?)[\"']?\s*$/i);
      return { intent: 'action:delete_folder', folderName: folderMatch ? folderMatch[1].trim() : null };
    }
    // "folder Jadu delete karo", "Jadu folder hatao" (Hindi reverse)
    if (/(.+)\s+folder\s+(?:hatao|delete\s+karo|delete\s+kardo|mitao|hata\s+do)[\s!?.]*$/i.test(q)) {
      let folderMatch = q.match(/(.+)\s+folder\s+(?:hatao|delete\s+karo|delete\s+kardo|mitao|hata\s+do)/i);
      return { intent: 'action:delete_folder', folderName: folderMatch ? folderMatch[1].trim() : null };
    }

    // --- ACTIONS ---
    // Save bookmark / create shortcut
    if (/(?:save|add|bookmark|create|make|new)\s+(?:this\s+|a\s+|the\s+|me\s+a\s+)?(?:link|bookmark|url|page|site|shortcut)/i.test(q) ||
        /(?:save|add|bookmark)\s+(?:https?:\/\/)/i.test(q) ||
        /save\s+(?:this|it)\s+(?:as|to)\s+(?:a\s+)?(?:bookmark|shortcut)/i.test(q) ||
        /(?:can you|could you|please|i want to|i'd like to|let me|help me)?\s*(?:save|add|create|make)\s+(?:a\s+)?(?:new\s+)?(?:bookmark|shortcut)/i.test(q) ||
        q === 'new shortcut' || q === 'new bookmark' || q === 'add bookmark' || q === 'add shortcut' || q === 'create shortcut' || q === 'save bookmark') {
      let urlMatch = q.match(/https?:\/\/\S+/);
      return { intent: 'action:save_bookmark', url: urlMatch ? urlMatch[0] : null };
    }
    // Create folder
    if (/^(create|add|make|new)\s+(a\s+)?(new\s+)?(bookmark\s+)?folder/i.test(q)) {
      let nameMatch = query.match(/(?:called|named|\")\s*(.+?)(?:\"|$)/i);
      return { intent: 'action:create_folder', folderName: nameMatch ? nameMatch[1].trim() : null };
    }
    // Delete shortcut
    if (/^(delete|remove|drop)\s+(the\s+)?(shortcut|bookmark)\s+/i.test(q)) {
      let nameMatch = query.match(/(?:shortcut|bookmark)\s+(?:called\s+|named\s+|\")?(.+?)(?:\"|$)/i);
      return { intent: 'action:delete_shortcut', shortcutName: nameMatch ? nameMatch[1].trim() : null };
    }
    // Open a shortcut
    if (/^(open|go to|navigate to|launch)\s+/i.test(q)) {
      let target = q.replace(/^(open|go to|navigate to|launch)\s+(the\s+)?(shortcut\s+|bookmark\s+)?/i, '').trim();
      return { intent: 'action:open', target: target };
    }
    // Toggle AI features
    if (/(?:enable|disable|turn\s+on|turn\s+off|toggle)\s+(?:the\s+)?(?:ai|artificial|gemini|smart)/i.test(q)) {
      let enable = /(?:enable|turn\s+on)/i.test(q);
      return { intent: 'action:toggle_ai', enable: enable };
    }
    // Toggle bookmark sync
    if (/(?:enable|disable|turn\s+on|turn\s+off|toggle)\s+(?:the\s+)?(?:bookmark\s+)?sync/i.test(q)) {
      let enable = /(?:enable|turn\s+on)/i.test(q);
      return { intent: 'action:toggle_sync', enable: enable };
    }
    // Export shortcuts
    if (/(?:export|download|backup)\s+(?:my\s+)?(?:all\s+)?(?:shortcut|bookmark|data)/i.test(q)) {
      return { intent: 'action:export' };
    }
    // Navigate to dashboard sections
    if (/(?:go\s+to|show|open|take\s+me\s+to)\s+(?:the\s+)?(?:setting|preference|config)/i.test(q) ||
        /(?:change|update|edit)\s+(?:my\s+)?(?:setting|preference)/i.test(q)) {
      return { intent: 'action:navigate', section: 'settings' };
    }
    if (/(?:go\s+to|show|open|take\s+me\s+to)\s+(?:the\s+)?(?:shortcut|home)\s*(?:page|section|tab|view)?\s*$/i.test(q)) {
      return { intent: 'action:navigate', section: 'shortcuts' };
    }
    if (/(?:go\s+to|show|open|take\s+me\s+to)\s+(?:the\s+)?(?:bookmarks?)\s*(?:page|section|tab|view)?\s*$/i.test(q)) {
      return { intent: 'action:navigate', section: 'bookmarks' };
    }
    // Show trash / deleted items
    if (/(?:show|view|open|list)\s+(?:my\s+)?(?:trash|deleted|removed|bin)/i.test(q) ||
        /(?:trash|recycle|bin|deleted\s+items?)/i.test(q) ||
        /(?:undo|restore|recover)\s+(?:my\s+)?(?:delete|last|bookmark|shortcut)/i.test(q)) {
      return { intent: 'query:trash' };
    }
    // Find duplicates
    if (/(?:find|show|check|detect)\s+(?:my\s+)?(?:duplicate|dupe)/i.test(q) ||
        /duplicate\s+(?:bookmark|shortcut|link)/i.test(q)) {
      return { intent: 'query:duplicates' };
    }
    // List folders
    if (/(?:list|show|what|view)\s+(?:are\s+)?(?:my\s+)?(?:all\s+)?(?:bookmark\s+)?folder/i.test(q) ||
        /^(?:my\s+)?folders?$/i.test(q)) {
      return { intent: 'query:folders' };
    }

    // --- DATA QUERIES ---
    // List all bookmarks / shortcuts
    if (/^(?:list|show|display|get|view|see)\s+(?:all\s+)?(?:my\s+)?(?:all\s+)?(?:saved\s+)?(?:bookmark|shortcut|link|saved)s?$/i.test(q) ||
        /^(?:list|show|display|view|see)\s+(?:my\s+)?(?:every|the)\s+(?:saved\s+)?(?:bookmark|shortcut|link)s?$/i.test(q) ||
        /^(?:all|my)\s+(?:saved\s+)?(?:bookmark|shortcut|link|saved)s?$/i.test(q) ||
        /^what\s+(?:are\s+)?(?:all\s+)?(?:my\s+)?(?:saved\s+)?(?:bookmark|shortcut|link|saved)s?\??$/i.test(q) ||
        /^(?:show|list|give)\s+(?:me\s+)?(?:all\s+)?(?:my\s+)?(?:all\s+)?(?:saved\s+)?(?:bookmark|shortcut|link|saved)s?$/i.test(q) ||
        /^(?:show|list|give)\s+(?:me\s+)?(?:everything|all)\s+(?:i'?v?e?\s+)?(?:saved|bookmarked)$/i.test(q)) {
      let type = /shortcut/i.test(q) ? 'shortcuts' : /bookmark/i.test(q) ? 'bookmarks' : 'all';
      return { intent: 'query:list_all', listType: type };
    }
    // Count queries
    if (/how many\s+(bookmark|shortcut|link|folder|tag)/i.test(q) ||
        /total\s+(bookmark|shortcut|link|folder)/i.test(q) ||
        /count\s+(my\s+)?(bookmark|shortcut|folder)/i.test(q) ||
        q === 'stats' || q === 'statistics' || q === 'overview' || q === 'summary') {
      return { intent: 'query:count' };
    }
    // Most used / top shortcuts
    if (/most\s+(used|opened|visited|accessed|popular)/i.test(q) ||
        /top\s+(\d+\s+)?(shortcut|bookmark)/i.test(q) ||
        /frequently\s+(used|opened)/i.test(q)) {
      let numMatch = q.match(/top\s+(\d+)/);
      return { intent: 'query:most_used', limit: numMatch ? parseInt(numMatch[1]) : 5 };
    }
    // Least used / dead bookmarks
    if (/least\s+(used|opened|visited|accessed)/i.test(q) ||
        /dead\s+bookmark/i.test(q) ||
        /never\s+(used|opened|accessed)/i.test(q) ||
        /unused\s+(bookmark|shortcut)/i.test(q)) {
      return { intent: 'query:least_used' };
    }
    // Recently added
    if (/recent(ly)?\s+(added|created|saved|new)/i.test(q) ||
        /newest\s+(bookmark|shortcut)/i.test(q) ||
        /latest\s+(bookmark|shortcut)/i.test(q) ||
        /last\s+(\d+\s+)?(added|created|saved)/i.test(q)) {
      return { intent: 'query:recent' };
    }
    // Recently accessed
    if (/recent(ly)?\s+(used|opened|accessed|visited)/i.test(q) ||
        /last\s+(opened|used|visited)/i.test(q)) {
      return { intent: 'query:recently_accessed' };
    }
    // Show tags
    if (/show\s+(my\s+|all\s+)?tags/i.test(q) ||
        /list\s+(all\s+)?tags/i.test(q) ||
        /what\s+tags/i.test(q) ||
        q === 'tags') {
      return { intent: 'query:tags' };
    }
    // Filter by tag
    if (/tag(ged)?\s+(with\s+|as\s+)?[\"']?(\w+)/i.test(q) ||
        /with\s+tag\s+[\"']?(\w+)/i.test(q) ||
        /show\s+(\w+)\s+tag/i.test(q)) {
      let tagMatch = q.match(/(?:tagged?\s+(?:with\s+|as\s+)?|with\s+tag\s+|show\s+)[\"\']?(\w+)[\"\']?/i);
      return { intent: 'query:by_tag', tag: tagMatch ? tagMatch[1] : '' };
    }
    // Search by domain
    if (/(?:zoho|google|github|youtube|slack|figma|twitter|linkedin|reddit|amazon|netflix|facebook|instagram|stackoverflow)\s*(bookmark|shortcut|link|site)?s?$/i.test(q) ||
        /(?:bookmark|shortcut|link|site)s?\s+(?:from|on|at)\s+(\w+)/i.test(q) ||
        /(?:from|on)\s+([\w.]+\.(?:com|org|net|io|dev|co|ai))/i.test(q) ||
        /which\s+(?:ones?|bookmark|shortcut)s?\s+(?:are|is)\s+(?:from\s+)?(\w+)/i.test(q)) {
      // Extract domain keyword
      let domainMatch = q.match(/(zoho|google|github|youtube|slack|figma|twitter|linkedin|reddit|amazon|netflix|facebook|instagram|stackoverflow)/i);
      if (!domainMatch) domainMatch = q.match(/(?:from|on|at)\s+([\w.]+)/i);
      if (!domainMatch) domainMatch = q.match(/which\s+(?:ones?|bookmark|shortcut)s?\s+(?:are|is)\s+(?:from\s+)?(\w+)/i);
      return { intent: 'query:by_domain', domain: domainMatch ? domainMatch[1] : '' };
    }
    // Folder contents
    if (/(?:what'?s?\s+in|show|list|contents?\s+of)\s+(?:the\s+)?(?:folder\s+)?[\"']?(.+?)[\"']?\s*(?:folder)?$/i.test(q) &&
        /folder/i.test(q)) {
      let folderMatch = q.match(/(?:what'?s?\s+in|show|list|contents?\s+of)\s+(?:the\s+)?(?:folder\s+)?[\"']?(.+?)[\"']?\s*(?:folder)?$/i);
      return { intent: 'query:folder_contents', folderName: folderMatch ? folderMatch[1].replace(/\s*folder\s*/gi, '').trim() : '' };
    }
    // Usage in time period
    if (/(?:last|past|this)\s+(week|month|day|year)/i.test(q) &&
        /(?:usage|opens?|accessed|visited|activity|used)/i.test(q)) {
      let periodMatch = q.match(/(week|month|day|year)/i);
      return { intent: 'query:usage_period', period: periodMatch ? periodMatch[1] : 'month' };
    }
    // Generic search for bookmarks
    if (/^(?:find|search|look\s?up|where\s+is)\s+/i.test(q)) {
      let searchTerm = q.replace(/^(?:find|search|look\s?up|where\s+is)\s+(for\s+|the\s+|my\s+|a\s+)*/i, '').trim();
      return { intent: 'query:search', term: searchTerm };
    }

    // --- HELP ---
    let helpTopic = findHelpTopic(q);
    if (helpTopic) return { intent: 'help', topic: helpTopic };

    // --- SMART FALLBACK ---
    // Single words that could be shortcut names — try to open them
    if (q.split(/\s+/).length === 1 && q.length >= 2 && /^[a-z0-9]+$/i.test(q)) {
      return { intent: 'query:smart_single', term: q };
    }
    // Short vague messages (2 words) that don't match any known keyword
    if (q.split(/\s+/).length <= 2 && !/bookmark|shortcut|tag|folder|open|url|link|save|export|import|setting|ai|sync|help|duplicate/i.test(q)) {
      return { intent: 'unknown', term: q };
    }
    // Longer queries → try as search first, AI will handle the rest if it fails
    return { intent: 'query:search', term: q };
  }

  // ============================================================
  // RESPONSE HANDLERS
  // ============================================================
  async function handleQueryCount() {
    let shortcuts = await getAllShortcuts();
    let tree = await getBookmarkTree();
    let counts = countBookmarks(tree);
    let folders = flattenFolders(tree);

    let totalUses = 0;
    let usedCount = 0;
    let tagSet = {};
    shortcuts.forEach(function (s) {
      totalUses += s.count;
      if (s.count > 0) usedCount++;
      s.tags.forEach(function (t) { tagSet[t] = (tagSet[t] || 0) + 1; });
    });

    let openRate = shortcuts.length > 0 ? Math.round((usedCount / shortcuts.length) * 100) : 0;

    let html = '<div style="margin-bottom:8px;">Here\'s your overview:</div>';
    html += '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
    html += '<span class="chat-stat-card"><span class="chat-stat-value">' + counts.bookmarks + '</span> bookmarks</span>';
    html += '<span class="chat-stat-card"><span class="chat-stat-value">' + shortcuts.length + '</span> shortcuts</span>';
    html += '<span class="chat-stat-card"><span class="chat-stat-value">' + folders.length + '</span> folders</span>';
    html += '<span class="chat-stat-card"><span class="chat-stat-value">' + Object.keys(tagSet).length + '</span> tags</span>';
    html += '<span class="chat-stat-card"><span class="chat-stat-value">' + totalUses + '</span> total opens</span>';
    html += '<span class="chat-stat-card"><span class="chat-stat-value">' + openRate + '%</span> open rate</span>';
    html += '</div>';
    return html;
  }

  async function handleQueryMostUsed(limit) {
    let shortcuts = await getAllShortcuts();
    let sorted = shortcuts.filter(function (s) { return s.count > 0; }).sort(function (a, b) { return b.count - a.count; }).slice(0, limit || 5);
    if (sorted.length === 0) return 'You haven\'t used any shortcuts yet. Start by typing <code>0</code> + <code>Tab</code> in your Chrome search bar!';
    let html = '<div style="margin-bottom:6px;">Your top ' + sorted.length + ' most used:</div>';
    sorted.forEach(function (s) {
      let fav = chatGetFavicon(s.url);
      html += '<div class="chat-list-item"><img src="' + fav + '"><span class="chat-list-name">' + chatEscapeHtml(s.name) + '</span><span class="chat-list-meta">' + s.count + ' opens</span></div>';
    });
    return html;
  }

  async function handleQueryLeastUsed() {
    let shortcuts = await getAllShortcuts();
    let dead = shortcuts.filter(function (s) { return s.count === 0 && s.type !== 'folder'; }).slice(0, 10);
    if (dead.length === 0) return 'Great news — all your bookmarks have been used at least once!';
    let html = '<div style="margin-bottom:6px;">You have <strong>' + dead.length + '</strong> unused bookmark' + (dead.length > 1 ? 's' : '') + ':</div>';
    dead.forEach(function (s) {
      let fav = chatGetFavicon(s.url);
      html += '<div class="chat-list-item"><img src="' + fav + '"><span class="chat-list-name">' + chatEscapeHtml(s.name) + '</span><span class="chat-list-meta">never opened</span></div>';
    });
    return html;
  }

  async function handleQueryRecent() {
    let shortcuts = await getAllShortcuts();
    let sorted = shortcuts.filter(function (s) { return s.createdAt > 0; }).sort(function (a, b) { return b.createdAt - a.createdAt; }).slice(0, 8);
    if (sorted.length === 0) return 'No timestamp data available for your bookmarks yet.';
    let html = '<div style="margin-bottom:6px;">Recently added:</div>';
    sorted.forEach(function (s) {
      let fav = chatGetFavicon(s.url);
      html += '<div class="chat-list-item"><img src="' + fav + '"><span class="chat-list-name">' + chatEscapeHtml(s.name) + '</span><span class="chat-list-meta">' + chatTimeAgo(s.createdAt) + '</span></div>';
    });
    return html;
  }

  async function handleQueryRecentlyAccessed() {
    let shortcuts = await getAllShortcuts();
    let sorted = shortcuts.filter(function (s) { return s.lastAccessed > 0; }).sort(function (a, b) { return b.lastAccessed - a.lastAccessed; }).slice(0, 8);
    if (sorted.length === 0) return 'No usage data yet. Try opening some shortcuts first!';
    let html = '<div style="margin-bottom:6px;">Recently opened:</div>';
    sorted.forEach(function (s) {
      let fav = chatGetFavicon(s.url);
      html += '<div class="chat-list-item"><img src="' + fav + '"><span class="chat-list-name">' + chatEscapeHtml(s.name) + '</span><span class="chat-list-meta">' + chatTimeAgo(s.lastAccessed) + '</span></div>';
    });
    return html;
  }

  async function handleQueryTags() {
    let shortcuts = await getAllShortcuts();
    let tagMap = {};
    shortcuts.forEach(function (s) {
      s.tags.forEach(function (t) { tagMap[t] = (tagMap[t] || 0) + 1; });
    });
    let tags = Object.keys(tagMap).sort(function (a, b) { return tagMap[b] - tagMap[a]; });
    if (tags.length === 0) return 'No tags found yet. Tags are auto-generated when you save bookmarks.';
    let html = '<div style="margin-bottom:6px;">You have <strong>' + tags.length + '</strong> tags:</div><div style="line-height:2;">';
    tags.forEach(function (t) {
      html += '<span class="chat-tag-pill">' + chatEscapeHtml(t) + ' <span class="chat-tag-count">' + tagMap[t] + '</span></span>';
    });
    html += '</div>';
    return html;
  }

  async function handleQueryByTag(tag) {
    let shortcuts = await getAllShortcuts();
    let matches = shortcuts.filter(function (s) {
      return s.tags.some(function (t) { return t.toLowerCase() === tag.toLowerCase(); });
    });
    if (matches.length === 0) return 'No bookmarks found with the tag <strong>' + chatEscapeHtml(tag) + '</strong>. Try <em>show my tags</em> to see available tags.';
    let html = '<div style="margin-bottom:6px;">Found <strong>' + matches.length + '</strong> bookmark' + (matches.length > 1 ? 's' : '') + ' tagged <strong>' + chatEscapeHtml(tag) + '</strong>:</div>';
    matches.slice(0, 15).forEach(function (s) {
      let fav = chatGetFavicon(s.url);
      html += '<div class="chat-list-item"><img src="' + fav + '"><span class="chat-list-name">' + chatEscapeHtml(s.name) + '</span><span class="chat-list-meta">' + s.count + ' opens</span></div>';
    });
    if (matches.length > 15) html += '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">+ ' + (matches.length - 15) + ' more</div>';
    return html;
  }

  async function handleQueryByDomain(domain) {
    let shortcuts = await getAllShortcuts();
    let d = domain.toLowerCase();
    let matches = shortcuts.filter(function (s) {
      return s.url.toLowerCase().includes(d) || s.name.toLowerCase().includes(d) ||
             s.bookmarkTitle.toLowerCase().includes(d);
    });
    if (matches.length === 0) {
      // Also search the full bookmark tree
      let tree = await getBookmarkTree();
      let allBm = flattenBookmarks(tree);
      let bmMatches = allBm.filter(function (b) { return b.url.toLowerCase().includes(d) || b.title.toLowerCase().includes(d); });
      if (bmMatches.length === 0) return 'No bookmarks found matching <strong>' + chatEscapeHtml(domain) + '</strong>.';
      let html = '<div style="margin-bottom:6px;">Found <strong>' + bmMatches.length + '</strong> bookmark' + (bmMatches.length > 1 ? 's' : '') + ' matching <strong>' + chatEscapeHtml(domain) + '</strong> (in Chrome bookmarks):</div>';
      bmMatches.slice(0, 12).forEach(function (b) {
        let fav = chatGetFavicon(b.url);
        html += '<div class="chat-list-item"><img src="' + fav + '"><span class="chat-list-name">' + chatEscapeHtml(b.title || b.url) + '</span></div>';
      });
      if (bmMatches.length > 12) html += '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">+ ' + (bmMatches.length - 12) + ' more</div>';
      return html;
    }
    let html = '<div style="margin-bottom:6px;">Found <strong>' + matches.length + '</strong> shortcut' + (matches.length > 1 ? 's' : '') + ' matching <strong>' + chatEscapeHtml(domain) + '</strong>:</div>';
    matches.slice(0, 12).forEach(function (s) {
      let fav = chatGetFavicon(s.url);
      html += '<div class="chat-list-item"><img src="' + fav + '"><span class="chat-list-name">' + chatEscapeHtml(s.name) + '</span><span class="chat-list-meta">' + s.count + ' opens</span></div>';
    });
    if (matches.length > 12) html += '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">+ ' + (matches.length - 12) + ' more</div>';
    return html;
  }

  async function handleQueryFolderContents(folderName) {
    let tree = await getBookmarkTree();
    let folders = flattenFolders(tree);
    let fn = folderName.toLowerCase();
    let match = folders.find(function (f) { return f.title.toLowerCase() === fn; }) ||
                folders.find(function (f) { return f.title.toLowerCase().includes(fn); });
    if (!match) return 'Could not find a folder matching <strong>' + chatEscapeHtml(folderName) + '</strong>. Your folders are: ' + folders.map(function (f) { return '<strong>' + chatEscapeHtml(f.title) + '</strong>'; }).join(', ') + '.';

    // Get folder subtree
    let subtree = await new Promise(function (resolve) {
      chrome.bookmarks.getSubTree(match.id, function (r) {
        if (chrome.runtime.lastError) resolve([]);
        else resolve(r || []);
      });
    });
    let items = [];
    if (subtree[0] && subtree[0].children) {
      subtree[0].children.forEach(function (c) {
        if (c.url) items.push({ title: c.title, url: c.url, type: 'bookmark' });
        else if (c.children) items.push({ title: c.title, type: 'folder', count: c.children.length });
      });
    }
    if (items.length === 0) return 'The folder <strong>' + chatEscapeHtml(match.title) + '</strong> is empty.';
    let html = '<div style="margin-bottom:6px;"><strong>' + chatEscapeHtml(match.title) + '</strong> contains ' + items.length + ' item' + (items.length > 1 ? 's' : '') + ':</div>';
    items.forEach(function (item) {
      if (item.type === 'folder') {
        html += '<div class="chat-list-item"><span style="font-size:14px;">&#128193;</span><span class="chat-list-name">' + chatEscapeHtml(item.title) + '</span><span class="chat-list-meta">' + item.count + ' items</span></div>';
      } else {
        let fav = chatGetFavicon(item.url);
        html += '<div class="chat-list-item"><img src="' + fav + '"><span class="chat-list-name">' + chatEscapeHtml(item.title) + '</span></div>';
      }
    });
    return html;
  }

  async function handleQueryUsagePeriod(period) {
    let stats = await getDailyStats();
    let days = Object.keys(stats).sort();
    if (days.length === 0) return 'No usage data recorded yet. Start using your shortcuts and I\'ll track it!';

    let now = new Date();
    let cutoff;
    if (period === 'day') cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    else if (period === 'week') cutoff = new Date(now.getTime() - 7 * 86400000);
    else if (period === 'year') cutoff = new Date(now.getTime() - 365 * 86400000);
    else cutoff = new Date(now.getTime() - 30 * 86400000); // month

    let total = 0;
    let activeDays = 0;
    days.forEach(function (d) {
      if (new Date(d) >= cutoff) {
        total += stats[d];
        if (stats[d] > 0) activeDays++;
      }
    });

    let periodLabel = period === 'day' ? 'today' : 'the last ' + (period === 'week' ? '7 days' : period === 'year' ? 'year' : '30 days');
    let html = '<div style="margin-bottom:8px;">Usage in ' + periodLabel + ':</div>';
    html += '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
    html += '<span class="chat-stat-card"><span class="chat-stat-value">' + total + '</span> opens</span>';
    html += '<span class="chat-stat-card"><span class="chat-stat-value">' + activeDays + '</span> active days</span>';
    if (activeDays > 0) html += '<span class="chat-stat-card"><span class="chat-stat-value">' + (total / activeDays).toFixed(1) + '</span> avg/day</span>';
    html += '</div>';
    return html;
  }

  async function handleQueryListAll(listType) {
    let shortcuts = await getAllShortcuts();
    let tree = await getBookmarkTree();
    let allBm = flattenBookmarks(tree);
    let html = '';

    if (listType === 'shortcuts' || listType === 'all') {
      if (shortcuts.length === 0) {
        html += '<div style="margin-bottom:8px;">You don\'t have any shortcuts yet. Try "Create a shortcut" to add one!</div>';
      } else {
        html += '<div style="margin-bottom:6px;"><strong>' + shortcuts.length + ' Shortcut' + (shortcuts.length > 1 ? 's' : '') + ':</strong></div>';
        shortcuts.sort(function (a, b) { return b.count - a.count; });
        // Remember sorted list so user can say "open the second one"
        rememberListResults(shortcuts);
        shortcuts.forEach(function (s) {
          let fav = chatGetFavicon(s.url);
          let tags = s.tags.length > 0 ? ' <span style="font-size:11px;color:var(--text-muted);">' + s.tags.map(function (t) { return '#' + chatEscapeHtml(t); }).join(' ') + '</span>' : '';
          html += '<div class="chat-list-item"><img src="' + fav + '"><span class="chat-list-name">' + chatEscapeHtml(s.name) + '</span><span class="chat-list-meta">' + s.count + ' opens' + tags + '</span></div>';
        });
      }
    }

    if (listType === 'bookmarks' || listType === 'all') {
      // Exclude bookmarks that are already shortcuts to avoid duplication when showing "all"
      let shortcutUrls = {};
      if (listType === 'all') {
        shortcuts.forEach(function (s) { shortcutUrls[s.url] = true; });
      }
      let bookmarks = listType === 'all' ? allBm.filter(function (b) { return !shortcutUrls[b.url]; }) : allBm;

      if (bookmarks.length === 0 && listType === 'bookmarks') {
        html += '<div style="margin-bottom:8px;">You don\'t have any Chrome bookmarks yet.</div>';
      } else if (bookmarks.length > 0) {
        let label = listType === 'all' ? 'Other Chrome Bookmarks' : 'Chrome Bookmarks';
        html += '<div style="margin:' + (listType === 'all' ? '12px' : '0') + ' 0 6px;"><strong>' + bookmarks.length + ' ' + label + ':</strong></div>';
        let showLimit = 50;
        bookmarks.slice(0, showLimit).forEach(function (b) {
          let fav = chatGetFavicon(b.url);
          let folderLabel = b.folder ? ' <span style="font-size:11px;color:var(--text-muted);">' + chatEscapeHtml(b.folder) + '</span>' : '';
          html += '<div class="chat-list-item"><img src="' + fav + '"><span class="chat-list-name">' + chatEscapeHtml(b.title || b.url) + '</span><span class="chat-list-meta">' + folderLabel + '</span></div>';
        });
        if (bookmarks.length > showLimit) {
          html += '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">+ ' + (bookmarks.length - showLimit) + ' more bookmarks. Try filtering by tag, domain, or folder for specific results.</div>';
        }
      }
    }

    if (!html) html = '<div>No bookmarks or shortcuts found. Start saving some!</div>';
    return html;
  }

  async function handleQuerySearch(term) {
    let shortcuts = await getAllShortcuts();
    let t = term.toLowerCase();
    let matches = shortcuts.filter(function (s) {
      return s.name.toLowerCase().includes(t) ||
             s.url.toLowerCase().includes(t) ||
             s.bookmarkTitle.toLowerCase().includes(t) ||
             (s.aiDescription || '').toLowerCase().includes(t) ||
             s.tags.some(function (tag) { return tag.toLowerCase().includes(t); });
    });

    // Also search chrome bookmarks if few matches
    if (matches.length < 3) {
      let tree = await getBookmarkTree();
      let allBm = flattenBookmarks(tree);
      let bmMatches = allBm.filter(function (b) {
        return (b.title.toLowerCase().includes(t) || b.url.toLowerCase().includes(t)) &&
               !matches.some(function (s) { return s.url === b.url; });
      });
      if (bmMatches.length > 0) {
        let html = '';
        if (matches.length > 0) {
          html += '<div style="margin-bottom:6px;">Found <strong>' + matches.length + '</strong> shortcut' + (matches.length > 1 ? 's' : '') + ':</div>';
          matches.forEach(function (s) {
            let fav = chatGetFavicon(s.url);
            html += '<div class="chat-list-item"><img src="' + fav + '"><span class="chat-list-name">' + chatEscapeHtml(s.name) + '</span><span class="chat-list-meta">' + s.count + ' opens</span></div>';
          });
          html += '<div style="margin:8px 0 6px;font-size:12px;color:var(--text-secondary);">Also found in Chrome bookmarks:</div>';
        } else {
          html += '<div style="margin-bottom:6px;">No shortcuts match, but found in Chrome bookmarks:</div>';
        }
        bmMatches.slice(0, 8).forEach(function (b) {
          let fav = chatGetFavicon(b.url);
          html += '<div class="chat-list-item"><img src="' + fav + '"><span class="chat-list-name">' + chatEscapeHtml(b.title || b.url) + '</span></div>';
        });
        return html;
      }
    }

    if (matches.length === 0) {
      // Try AI-powered search if available
      let aiResult = await tryAiSearch(term, shortcuts);
      if (aiResult) return aiResult;
      return await generateContextualFallback(term);
    }

    // Remember matches so user can say "open the second one"
    rememberListResults(matches);
    if (matches.length === 1) rememberShortcut(matches[0]);

    let html = '<div style="margin-bottom:6px;">Found <strong>' + matches.length + '</strong> match' + (matches.length > 1 ? 'es' : '') + ':</div>';
    matches.slice(0, 10).forEach(function (s) {
      let fav = chatGetFavicon(s.url);
      html += '<div class="chat-list-item"><img src="' + fav + '"><span class="chat-list-name">' + chatEscapeHtml(s.name) + '</span><span class="chat-list-meta">' + s.count + ' opens</span></div>';
    });
    if (matches.length > 10) html += '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">+ ' + (matches.length - 10) + ' more</div>';
    return html;
  }

  // ============================================================
  // CO-PILOT ACTION HANDLERS
  // ============================================================

  async function handleToggleAi(enable) {
    try {
      let result = await chatStorageGet('__0tab_settings');
      let settings = result['__0tab_settings'] || {};
      settings.aiEnabled = enable;
      await chatStorageSet({ '__0tab_settings': settings });
      // Update toggle on page if visible
      let toggle = document.getElementById('settingAiFeatures');
      if (toggle) toggle.checked = enable;
      let statusText = document.getElementById('aiStatusText');
      if (statusText) statusText.textContent = enable ? '(Available)' : '(Disabled)';
      return 'AI features have been <strong>' + (enable ? 'enabled' : 'disabled') + '</strong>.' + (enable ? ' 0tab AI will now use Gemini Nano for smarter suggestions.' : '');
    } catch (e) {
      return 'Failed to update AI settings: ' + chatEscapeHtml(e.message);
    }
  }

  async function handleToggleSync(enable) {
    try {
      let result = await chatStorageGet('__0tab_settings');
      let settings = result['__0tab_settings'] || {};
      settings.bookmarkSync = enable;
      await chatStorageSet({ '__0tab_settings': settings });
      let toggle = document.getElementById('settingBookmarkSync');
      if (toggle) toggle.checked = enable;
      return 'Bookmark sync has been <strong>' + (enable ? 'enabled' : 'disabled') + '</strong>.';
    } catch (e) {
      return 'Failed to update sync settings: ' + chatEscapeHtml(e.message);
    }
  }

  function handleNavigate(section) {
    // Map section names to data-view values used in manage.html
    let viewMap = { shortcuts: 'bookmarks', bookmarks: 'bookmarks', settings: 'settings', stats: 'stats', statistics: 'stats' };
    let viewName = viewMap[section] || section;
    let navBtn = document.querySelector('.nav-item[data-view="' + viewName + '"]');
    if (navBtn) {
      navBtn.click();
      // For shortcuts sub-tab within bookmarks view
      if (section === 'shortcuts') {
        setTimeout(function () {
          let subTabBtn = document.querySelector('.tab-btn[data-subtab="bm-shortcuts"]');
          if (subTabBtn) subTabBtn.click();
        }, 100);
      }
      return 'Switched to the <strong>' + chatEscapeHtml(section) + '</strong> section.';
    }
    return 'I couldn\'t find the <strong>' + chatEscapeHtml(section) + '</strong> section. Available sections: bookmarks, shortcuts, statistics, settings.';
  }

  async function handleExport() {
    try {
      let all = await chatStorageGet(null);
      let shortcuts = Object.keys(all).filter(function (k) {
        return k !== '__0tab_folders' && k !== '__0tab_settings' && typeof all[k] === 'object' && all[k].url;
      });
      if (shortcuts.length === 0) return 'No shortcuts to export.';
      let csv = 'Name,URL,Tags,Count,Created\n';
      shortcuts.forEach(function (k) {
        let d = all[k];
        csv += '"' + k + '","' + (d.url || '') + '","' + (d.tags || []).join(';') + '",' + (d.count || 0) + ',' + (d.createdAt ? new Date(d.createdAt).toISOString().split('T')[0] : '') + '\n';
      });
      let blob = new Blob([csv], { type: 'text/csv' });
      let link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'tab0-shortcuts-' + new Date().toISOString().split('T')[0] + '.csv';
      link.click();
      URL.revokeObjectURL(link.href);
      return 'Exported <strong>' + shortcuts.length + '</strong> shortcuts as CSV. Check your downloads!';
    } catch (e) {
      return 'Export failed: ' + chatEscapeHtml(e.message);
    }
  }

  async function handleQueryDuplicates() {
    let shortcuts = await getAllShortcuts();
    let tree = await getBookmarkTree();
    let allBm = flattenBookmarks(tree);

    // --- Duplicate shortcuts: exact same URL in multiple shortcuts ---
    let shortcutUrlMap = {};
    shortcuts.forEach(function (s) {
      if (!s.url) return;
      let norm = s.url.replace(/\/+$/, '').toLowerCase();
      if (!shortcutUrlMap[norm]) shortcutUrlMap[norm] = [];
      shortcutUrlMap[norm].push(s.name);
    });
    let shortcutDupes = Object.keys(shortcutUrlMap).filter(function (u) { return shortcutUrlMap[u].length > 1; });

    // --- Duplicate bookmarks: exact same URL in multiple Chrome bookmarks ---
    let bmUrlMap = {};
    allBm.forEach(function (b) {
      if (!b.url) return;
      let norm = b.url.replace(/\/+$/, '').toLowerCase();
      if (!bmUrlMap[norm]) bmUrlMap[norm] = [];
      bmUrlMap[norm].push(b.title || b.url);
    });
    let bmDupes = Object.keys(bmUrlMap).filter(function (u) { return bmUrlMap[u].length > 1; });

    let totalDupes = shortcutDupes.length + bmDupes.length;
    if (totalDupes === 0) return 'No duplicates found — your bookmarks are clean!';

    let html = '<div style="margin-bottom:6px;">Found <strong>' + totalDupes + '</strong> duplicate URL' + (totalDupes > 1 ? 's' : '') + ':</div>';

    if (shortcutDupes.length > 0) {
      html += '<div style="margin-bottom:4px;font-size:11px;font-weight:600;color:var(--accent-primary);">Duplicate shortcuts:</div>';
      shortcutDupes.slice(0, 10).forEach(function (u) {
        let names = shortcutUrlMap[u];
        html += '<div class="chat-list-item" style="flex-direction:column;align-items:flex-start;gap:2px;">';
        html += '<span style="font-size:11px;color:var(--text-muted);word-break:break-all;">' + chatEscapeHtml(u.length > 60 ? u.substring(0, 60) + '...' : u) + '</span>';
        names.forEach(function (n) {
          html += '<span style="font-size:12px;"><strong>' + chatEscapeHtml(n) + '</strong></span>';
        });
        html += '</div>';
      });
    }

    if (bmDupes.length > 0) {
      html += '<div style="margin:8px 0 4px;font-size:11px;font-weight:600;color:var(--accent-primary);">Duplicate bookmarks:</div>';
      bmDupes.slice(0, 10).forEach(function (u) {
        let titles = bmUrlMap[u];
        html += '<div class="chat-list-item" style="flex-direction:column;align-items:flex-start;gap:2px;">';
        html += '<span style="font-size:11px;color:var(--text-muted);word-break:break-all;">' + chatEscapeHtml(u.length > 60 ? u.substring(0, 60) + '...' : u) + '</span>';
        titles.forEach(function (t) {
          html += '<span style="font-size:12px;">' + chatEscapeHtml(t) + '</span>';
        });
        html += '</div>';
      });
    }

    let remaining = totalDupes - 20;
    if (remaining > 0) html += '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">+ ' + remaining + ' more duplicates</div>';
    return html;
  }

  async function handleQueryFolders() {
    let tree = await getBookmarkTree();
    let folders = flattenFolders(tree);
    if (folders.length === 0) return 'No bookmark folders found.';
    let html = '<div style="margin-bottom:6px;"><strong>' + folders.length + '</strong> bookmark folders:</div>';
    folders.forEach(function (f) {
      html += '<div class="chat-list-item"><span class="chat-list-name" style="font-weight:500;">' + chatEscapeHtml(f.path || f.title) + '</span><span class="chat-list-meta">' + f.childCount + ' items</span></div>';
    });
    return html;
  }

  async function handleShowTrash() {
    let items = await getTrashItems();
    if (items.length === 0) {
      return {
        text: 'Your trash is empty — nothing has been deleted recently.',
        options: [
          { label: 'Show my shortcuts', query: 'List all my shortcuts' },
          { label: 'Clean up unused', query: 'Clean up unused bookmarks' }
        ]
      };
    }
    let html = '<div style="margin-bottom:6px;"><strong>' + items.length + '</strong> deleted item' + (items.length > 1 ? 's' : '') + ' in trash:</div>';
    items.forEach(function (item) {
      let isFolder = item.type === 'folder';
      let icon = isFolder
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px;opacity:0.7;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
        : '<img src="' + chatGetFavicon(item.url) + '">';
      let meta = isFolder
        ? ((item.urls ? item.urls.length : 0) + ' tabs &middot; deleted ' + chatTimeAgo(item.deletedAt))
        : ('deleted ' + chatTimeAgo(item.deletedAt));
      html += '<div class="chat-list-item">' + icon + '<span class="chat-list-name">' + chatEscapeHtml(item.name) + '</span><span class="chat-list-meta">' + meta + '</span></div>';
    });
    html += '<div style="margin-top:8px;font-size:12px;">To restore items, go to <strong>Settings > Trash</strong>.</div>';
    return {
      text: html,
      options: [
        { label: 'Go to Trash', query: 'Go to settings' },
        { label: 'Show my shortcuts', query: 'List all my shortcuts' }
      ]
    };
  }

  // ============================================================
  // CONTEXTUAL RESPONSE GENERATOR
  // Produces varied, helpful replies instead of generic errors
  // ============================================================
  let _lastFallbackIdx = -1;

  async function generateContextualFallback(userQuery) {
    // Always try AI first for a contextual, natural response
    let aiReply = await tryAiChat(userQuery);
    if (aiReply) return aiReply;

    // AI unavailable — fall back to hardcoded category responses
    let q = userQuery.toLowerCase();
    let ctxOptions = await getUserContextOptions();

    let isAboutCapabilities = /what (?:all )?can|what do|feature|ability|capable|support|power|skill/i.test(q);
    let isPersonal = /weather|news|time|date|joke|game|play|song|movie|recipe|translate|calculate|math/i.test(q);

    if (isAboutCapabilities) {
      return {
        text: 'I\'m <strong>Ask 0tab AI</strong> — your bookmark co-pilot! I can find, open, save, organize, clean up, and analyze your bookmarks. Try one of these:',
        options: ctxOptions.slice(0, 6)
      };
    }

    if (isPersonal) {
      return {
        text: 'I wish I could help with that! I\'m <strong>Ask 0tab AI</strong> — specialized in managing your bookmarks. Here\'s what I can do instead:',
        options: ctxOptions.slice(0, 5)
      };
    }

    return {
      text: 'I\'m not sure what you mean — but I\'d love to help! Try one of these:',
      options: ctxOptions.slice(0, 6)
    };
  }

  function chatNormalizeUrl(url) {
    if (!url) return '';
    url = url.trim();
    if (/^www\./i.test(url)) url = 'https://' + url;
    else if (/^[a-z0-9][\w.-]+\.[a-z]{2,}/i.test(url) && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    return url;
  }

  async function showSaveBookmarkForm(prefillUrl) {
    // If no URL was passed, prefill with the active tab URL — that's
    // almost always what the user means by "save this page".
    if (!prefillUrl) {
      let ctx = await getCurrentTabContext();
      if (ctx && ctx.url) prefillUrl = ctx.url;
    }
    // Build folder options
    let folderOptions = '<option value="">No folder (shortcut only)</option>';
    try {
      let tree = await getBookmarkTree();
      let folders = flattenFolders(tree);
      folders.forEach(function (f) {
        let selected = f.title === 'Bookmarks bar' ? ' selected' : '';
        folderOptions += '<option value="' + f.id + '"' + selected + '>' + chatEscapeHtml(f.path || f.title) + '</option>';
      });
    } catch (e) {}

    let actionArea = document.getElementById('chatActionArea');
    actionArea.classList.remove('hidden');
    actionArea.innerHTML =
      '<label>URL</label>' +
      '<input type="text" id="chatSaveUrl" placeholder="https://example.com or www.example.com" value="' + chatEscapeHtml(prefillUrl || '') + '">' +
      '<label>Bookmark name</label>' +
      '<input type="text" id="chatSaveBookmarkTitle" placeholder="Auto-filled from URL">' +
      '<label>0tab Shortcut</label>' +
      '<input type="text" id="chatSaveName" placeholder="Auto-filled from URL">' +
      '<label>Bookmark Folder</label>' +
      '<select id="chatSaveFolder" style="width:100%;padding:7px 10px;background:var(--bg-input);border:1px solid var(--border-primary);border-radius:8px;color:var(--text-primary);font-size:12px;font-family:inherit;">' + folderOptions + '</select>' +
      '<label>Tags (comma-separated, optional)</label>' +
      '<input type="text" id="chatSaveTags" placeholder="e.g. work, dev, social">' +
      '<div class="chat-action-btns">' +
      '<button id="chatSaveCancel">Cancel</button>' +
      '<button id="chatSaveConfirm" class="chat-action-primary">Save Bookmark</button>' +
      '</div>';

    // Auto-fill bookmark name and shortcut from URL
    function chatAutoFillFromUrl() {
      let urlVal = document.getElementById('chatSaveUrl').value.trim();
      let normalized = chatNormalizeUrl(urlVal);
      if (!normalized || !/^https?:\/\//i.test(normalized)) return;
      try {
        let hostname = new URL(normalized).hostname.replace(/^www\./, '');
        let domain = hostname.split('.')[0];
        let titleField = document.getElementById('chatSaveBookmarkTitle');
        let nameField = document.getElementById('chatSaveName');
        if (!titleField.value.trim()) {
          titleField.value = domain.charAt(0).toUpperCase() + domain.slice(1);
        }
        if (!nameField.value.trim()) {
          nameField.value = domain.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 3);
        }
      } catch (e) {}
    }
    document.getElementById('chatSaveUrl').addEventListener('blur', chatAutoFillFromUrl);
    document.getElementById('chatSaveUrl').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); chatAutoFillFromUrl(); document.getElementById('chatSaveBookmarkTitle').focus(); }
    });
    // If URL was prefilled, auto-fill immediately
    if (prefillUrl) chatAutoFillFromUrl();

    document.getElementById('chatSaveCancel').addEventListener('click', function () {
      actionArea.classList.add('hidden');
      actionArea.innerHTML = '';
    });
    document.getElementById('chatSaveConfirm').addEventListener('click', async function () {
      let bookmarkTitle = document.getElementById('chatSaveBookmarkTitle').value.trim();
      let name = document.getElementById('chatSaveName').value.trim();
      let url = chatNormalizeUrl(document.getElementById('chatSaveUrl').value);
      let folderId = document.getElementById('chatSaveFolder').value;
      let tagsStr = document.getElementById('chatSaveTags').value.trim();
      if (!name) { addMessage('bot', 'Please enter a shortcut name.'); return; }
      if (!url || !/^https?:\/\//i.test(url)) { addMessage('bot', 'Please enter a valid URL (e.g. www.example.com or https://example.com).'); return; }
      let tags = tagsStr ? tagsStr.split(',').map(function (t) { return t.trim().toLowerCase(); }).filter(Boolean) : [];
      let bmTitle = bookmarkTitle || name;
      try {
        // Save as 0tab shortcut
        let saveData = {};
        saveData[name] = { url: url, count: 0, tags: tags, createdAt: Date.now(), lastAccessed: 0, bookmarkTitle: bmTitle };
        await chatStorageSet(saveData);
        // Also create Chrome bookmark if a folder was selected
        if (folderId) {
          try {
            await new Promise(function (resolve, reject) {
              chrome.bookmarks.create({ parentId: folderId, title: bmTitle, url: url }, function (node) {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(node);
              });
            });
          } catch (bmErr) {
            // Shortcut saved, but Chrome bookmark creation failed — tell the user.
            console.warn('0tab: chat bookmark create failed:', bmErr && bmErr.message);
            addMessage('bot', 'Saved the shortcut, but could not add it to your bookmark folder: ' + chatEscapeHtml(bmErr && bmErr.message || 'unknown error'));
          }
        }
        actionArea.classList.add('hidden');
        actionArea.innerHTML = '';
        let msg = 'Saved <strong>' + chatEscapeHtml(name) + '</strong> as a shortcut!';
        if (folderId) msg += ' Also added to your bookmark folder.';
        msg += ' Open it with <code>0</code> + <code>Tab</code> + <code>' + chatEscapeHtml(name) + '</code>.';
        addMessage('bot', msg, [
          { label: 'Open ' + name, query: 'Open ' + name },
          { label: 'Save another', query: 'Save a bookmark' },
          { label: 'Show all shortcuts', query: 'List all my shortcuts' }
        ]);
        if (typeof loadShortcutsTable === 'function') loadShortcutsTable();
        if (typeof loadBookmarksView === 'function') loadBookmarksView();
      } catch (e) {
        addMessage('bot', 'Failed to save: ' + chatEscapeHtml(e.message));
      }
    });
    return 'Paste a URL below and I\'ll auto-fill the rest for you:';
  }

  async function handleCreateFolder(folderName) {
    if (!folderName) {
      return 'What should I name the folder? Say something like <em>create a folder called Work</em>.';
    }
    try {
      // Create under "Bookmarks bar" (id "1")
      let result = await new Promise(function (resolve, reject) {
        chrome.bookmarks.create({ parentId: '1', title: folderName }, function (node) {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(node);
        });
      });
      // Generate a unique shortcut name that doesn't conflict
      let allData = await chatStorageGet(null);
      let words = (folderName || '').toLowerCase().replace(/[^a-z0-9\s]+/g, '').trim().split(/\s+/).filter(Boolean);
      let base = '';
      if (words.length >= 3) {
        base = words[0][0] + words[1][0] + words[2][0];
      } else if (words.length === 2) {
        base = words[0][0] + words[1].substring(0, 2);
      } else if (words[0]) {
        base = words[0].substring(0, 3);
      }
      if (base.length < 2) base = 'fld';
      base = base.substring(0, 3);
      let shortcutKey = base;
      let suffix = 1;
      while (allData[shortcutKey]) { shortcutKey = base + suffix; suffix++; }

      // Save as proper folder-type shortcut
      if (shortcutKey) {
        await chatStorageSet({
          [shortcutKey]: {
            type: 'folder',
            urls: [],
            folderId: result.id,
            folderTitle: folderName,
            count: 0,
            tags: ['folder'],
            createdAt: Date.now()
          }
        });
      }
      // Refresh bookmarks view if active
      if (typeof loadBookmarksView === 'function') loadBookmarksView();
      if (typeof loadShortcutsTable === 'function') loadShortcutsTable();
      let scMsg = shortcutKey ? ' 0tab shortcut <strong>' + chatEscapeHtml(shortcutKey) + '</strong> also created.' : '';
      return 'Created folder <strong>' + chatEscapeHtml(folderName) + '</strong> in Bookmarks bar!' + scMsg;
    } catch (e) {
      return 'Failed to create folder: ' + chatEscapeHtml(e.message);
    }
  }

  async function handleOpenShortcut(target) {
    let t = target.toLowerCase().trim();

    // 1. Check if it's a URL — just open it directly
    if (/^https?:\/\//i.test(target) || /^www\./i.test(target) || /^[\w.-]+\.[a-z]{2,}/i.test(target)) {
      let url = chatNormalizeUrl(target);
      chrome.tabs.create({ url: url });
      return 'Opening <strong>' + chatEscapeHtml(url) + '</strong>...';
    }

    let shortcuts = await getAllShortcuts();
    let tree = await getBookmarkTree();

    // 2. Exact shortcut name match
    let shortcutMatch = shortcuts.find(function (s) { return s.name.toLowerCase() === t; });
    // 3. Partial shortcut name match
    if (!shortcutMatch) shortcutMatch = shortcuts.find(function (s) { return s.name.toLowerCase().includes(t); });

    // 4. Try matching by bookmark title (bookmarkTitle field)
    let bmTitleMatch = null;
    if (!shortcutMatch) {
      bmTitleMatch = shortcuts.find(function (s) { return (s.bookmarkTitle || '').toLowerCase() === t; });
      if (!bmTitleMatch) bmTitleMatch = shortcuts.find(function (s) { return (s.bookmarkTitle || '').toLowerCase().includes(t); });
    }

    // 5. Try matching Chrome bookmark title
    let chromeBmMatch = null;
    if (!shortcutMatch && !bmTitleMatch) {
      let allBm = flattenBookmarks(tree);
      chromeBmMatch = allBm.find(function (b) { return b.title.toLowerCase() === t; });
      if (!chromeBmMatch) chromeBmMatch = allBm.find(function (b) { return b.title.toLowerCase().includes(t); });
    }

    // 6. Try matching folder name
    let folderMatch = null;
    if (!shortcutMatch && !bmTitleMatch && !chromeBmMatch) {
      let folders = flattenFolders(tree);
      folderMatch = folders.find(function (f) { return f.title.toLowerCase() === t; });
      if (!folderMatch) folderMatch = folders.find(function (f) { return f.title.toLowerCase().includes(t); });
    }

    // Handle folder match — ask before opening all
    if (folderMatch) {
      rememberFolder(folderMatch);
      // Get bookmarks in this folder
      let folderBookmarks = [];
      try {
        let subTree = await new Promise(function (resolve) {
          chrome.bookmarks.getSubTree(folderMatch.id, function (r) { resolve(r || []); });
        });
        if (subTree[0] && subTree[0].children) {
          folderBookmarks = subTree[0].children.filter(function (c) { return c.url; });
        }
      } catch (e) {}

      if (folderBookmarks.length === 0) {
        return 'Folder <strong>' + chatEscapeHtml(folderMatch.title) + '</strong> is empty.';
      }

      // Show folder contents and ask
      let html = 'Found folder <strong>' + chatEscapeHtml(folderMatch.title) + '</strong> with ' + folderBookmarks.length + ' bookmark' + (folderBookmarks.length > 1 ? 's' : '') + ':';
      html += '<div style="margin:6px 0;">';
      folderBookmarks.slice(0, 8).forEach(function (b) {
        let fav = chatGetFavicon(b.url);
        html += '<div class="chat-list-item"><img src="' + fav + '"><span class="chat-list-name">' + chatEscapeHtml(b.title || b.url) + '</span></div>';
      });
      if (folderBookmarks.length > 8) html += '<div style="font-size:11px;color:var(--text-muted);">+ ' + (folderBookmarks.length - 8) + ' more</div>';
      html += '</div>';

      // Build option pills for individual bookmarks + open all
      let openOptions = [{ label: 'Open all (' + folderBookmarks.length + ')', query: '__open_folder_all__' + folderMatch.id }];
      folderBookmarks.slice(0, 4).forEach(function (b) {
        openOptions.push({ label: 'Open ' + (b.title || 'link').substring(0, 20), query: '__open_url__' + b.url });
      });

      return { text: html, options: openOptions };
    }

    // Handle shortcut match (including folder-type shortcuts)
    let match = shortcutMatch || bmTitleMatch;
    if (match) {
      rememberShortcut(match);
      if (match.type === 'folder' && match.urls && match.urls.length > 0) {
        match.urls.forEach(function (u) { chrome.tabs.create({ url: u }); });
        return 'Opened all ' + match.urls.length + ' bookmarks from folder <strong>' + chatEscapeHtml(match.name) + '</strong>.';
      }
      if (match.url) {
        chrome.tabs.create({ url: match.url });
        return 'Opening <strong>' + chatEscapeHtml(match.bookmarkTitle || match.name) + '</strong>...';
      }
    }

    // Handle Chrome bookmark match
    if (chromeBmMatch) {
      rememberShortcut({ name: chromeBmMatch.title, url: chromeBmMatch.url });
      chrome.tabs.create({ url: chromeBmMatch.url });
      return 'Opening <strong>' + chatEscapeHtml(chromeBmMatch.title) + '</strong>...';
    }

    // Nothing found
    let allOptions = shortcuts.slice().sort(function (a, b) { return b.count - a.count; }).slice(0, 4);
    let suggestOptions = allOptions.map(function (s) {
      return { label: 'Open ' + s.name, query: 'Open ' + s.name };
    });
    suggestOptions.push({ label: 'List all bookmarks', query: 'List all my bookmarks' });
    return {
      text: 'Could not find <strong>' + chatEscapeHtml(target) + '</strong> in your shortcuts, bookmarks, or folders.',
      options: suggestOptions
    };
  }

  async function handleDeleteShortcut(name) {
    if (!name) return 'Which shortcut should I delete? Say something like <em>delete shortcut gmail</em>.';
    let shortcuts = await getAllShortcuts();
    let t = name.toLowerCase();
    let match = shortcuts.find(function (s) { return s.name.toLowerCase() === t; }) ||
                shortcuts.find(function (s) { return s.name.toLowerCase().includes(t); });
    if (!match) return 'Could not find a shortcut matching <strong>' + chatEscapeHtml(name) + '</strong>.';

    // Show confirmation in action area
    let actionArea = document.getElementById('chatActionArea');
    actionArea.classList.remove('hidden');
    actionArea.innerHTML =
      '<div style="font-size:13px;margin-bottom:8px;">Are you sure you want to delete <strong>' + chatEscapeHtml(match.name) + '</strong>?</div>' +
      '<div class="chat-action-btns">' +
      '<button id="chatDeleteCancel">Cancel</button>' +
      '<button id="chatDeleteConfirm" class="chat-action-primary" style="background:var(--danger);border-color:var(--danger);">Delete</button>' +
      '</div>';

    return new Promise(function (resolve) {
      document.getElementById('chatDeleteCancel').addEventListener('click', function () {
        actionArea.classList.add('hidden');
        actionArea.innerHTML = '';
        resolve('Cancelled deletion.');
      });
      document.getElementById('chatDeleteConfirm').addEventListener('click', async function () {
        try {
          // Snapshot the data BEFORE deleting so we can restore on undo
          let snapshot = JSON.parse(JSON.stringify(match));
          await addToTrash(match);
          await chatStorageRemove(match.name);
          actionArea.classList.add('hidden');
          actionArea.innerHTML = '';
          if (typeof loadShortcutsTable === 'function') loadShortcutsTable();
          // Register undo: re-create the shortcut from the snapshot
          rememberAction('delete_shortcut', { name: match.name }, async function () {
            let restoreData = {};
            let s = snapshot;
            restoreData[s.name] = {
              url: s.url || '',
              count: s.count || 0,
              tags: s.tags || [],
              type: s.type || undefined,
              urls: s.urls || undefined,
              urlTitles: s.urlTitles || undefined,
              folderId: s.folderId || undefined,
              folderTitle: s.folderTitle || undefined,
              bookmarkId: s.bookmarkId || undefined,
              bookmarkTitle: s.bookmarkTitle || s.name,
              createdAt: s.createdAt || Date.now(),
              lastAccessed: s.lastAccessed || 0,
              aiDescription: s.aiDescription || ''
            };
            // Strip undefined fields so storage doesn't store literal undefined
            Object.keys(restoreData[s.name]).forEach(function (k) {
              if (restoreData[s.name][k] === undefined) delete restoreData[s.name][k];
            });
            await chatStorageSet(restoreData);
            if (typeof loadShortcutsTable === 'function') loadShortcutsTable();
            return 'Restored <strong>' + chatEscapeHtml(s.name) + '</strong>.';
          });
          resolve({
            text: 'Deleted <strong>' + chatEscapeHtml(match.name) + '</strong>. Say <em>undo</em> to restore.',
            options: [
              { label: 'Undo', query: 'undo' },
              { label: 'Show my shortcuts', query: 'List all my shortcuts' },
              { label: 'Find duplicates', query: 'Find duplicates' }
            ]
          });
        } catch (e) {
          resolve('Failed to delete: ' + chatEscapeHtml(e.message));
        }
      });
    });
  }

  // ============================================================
  // FOLDER MANAGEMENT HANDLERS
  // ============================================================

  async function handleMoveByDomain(domain, folderName) {
    if (!domain) return 'Which domain should I look for? Say something like <em>move zoho.com bookmarks to Zoho folder</em>.';
    if (!folderName) return 'Which folder should I move them to? Say something like <em>move ' + chatEscapeHtml(domain) + ' bookmarks to Work</em>.';

    let shortcuts = await getAllShortcuts();
    let tree = await getBookmarkTree();
    let allBm = flattenBookmarks(tree);

    // Normalize domain: strip www, protocol, trailing dots
    let domainClean = domain.toLowerCase().replace(/^(?:https?:\/\/)?(?:www\.)?/i, '').replace(/[\/.\s]+$/, '');

    // Find matching Chrome bookmarks by domain
    let matchingBm = allBm.filter(function (b) {
      try {
        let u = new URL(b.url);
        let host = u.hostname.replace(/^www\./, '');
        return host.includes(domainClean) || domainClean.includes(host);
      } catch (e) { return false; }
    });

    // Also find matching 0tab shortcuts by domain
    let matchingShortcuts = shortcuts.filter(function (s) {
      if (!s.url) return false;
      try {
        let u = new URL(s.url);
        let host = u.hostname.replace(/^www\./, '');
        return host.includes(domainClean) || domainClean.includes(host);
      } catch (e) { return false; }
    });

    // Merge unique by URL
    let seenUrls = {};
    let allMatches = [];
    matchingBm.forEach(function (b) {
      if (!seenUrls[b.url]) { seenUrls[b.url] = true; allMatches.push({ title: b.title, url: b.url, source: 'bookmark', id: b.id }); }
    });
    matchingShortcuts.forEach(function (s) {
      if (!seenUrls[s.url]) { seenUrls[s.url] = true; allMatches.push({ title: s.bookmarkTitle || s.name, url: s.url, source: 'shortcut', name: s.name }); }
    });

    if (allMatches.length === 0) {
      return 'I couldn\'t find any bookmarks or shortcuts matching <strong>' + chatEscapeHtml(domain) + '</strong>. Check the domain name and try again.';
    }

    // Show matches and ask for confirmation
    let listHtml = '<div style="margin-bottom:8px;">Found <strong>' + allMatches.length + '</strong> item' + (allMatches.length > 1 ? 's' : '') + ' matching <strong>' + chatEscapeHtml(domain) + '</strong>:</div>';
    allMatches.slice(0, 15).forEach(function (m) {
      let fav = chatGetFavicon(m.url);
      listHtml += '<div class="chat-list-item"><img src="' + fav + '"><span class="chat-list-name">' + chatEscapeHtml(m.title || m.url) + '</span></div>';
    });
    if (allMatches.length > 15) {
      listHtml += '<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">...and ' + (allMatches.length - 15) + ' more</div>';
    }
    listHtml += '<div style="margin-top:8px;">Move them all to folder <strong>' + chatEscapeHtml(folderName) + '</strong>?</div>';

    conversationState.mode = 'awaiting_confirm';
    conversationState.pendingAction = async function () {
      try {
        // Find or create target folder
        let currentTree = await getBookmarkTree();
        let folders = flattenFolders(currentTree);
        let targetFolder = folders.find(function (f) { return f.title.toLowerCase() === folderName.toLowerCase(); });
        let folderId;

        if (targetFolder) {
          folderId = targetFolder.id;
        } else {
          // Create folder under Bookmarks bar (id "1")
          let newFolder = await new Promise(function (resolve, reject) {
            chrome.bookmarks.create({ parentId: '1', title: folderName }, function (node) {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(node);
            });
          });
          folderId = newFolder.id;
        }

        // Move existing bookmarks, create new ones for shortcut-only items
        let movedCount = 0;
        let createdCount = 0;
        for (let i = 0; i < allMatches.length; i++) {
          let item = allMatches[i];
          if (item.id) {
            // It's a Chrome bookmark — move it
            await new Promise(function (resolve, reject) {
              chrome.bookmarks.move(item.id, { parentId: folderId }, function (result) {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(result);
              });
            });
            movedCount++;
          } else {
            // It's a 0tab shortcut without a bookmark ID — create bookmark in folder
            await new Promise(function (resolve, reject) {
              chrome.bookmarks.create({ parentId: folderId, title: item.title || item.name, url: item.url }, function (node) {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(node);
              });
            });
            createdCount++;
          }
        }

        // Refresh views
        if (typeof loadBookmarksView === 'function') loadBookmarksView();

        let msg = 'Done! ';
        if (movedCount > 0) msg += 'Moved <strong>' + movedCount + '</strong> bookmark' + (movedCount > 1 ? 's' : '') + ' to <strong>' + chatEscapeHtml(folderName) + '</strong>. ';
        if (createdCount > 0) msg += 'Created <strong>' + createdCount + '</strong> new bookmark' + (createdCount > 1 ? 's' : '') + ' in <strong>' + chatEscapeHtml(folderName) + '</strong>. ';
        if (!targetFolder) msg += '(New folder created)';
        return msg;
      } catch (e) {
        return 'Something went wrong while moving bookmarks: ' + chatEscapeHtml(e.message);
      }
    };
    conversationState.pendingCancel = function () { return 'No problem, cancelled the move.'; };

    return {
      text: listHtml,
      options: [
        { label: 'Yes, move them', query: 'Yes' },
        { label: 'Cancel', query: 'No' }
      ]
    };
  }

  async function handleMoveByTag(tag, folderName) {
    if (!tag) return 'Which tag should I look for? Say something like <em>move shortcuts tagged work to Work folder</em>.';
    if (!folderName) return 'Which folder should I move them to? Say something like <em>move shortcuts tagged ' + chatEscapeHtml(tag) + ' to Work</em>.';

    let shortcuts = await getAllShortcuts();
    let tagClean = tag.toLowerCase().trim();

    let matching = shortcuts.filter(function (s) {
      return s.tags.some(function (t) { return t.toLowerCase() === tagClean; });
    });

    if (matching.length === 0) {
      // Try partial match
      matching = shortcuts.filter(function (s) {
        return s.tags.some(function (t) { return t.toLowerCase().includes(tagClean) || tagClean.includes(t.toLowerCase()); });
      });
    }

    if (matching.length === 0) {
      return 'I couldn\'t find any shortcuts tagged <strong>' + chatEscapeHtml(tag) + '</strong>. Use <em>show tags</em> to see available tags.';
    }

    let listHtml = '<div style="margin-bottom:8px;">Found <strong>' + matching.length + '</strong> shortcut' + (matching.length > 1 ? 's' : '') + ' tagged <strong>' + chatEscapeHtml(tag) + '</strong>:</div>';
    matching.slice(0, 15).forEach(function (s) {
      let fav = chatGetFavicon(s.url);
      listHtml += '<div class="chat-list-item"><img src="' + fav + '"><span class="chat-list-name">' + chatEscapeHtml(s.name) + '</span><span class="chat-list-meta">' + s.tags.join(', ') + '</span></div>';
    });
    if (matching.length > 15) {
      listHtml += '<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">...and ' + (matching.length - 15) + ' more</div>';
    }
    listHtml += '<div style="margin-top:8px;">Move them all to folder <strong>' + chatEscapeHtml(folderName) + '</strong>?</div>';

    conversationState.mode = 'awaiting_confirm';
    conversationState.pendingAction = async function () {
      try {
        let currentTree = await getBookmarkTree();
        let folders = flattenFolders(currentTree);
        let targetFolder = folders.find(function (f) { return f.title.toLowerCase() === folderName.toLowerCase(); });
        let folderId;

        if (targetFolder) {
          folderId = targetFolder.id;
        } else {
          let newFolder = await new Promise(function (resolve, reject) {
            chrome.bookmarks.create({ parentId: '1', title: folderName }, function (node) {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(node);
            });
          });
          folderId = newFolder.id;
        }

        // For each matching shortcut, find its Chrome bookmark and move, or create new
        let movedCount = 0;
        let createdCount = 0;
        let allBm = flattenBookmarks(currentTree);

        for (let i = 0; i < matching.length; i++) {
          let s = matching[i];
          // Try to find existing Chrome bookmark by URL
          let existingBm = allBm.find(function (b) { return b.url === s.url; });
          if (existingBm) {
            await new Promise(function (resolve, reject) {
              chrome.bookmarks.move(existingBm.id, { parentId: folderId }, function (result) {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(result);
              });
            });
            movedCount++;
          } else if (s.url) {
            await new Promise(function (resolve, reject) {
              chrome.bookmarks.create({ parentId: folderId, title: s.bookmarkTitle || s.name, url: s.url }, function (node) {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(node);
              });
            });
            createdCount++;
          }
        }

        if (typeof loadBookmarksView === 'function') loadBookmarksView();

        let msg = 'Done! ';
        if (movedCount > 0) msg += 'Moved <strong>' + movedCount + '</strong> bookmark' + (movedCount > 1 ? 's' : '') + '. ';
        if (createdCount > 0) msg += 'Created <strong>' + createdCount + '</strong> new bookmark' + (createdCount > 1 ? 's' : '') + '. ';
        msg += 'All in <strong>' + chatEscapeHtml(folderName) + '</strong>.' + (!targetFolder ? ' (New folder created)' : '');
        return msg;
      } catch (e) {
        return 'Something went wrong: ' + chatEscapeHtml(e.message);
      }
    };
    conversationState.pendingCancel = function () { return 'No problem, cancelled the move.'; };

    return {
      text: listHtml,
      options: [
        { label: 'Yes, move them', query: 'Yes' },
        { label: 'Cancel', query: 'No' }
      ]
    };
  }

  async function handleDeleteFolder(folderName) {
    if (!folderName) return 'Which folder should I delete? Say something like <em>delete folder called Work</em>.';

    let tree = await getBookmarkTree();
    let folders = flattenFolders(tree);
    let folderClean = folderName.toLowerCase().trim();

    // Exact then partial match
    let targetFolder = folders.find(function (f) { return f.title.toLowerCase() === folderClean; });
    if (!targetFolder) targetFolder = folders.find(function (f) { return f.title.toLowerCase().includes(folderClean); });

    if (!targetFolder) {
      let suggestions = folders.slice(0, 5).map(function (f) { return '<strong>' + chatEscapeHtml(f.title) + '</strong>'; }).join(', ');
      return 'I couldn\'t find a folder called <strong>' + chatEscapeHtml(folderName) + '</strong>.' + (suggestions ? ' Your folders: ' + suggestions : '');
    }

    // Show folder contents
    let contentsHtml = '<div style="margin-bottom:8px;">Folder <strong>' + chatEscapeHtml(targetFolder.title) + '</strong> contains <strong>' + targetFolder.childCount + '</strong> item' + (targetFolder.childCount !== 1 ? 's' : '') + '.</div>';

    if (targetFolder.childCount > 0) {
      // Get the actual children
      let children = [];
      function findFolderChildren(node) {
        if (node.id === targetFolder.id && node.children) {
          children = node.children;
          return true;
        }
        if (node.children) {
          for (let i = 0; i < node.children.length; i++) {
            if (findFolderChildren(node.children[i])) return true;
          }
        }
        return false;
      }
      tree.forEach(findFolderChildren);

      children.slice(0, 10).forEach(function (c) {
        if (c.url) {
          let fav = chatGetFavicon(c.url);
          contentsHtml += '<div class="chat-list-item"><img src="' + fav + '"><span class="chat-list-name">' + chatEscapeHtml(c.title || c.url) + '</span></div>';
        } else {
          contentsHtml += '<div class="chat-list-item"><span style="margin-right:6px;">📁</span><span class="chat-list-name">' + chatEscapeHtml(c.title) + '</span></div>';
        }
      });
      if (children.length > 10) {
        contentsHtml += '<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">...and ' + (children.length - 10) + ' more</div>';
      }
    }

    contentsHtml += '<div style="margin-top:8px;color:var(--accent-danger, #e53e3e);font-weight:600;">This will permanently delete the folder and all its contents. Are you sure?</div>';

    conversationState.mode = 'awaiting_confirm';
    conversationState.pendingAction = async function () {
      try {
        // Find and trash the associated folder shortcut before deleting
        let allData = await chatStorageGet(null);
        for (let key in allData) {
          if (key.startsWith('__')) continue;
          let d = allData[key];
          if (d && typeof d === 'object' && d.type === 'folder' && d.folderId === targetFolder.id) {
            await addToTrash({ name: key, type: 'folder', urls: d.urls || [], urlTitles: d.urlTitles || [], folderId: d.folderId || '', folderTitle: d.folderTitle || '', tags: d.tags || [], count: d.count || 0 });
            try { await chatStorageRemove(key); } catch (e) { /* ignore */ }
            break;
          }
        }
        await new Promise(function (resolve, reject) {
          chrome.bookmarks.removeTree(targetFolder.id, function () {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
          });
        });
        if (typeof loadBookmarksView === 'function') loadBookmarksView();
        return 'Deleted folder <strong>' + chatEscapeHtml(targetFolder.title) + '</strong> and all its contents. You can find it in trash.';
      } catch (e) {
        return 'Failed to delete folder: ' + chatEscapeHtml(e.message);
      }
    };
    conversationState.pendingCancel = function () { return 'Good call, the folder is safe!'; };

    return {
      text: contentsHtml,
      options: [
        { label: 'Yes, delete it', query: 'Yes' },
        { label: 'Cancel', query: 'No' }
      ]
    };
  }

  async function handleRenameShortcut(target) {
    if (!target) return 'Which shortcut should I rename? Say something like <em>rename shortcut gmail</em>.';
    let shortcuts = await getAllShortcuts();
    let t = target.toLowerCase().trim();
    // Try to split "oldname to newname"
    let toMatch = target.match(/^(.+?)\s+(?:to|as|into)\s+(.+)$/i);
    if (toMatch) {
      let oldName = toMatch[1].trim().toLowerCase();
      let newName = toMatch[2].trim();
      let match = shortcuts.find(function (s) { return s.name.toLowerCase() === oldName; }) ||
                  shortcuts.find(function (s) { return s.name.toLowerCase().includes(oldName); });
      if (!match) return 'Could not find a shortcut matching <strong>' + chatEscapeHtml(toMatch[1].trim()) + '</strong>.';

      conversationState.mode = 'awaiting_confirm';
      conversationState.pendingAction = async function () {
        // Copy data to new name, delete old
        let data = {};
        data[newName] = { url: match.url, count: match.count, tags: match.tags, type: match.type, lastAccessed: match.lastAccessed, createdAt: match.createdAt, bookmarkTitle: match.bookmarkTitle, aiDescription: match.aiDescription || '' };
        await chatStorageSet(data);
        try { await chatStorageRemove(match.name); } catch (e) { /* ignore */ }
        if (typeof loadShortcutsTable === 'function') loadShortcutsTable();
        return 'Renamed <strong>' + chatEscapeHtml(match.name) + '</strong> to <strong>' + chatEscapeHtml(newName) + '</strong>!';
      };

      return {
        text: 'Rename <strong>' + chatEscapeHtml(match.name) + '</strong> to <strong>' + chatEscapeHtml(newName) + '</strong>?',
        options: [
          { label: 'Yes, rename', query: 'Yes' },
          { label: 'Cancel', query: 'No' }
        ]
      };
    }

    // Only got target name, ask for new name
    let match = shortcuts.find(function (s) { return s.name.toLowerCase() === t; }) ||
                shortcuts.find(function (s) { return s.name.toLowerCase().includes(t); });
    if (!match) return 'Could not find a shortcut matching <strong>' + chatEscapeHtml(target) + '</strong>.';

    conversationState.mode = 'awaiting_input';
    conversationState.pendingAction = async function (newName) {
      newName = newName.trim();
      if (!newName) return 'Please provide a valid name.';
      let data = {};
      data[newName] = { url: match.url, count: match.count, tags: match.tags, type: match.type, lastAccessed: match.lastAccessed, createdAt: match.createdAt, bookmarkTitle: match.bookmarkTitle, aiDescription: match.aiDescription || '' };
      await chatStorageSet(data);
      try { await chatStorageRemove(match.name); } catch (e) { /* ignore */ }
      if (typeof loadShortcutsTable === 'function') loadShortcutsTable();
      return 'Renamed <strong>' + chatEscapeHtml(match.name) + '</strong> to <strong>' + chatEscapeHtml(newName) + '</strong>!';
    };

    return 'What would you like to rename <strong>' + chatEscapeHtml(match.name) + '</strong> to?';
  }

  // ============================================================
  // AI-ENHANCED NLU (Optional - uses Gemini Nano if available)
  // ============================================================
  let aiChatAvailable = null;
  let aiChatRawStatus = null; // 'readily' | 'after-download' | 'no' | 'disabled'

  async function checkChatAi() {
    if (aiChatAvailable !== null) return aiChatAvailable;
    try {
      // Check settings
      let settings = await chatStorageGet(['__0tab_settings']);
      let s = settings['__0tab_settings'] || {};
      if (s.aiEnabled !== true) {
        aiChatAvailable = false;
        aiChatRawStatus = 'disabled';
        return false;
      }
      let response = await new Promise(function (resolve) {
        let timeout = setTimeout(function () { resolve({ available: false, status: 'no' }); }, 2000);
        chrome.runtime.sendMessage({ action: 'ai:status' }, function (r) {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) { resolve({ available: false, status: 'no' }); return; }
          resolve(r || { available: false, status: 'no' });
        });
      });
      aiChatAvailable = response.available;
      aiChatRawStatus = response.status || (response.available ? 'readily' : 'no');
      return aiChatAvailable;
    } catch (e) {
      aiChatAvailable = false;
      aiChatRawStatus = 'no';
      return false;
    }
  }

  // ============================================================
  // AI STATUS PILL — small dot in chat header reflecting Gemini Nano state
  // green  = ready
  // yellow = available but model needs download
  // gray   = unavailable / disabled (clickable → opens settings)
  // ============================================================
  function updateAiStatusPill() {
    let pill = document.getElementById('chatAiStatus');
    if (!pill) return;
    let label = pill.querySelector('.chat-ai-status-label');

    // Build the freshest state — bypass the cached aiChatAvailable so the
    // pill reflects current settings even after the user toggles AI on/off.
    chatStorageGet(['__0tab_settings']).then(function (settings) {
      let s = (settings && settings['__0tab_settings']) || {};
      let enabled = s.aiEnabled === true;

      function applyState(stateClass, text, title, clickable) {
        pill.className = 'chat-ai-status ' + stateClass;
        if (label) label.textContent = text;
        pill.setAttribute('title', title);
        if (clickable) pill.setAttribute('data-clickable', 'true');
        else pill.removeAttribute('data-clickable');
      }

      // Ask the background for the latest model status
      chrome.runtime.sendMessage({ action: 'ai:status' }, function (resp) {
        if (chrome.runtime.lastError) {
          applyState('chat-ai-status-unavailable', 'AI off', 'AI features unavailable', true);
          return;
        }
        let status = (resp && resp.status) || 'no';
        if (!enabled) {
          applyState('chat-ai-status-unavailable', 'AI off', 'AI features disabled — click to open settings', true);
        } else if (status === 'readily') {
          applyState('chat-ai-status-ready', 'AI on', 'Gemini Nano ready', false);
        } else if (status === 'after-download') {
          applyState('chat-ai-status-downloading', 'Setup', 'Gemini Nano needs to download — click to set up', true);
        } else {
          applyState('chat-ai-status-unavailable', 'No AI', 'Gemini Nano not available on this browser — click for setup info', true);
        }
      });
    });
  }

  function wireAiStatusPill() {
    let pill = document.getElementById('chatAiStatus');
    if (!pill) return;
    pill.addEventListener('click', function () {
      if (pill.getAttribute('data-clickable') !== 'true') return;
      // Switch the dashboard to Settings → AI section
      let settingsBtn = document.querySelector('[data-view="settings"]');
      if (settingsBtn) settingsBtn.click();
      // Try to scroll to the AI block in settings
      setTimeout(function () {
        let aiBlock = document.getElementById('settingAiFeatures');
        let target = aiBlock ? aiBlock.closest('.setting-row') || aiBlock : null;
        if (target && target.scrollIntoView) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.style.transition = 'background 600ms ease';
          let prev = target.style.background;
          target.style.background = 'rgba(234,179,8,0.18)';
          setTimeout(function () { target.style.background = prev; }, 1200);
        }
      }, 120);
    });
    // Refresh whenever AI settings change
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== 'local') return;
      if (changes['__0tab_settings']) {
        aiChatAvailable = null; // invalidate cache
        updateAiStatusPill();
      }
    });
  }

  // Build dynamic option pills from user's actual data
  async function getUserContextOptions() {
    let shortcuts = await getAllShortcuts();
    let tree = await getBookmarkTree();
    let tagMap = {};
    let untagged = 0;
    let dead = 0;
    shortcuts.forEach(function (s) {
      s.tags.forEach(function (t) { tagMap[t] = (tagMap[t] || 0) + 1; });
      if (s.tags.length === 0 && s.type !== 'folder') untagged++;
      if (s.count === 0 && s.type !== 'folder') dead++;
    });
    let topShortcuts = shortcuts.slice().sort(function (a, b) { return b.count - a.count; }).slice(0, 3);
    let topTags = Object.keys(tagMap).sort(function (a, b) { return tagMap[b] - tagMap[a]; }).slice(0, 2);
    let folders = flattenFolders(tree);

    let options = [];
    // Show a real top shortcut to open
    if (topShortcuts.length > 0 && topShortcuts[0].count > 0) {
      options.push({ label: 'Open ' + topShortcuts[0].name, query: 'Open ' + topShortcuts[0].name });
    }
    options.push({ label: 'List all bookmarks', query: 'List all my bookmarks' });
    options.push({ label: 'Most used shortcuts', query: 'Show my most used shortcuts' });
    options.push({ label: 'Save a bookmark', query: 'Save a bookmark' });
    // Real tag
    if (topTags.length > 0) {
      options.push({ label: 'Tag: ' + topTags[0], query: 'Show bookmarks tagged ' + topTags[0] });
    }
    // Copilot actions — suggest based on data health
    if (dead >= 3) {
      options.push({ label: 'Clean up unused', query: 'Clean up unused bookmarks' });
    }
    if (untagged >= 5) {
      options.push({ label: 'Bulk tag shortcuts', query: 'Bulk tag my shortcuts' });
    }
    options.push({ label: 'Find duplicates', query: 'Find duplicates' });
    if (folders.length > 0) {
      options.push({ label: 'My folders', query: 'Show my folders' });
    }
    options.push({ label: 'Organize bookmarks', query: 'Organize my bookmarks into folders' });
    return options;
  }

  // Reusable response generators — return {text, options}
  async function greetingResponse(originalQuery) {
    let aiReply = await tryAiChat(originalQuery || 'hello');
    if (aiReply) return aiReply;
    let options = await getUserContextOptions();
    return {
      text: 'Hey! I\'m <strong>Ask 0tab AI</strong> — your co-pilot for managing bookmarks. What would you like to do?',
      options: options.slice(0, 6)
    };
  }

  async function whoAreYouResponse(originalQuery) {
    let aiReply = await tryAiChat(originalQuery || 'what can you do');
    if (aiReply) return aiReply;
    let options = await getUserContextOptions();
    return {
      text: 'I\'m <strong>Ask 0tab AI</strong> — your bookmark co-pilot! Talk to me naturally and I\'ll manage your bookmarks for you.<br><br>' +
        '&bull; <strong>Find & Open</strong> — "open gmail", "find my work links"<br>' +
        '&bull; <strong>Save & Organize</strong> — "save a bookmark", "organize my bookmarks"<br>' +
        '&bull; <strong>Clean Up</strong> — "clean up unused", "find duplicates"<br>' +
        '&bull; <strong>Analyze</strong> — "how many bookmarks?", "most used", "show tags"<br>' +
        '&bull; <strong>Manage</strong> — "rename shortcut", "bulk tag", "export"<br>' +
        '&bull; <strong>Navigate</strong> — "go to settings", "go to bookmarks"<br><br>' +
        'Try one of these:',
      options: options.slice(0, 6)
    };
  }

  async function confusedResponse(originalQuery, skipAi) {
    if (originalQuery && !skipAi) {
      let aiReply = await tryAiChat(originalQuery);
      if (aiReply) return aiReply;
    }
    let options = await getUserContextOptions();
    return {
      text: 'I\'m not sure what you mean — but I\'d love to help! Try one of these:',
      options: options.slice(0, 6)
    };
  }

  // AI-powered intent classification — when regex fails, ask AI to classify
  async function tryAiClassifyIntent(query) {
    let available = await checkChatAi();
    if (!available) return null;
    try {
      let shortcuts = await getAllShortcuts();
      let shortcutNames = shortcuts.map(function (s) { return s.name; }).join(', ');
      let tree = await getBookmarkTree();
      let folders = flattenFolders(tree);
      let folderNames = folders.map(function (f) { return f.title; }).join(', ');
      let tagMap = {};
      shortcuts.forEach(function (s) { s.tags.forEach(function (t) { tagMap[t] = true; }); });
      let tagNames = Object.keys(tagMap).join(', ');

      // Include recent conversation for context
      let recentHistory = getConversationContext();

      let prompt = 'You are the intent classifier for 0tab AI, a Chrome bookmark manager assistant.\n' +
        'User\'s shortcuts: ' + (shortcutNames || 'none') + '\n' +
        'User\'s folders: ' + (folderNames || 'none') + '\n' +
        'User\'s tags: ' + (tagNames || 'none') + '\n' +
        (recentHistory ? 'Recent conversation:\n' + recentHistory + '\n' : '') + '\n' +
        'Classify this user message into EXACTLY ONE intent. Reply with ONLY the intent code and any parameter, nothing else.\n\n' +
        'Available intents:\n' +
        'greeting - hello, hi, hey\n' +
        'who_are_you - asking about capabilities\n' +
        'thanks - expressing gratitude\n' +
        'query:list_all [shortcuts|bookmarks|all] - list all items\n' +
        'query:count - asking how many bookmarks/shortcuts\n' +
        'query:most_used - top/popular/frequently used\n' +
        'query:least_used - unused/dead bookmarks\n' +
        'query:recent - recently added\n' +
        'query:recently_accessed - recently opened\n' +
        'query:tags - show all tags\n' +
        'query:by_tag [tagname] - filter by tag\n' +
        'query:by_domain [domain] - filter by domain/website\n' +
        'query:folder_contents [folder] - what\'s in a folder\n' +
        'query:folders - list folders\n' +
        'query:duplicates - find duplicate bookmarks\n' +
        'query:usage_period [week|month|year] - usage in time period\n' +
        'query:search [term] - search for specific bookmark\n' +
        'action:save_bookmark - user wants to save/add a bookmark\n' +
        'action:create_folder [name] - create new folder\n' +
        'action:open [target] - open a bookmark/shortcut\n' +
        'action:delete_shortcut [name] - delete a shortcut\n' +
        'action:toggle_ai [on|off] - toggle AI features\n' +
        'action:toggle_sync [on|off] - toggle bookmark sync\n' +
        'action:export - export shortcuts data\n' +
        'action:navigate [settings|bookmarks|shortcuts] - go to section\n' +
        'action:move_by_domain [domain] [folder] - move/add/group bookmarks from a domain into a folder (e.g. "add zoho bookmarks to Zoho folder", "which are of google put them in Google")\n' +
        'action:move_by_tag [tag] [folder] - move shortcuts with a tag into a folder\n' +
        'action:delete_folder [name] - delete/remove a bookmark folder\n' +
        'help [topic] - help with getting-started, omnibox, shortcuts, tags, dashboard, sync, keyboard, ai-features\n' +
        'out_of_scope - message is unrelated to bookmarks/0tab AI\n\n' +
        'User message: "' + query + '"\n\nIntent:';

      let response = await new Promise(function (resolve) {
        let timeout = setTimeout(function () { resolve(null); }, 5000);
        chrome.runtime.sendMessage({
          action: 'ai:chat',
          prompt: prompt
        }, function (r) {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(r);
        });
      });

      if (!response || !response.text) return null;
      let aiText = response.text.trim().toLowerCase();

      // Parse the AI response into an intent object
      if (aiText.startsWith('greeting')) return { intent: 'greeting' };
      if (aiText.startsWith('who_are_you')) return { intent: 'who_are_you' };
      if (aiText.startsWith('thanks')) return { intent: 'thanks' };
      if (aiText.startsWith('out_of_scope')) return null; // let fallback handle it

      if (aiText.startsWith('query:list_all')) {
        let type = /shortcut/i.test(aiText) ? 'shortcuts' : /bookmark/i.test(aiText) ? 'bookmarks' : 'all';
        return { intent: 'query:list_all', listType: type };
      }
      if (aiText.startsWith('query:count')) return { intent: 'query:count' };
      if (aiText.startsWith('query:most_used')) return { intent: 'query:most_used', limit: 5 };
      if (aiText.startsWith('query:least_used')) return { intent: 'query:least_used' };
      if (aiText.startsWith('query:recent_accessed') || aiText.startsWith('query:recently_accessed')) return { intent: 'query:recently_accessed' };
      if (aiText.startsWith('query:recent')) return { intent: 'query:recent' };
      if (aiText.startsWith('query:tags')) return { intent: 'query:tags' };
      if (aiText.startsWith('query:by_tag')) {
        let tag = aiText.replace(/^query:by_tag\s*/i, '').replace(/[\[\]]/g, '').trim();
        return { intent: 'query:by_tag', tag: tag || '' };
      }
      if (aiText.startsWith('query:by_domain')) {
        let domain = aiText.replace(/^query:by_domain\s*/i, '').replace(/[\[\]]/g, '').trim();
        return { intent: 'query:by_domain', domain: domain || '' };
      }
      if (aiText.startsWith('query:folder_contents')) {
        let folder = aiText.replace(/^query:folder_contents\s*/i, '').replace(/[\[\]]/g, '').trim();
        return { intent: 'query:folder_contents', folderName: folder || '' };
      }
      if (aiText.startsWith('query:folders')) return { intent: 'query:folders' };
      if (aiText.startsWith('query:duplicates')) return { intent: 'query:duplicates' };
      if (aiText.startsWith('query:usage_period')) {
        let period = aiText.match(/(week|month|year|day)/i);
        return { intent: 'query:usage_period', period: period ? period[1] : 'month' };
      }
      if (aiText.startsWith('query:search')) {
        let term = aiText.replace(/^query:search\s*/i, '').replace(/[\[\]]/g, '').trim();
        return { intent: 'query:search', term: term || query };
      }
      if (aiText.startsWith('action:save_bookmark')) return { intent: 'action:save_bookmark', url: null };
      if (aiText.startsWith('action:create_folder')) {
        let name = aiText.replace(/^action:create_folder\s*/i, '').replace(/[\[\]]/g, '').trim();
        return { intent: 'action:create_folder', folderName: name || null };
      }
      if (aiText.startsWith('action:open')) {
        let target = aiText.replace(/^action:open\s*/i, '').replace(/[\[\]]/g, '').trim();
        return { intent: 'action:open', target: target || '' };
      }
      if (aiText.startsWith('action:delete_shortcut')) {
        let name = aiText.replace(/^action:delete_shortcut\s*/i, '').replace(/[\[\]]/g, '').trim();
        return { intent: 'action:delete_shortcut', shortcutName: name || null };
      }
      if (aiText.startsWith('action:toggle_ai')) {
        return { intent: 'action:toggle_ai', enable: /on/i.test(aiText) };
      }
      if (aiText.startsWith('action:toggle_sync')) {
        return { intent: 'action:toggle_sync', enable: /on/i.test(aiText) };
      }
      if (aiText.startsWith('action:export')) return { intent: 'action:export' };
      if (aiText.startsWith('action:navigate')) {
        let section = aiText.match(/(settings|bookmarks|shortcuts)/i);
        return { intent: 'action:navigate', section: section ? section[1] : 'settings' };
      }
      if (aiText.startsWith('action:move_by_domain')) {
        let parts = aiText.replace(/^action:move_by_domain\s*/i, '').replace(/[\[\]]/g, '').trim().split(/\s+/);
        let aiDomain = parts[0] || '';
        let aiFolder = parts.slice(1).join(' ') || '';
        return { intent: 'action:move_by_domain', domain: aiDomain, folderName: aiFolder };
      }
      if (aiText.startsWith('action:move_by_tag')) {
        let parts = aiText.replace(/^action:move_by_tag\s*/i, '').replace(/[\[\]]/g, '').trim().split(/\s+/);
        let aiTag = parts[0] || '';
        let aiFolder = parts.slice(1).join(' ') || '';
        return { intent: 'action:move_by_tag', tag: aiTag, folderName: aiFolder };
      }
      if (aiText.startsWith('action:delete_folder')) {
        let aiFolder = aiText.replace(/^action:delete_folder\s*/i, '').replace(/[\[\]]/g, '').trim();
        return { intent: 'action:delete_folder', folderName: aiFolder || null };
      }
      if (aiText.startsWith('help')) {
        let topic = aiText.replace(/^help\s*/i, '').replace(/[\[\]]/g, '').trim();
        let matchedTopic = topic ? findHelpTopic(topic) : findHelpTopic(query);
        if (matchedTopic) return { intent: 'help', topic: matchedTopic };
        return { intent: 'who_are_you' }; // Default to capabilities overview
      }

      return null; // Could not parse AI response
    } catch (e) { return null; }
  }

  async function tryAiSearch(query, shortcuts) {
    let available = await checkChatAi();
    if (!available) return null;
    try {
      let response = await new Promise(function (resolve) {
        let timeout = setTimeout(function () { resolve({ results: null }); }, 5000);
        chrome.runtime.sendMessage({ action: 'ai:search', query: query, shortcuts: shortcuts.map(function (s) { return s.name; }) }, function (r) {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) { resolve({ results: null }); return; }
          resolve(r || { results: null });
        });
      });
      if (!response.results || !Array.isArray(response.results) || response.results.length === 0) return null;
      let aiMatches = response.results.map(function (name) { return shortcuts.find(function (s) { return s.name === name; }); }).filter(Boolean);
      if (aiMatches.length === 0) return null;
      let html = '<div style="margin-bottom:6px;">Found these related results:</div>';
      aiMatches.forEach(function (s) {
        let fav = chatGetFavicon(s.url);
        html += '<div class="chat-list-item"><img src="' + fav + '"><span class="chat-list-name">' + chatEscapeHtml(s.name) + '</span><span class="chat-list-meta">' + s.count + ' opens</span></div>';
      });
      return html;
    } catch (e) { return null; }
  }

  async function tryAiChat(query) {
    let available = await checkChatAi();
    if (!available) return null;
    try {
      // Get rich data context for the AI
      let shortcuts = await getAllShortcuts();
      let tree = await getBookmarkTree();
      let counts = countBookmarks(tree);
      let folders = flattenFolders(tree);
      let tagMap = {};
      let totalUses = 0;
      shortcuts.forEach(function (s) { totalUses += s.count; s.tags.forEach(function (t) { tagMap[t] = (tagMap[t] || 0) + 1; }); });
      let topShortcuts = shortcuts.slice().sort(function (a, b) { return b.count - a.count; }).slice(0, 10);

      // Data health signals
      let deadCount = shortcuts.filter(function (s) { return s.count === 0 && s.type !== 'folder'; }).length;
      let untaggedCount = shortcuts.filter(function (s) { return s.tags.length === 0 && s.type !== 'folder'; }).length;

      let context = 'You are Ask 0tab AI, a conversational co-pilot for 0tab AI (a Chrome bookmark manager extension). You are NOT just a command interface — you are a helpful assistant that users can talk to naturally.\n\n';
      context += 'ABOUT 0TAB AI: 0tab AI lets users create keyboard shortcuts for bookmarks. In your Chrome search bar, type 0+Tab, then type a shortcut name to open any bookmark instantly.\n\n';
      context += 'USER DATA:\n';
      context += '- ' + shortcuts.length + ' shortcuts, ' + counts.bookmarks + ' Chrome bookmarks, ' + folders.length + ' folders\n';
      context += '- ' + Object.keys(tagMap).length + ' unique tags, ' + totalUses + ' total opens\n';
      context += '- ' + deadCount + ' unused shortcuts, ' + untaggedCount + ' untagged shortcuts\n';
      context += '- Top tags: ' + Object.keys(tagMap).sort(function (a, b) { return tagMap[b] - tagMap[a]; }).slice(0, 10).join(', ') + '\n';
      context += '- Top shortcuts: ' + topShortcuts.map(function (s) { return s.name + ' (' + s.count + ' opens)'; }).join(', ') + '\n\n';
      // Include conversation history for context continuity
      let historyStr = getConversationContext();
      if (historyStr) {
        context += 'CONVERSATION HISTORY (recent messages):\n' + historyStr + '\n\n';
      }
      context += 'CAPABILITIES (what you can suggest the user try):\n';
      context += '- Query: list bookmarks, show stats, filter by tags/domains/folders, search\n';
      context += '- Actions: open/save/delete/rename shortcuts, create folders, export CSV\n';
      context += '- Copilot workflows: "clean up unused bookmarks", "organize my bookmarks into folders", "bulk tag my shortcuts"\n';
      context += '- Settings: toggle AI features, toggle bookmark sync, navigate to any dashboard section\n';
      context += '- Help: explain any 0tab AI feature\n\n';
      context += 'PERSONALITY RULES:\n';
      context += '- Always respond in English\n';
      context += '- Be warm, conversational, and concise (2-3 sentences max)\n';
      context += '- If the user asks something outside bookmarks/0tab AI, warmly redirect to what you CAN do\n';
      context += '- Proactively suggest actions based on the user\'s data (e.g., if they have many unused bookmarks, suggest cleanup)\n';
      context += '- Reference conversation history when relevant — remember what was just discussed\n';
      context += '- Be a co-pilot: anticipate needs, don\'t just answer questions\n\n';
      context += 'User says: "' + query + '"\n\nRespond:';

      let response = await new Promise(function (resolve) {
        let timeout = setTimeout(function () { resolve(null); }, 8000);
        chrome.runtime.sendMessage({
          action: 'ai:chat',
          prompt: context
        }, function (r) {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(r);
        });
      });
      if (response && response.text) {
        return chatEscapeHtml(response.text) + ' <span style="display:inline-block;background:var(--accent-secondary);color:#fff;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:600;opacity:0.7;vertical-align:middle;">AI</span>';
      }
      return null;
    } catch (e) { return null; }
  }

  // ============================================================
  // UI CONTROLLER
  // ============================================================
  let chatOpen = false;

  function initChat() {
    let widget = document.getElementById('chatWidget');
    let toggleBtn = document.getElementById('chatToggleBtn');
    let closeBtn = document.getElementById('chatCloseBtn');
    let panel = document.getElementById('chatPanel');
    let input = document.getElementById('chatInput');
    let sendBtn = document.getElementById('chatSendBtn');
    let mainEl = document.querySelector('.main');
    let resizeHandle = document.getElementById('chatResizeHandle');
    sendMessageFn = sendMessage;

    // Wire AI status pill once and seed initial state
    wireAiStatusPill();
    updateAiStatusPill();

    function openChat() {
      chatOpen = true;
      widget.classList.add('chat-open');
      panel.classList.remove('hidden');
      if (mainEl) mainEl.classList.add('chat-is-open');
      document.body.classList.add('chat-panel-open');
      // If 2 bookmark panels are open, collapse to 1 to make room
      if (typeof openPanels !== 'undefined' && openPanels.length > 1) {
        openPanels.splice(1);
        if (typeof renderAllPanels === 'function') renderAllPanels();
      }
      input.focus();
      // Refresh the AI status pill every open in case settings changed
      updateAiStatusPill();
      // Show dynamic welcome on first open
      if (!proactiveShown) {
        showDynamicWelcome();
      }
    }

    function closeChat() {
      chatOpen = false;
      widget.classList.remove('chat-open');
      panel.classList.add('hidden');
      if (mainEl) mainEl.classList.remove('chat-is-open');
      document.body.classList.remove('chat-panel-open');
    }

    toggleBtn.addEventListener('click', openChat);
    closeBtn.addEventListener('click', closeChat);

    sendBtn.addEventListener('click', function () {
      sendMessage();
    });

    // Auto-expanding textarea
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 100) + 'px';
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
        input.style.height = 'auto';
      }
    });

    // Resizable panel
    if (resizeHandle) {
      let isResizing = false;
      let startX, startWidth;

      resizeHandle.addEventListener('mousedown', function (e) {
        isResizing = true;
        startX = e.clientX;
        startWidth = widget.offsetWidth;
        resizeHandle.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });

      document.addEventListener('mousemove', function (e) {
        if (!isResizing) return;
        let diff = startX - e.clientX;
        let newWidth = Math.max(300, Math.min(startWidth + diff, window.innerWidth * 0.5));
        widget.style.width = newWidth + 'px';
        document.documentElement.style.setProperty('--chat-panel-width', newWidth + 'px');
      });

      document.addEventListener('mouseup', function () {
        if (isResizing) {
          isResizing = false;
          resizeHandle.classList.remove('dragging');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
      });
    }

    // Auto-open chat if ?openChat=1 is in the URL (from popup redirect)
    try {
      let params = new URLSearchParams(window.location.search);
      if (params.get('openChat') === '1') {
        openChat();
        window.history.replaceState({}, '', window.location.pathname);
      }
    } catch (e) {}

    // Initialize trash view in settings
    loadTrashView();

    // Auto-apply letter avatar fallback to all favicon images in chat
    // Auto-upgrade Google globe favicons in chat messages:
    // Try Chrome's _favicon API (same-origin, canvas-readable) to detect defaults
    let chatMsgs = document.getElementById('chatMessages');
    if (chatMsgs) {
      let favObserver = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
          m.addedNodes.forEach(function (node) {
            if (node.nodeType !== 1) return;
            let imgs = node.querySelectorAll ? node.querySelectorAll('img') : [];
            imgs.forEach(function (img) {
              if (img.hasAttribute('data-fav-handled')) return;
              img.setAttribute('data-fav-handled', '1');
              let src = img.getAttribute('src') || '';
              if (src.indexOf('google.com/s2/favicons') < 0) return;

              let nameEl = img.parentNode && (img.parentNode.querySelector('.chat-list-name') || img.parentNode.querySelector('.chat-card-name'));
              let name = (nameEl ? nameEl.textContent : '') || img.getAttribute('data-name') || '?';
              let size = img.width || 16;

              // Extract the page URL from the Google favicon URL
              let domainMatch = src.match(/domain=([^&]+)/);
              if (!domainMatch) return;
              let pageUrl = 'https://' + domainMatch[1];

              // Chrome's _favicon API as the authority (same-origin → canvas-readable)
              // If Chrome has a real favicon → use it. If not → letter avatar.
              try {
                let chromeFavUrl = chrome.runtime.getURL('_favicon/?pageUrl=' + encodeURIComponent(pageUrl) + '&size=' + (size > 16 ? 32 : 16));
                let testImg = new Image();
                testImg.onload = function () {
                  if (typeof isRealFavicon === 'function' && isRealFavicon(testImg)) {
                    // Chrome has a real favicon → use it directly
                    testImg.width = size;
                    testImg.height = size;
                    testImg.style.cssText = 'border-radius:4px;';
                    if (img.parentNode) img.parentNode.replaceChild(testImg, img);
                  } else {
                    // Chrome confirms no real favicon → letter avatar
                    let avatar = typeof createLetterAvatar === 'function' ? createLetterAvatar(name, size) : null;
                    if (avatar && img.parentNode) img.parentNode.replaceChild(avatar, img);
                  }
                };
                testImg.onerror = function () {
                  // _favicon failed → keep Google image as fallback
                };
                testImg.src = chromeFavUrl;
              } catch (e) {}
            });
          });
        });
      });
      favObserver.observe(chatMsgs, { childList: true, subtree: true });
    }
  }

  // Build clickable option pill HTML from array of {label, query} objects
  function buildOptionPills(options) {
    if (!options || options.length === 0) return '';
    let html = '<div class="chat-option-pills">';
    options.forEach(function (opt) {
      html += '<button class="chat-option-pill" data-query="' + chatEscapeHtml(opt.query) + '">' + chatEscapeHtml(opt.label) + '</button>';
    });
    html += '</div>';
    return html;
  }

  // Minimal post-render sanitizer. marked.js renders markdown faithfully,
  // which means a malicious input like `[x](javascript:alert(1))` becomes an
  // anchor with a javascript: href. We also defensively strip inline event
  // handlers and data:/vbscript: URLs. Applied to any innerHTML assignment
  // whose source is user-typed or AI-produced (bot messages).
  function sanitizeRenderedHtml(html) {
    if (!html || typeof html !== 'string') return html || '';
    let tmp = document.createElement('div');
    tmp.innerHTML = html;
    let nodes = tmp.querySelectorAll('*');
    for (let i = 0; i < nodes.length; i++) {
      let el = nodes[i];
      // Strip event-handler attributes (onclick, onerror, onload, etc.)
      let attrs = el.attributes;
      for (let j = attrs.length - 1; j >= 0; j--) {
        let name = attrs[j].name;
        if (/^on/i.test(name)) el.removeAttribute(name);
      }
      // Neutralize dangerous URL schemes on href/src/action
      ['href', 'src', 'xlink:href', 'action', 'formaction'].forEach(function (a) {
        let v = el.getAttribute && el.getAttribute(a);
        if (!v) return;
        let t = v.trim().toLowerCase();
        if (t.indexOf('javascript:') === 0 || t.indexOf('data:') === 0 || t.indexOf('vbscript:') === 0) {
          el.setAttribute(a, '#');
        }
      });
      // Drop elements that should never appear in chat output
      if (/^(script|iframe|object|embed)$/i.test(el.tagName)) {
        el.parentNode && el.parentNode.removeChild(el);
      }
    }
    return tmp.innerHTML;
  }

  function addMessage(role, html, options, meta) {
    let container = document.getElementById('chatMessages');
    let msg = document.createElement('div');
    msg.className = 'chat-msg chat-msg-' + role;
    let content = document.createElement('div');
    content.className = 'chat-msg-content';
    // Use markdown rendering for bot messages if marked.js is available
    if (role === 'bot' && typeof marked !== 'undefined' && typeof html === 'string' && !/<[a-z][\s\S]*>/i.test(html)) {
      try { content.innerHTML = sanitizeRenderedHtml(marked.parse(html)); } catch (e) { content.innerHTML = sanitizeRenderedHtml(html); }
    } else {
      content.innerHTML = role === 'bot' ? sanitizeRenderedHtml(html) : html;
    }
    // Append option pills if provided
    if (options && options.length > 0) {
      let pillsHtml = buildOptionPills(options);
      let pillsDiv = document.createElement('div');
      pillsDiv.innerHTML = pillsHtml;
      content.appendChild(pillsDiv.firstElementChild);
    }
    msg.appendChild(content);
    // Feedback bar for bot messages
    if (role === 'bot') {
      let feedbackBar = document.createElement('div');
      feedbackBar.className = 'chat-feedback-bar';
      let originalQuery = meta && meta.query ? meta.query : '';
      feedbackBar.innerHTML =
        '<button class="chat-feedback-btn" data-feedback="up" title="Helpful"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg></button>' +
        '<button class="chat-feedback-btn" data-feedback="down" title="Not helpful"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"/></svg></button>' +
        (originalQuery ? '<button class="chat-feedback-btn chat-retry-btn" data-feedback="retry" data-query="' + chatEscapeHtml(originalQuery) + '" title="Try again"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>' : '');
      msg.appendChild(feedbackBar);
      // Wire feedback clicks
      feedbackBar.querySelectorAll('.chat-feedback-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          let fb = btn.getAttribute('data-feedback');
          if (fb === 'retry') {
            let q = btn.getAttribute('data-query');
            if (q) { document.getElementById('chatInput').value = q; sendMessageFn(); }
            return;
          }
          if (fb === 'up') {
            feedbackBar.innerHTML = '<span class="chat-feedback-thanks">Thanks for the feedback!</span>';
          } else if (fb === 'down') {
            feedbackBar.innerHTML = '<span class="chat-feedback-thanks">Thanks! <a href="https://chromewebstore.google.com/detail/Tab0/ejcaloplfaackbkpdiidjgakbogilcdf?hl=en&authuser=0" target="_blank" class="chat-feedback-link">Leave a review</a> to help us improve.</span>';
          }
        });
      });
    }
    container.appendChild(msg);
    // Wire up option pill clicks
    msg.querySelectorAll('.chat-option-pill').forEach(function (pill) {
      pill.addEventListener('click', function () {
        let query = pill.getAttribute('data-query');
        if (query) {
          let input = document.getElementById('chatInput');
          if (input) { input.value = query; }
          if (typeof sendMessageFn === 'function') sendMessageFn();
        }
      });
    });
    // Wire up rich card actions
    wireCardActions(msg);
    // Scroll behavior
    if (role === 'user') {
      container.scrollTop = container.scrollHeight;
    } else {
      msg.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // Streaming typewriter effect for bot messages
  function addMessageStreaming(html, options, meta) {
    let container = document.getElementById('chatMessages');
    // Remove typing indicator
    hideTyping();
    let msg = document.createElement('div');
    msg.className = 'chat-msg chat-msg-bot';
    let content = document.createElement('div');
    content.className = 'chat-msg-content chat-streaming';
    msg.appendChild(content);
    container.appendChild(msg);
    msg.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Parse HTML into words/tokens for streaming
    let tempDiv = document.createElement('div');
    // Use markdown if it's plain text
    if (typeof marked !== 'undefined' && typeof html === 'string' && !/<[a-z][\s\S]*>/i.test(html)) {
      try { tempDiv.innerHTML = sanitizeRenderedHtml(marked.parse(html)); } catch (e) { tempDiv.innerHTML = sanitizeRenderedHtml(html); }
    } else {
      tempDiv.innerHTML = sanitizeRenderedHtml(html);
    }
    let fullHtml = tempDiv.innerHTML;

    // Add stop button during streaming
    let stopBtn = document.createElement('button');
    stopBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg> Stop';
    stopBtn.style.cssText = 'display:inline-flex;align-items:center;gap:4px;margin-top:8px;padding:3px 10px;font-size:11px;background:var(--bg-tertiary);color:var(--text-muted);border:1px solid var(--border-primary);border-radius:6px;cursor:pointer;';
    msg.appendChild(stopBtn);

    function onStreamEnd() {
      content.classList.remove('chat-streaming');
      if (stopBtn.parentNode) stopBtn.remove();
      // Add pills
      if (options && options.length > 0) {
        let pillsHtml = buildOptionPills(options);
        let pillsDiv = document.createElement('div');
        pillsDiv.innerHTML = pillsHtml;
        content.appendChild(pillsDiv.firstElementChild);
        msg.querySelectorAll('.chat-option-pill').forEach(function (pill) {
          pill.addEventListener('click', function () {
            let query = pill.getAttribute('data-query');
            if (query) {
              document.getElementById('chatInput').value = query;
              if (typeof sendMessageFn === 'function') sendMessageFn();
            }
          });
        });
      }
      // Add feedback bar
      let feedbackBar = document.createElement('div');
      feedbackBar.className = 'chat-feedback-bar';
      let originalQuery = meta && meta.query ? meta.query : '';
      feedbackBar.innerHTML =
        '<button class="chat-feedback-btn" data-feedback="up" title="Helpful"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg></button>' +
        '<button class="chat-feedback-btn" data-feedback="down" title="Not helpful"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"/></svg></button>' +
        (originalQuery ? '<button class="chat-feedback-btn chat-retry-btn" data-feedback="retry" data-query="' + chatEscapeHtml(originalQuery) + '" title="Try again"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>' : '');
      msg.appendChild(feedbackBar);
      feedbackBar.querySelectorAll('.chat-feedback-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          let fb = btn.getAttribute('data-feedback');
          if (fb === 'retry') {
            let q = btn.getAttribute('data-query');
            if (q) { document.getElementById('chatInput').value = q; sendMessageFn(); }
            return;
          }
          if (fb === 'up') {
            feedbackBar.innerHTML = '<span class="chat-feedback-thanks">Thanks for the feedback!</span>';
          } else if (fb === 'down') {
            feedbackBar.innerHTML = '<span class="chat-feedback-thanks">Thanks! <a href="https://chromewebstore.google.com/detail/Tab0/ejcaloplfaackbkpdiidjgakbogilcdf?hl=en&authuser=0" target="_blank" class="chat-feedback-link">Leave a review</a> to help us improve.</span>';
          }
        });
      });
      wireCardActions(msg);
    }

    // Stream character by character through HTML
    let charIndex = 0;
    let inTag = false;
    let streamInterval = setInterval(function () {
      if (charIndex >= fullHtml.length) {
        clearInterval(streamInterval);
        onStreamEnd();
        return;
      }
      // Skip through HTML tags instantly
      let charsToAdd = 3;
      while (charsToAdd > 0 && charIndex < fullHtml.length) {
        let ch = fullHtml[charIndex];
        if (ch === '<') inTag = true;
        if (inTag) {
          charIndex++;
          if (ch === '>') inTag = false;
          continue;
        }
        charIndex++;
        charsToAdd--;
      }
      content.innerHTML = fullHtml.substring(0, charIndex);
      container.scrollTop = container.scrollHeight;
    }, 12);

    // Stop button handler — immediately show full content
    stopBtn.addEventListener('click', function () {
      clearInterval(streamInterval);
      content.innerHTML = fullHtml;
      onStreamEnd();
    });
  }

  function showTyping() {
    let container = document.getElementById('chatMessages');
    let typing = document.createElement('div');
    typing.className = 'chat-typing';
    typing.id = 'chatTypingIndicator';
    typing.innerHTML = '<span></span><span></span><span></span>';
    container.appendChild(typing);
    typing.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function hideTyping() {
    let el = document.getElementById('chatTypingIndicator');
    if (el) el.remove();
  }

  async function sendMessage() {
    if (!sendMessageFn) sendMessageFn = sendMessage;
    let input = document.getElementById('chatInput');
    let query = input.value.trim();
    if (!query) return;

    // Track conversation history
    addToHistory('user', query);

    // Don't show internal command prefixes to user
    let displayQuery = query.replace(/^__open_folder_all__.*/, 'Open all bookmarks in folder')
                            .replace(/^__open_url__(.*)/, 'Open $1');
    addMessage('user', chatEscapeHtml(displayQuery));
    input.value = '';

    // Hide action area if visible
    let actionArea = document.getElementById('chatActionArea');
    if (actionArea) { actionArea.classList.add('hidden'); actionArea.innerHTML = ''; }

    showTyping();

    try {
      // FIRST: Check if we're in a multi-turn conversation state (confirmation, workflow, etc.)
      let stateResponse = await handleStateMachineInput(query);
      if (stateResponse) {
        hideTyping();
        let stateText = typeof stateResponse === 'object' && stateResponse.text ? stateResponse.text : stateResponse;
        addToHistory('bot', stateText.replace(/<[^>]+>/g, '').substring(0, 200));
        if (typeof stateResponse === 'object' && stateResponse.text) {
          addMessage('bot', stateResponse.text, stateResponse.options);
        } else {
          addMessage('bot', stateResponse);
        }
        return;
      }

      let parsed = parseIntent(query);

      // --- AI-first routing ---
      // If the regex matcher fell through to a vague intent (unknown,
      // query:smart_single, or query:search) AND Gemini Nano is available,
      // try AI classification BEFORE giving up. The regex remains the
      // first-pass parser (fast, free, deterministic) — AI is the
      // intelligent backup when the user phrasing doesn't match a rule.
      let vagueIntents = { 'unknown': 1, 'query:smart_single': 1, 'query:search': 1 };
      if (vagueIntents[parsed.intent] && query.length >= 3) {
        let aiClassified = await tryAiClassifyIntent(query);
        if (aiClassified && aiClassified.intent && aiClassified.intent !== 'out_of_scope') {
          parsed = aiClassified;
        }
      }

      // --- Pronoun / ordinal resolution from conversation memory ---
      // "open it", "delete that", "rename it to X", "open the second one"
      // → fill in the target from what we last referenced.
      let needsTarget = (parsed.intent === 'action:open' && (!parsed.target || parsed.target.length < 2 || /^(it|that|this|this\s+one|that\s+one|the\s+(?:first|second|third|last|\d+(?:st|nd|rd|th)?))$/i.test((parsed.target || '').trim()))) ||
                       (parsed.intent === 'action:delete_shortcut' && (!parsed.shortcutName || /^(it|that|this|this\s+one|that\s+one|the\s+(?:first|second|third|last|\d+(?:st|nd|rd|th)?))$/i.test((parsed.shortcutName || '').trim()))) ||
                       (parsed.intent === 'action:rename' && (!parsed.target || /^(it|that|this|this\s+one|that\s+one)$/i.test((parsed.target || '').trim())));
      if (needsTarget) {
        let resolved = resolveReferenceFromMemory(query);
        if (resolved) {
          if (parsed.intent === 'action:open') parsed.target = resolved;
          else if (parsed.intent === 'action:delete_shortcut') parsed.shortcutName = resolved;
          else if (parsed.intent === 'action:rename') {
            // Preserve "rename it to X" — keep the new name part
            let m = query.match(/(?:to|as|into)\s+(.+)$/i);
            parsed.target = m ? (resolved + ' to ' + m[1].trim()) : resolved;
          }
        }
      }

      let response = '';

      // If query contains non-Latin script and wasn't matched by a known intent regex,
      // show English-only message. Recognized Hinglish commands (kholo, karo, etc.) still work.
      if (isNonEnglishQuery(query) && (parsed.intent === 'unknown' || parsed.intent === 'query:search' || parsed.intent === 'query:smart_single')) {
        hideTyping();
        let options = await getUserContextOptions();
        addMessage('bot', 'I can currently only respond in <strong>English</strong>. Multilingual support is coming soon! In the meantime, you can use Hinglish commands like <em>"kholo"</em>, <em>"dikhao"</em>, <em>"hatao"</em> — or try one of these:', options.slice(0, 6));
        return;
      }

      // --- UNDO — uses conversation memory ---
      if (parsed.intent === 'action:undo') {
        let last = conversationState.memory.lastAction;
        if (!last || !last.undo) {
          response = 'There\'s nothing to undo right now.';
        } else {
          try {
            let undoResult = await last.undo();
            conversationState.memory.lastAction = null; // single-shot
            response = undoResult || 'Undone!';
          } catch (e) {
            response = 'Could not undo: ' + chatEscapeHtml(e && e.message || 'unknown error');
          }
        }
        hideTyping();
        addToHistory('bot', (response || '').toString().replace(/<[^>]+>/g, '').substring(0, 200));
        addMessageStreaming(response, null, { query: query });
        return;
      }

      switch (parsed.intent) {
        case 'greeting':
          response = await greetingResponse(query);
          break;
        case 'thanks':
          response = (await tryAiChat(query)) || 'Happy to help! Let me know if you need anything else.';
          break;
        case 'confused':
          response = await confusedResponse(query);
          break;
        case 'who_are_you':
          response = await whoAreYouResponse(query);
          break;
        case 'query:list_all':
          response = await handleQueryListAll(parsed.listType);
          break;
        case 'query:count':
          response = await handleQueryCount();
          break;
        case 'query:most_used':
          response = await handleQueryMostUsed(parsed.limit);
          break;
        case 'query:least_used':
          response = await handleQueryLeastUsed();
          break;
        case 'query:recent':
          response = await handleQueryRecent();
          break;
        case 'query:recently_accessed':
          response = await handleQueryRecentlyAccessed();
          break;
        case 'query:tags':
          response = await handleQueryTags();
          break;
        case 'query:by_tag':
          response = await handleQueryByTag(parsed.tag);
          break;
        case 'query:by_domain':
          response = await handleQueryByDomain(parsed.domain);
          break;
        case 'query:folder_contents':
          response = await handleQueryFolderContents(parsed.folderName);
          break;
        case 'query:usage_period':
          response = await handleQueryUsagePeriod(parsed.period);
          break;
        case 'query:search':
          response = await handleQuerySearch(parsed.term);
          break;
        case 'query:smart_single':
          // Check if it's a shortcut name first
          let singleShortcuts = await getAllShortcuts();
          let exactMatch = singleShortcuts.find(function (s) { return s.name.toLowerCase() === parsed.term; });
          if (exactMatch) {
            response = {
              text: 'Found your shortcut <strong>' + chatEscapeHtml(exactMatch.name) + '</strong> (' + chatEscapeHtml(exactMatch.url) + ').',
              options: [
                { label: 'Open ' + exactMatch.name, query: 'Open ' + exactMatch.name },
                { label: 'Delete ' + exactMatch.name, query: 'Delete shortcut ' + exactMatch.name }
              ]
            };
          } else {
            // Try partial match
            let partialMatches = singleShortcuts.filter(function (s) { return s.name.toLowerCase().includes(parsed.term); });
            if (partialMatches.length > 0) {
              response = '<div style="margin-bottom:6px;">Found ' + partialMatches.length + ' shortcut' + (partialMatches.length > 1 ? 's' : '') + ' matching <strong>' + chatEscapeHtml(parsed.term) + '</strong>:</div>';
              partialMatches.slice(0, 5).forEach(function (s) {
                let fav = chatGetFavicon(s.url);
                response += '<div class="chat-list-item"><img src="' + fav + '"><span class="chat-list-name">' + chatEscapeHtml(s.name) + '</span><span class="chat-list-meta">' + s.count + ' opens</span></div>';
              });
            } else {
              response = null; // Fall through to default/AI
            }
          }
          if (!response) {
            // Not a shortcut — try AI classification then AI chat
            let smartAiIntent = await tryAiClassifyIntent(parsed.term);
            if (smartAiIntent && smartAiIntent.intent !== 'out_of_scope') {
              switch (smartAiIntent.intent) {
                case 'greeting': response = await greetingResponse(parsed.term); break;
                case 'who_are_you': response = await whoAreYouResponse(parsed.term); break;
                case 'thanks': response = (await tryAiChat(parsed.term)) || 'Happy to help! Let me know if you need anything else.'; break;
                default: response = null;
              }
            }
            if (!response) {
              let smartAiChat = await tryAiChat(parsed.term);
              response = smartAiChat || (await confusedResponse(parsed.term, true));
            }
          }
          break;
        case 'unknown':
          // Unknown short message — try AI first
          let unknownAiIntent = await tryAiClassifyIntent(query);
          if (unknownAiIntent) {
            switch (unknownAiIntent.intent) {
              case 'greeting': response = await greetingResponse(query); break;
              case 'who_are_you': response = await whoAreYouResponse(query); break;
              case 'thanks': response = (await tryAiChat(query)) || 'Happy to help!'; break;
              case 'query:count': response = await handleQueryCount(); break;
              case 'query:list_all': response = await handleQueryListAll(unknownAiIntent.listType || 'all'); break;
              case 'query:tags': response = await handleQueryTags(); break;
              case 'query:folders': response = await handleQueryFolders(); break;
              case 'action:save_bookmark': response = await showSaveBookmarkForm(null); break;
              default: response = null;
            }
            if (response) {
              break;
            }
          }
          let unknownAiChat = await tryAiChat(query);
          response = unknownAiChat || (await confusedResponse(query, true));
          break;
        case 'action:save_bookmark':
          response = await showSaveBookmarkForm(parsed.url);
          break;
        case 'action:create_folder':
          response = await handleCreateFolder(parsed.folderName);
          break;
        case 'action:open':
          response = await handleOpenShortcut(parsed.target);
          break;
        case 'action:open_folder_all':
          try {
            let subTree = await new Promise(function (resolve) {
              chrome.bookmarks.getSubTree(parsed.folderId, function (r) { resolve(r || []); });
            });
            let folderUrls = [];
            if (subTree[0] && subTree[0].children) {
              subTree[0].children.forEach(function (c) { if (c.url) folderUrls.push(c.url); });
            }
            if (folderUrls.length > 0) {
              let folderName = (subTree[0] && subTree[0].title) ? subTree[0].title : 'Folder';
              // Check tab group setting
              let chatSettings = await new Promise(function (resolve) {
                chatStorageGet(['__0tab_settings']).then(function (r) { resolve((r && r['__0tab_settings']) || {}); });
              });
              let chatUseTabGroup = chatSettings.tabGroupFolders !== false;
              // Send to background to open with tab group support
              await new Promise(function (resolve) {
                chrome.runtime.sendMessage({
                  action: 'openFolderInTabGroup',
                  urls: folderUrls,
                  groupName: folderName,
                  useTabGroup: chatUseTabGroup
                }, function () { resolve(); });
              });
            }
            response = 'Opened <strong>' + folderUrls.length + '</strong> bookmarks from the folder.';
          } catch (e) { response = 'Failed to open folder: ' + chatEscapeHtml(e.message); }
          break;
        case 'action:open_url':
          chrome.tabs.create({ url: parsed.url });
          response = 'Opening...';
          break;
        case 'action:delete_shortcut':
          response = await handleDeleteShortcut(parsed.shortcutName);
          break;
        case 'action:toggle_ai':
          response = await handleToggleAi(parsed.enable);
          break;
        case 'action:toggle_sync':
          response = await handleToggleSync(parsed.enable);
          break;
        case 'action:export':
          response = await handleExport();
          break;
        case 'action:navigate':
          response = handleNavigate(parsed.section);
          break;
        case 'query:duplicates':
          response = await handleQueryDuplicates();
          break;
        case 'query:folders':
          response = await handleQueryFolders();
          break;
        case 'query:trash':
          response = await handleShowTrash();
          break;
        case 'help':
          response = '<strong>' + parsed.topic.title + '</strong>' + parsed.topic.body;
          break;
        case 'workflow:cleanup':
          response = await startCleanupWorkflow();
          break;
        case 'workflow:organize':
          response = await startOrganizeWorkflow();
          break;
        case 'workflow:bulk_tag':
          response = await startBulkTagWorkflow();
          break;
        case 'action:move_by_domain':
          response = await handleMoveByDomain(parsed.domain, parsed.folderName);
          break;
        case 'action:move_by_tag':
          response = await handleMoveByTag(parsed.tag, parsed.folderName);
          break;
        case 'action:delete_folder':
          response = await handleDeleteFolder(parsed.folderName);
          break;
        case 'action:rename':
          response = await handleRenameShortcut(parsed.target);
          break;
        default:
          // LAYER 2: Try AI intent classification before giving up
          let aiIntent = await tryAiClassifyIntent(query);
          if (aiIntent) {
            // Re-dispatch with AI-classified intent
            parsed = aiIntent;
            switch (parsed.intent) {
              case 'greeting': response = await greetingResponse(query); break;
              case 'who_are_you': response = await whoAreYouResponse(query); break;
              case 'thanks': response = (await tryAiChat(query)) || 'Happy to help! Let me know if you need anything else.'; break;
              case 'query:list_all': response = await handleQueryListAll(parsed.listType); break;
              case 'query:count': response = await handleQueryCount(); break;
              case 'query:most_used': response = await handleQueryMostUsed(parsed.limit || 5); break;
              case 'query:least_used': response = await handleQueryLeastUsed(); break;
              case 'query:recent': response = await handleQueryRecent(); break;
              case 'query:recently_accessed': response = await handleQueryRecentlyAccessed(); break;
              case 'query:tags': response = await handleQueryTags(); break;
              case 'query:by_tag': response = await handleQueryByTag(parsed.tag); break;
              case 'query:by_domain': response = await handleQueryByDomain(parsed.domain); break;
              case 'query:folder_contents': response = await handleQueryFolderContents(parsed.folderName); break;
              case 'query:folders': response = await handleQueryFolders(); break;
              case 'query:trash': response = await handleShowTrash(); break;
              case 'query:duplicates': response = await handleQueryDuplicates(); break;
              case 'query:usage_period': response = await handleQueryUsagePeriod(parsed.period); break;
              case 'query:search': response = await handleQuerySearch(parsed.term); break;
              case 'action:save_bookmark': response = await showSaveBookmarkForm(parsed.url); break;
              case 'action:create_folder': response = await handleCreateFolder(parsed.folderName); break;
              case 'action:open': response = await handleOpenShortcut(parsed.target); break;
              case 'action:delete_shortcut': response = await handleDeleteShortcut(parsed.shortcutName); break;
              case 'action:toggle_ai': response = await handleToggleAi(parsed.enable); break;
              case 'action:toggle_sync': response = await handleToggleSync(parsed.enable); break;
              case 'action:export': response = await handleExport(); break;
              case 'action:navigate': response = handleNavigate(parsed.section); break;
              case 'action:move_by_domain': response = await handleMoveByDomain(parsed.domain, parsed.folderName); break;
              case 'action:move_by_tag': response = await handleMoveByTag(parsed.tag, parsed.folderName); break;
              case 'action:delete_folder': response = await handleDeleteFolder(parsed.folderName); break;
              case 'help': response = '<strong>' + parsed.topic.title + '</strong>' + parsed.topic.body; break;
              default: response = null;
            }
            if (response) {
              break;
            }
          }
          // LAYER 3: Try AI free-form chat with full context
          let aiResponse = await tryAiChat(query);
          if (aiResponse) {
            response = aiResponse;
          } else {
            // LAYER 4: Smart contextual fallback with options (no AI available)
            response = await confusedResponse(query, true);
          }
      }

      hideTyping();
      let metaInfo = { query: query };
      if (typeof response === 'object' && response.text) {
        addToHistory('bot', response.text.replace(/<[^>]+>/g, '').substring(0, 200));
        addMessageStreaming(response.text, response.options, metaInfo);
      } else {
        addToHistory('bot', (response || '').toString().replace(/<[^>]+>/g, '').substring(0, 200));
        addMessageStreaming(response || 'I\'m not sure how to help with that. Try asking about your bookmarks!', null, metaInfo);
      }
    } catch (e) {
      hideTyping();
      addMessage('bot', 'Something went wrong: ' + chatEscapeHtml(e.message));
    }
  }

  // ============================================================
  // TRASH VIEW (Settings Page)
  // ============================================================
  async function loadTrashView() {
    let trashList = document.getElementById('trashList');
    if (!trashList) return;
    let items = await getTrashItems();
    if (items.length === 0) {
      trashList.innerHTML = '<div class="empty-msg">Trash is empty.</div>';
      return;
    }
    let html = '';
    items.forEach(function (item, idx) {
      let fav = chatGetFavicon(item.url);
      let deletedAgo = chatTimeAgo(item.deletedAt);
      html += '<div class="trash-item" data-index="' + idx + '">';
      html += '<img src="' + fav + '" class="trash-item-favicon">';
      html += '<div class="trash-item-info"><span class="trash-item-name">' + chatEscapeHtml(item.name) + '</span>';
      html += '<span class="trash-item-meta">' + chatEscapeHtml(item.url.substring(0, 50)) + (item.url.length > 50 ? '...' : '') + ' &middot; deleted ' + deletedAgo + '</span></div>';
      html += '<button class="trash-restore-btn" data-index="' + idx + '">Restore</button>';
      html += '</div>';
    });
    html += '<div style="margin-top:12px;"><button id="clearTrashBtn" class="btn btn-sm btn-outline" style="color:var(--danger);border-color:var(--danger);">Empty Trash</button></div>';
    trashList.innerHTML = html;
    // Wire restore buttons
    trashList.querySelectorAll('.trash-restore-btn').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        let idx = parseInt(btn.getAttribute('data-index'));
        let restored = await restoreFromTrash(idx);
        if (restored) {
          loadTrashView();
          if (typeof loadShortcutsTable === 'function') loadShortcutsTable();
        }
      });
    });
    let clearBtn = document.getElementById('clearTrashBtn');
    if (clearBtn) {
      clearBtn.addEventListener('click', async function () {
        await clearTrash();
        loadTrashView();
      });
    }
  }

  // Expose loadTrashView globally for settings navigation
  window.loadTrashView = loadTrashView;

  // Dynamic welcome card with personalized content
  async function showDynamicWelcome() {
    let container = document.getElementById('chatMessages');
    if (!container) return;

    // Get user's name from Chrome profile
    let userName = '';
    try {
      let profileInfo = await new Promise(function (resolve) {
        if (chrome.identity && chrome.identity.getProfileUserInfo) {
          chrome.identity.getProfileUserInfo(function (info) {
            if (chrome.runtime.lastError) resolve({});
            else resolve(info || {});
          });
        } else { resolve({}); }
      });
      if (profileInfo.email) {
        userName = profileInfo.email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
      }
    } catch (e) {}

    // Get bookmark stats
    let shortcuts = await getAllShortcuts();
    let tree = await getBookmarkTree();
    let counts = countBookmarks(tree);
    let folders = flattenFolders(tree);
    let totalUses = 0;
    shortcuts.forEach(function (s) { totalUses += s.count; });

    let greeting = userName ? 'Hey ' + chatEscapeHtml(userName) + '!' : 'Hey!';
    let statsLine = '<span style="color:var(--text-secondary);font-size:12px;">' + counts.bookmarks + ' bookmarks &middot; ' + shortcuts.length + ' shortcuts &middot; ' + folders.length + ' folders</span>';

    let welcomeHtml = '<div class="chat-welcome-card">';
    welcomeHtml += '<div class="chat-welcome-greeting">' + greeting + '</div>';
    welcomeHtml += '<div class="chat-welcome-subtitle">I\'m your bookmark co-pilot. ' + statsLine + '</div>';
    welcomeHtml += '</div>';

    addMessage('bot', welcomeHtml, null);

    // Show proactive insight(s) — top one as primary, next one as a
    // softer follow-up so the chat feels alive even before user types.
    let insight = await generateProactiveInsight();
    if (insight) {
      addMessage('bot', insight.text, insight.options);
      let allInsights = generateProactiveInsight._all || [];
      if (allInsights.length > 1) {
        let second = allInsights[1];
        addMessage('bot', second.text, second.options);
      }
    } else {
      // Default suggestions
      let options = await getUserContextOptions();
      addMessage('bot', 'What would you like to do?', options.slice(0, 4));
    }

    // "What I can do" expandable
    let capMsg = document.createElement('div');
    capMsg.className = 'chat-msg chat-msg-bot';
    let capContent = document.createElement('div');
    capContent.className = 'chat-msg-content';
    capContent.innerHTML = '<details class="chat-capabilities"><summary style="cursor:pointer;font-size:12px;color:var(--accent);font-weight:500;">What I can do</summary>' +
      '<div style="font-size:12px;margin-top:8px;line-height:1.7;color:var(--text-secondary);">' +
      '<strong style="color:var(--text-primary);">Find & Open</strong> — "open gmail", "find work links"<br>' +
      '<strong style="color:var(--text-primary);">Save & Organize</strong> — "save a bookmark", "organize bookmarks"<br>' +
      '<strong style="color:var(--text-primary);">Clean Up</strong> — "clean up unused", "find duplicates"<br>' +
      '<strong style="color:var(--text-primary);">Analyze</strong> — "how many bookmarks?", "most used"<br>' +
      '<strong style="color:var(--text-primary);">Manage</strong> — "rename shortcut", "bulk tag", "export"' +
      '</div></details>';
    capMsg.appendChild(capContent);
    container.appendChild(capMsg);

    proactiveShown = true;
  }

  // ============================================================
  // INIT
  // ============================================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChat);
  } else {
    initChat();
  }

})();
