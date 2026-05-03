/**
 * background.js — Service Worker for Badge Updates
 *
 * Chrome's "always-on" background script for Tab Out.
 * Its only job: keep the toolbar badge showing the current open tab count.
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts real web tabs (skipping chrome:// and extension pages).
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#3d7a4a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' });
  }
}


// Workspace windows ---------------------------------------------------------
//
// workspaceWindows is stored as { [windowId]: workspaceId }. When a workspace
// is opened from the dashboard, app.js registers the newly-created Chrome
// window here. From then on, tab changes in that window update the saved
// workspace automatically.

function isSaveableWorkspaceTab(tab) {
  const url = tab.url || tab.pendingUrl || '';
  if (!url) return false;
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return false;
  if (url.startsWith('edge://') || url.startsWith('about:')) return false;
  if (url.startsWith('devtools://')) return false;
  return /^(https?|file|ftp):/i.test(url);
}

function getHostFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

async function getWorkspaceWindows() {
  const { workspaceWindows = {} } = await chrome.storage.local.get('workspaceWindows');
  return workspaceWindows;
}

async function setWorkspaceWindows(workspaceWindows) {
  await chrome.storage.local.set({ workspaceWindows });
}

async function registerWorkspaceWindow(workspaceId, windowId) {
  if (!workspaceId || !windowId) return;
  const workspaceWindows = await getWorkspaceWindows();
  workspaceWindows[String(windowId)] = workspaceId;
  await setWorkspaceWindows(workspaceWindows);
  await syncWorkspaceWindow(windowId);
}

async function removeWorkspaceWindow(windowId) {
  const workspaceWindows = await getWorkspaceWindows();
  const key = String(windowId);
  if (!workspaceWindows[key]) return;
  delete workspaceWindows[key];
  await setWorkspaceWindows(workspaceWindows);
}

async function workspaceIdForWindow(windowId) {
  const workspaceWindows = await getWorkspaceWindows();
  return workspaceWindows[String(windowId)] || null;
}

async function syncWorkspaceWindow(windowId) {
  const workspaceWindows = await getWorkspaceWindows();
  const workspaceId = workspaceWindows[String(windowId)];
  if (!workspaceId) return;

  let tabs;
  try {
    tabs = await chrome.tabs.query({ windowId: Number(windowId) });
  } catch {
    return;
  }

  const savedTabs = tabs
    .filter(isSaveableWorkspaceTab)
    .sort((a, b) => a.index - b.index)
    .map(tab => {
      const url = tab.url || tab.pendingUrl || '';
      return {
        url,
        title: tab.title || '',
        host: getHostFromUrl(url),
      };
    });

  const { workspaces = [] } = await chrome.storage.local.get('workspaces');
  const idx = workspaces.findIndex(ws => ws.id === workspaceId);
  if (idx === -1) {
    delete workspaceWindows[String(windowId)];
    await setWorkspaceWindows(workspaceWindows);
    return;
  }

  workspaces[idx] = {
    ...workspaces[idx],
    tabs: savedTabs,
    savedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ workspaces });
}

async function syncIfWorkspaceWindow(windowId) {
  if (!windowId) return;
  const workspaceId = await workspaceIdForWindow(windowId);
  if (!workspaceId) return;
  await syncWorkspaceWindow(windowId);
}

async function cleanupWorkspaceWindows() {
  const workspaceWindows = await getWorkspaceWindows();
  const ids = Object.keys(workspaceWindows);
  if (ids.length === 0) return;

  const openWindows = await chrome.windows.getAll();
  const openIds = new Set(openWindows.map(win => String(win.id)));
  let changed = false;

  for (const id of ids) {
    if (!openIds.has(id)) {
      delete workspaceWindows[id];
      changed = true;
    }
  }

  if (changed) await setWorkspaceWindows(workspaceWindows);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'tab-out:workspace-window-opened') return;

  registerWorkspaceWindow(message.workspaceId, message.windowId)
    .then(() => sendResponse({ ok: true }))
    .catch(err => {
      console.warn('[tab-out] Failed to register workspace window:', err);
      sendResponse({ ok: false });
    });

  return true;
});

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
  cleanupWorkspaceWindows().catch(() => {});
});

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  cleanupWorkspaceWindows().catch(() => {});
});

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener(tab => {
  updateBadge();
  syncIfWorkspaceWindow(tab.windowId).catch(() => {});
});

// Update badge whenever a tab is closed
// When the window is closing (isWindowClosing), we sync once on the first
// removal so the workspace saves its tab list while tabs are still queryable.
// Subsequent removals for the same closing window are skipped to avoid
// progressively overwriting with fewer and fewer tabs.
const closingWindows = new Set();

chrome.tabs.onRemoved.addListener((_tabId, removeInfo) => {
  updateBadge();

  if (removeInfo.isWindowClosing) {
    if (closingWindows.has(removeInfo.windowId)) return;
    closingWindows.add(removeInfo.windowId);
    syncIfWorkspaceWindow(removeInfo.windowId)
      .finally(() => { closingWindows.delete(removeInfo.windowId); })
      .catch(() => {});
  } else {
    syncIfWorkspaceWindow(removeInfo.windowId).catch(() => {});
  }
});

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  updateBadge();
  if (changeInfo.url || changeInfo.title || changeInfo.status || tab.pendingUrl) {
    syncIfWorkspaceWindow(tab.windowId).catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(activeInfo => {
  syncIfWorkspaceWindow(activeInfo.windowId).catch(() => {});
});

chrome.tabs.onMoved.addListener((_tabId, moveInfo) => {
  syncIfWorkspaceWindow(moveInfo.windowId).catch(() => {});
});

chrome.tabs.onAttached.addListener((_tabId, attachInfo) => {
  syncIfWorkspaceWindow(attachInfo.newWindowId).catch(() => {});
});

chrome.tabs.onDetached.addListener((_tabId, detachInfo) => {
  syncIfWorkspaceWindow(detachInfo.oldWindowId).catch(() => {});
});

chrome.tabs.onReplaced.addListener((addedTabId) => {
  chrome.tabs.get(addedTabId)
    .then(tab => syncIfWorkspaceWindow(tab.windowId))
    .catch(() => {});
});

chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    syncIfWorkspaceWindow(windowId).catch(() => {});
  }
});

chrome.windows.onRemoved.addListener(windowId => {
  removeWorkspaceWindow(windowId).catch(() => {});
});

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();
cleanupWorkspaceWindows().catch(() => {});
