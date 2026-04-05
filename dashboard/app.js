/* ================================================================
   Tab Mission Control — Dashboard App

   This file is the brain of the dashboard. It:
   1. Talks to the Chrome extension (to read/close actual browser tabs)
   2. Fetches mission data from our Express server (/api/missions)
   3. Renders mission cards, banners, stats, and the scatter meter
   4. Handles all user actions (close tabs, archive, dismiss, focus)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   EXTENSION BRIDGE

   The dashboard runs in an iframe inside the Chrome extension's
   new-tab page. To communicate with the extension's background
   script, we use window.postMessage — the extension's content
   script listens and relays messages.

   When running in a regular browser tab (dev mode), we gracefully
   fall back without crashing.
   ---------------------------------------------------------------- */

// Track whether the extension is actually available (set after first successful call)
let extensionAvailable = false;

// Track all open tabs fetched from the extension (array of tab objects)
let openTabs = [];

/**
 * sendToExtension(action, data)
 *
 * Sends a message to the parent frame (the Chrome extension) and
 * waits up to 3 seconds for a response.
 *
 * Think of it like sending a text message and waiting for a reply —
 * if no reply comes in 3 seconds, we give up gracefully.
 */
function sendToExtension(action, data = {}) {
  return new Promise((resolve) => {
    // If we're not inside an iframe, there's no extension to talk to
    if (window.parent === window) {
      resolve({ success: false, reason: 'not-in-extension' });
      return;
    }

    // Generate a random ID so we can match the response to this specific request
    const messageId = 'tmc-' + Math.random().toString(36).slice(2);

    // Set a 3-second timeout in case the extension doesn't respond
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ success: false, reason: 'timeout' });
    }, 3000);

    // Listen for the matching response from the extension
    function handler(event) {
      if (event.data && event.data.messageId === messageId) {
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        resolve(event.data);
      }
    }

    window.addEventListener('message', handler);

    // Send the message to the parent frame (extension)
    window.parent.postMessage({ action, messageId, ...data }, '*');
  });
}

/**
 * fetchOpenTabs()
 *
 * Asks the extension for the list of currently open browser tabs.
 * Sets extensionAvailable = true if it works, false otherwise.
 */
async function fetchOpenTabs() {
  const result = await sendToExtension('getTabs');
  if (result && result.success && Array.isArray(result.tabs)) {
    openTabs = result.tabs;
    extensionAvailable = true;
  } else {
    openTabs = [];
    extensionAvailable = false;
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Tells the extension to close all tabs matching the given URLs.
 * After closing, we re-fetch the tab list so our state stays accurate.
 */
async function closeTabsByUrls(urls) {
  if (!extensionAvailable || !urls || urls.length === 0) return;
  await sendToExtension('closeTabs', { urls });
  // Refresh our local tab list to reflect what was closed
  await fetchOpenTabs();
}

/**
 * focusTabsByUrls(urls)
 *
 * Tells the extension to bring the first matching tab into focus
 * (switch to that tab in Chrome). Used by the "Focus on this" button.
 */
async function focusTabsByUrls(urls) {
  if (!extensionAvailable || !urls || urls.length === 0) return;
  await sendToExtension('focusTabs', { urls });
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * showToast(message)
 *
 * Shows a brief pop-up notification at the bottom of the screen.
 * Like the little notification that pops up when you send a message.
 */
/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — this creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card in two phases:
 * 1. Fade out + slide right (GPU-accelerated, smooth)
 * 2. After fade completes, collapse the height
 * 3. After collapse, remove from DOM
 */
function animateCardOut(card) {
  if (!card) return;
  // Set explicit max-height so the collapse transition has a starting value
  card.style.maxHeight = card.offsetHeight + 'px';
  // Phase 1: fade + slide
  card.classList.add('closing');
  // Phase 2: collapse height after fade finishes
  setTimeout(() => {
    card.classList.add('collapsed');
    // Phase 3: remove from DOM after collapse
    setTimeout(() => card.remove(), 280);
  }, 320);
}

function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * e.g. "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';

  const then = new Date(dateStr);
  const now = new Date();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting()
 *
 * Returns an appropriate greeting based on the current hour.
 * Morning = before noon, Afternoon = noon–5pm, Evening = after 5pm.
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning, Zara';
  if (hour < 17) return 'Good afternoon, Zara';
  return 'Good evening, Zara';
}

/**
 * getDateDisplay()
 *
 * Returns a formatted date string like "Friday, April 4, 2026".
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

/**
 * countOpenTabsForMission(missionUrls)
 *
 * Counts how many of the user's currently open browser tabs
 * match any of the URLs associated with a mission.
 *
 * We match by domain (hostname) rather than exact URL, because
 * the exact URL often changes (e.g. page IDs, session tokens).
 */
function countOpenTabsForMission(missionUrls) {
  return getOpenTabsForMission(missionUrls).length;
}

/**
 * getOpenTabsForMission(missionUrls)
 *
 * Returns the actual tab objects from openTabs that match
 * any URL in the mission's URL list (matched by domain).
 */
function getOpenTabsForMission(missionUrls) {
  if (!missionUrls || missionUrls.length === 0 || openTabs.length === 0) return [];

  // Extract the domains from the mission's saved URLs
  // missionUrls can be either URL strings or objects with a .url property
  const missionDomains = missionUrls.map(item => {
    const urlStr = (typeof item === 'string') ? item : (item.url || '');
    try {
      return new URL(urlStr.startsWith('http') ? urlStr : 'https://' + urlStr).hostname;
    } catch {
      return urlStr;
    }
  });

  // Find open tabs whose hostname matches any mission domain
  return openTabs.filter(tab => {
    try {
      const tabDomain = new URL(tab.url).hostname;
      return missionDomains.some(d => tabDomain.includes(d) || d.includes(tabDomain));
    } catch {
      return false;
    }
  });
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS

   We store these as a constant so we can reuse them in buttons
   without writing raw SVG every time. Each value is an HTML string
   ready to be injected with innerHTML.
   ---------------------------------------------------------------- */
const ICONS = {
  // Tab/browser icon — used in the "N tabs open" badge
  tabs: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,

  // X / close icon — used in "Close N tabs" button
  close: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,

  // Archive / trash icon — used in "Close & archive" button
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,

  // Arrow up-right — used in "Focus on this" button
  focus: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`
};


/* ----------------------------------------------------------------
   MISSION CARD RENDERERS

   Two distinct renderers for the two sections:

   1. renderOpenTabsMissionCard() — for "Right now" section.
      Shows currently open tabs as chips. Has "Close all" button.
      These missions come from /api/cluster-tabs (ephemeral, live).

   2. renderHistoryMissionCard() — for "Pick back up" section.
      Lighter/smaller treatment. Has "Reopen" link.
      These missions come from /api/history-missions (from the DB).
   ---------------------------------------------------------------- */

/**
 * renderOpenTabsMissionCard(mission, missionIndex)
 *
 * Builds the HTML for a single "Right now" mission card.
 * The mission object comes from /api/cluster-tabs and has this shape:
 *   { name, summary, tabs: [{ url, title, tabId }] }
 *
 * @param {Object} mission      - Mission object from cluster-tabs API
 * @param {number} missionIndex - 0-based index, used as a fallback ID
 * @returns {string}            - HTML string ready for innerHTML
 */
function renderOpenTabsMissionCard(mission, missionIndex) {
  const tabs = mission.tabs || [];
  const tabCount = tabs.length;

  // Tab count badge — always shown since every card has open tabs by definition
  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  // Check if any tabs in this mission are duplicates
  const dupeMap = window._dupeUrlMap || {};
  const missionHasDupes = tabs.some(t => dupeMap[t.url]);

  // Page chips — one per actual open tab (up to 5 shown, rest summarized)
  const visibleTabs = tabs.slice(0, 5);
  const extraCount  = tabs.length - visibleTabs.length;
  const pageChips = visibleTabs.map(tab => {
    const label   = tab.title || tab.url || '';
    const display = label.length > 45 ? label.slice(0, 45) + '…' : label;
    const dupeCount = dupeMap[tab.url];
    const dupeTag = dupeCount ? ` <span style="color:var(--accent-amber);font-weight:600">(${dupeCount}x)</span>` : '';
    return `<span class="page-chip clickable" data-action="focus-tab" data-tab-url="${(tab.url || '').replace(/"/g, '&quot;')}" title="${label.replace(/"/g, '&quot;')}">${display}${dupeTag}</span>`;
  }).join('') + (extraCount > 0 ? `<span class="page-chip">+${extraCount} more</span>` : '');

  // Use a stable ID based on mission name (not array index, which shifts when
  // earlier missions are closed). This way closing mission #2 doesn't break
  // the button on mission #5.
  const stableId = mission._stableId || missionIndex;

  // Get duplicate URLs that belong to this mission
  const missionDupeUrls = tabs.filter(t => dupeMap[t.url]).map(t => t.url);
  const uniqueDupeUrls = [...new Set(missionDupeUrls)];

  let actionsHtml = '';
  if (tabCount > 0) {
    actionsHtml += `
      <button class="action-btn close-tabs" data-action="close-open-tabs" data-open-mission-id="${stableId}">
        ${ICONS.close}
        Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
      </button>`;
  }
  if (uniqueDupeUrls.length > 0) {
    const extraDupes = uniqueDupeUrls.reduce((s, u) => s + dupeMap[u] - 1, 0);
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${uniqueDupeUrls.map(u => encodeURIComponent(u)).join(',')}">
        Close ${extraDupes} duplicate${extraDupes !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card" data-open-mission-id="${stableId}">
      <div class="status-bar active"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${mission.name || 'Unnamed Mission'}</span>
          <span class="mission-tag active">Open</span>
          ${tabBadge}
        </div>
        <div class="mission-summary">${mission.summary || ''}</div>
        <div class="mission-pages">${pageChips}</div>
        ${actionsHtml ? `<div class="actions">${actionsHtml}</div>` : ''}
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}

/**
 * renderHistoryMissionCard(mission)
 *
 * Builds the HTML for a single "Pick back up" history card.
 * Lighter visual treatment — smaller, no status bar color, just info + reopen.
 * The mission object comes from /api/history-missions and has the DB shape:
 *   { id, name, summary, status, last_activity, urls: [{ url, title }] }
 *
 * @param {Object} mission - Mission object from history-missions API
 * @returns {string}       - HTML string ready for innerHTML
 */
function renderHistoryMissionCard(mission) {
  const pageCount = (mission.urls || []).length;

  // Status-based age tag (e.g. "2 days cold", "1 week cold")
  const ageLabel = timeAgo(mission.last_activity)
    .replace(' ago', '')
    .replace('yesterday', '1 day')
    .replace(' hrs', 'h')
    .replace(' hr', 'h')
    .replace(' min', 'm');

  return `
    <div class="mission-card history-card" data-mission-id="${mission.id}">
      <div class="status-bar abandoned"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${mission.name || 'Unnamed Mission'}</span>
          <span class="mission-tag abandoned">${ageLabel} ago</span>
        </div>
        <div class="mission-summary">${mission.summary || ''}</div>
        <div class="actions">
          <button class="action-btn primary" data-action="focus" data-mission-id="${mission.id}">
            ${ICONS.focus}
            Reopen
          </button>
          <button class="action-btn danger" data-action="dismiss" data-mission-id="${mission.id}">
            Let it go
          </button>
        </div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${pageCount}</div>
        <div class="mission-page-label">pages</div>
      </div>
    </div>`;
}

// Keep the old renderMissionCard() for any legacy use (e.g. handleCloseAllStale)
// but it's no longer called by renderDashboard().
function renderMissionCard(mission, openTabCount) {
  const status = mission.status || 'active';
  const statusBarClass = status;
  let tagLabel = '';
  if (status === 'active') {
    tagLabel = 'Active';
  } else {
    tagLabel = timeAgo(mission.last_activity)
      .replace(' ago', '')
      .replace('yesterday', '1 day')
      .replace(' hrs', 'h')
      .replace(' hr', 'h')
      .replace(' min', 'm');
  }
  const tabBadge = openTabCount > 0
    ? `<span class="open-tabs-badge" data-mission-id="${mission.id}">${ICONS.tabs} ${openTabCount} tab${openTabCount !== 1 ? 's' : ''} open</span>`
    : '';
  const pages = (mission.urls || []).slice(0, 4);
  const pageChips = pages.map(page => {
    const label = page.title || page.url || page;
    const display = label.length > 40 ? label.slice(0, 40) + '…' : label;
    return `<span class="page-chip">${display}</span>`;
  }).join('');
  const pageCount = (mission.urls || []).length;
  const metaHtml = `<div class="mission-meta"><div class="mission-time">${timeAgo(mission.last_activity)}</div><div class="mission-page-count">${pageCount}</div><div class="mission-page-label">pages</div></div>`;
  return `
    <div class="mission-card" data-mission-id="${mission.id}">
      <div class="status-bar ${statusBarClass}"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${mission.name || 'Unnamed Mission'}</span>
          <span class="mission-tag ${statusBarClass}">${tagLabel}</span>
          ${tabBadge}
        </div>
        <div class="mission-summary">${mission.summary || ''}</div>
        <div class="mission-pages">${pageChips}</div>
      </div>
      ${metaHtml}
    </div>`;
}


/* ----------------------------------------------------------------
   SCATTER BAR RENDERER

   The scatter bar is the 10-dot "focus level" indicator in the
   top-right. It shows how spread out Zara's attention is across
   missions. More missions = more scatter = more dots filled = redder.
   ---------------------------------------------------------------- */

/**
 * renderScatterBar(missionCount)
 *
 * Fills the 10 scatter dots based on how many active missions exist.
 * Over 5 missions = "high scatter" (red dots).
 */
function renderScatterBar(missionCount) {
  const barEl = document.getElementById('scatterBar');
  const captionEl = document.getElementById('scatterCaption');
  if (!barEl || !captionEl) return;

  const isHigh = missionCount > 5;

  // Build 10 dots; fill the first `missionCount` of them
  let dotsHtml = '';
  for (let i = 0; i < 10; i++) {
    const filled = i < missionCount;
    const highClass = filled && isHigh ? ' high' : '';
    dotsHtml += `<div class="scatter-dot${filled ? ' filled' : ''}${highClass}"></div>`;
  }
  barEl.innerHTML = dotsHtml;

  // Caption text
  let level = 'focused';
  if (missionCount > 5) level = 'high scatter';
  else if (missionCount > 2) level = 'moderate scatter';

  captionEl.textContent = `${missionCount} parallel mission${missionCount !== 1 ? 's' : ''} — ${level}`;

  // Caption color: amber normally, rose when high scatter
  captionEl.style.color = isHigh ? 'var(--status-abandoned)' : 'var(--accent-amber)';
}


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB MISSIONS

   Because /api/cluster-tabs missions are ephemeral (not in the DB),
   we keep them in memory so the click handler can look them up when
   a "Close all" button is pressed.

   openTabMissions is repopulated every time renderDashboard() runs.
   ---------------------------------------------------------------- */
let openTabMissions = [];
let duplicateTabs = [];


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER

   New architecture:
   1. Fetch open tabs from extension
   2. POST those tabs to /api/cluster-tabs → "Right now" section
   3. Fetch /api/history-missions (excluding open tab URLs) → "Pick back up"
   4. Render both sections
   5. Keep cleanup banner, scatter bar, footer stats
   ---------------------------------------------------------------- */

/**
 * renderDashboard()
 *
 * Orchestrates everything:
 * 1. Paint greeting + date in the header
 * 2. Fetch open tabs from the Chrome extension
 * 3. Cluster those open tabs via /api/cluster-tabs → Section 1 "Right now"
 * 4. Fetch history missions that don't overlap with open tabs → Section 2 "Pick back up"
 * 5. Compute scatter level (based on number of open-tab missions)
 * 6. Show/hide cleanup banner and nudge banner
 * 7. Update footer stats
 */
async function renderDashboard() {
  // --- Header: greeting + date ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // ── Step 1: Fetch open tabs from the Chrome extension ────────────────────
  // fetchOpenTabs() populates the global `openTabs` array and sets
  // `extensionAvailable`. If not in the extension, openTabs stays [].
  await fetchOpenTabs();

  // ── Step 2: Cluster open tabs into missions ("Right now") ────────────────
  // We send all real tabs to the server, which calls DeepSeek to group them.
  // This is ephemeral — not stored, recalculated every load.
  openTabMissions = []; // reset in-memory store

  const openTabsSection     = document.getElementById('openTabsSection');
  const openTabsMissionsEl  = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');

  // Filter out chrome:// / extension pages before sending to server
  const realTabs = openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });

  if (extensionAvailable && realTabs.length > 0) {
    try {
      const clusterRes = await fetch('/api/cluster-tabs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabs: realTabs }),
      });

      if (clusterRes.ok) {
        const clusterData = await clusterRes.json();
        openTabMissions = (clusterData.missions || []).map((m, i) => ({
          ...m,
          _stableId: m.name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40) || `mission-${i}`,
        }));
        // Store duplicates for rendering
        duplicateTabs = clusterData.duplicates || [];
      }
    } catch (err) {
      console.warn('[TMC] Could not cluster open tabs:', err);
    }
  }

  // Render the "Right now" section
  if (openTabMissions.length > 0 && openTabsSection) {
    openTabsSectionCount.textContent = `${openTabMissions.length} mission${openTabMissions.length !== 1 ? 's' : ''}`;
    openTabsMissionsEl.innerHTML = openTabMissions
      .map((m, idx) => renderOpenTabsMissionCard(m, idx))
      .join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // Build a set of duplicate URLs for the card renderer to use
  const dupeUrlSet = new Set(duplicateTabs.map(d => d.url));
  const dupeUrlMap = {};
  duplicateTabs.forEach(d => { dupeUrlMap[d.url] = d.count; });

  // Store on window so renderOpenTabsMissionCard can access it
  window._dupeUrlMap = dupeUrlMap;

  // ── Step 3: Fetch history missions ("Pick back up") ──────────────────────
  // Pass all currently open URLs as a filter so the server can exclude
  // missions that are already represented in the "Right now" section.
  const openUrlsParam = realTabs
    .map(t => encodeURIComponent(t.url))
    .join(',');

  let historyMissions = [];
  try {
    const historyRes = await fetch(`/api/history-missions?openUrls=${openUrlsParam}`);
    if (historyRes.ok) {
      historyMissions = await historyRes.json();
    }
  } catch (err) {
    console.warn('[TMC] Could not fetch history missions:', err);
  }

  // Render the "Pick back up" section
  const historySection      = document.getElementById('historySection');
  const historyMissionsEl   = document.getElementById('historyMissions');
  const historySectionCount = document.getElementById('historySectionCount');

  if (historyMissions.length > 0 && historySection) {
    historySectionCount.textContent = `${historyMissions.length} mission${historyMissions.length !== 1 ? 's' : ''}`;
    historyMissionsEl.innerHTML = historyMissions
      .map(m => renderHistoryMissionCard(m))
      .join('');
    historySection.style.display = 'block';
  } else if (historySection) {
    historySection.style.display = 'none';
  }

  // ── Step 4: Scatter bar ───────────────────────────────────────────────────
  // Scatter = how many parallel open-tab missions exist right now
  renderScatterBar(openTabMissions.length);

  // ── Step 5: Stale tabs — tabs open but whose missions aren't "Right now" ──
  // With the new architecture ALL open tabs should be in a mission,
  // so stale tabs from the cleanup banner perspective are now tabs from the
  // history section (old missions) that are still open in the browser.
  // For simplicity: stale = open tabs that weren't in any cluster-tabs mission.
  const clusteredTabUrls = new Set(
    openTabMissions.flatMap(m => (m.tabs || []).map(t => t.url))
  );
  const staleTabs = realTabs.filter(t => !clusteredTabUrls.has(t.url));

  // Cleanup banner
  const cleanupBanner = document.getElementById('cleanupBanner');
  if (staleTabs.length > 0 && cleanupBanner) {
    document.getElementById('staleTabCount').textContent =
      `${staleTabs.length} stale tab${staleTabs.length !== 1 ? 's' : ''}`;
    cleanupBanner.style.display = 'flex';
  } else if (cleanupBanner) {
    cleanupBanner.style.display = 'none';
  }

  // Hide nudge banner — no longer used
  const nudgeBanner = document.getElementById('nudgeBanner');
  if (nudgeBanner) nudgeBanner.style.display = 'none';

  // ── Step 6: Footer stats ──────────────────────────────────────────────────
  const statMissions = document.getElementById('statMissions');
  const statTabs     = document.getElementById('statTabs');
  const statStale    = document.getElementById('statStale');
  // "Missions" in the footer = open-tab missions (the primary view)
  if (statMissions) statMissions.textContent = openTabMissions.length;
  if (statTabs)     statTabs.textContent     = openTabs.length;
  if (statStale)    statStale.textContent    = staleTabs.length;

  // Last refresh time (from the history analysis, not the tab clustering)
  const lastRefreshEl = document.getElementById('lastRefreshTime');
  if (lastRefreshEl) {
    try {
      const statsRes = await fetch('/api/stats');
      if (statsRes.ok) {
        const stats = await statsRes.json();
        lastRefreshEl.textContent = stats.lastAnalysis
          ? `History last analyzed ${timeAgo(stats.lastAnalysis)}`
          : 'History not yet analyzed';
      } else {
        lastRefreshEl.textContent = 'History not yet analyzed';
      }
    } catch {
      lastRefreshEl.textContent = 'History not yet analyzed';
    }
  }
}


/* ----------------------------------------------------------------
   EVENT HANDLERS (using event delegation)

   Instead of attaching a listener to every button, we attach ONE
   listener to the whole document and check what was clicked.
   This is more efficient and works even after we re-render cards.

   Think of it like one security guard watching the whole building
   instead of one guard per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM from the clicked element to find the nearest
  // element with a data-action attribute
  const actionEl = e.target.closest('[data-action]');

  // --- Close all stale tabs button (in the cleanup banner) ---
  if (e.target.closest('#closeAllStaleBtn')) {
    e.preventDefault();
    await handleCloseAllStale();
    return;
  }

  // --- Refresh button (in the footer) ---
  if (e.target.closest('#refreshBtn')) {
    e.preventDefault();
    await handleRefresh();
    return;
  }

  if (!actionEl) return; // click wasn't on an action button

  const action    = actionEl.dataset.action;
  const missionId = actionEl.dataset.missionId;

  // Find the card element so we can animate it
  const card = actionEl.closest('.mission-card');

  // ---- focus-tab: switch to a specific open tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) {
      await sendToExtension('focusTab', { url: tabUrl });
    }
    return;
  }

  // ---- close-all-dupes: close every duplicate tab ----

  // ---- dedup-keep-one: close extras but keep one copy of each ----
  if (action === 'dedup-keep-one') {
    // URLs come from the button's data attribute (per-mission duplicates)
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await sendToExtension('closeDuplicates', { urls, keepOne: true });
    playCloseSound();
    await fetchOpenTabs();

    // Remove the dupe button since they're cleaned up
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity = '0';
    setTimeout(() => actionEl.remove(), 200);

    showToast(`Closed duplicates, kept one copy each`);
    return;
  }

  // ---- close-open-tabs: close all tabs for an open-tab-clustered mission ----
  // These missions use a stable ID (based on name) so closing one doesn't
  // break buttons on others.
  if (action === 'close-open-tabs') {
    const stableId = actionEl.dataset.openMissionId;
    const mission = openTabMissions.find(m => m._stableId === stableId);
    if (!mission) return;

    const urls = (mission.tabs || []).map(t => t.url);
    await closeTabsByUrls(urls);

    // Animate the card out — the mission is "done" once all tabs are closed
    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory store so stale count stays accurate
    const idx = openTabMissions.indexOf(mission);
    if (idx !== -1) openTabMissions.splice(idx, 1);

    await updateStaleCount();
    showToast(`Closed tabs for "${mission.name}"`);
  }

  // ---- close-tabs: close all tabs belonging to a history mission ----
  else if (action === 'close-tabs') {
    const mission = await fetchMissionById(missionId);
    if (!mission) return;

    const urls = (mission.urls || []).map(u => u.url);
    await closeTabsByUrls(urls);

    // Remove the badge from the card (no tabs left open)
    if (card) {
      const badge = card.querySelector('.open-tabs-badge');
      if (badge) {
        badge.style.transition = 'opacity 0.3s, transform 0.3s';
        badge.style.opacity = '0';
        badge.style.transform = 'scale(0.8)';
        setTimeout(() => badge.remove(), 300);
      }
      // Remove this specific close-tabs button
      actionEl.style.transition = 'opacity 0.2s';
      actionEl.style.opacity = '0';
      setTimeout(() => actionEl.remove(), 200);
    }

    // Update footer stale count
    await updateStaleCount();
    showToast(`Closed tabs for "${mission.name}"`);
  }

  // ---- archive: close tabs + mark mission as archived, then remove card ----
  else if (action === 'archive') {
    const mission = await fetchMissionById(missionId);
    if (!mission) return;

    const urls = (mission.urls || []).map(u => u.url);
    await closeTabsByUrls(urls);

    // Tell the server to archive this mission
    try {
      await fetch(`/api/missions/${missionId}/archive`, { method: 'POST' });
    } catch (err) {
      console.warn('[TMC] Could not archive mission:', err);
    }

    // Animate the card out
    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    showToast(`Archived "${mission.name}"`);
    await updateStaleCount();
  }

  // ---- dismiss: close tabs (if any), mark as dismissed, remove card ----
  else if (action === 'dismiss') {
    const mission = await fetchMissionById(missionId);
    if (!mission) return;

    // If tabs are open, close them first
    const tabCount = card
      ? (card.querySelector('.open-tabs-badge')?.textContent.match(/\d+/)?.[0] || 0)
      : 0;

    if (parseInt(tabCount) > 0) {
      const urls = (mission.urls || []).map(u => u.url);
      await closeTabsByUrls(urls);
    }

    // Tell the server this mission is dismissed
    try {
      await fetch(`/api/missions/${missionId}/dismiss`, { method: 'POST' });
    } catch (err) {
      console.warn('[TMC] Could not dismiss mission:', err);
    }

    // Animate the card out
    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    showToast(`Let go of "${mission.name}"`);
    await updateStaleCount();
  }

  // ---- focus: bring the mission's tabs to the front ----
  else if (action === 'focus') {
    const mission = await fetchMissionById(missionId);
    if (!mission) return;

    const urls = (mission.urls || []).map(u => u.url);
    await focusTabsByUrls(urls);
    showToast(`Focused on "${mission.name}"`);
  }

  // ---- close-uncat: close uncategorized tabs by domain ----
  else if (action === 'close-uncat') {
    const domain = actionEl.dataset.domain;
    if (!domain) return;

    // Find all open tabs matching this domain and close them
    const tabsToClose = openTabs.filter(t => {
      try { return new URL(t.url).hostname === domain; }
      catch { return false; }
    });
    const urls = tabsToClose.map(t => t.url);
    await closeTabsByUrls(urls);

    // Animate card removal
    if (card) {
      playCloseSound();
      animateCardOut(card);
    }
    showToast(`Closed ${tabsToClose.length} tab${tabsToClose.length !== 1 ? 's' : ''} from ${domain}`);
    await updateStaleCount();
  }
});


/* ----------------------------------------------------------------
   ACTION HELPERS
   ---------------------------------------------------------------- */

/**
 * handleCloseAllStale()
 *
 * Closes all tabs that weren't assigned to any open-tab mission.
 * With the new architecture, "stale" means tabs that somehow slipped
 * through the AI clustering (shouldn't happen, but could with edge cases).
 */
async function handleCloseAllStale() {
  // Stale tabs = open real tabs not in any clustered mission
  const clusteredTabUrls = new Set(
    openTabMissions.flatMap(m => (m.tabs || []).map(t => t.url))
  );

  // Filter to real browser tabs only (not chrome:// etc.)
  const realTabs = openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });

  const staleUrls = realTabs
    .filter(t => !clusteredTabUrls.has(t.url))
    .map(t => t.url);

  if (staleUrls.length > 0) {
    await closeTabsByUrls(staleUrls);
  }

  playCloseSound();

  // Hide the cleanup banner
  const banner = document.getElementById('cleanupBanner');
  if (banner) {
    banner.style.transition = 'opacity 0.4s';
    banner.style.opacity = '0';
    setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
  }

  // Update footer stats
  const statStale = document.getElementById('statStale');
  const statTabs  = document.getElementById('statTabs');
  if (statStale) statStale.textContent = '0';
  if (statTabs)  statTabs.textContent  = openTabs.length;

  showToast('Closed all stale tabs. Breathing room restored.');
}

/**
 * handleRefresh()
 *
 * Triggers a fresh AI analysis of the browser history,
 * then re-renders the dashboard with the new data.
 */
async function handleRefresh() {
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.textContent = 'Refreshing…';
    refreshBtn.style.opacity = '0.5';
  }

  try {
    // Ask the server to re-read history + re-cluster missions
    await fetch('/api/missions/refresh', { method: 'POST' });
  } catch (err) {
    console.warn('[TMC] Refresh failed:', err);
  }

  // Re-render the full dashboard
  await renderDashboard();

  if (refreshBtn) {
    refreshBtn.textContent = 'Refresh now';
    refreshBtn.style.opacity = '1';
  }
}

/**
 * fetchMissionById(missionId)
 *
 * Fetches a single mission object by ID from the server.
 * We need this when handling button clicks, so we have the mission's
 * page URLs and name ready.
 *
 * Returns null if the fetch fails.
 */
async function fetchMissionById(missionId) {
  try {
    const res = await fetch('/api/missions');
    if (!res.ok) return null;
    const missions = await res.json();
    return missions.find(m => String(m.id) === String(missionId)) || null;
  } catch {
    return null;
  }
}

/**
 * updateStaleCount()
 *
 * Recalculates stale tabs after a close action and updates the footer + banner.
 * In the new architecture, stale = open real tabs not covered by any clustered mission.
 */
async function updateStaleCount() {
  await fetchOpenTabs(); // refresh our live tab list first

  // Recalculate which tabs are "stale" (not in any open-tab mission)
  const clusteredTabUrls = new Set(
    openTabMissions.flatMap(m => (m.tabs || []).map(t => t.url))
  );

  const realTabs = openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });

  const staleTabs = realTabs.filter(t => !clusteredTabUrls.has(t.url));

  // Update footer numbers
  const statStale = document.getElementById('statStale');
  const statTabs  = document.getElementById('statTabs');
  if (statStale) statStale.textContent = staleTabs.length;
  if (statTabs)  statTabs.textContent  = openTabs.length;

  // Update or hide the cleanup banner
  const staleTabCountEl = document.getElementById('staleTabCount');
  const cleanupBanner   = document.getElementById('cleanupBanner');
  if (staleTabs.length > 0) {
    if (staleTabCountEl) staleTabCountEl.textContent = `${staleTabs.length} stale tab${staleTabs.length !== 1 ? 's' : ''}`;
    if (cleanupBanner)   cleanupBanner.style.display = 'flex';
  } else {
    if (cleanupBanner) {
      cleanupBanner.style.transition = 'opacity 0.4s';
      cleanupBanner.style.opacity = '0';
      setTimeout(() => { cleanupBanner.style.display = 'none'; cleanupBanner.style.opacity = '1'; }, 400);
    }
  }
}


/* ----------------------------------------------------------------
   INITIALIZE

   When the page loads, paint the dashboard immediately.
   ---------------------------------------------------------------- */
renderDashboard();
