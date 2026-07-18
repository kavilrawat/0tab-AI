// ============================================================
// 0TAB AI - Offscreen Document for Gemini Nano Prompt API
// Runs in a web context where LanguageModel is available.
// The background service worker communicates via chrome.runtime messages.
// ============================================================

let aiSession = null;
const SYSTEM_PROMPT = 'You are 0tab, a bookmark assistant inside a Chrome extension. Always respond with valid JSON only — no markdown, no explanation, no extra text. Be concise and accurate.';

// Resolve the LanguageModel API
function getAPI() {
  if (typeof LanguageModel !== 'undefined') return LanguageModel;
  if (self.ai && self.ai.languageModel) return self.ai.languageModel;
  return null;
}

// Build a create() options object compatible with both the current and
// the newer Chrome LanguageModel spec. We declare expected input/output
// languages so Chrome won't emit the "No output language was specified"
// console warning on every prompt.
function buildCreateOptions(extra) {
  let opts = Object.assign({
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
    // Legacy field name (older Chrome versions) — harmless on newer.
    expectedOutputLanguages: ['en']
  }, extra || {});
  return opts;
}

async function checkAvailability() {
  try {
    let api = getAPI();
    if (!api) return 'no';
    // Modern API: availability() reports the model state without the side
    // effect of create() (which can implicitly kick off a download). This
    // is what lets the Settings page show the "Download model" button.
    if (typeof api.availability === 'function') {
      // Declare languages — Chrome logs a "No output language was specified"
      // warning on LanguageModel API requests without them.
      let status = await api.availability({
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }]
      });
      if (status === 'downloadable' || status === 'after-download') return 'downloadable';
      if (status === 'downloading') return 'downloading';
      if (status !== 'available' && status !== 'readily') return 'no';
      // Fall through to a real create() so "available" isn't a false positive.
    }
    if (typeof api.create !== 'function') return 'no';
    // Must actually try creating a session to know if model is available.
    // Just checking if LanguageModel global exists is not enough — it exists
    // on all Chromium browsers even without the model downloaded.
    let testSession = await api.create(buildCreateOptions());
    if (testSession) {
      aiSession = testSession; // reuse session
      return 'readily';
    }
    return 'no';
  } catch (e) {
    return 'no';
  }
}

async function getSession() {
  if (aiSession) return aiSession;
  try {
    let api = getAPI();
    if (!api) return null;
    aiSession = await api.create(buildCreateOptions({ systemPrompt: SYSTEM_PROMPT }));
    return aiSession;
  } catch (e) {
    console.warn('0tab offscreen: session creation failed:', e.message);
    aiSession = null;
    return null;
  }
}

// Wrap session.prompt to always pass outputLanguage on every request —
// newer Chrome builds require it on the call, not just session creation.
function promptWithLanguage(session, text) {
  try {
    return session.prompt(text, { outputLanguage: 'en' });
  } catch (e) {
    // Older API doesn't accept the second arg
    return session.prompt(text);
  }
}

function destroySession() {
  if (aiSession && aiSession.destroy) {
    try { aiSession.destroy(); } catch (e) {}
  }
  aiSession = null;
}

// Auto-destroy session after 5 minutes of inactivity
let idleTimer = null;
function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(destroySession, 5 * 60 * 1000);
}

// Handle messages from the background service worker
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request.target !== 'offscreen') return false;

  if (request.action === 'ai:check') {
    checkAvailability().then(function (status) {
      sendResponse({ status: status });
    });
    return true;
  }


  if (request.action === 'ai:prompt') {
    (async function () {
      try {
        let session = await getSession();
        if (!session) { sendResponse({ error: 'no session' }); return; }
        resetIdleTimer();
        let result = await promptWithLanguage(session, request.prompt);
        sendResponse({ result: result });
      } catch (e) {
        // Session might be stale — destroy and retry once
        destroySession();
        try {
          let session = await getSession();
          if (!session) { sendResponse({ error: 'retry failed' }); return; }
          let result = await promptWithLanguage(session, request.prompt);
          sendResponse({ result: result });
        } catch (e2) {
          sendResponse({ error: e2.message });
        }
      }
    })();
    return true;
  }

  if (request.action === 'ai:destroy') {
    destroySession();
    sendResponse({ ok: true });
    return true;
  }

  // Trigger model download — creating a session with monitor reports progress
  if (request.action === 'ai:download') {
    (async function () {
      try {
        let api = getAPI();
        if (!api) { sendResponse({ error: 'API not available' }); return; }
        let session = await api.create(buildCreateOptions({
          monitor: function (m) {
            m.addEventListener('downloadprogress', function (e) {
              chrome.runtime.sendMessage({
                target: 'background',
                action: 'ai:downloadProgress',
                loaded: e.loaded,
                total: e.total
              });
            });
          }
        }));
        // Session created means download completed
        if (session && session.destroy) session.destroy();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  return false;
});
