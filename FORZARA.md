# For Zara: Tab Out

## What We Built

**Tab Out** is a personal tab manager that replaces your Chrome new tab page with a dashboard of everything you have open — grouped either by domain (instant, free) or by AI-detected "missions" (what you're actually *doing*). It can close tabs for you, detect duplicates, and makes the whole experience of cleaning up your browser feel satisfying instead of stressful.

**Slogan:** Keep tabs on your tabs.

---

## The Architecture (In Plain Language)

Think of Tab Out as three pieces working together:

### 1. The Server (the brain)
A small Node.js program that runs silently on your Mac. It does two things:
- **Reads your Chrome history** — Chrome stores all your browsing in a SQLite database file on your computer. The server copies this file (because Chrome locks it while running) and reads it to understand what you've been doing.
- **Talks to DeepSeek** — When you click "Organize with AI," the server sends your open tab URLs to DeepSeek's API, which clusters them into named missions and writes a witty message about your browsing habits.

The server also caches results, so if your tabs haven't changed since last time, it skips the API call entirely (instant load, zero cost).

### 2. The Dashboard (the face)
A single HTML page served by the server at `localhost:3456`. It's vanilla HTML/CSS/JS — no React, no framework. It:
- Shows your tabs grouped by domain (default, instant)
- Calls the server's API to get AI clustering when you ask for it
- Communicates with the Chrome extension to know which tabs are actually open and to close them

### 3. The Chrome Extension (the bridge)
A tiny Manifest V3 extension that does three things:
- **Overrides the new tab page** — loads the dashboard in an iframe
- **Bridges Chrome's tab API** — the dashboard can't directly access `chrome.tabs` (it's a regular webpage), so the extension acts as a middleman via `postMessage`
- **Shows a badge** — the toolbar icon shows how many active missions you have, color-coded

The communication flow looks like this:
```
Dashboard (localhost:3456 in iframe)
    ↕ window.postMessage
Extension's newtab.html (has chrome.tabs access)
    ↕ chrome.tabs API
Your actual browser tabs
```

This is the cleverness of the architecture — the dashboard gets the best of both worlds: full design freedom (it's just a webpage) AND access to Chrome's privileged APIs (through the extension bridge).

---

## The Tech Stack (And Why Each Choice)

| Technology | Why |
|---|---|
| **Node.js + Express** | Lightweight server, fast startup, we already know JS from the frontend |
| **better-sqlite3** | Reads Chrome's SQLite history file directly. Synchronous API = simpler code |
| **DeepSeek API** | Cheap (fractions of a cent per call), good at classification, OpenAI-compatible SDK |
| **Vanilla HTML/CSS/JS** | No build step, no framework overhead. It's a dashboard, not a React app |
| **Chrome Extension MV3** | Required for tab access. Manifest V3 is Chrome's current extension standard |
| **macOS Launch Agent** | Auto-starts the server on login, restarts on crash. Like Spotify or Dropbox — invisible |

---

## How the Codebase is Connected

```
tab-out/
├── server/                    
│   ├── index.js          ← Entry point. Starts Express, schedules analysis
│   ├── config.js          ← Reads ~/.mission-control/config.json
│   ├── db.js              ← SQLite database for caching missions
│   ├── history-reader.js  ← Copies + reads Chrome's History SQLite file  
│   ├── url-filter.js      ← Removes noise (login pages, errors, etc.)
│   ├── clustering.js      ← Sends URLs to DeepSeek, parses response
│   └── routes.js          ← API endpoints the dashboard calls
│
├── dashboard/                 
│   ├── index.html         ← The HTML shell (empty, filled by JS)
│   ├── style.css          ← All styles (editorial/magazine aesthetic)
│   └── app.js             ← The big one: fetches data, renders cards, handles actions
│
├── extension/                 
│   ├── manifest.json      ← Chrome extension config
│   ├── newtab.html        ← Loads dashboard in iframe + fallback
│   ├── newtab.js          ← postMessage bridge to chrome.tabs
│   └── background.js      ← Badge updates (polls server every 60s)
│
└── scripts/
    └── install.js         ← Sets up config dir + macOS Launch Agent
```

**Data flow when you open a new tab:**
1. Extension's `newtab.html` loads → shows iframe pointing to `localhost:3456`
2. Dashboard's `app.js` runs → asks extension for open tabs via postMessage
3. Extension calls `chrome.tabs.query({})` → returns all tabs
4. Dashboard groups tabs by domain → renders instantly (no API call)
5. If you click "Organize with AI" → dashboard POSTs tabs to server
6. Server calls DeepSeek → gets mission clusters + witty message
7. Server caches result → returns to dashboard
8. Dashboard re-renders with AI missions, message, and action buttons

---

## Bugs We Ran Into and How We Fixed Them

### The Array Index Bug (The Sneakiest One)
**Problem:** Closing the 2nd mission card broke the "Close" button on the 5th card.
**Why:** We identified missions by their array index (`data-open-mission-idx="4"`). When you close mission #2, the array splices and mission #5 becomes mission #4 — but the DOM still had the old index.
**Fix:** Switched to stable IDs based on the mission name (slugified). Closing one card never affects another.
**Lesson:** Never use array indices as identifiers for things that can be deleted. Use stable IDs.

### The Config Export Mismatch
**Problem:** `app.js` did `const config = require('./config')` and accessed `config.port`, but `config.js` exported `{ config, CONFIG_DIR, ... }` — so `config.port` was undefined.
**Fix:** Changed the export to attach paths as properties on the config object itself, then export the object directly.
**Lesson:** When other modules will `require` your file, think about the ergonomics of the export. `require('./config').port` should just work.

### The postMessage Protocol Mismatch
**Problem:** Dashboard sent `{ action, messageId, urls: [...] }` flat. Extension expected `{ action, messageId, payload: { urls } }` nested. Also, extension never set `success: true` in responses, so dashboard thought extension was unavailable.
**Fix:** Made extension read flat fields and always include `success: true`.
**Lesson:** When two pieces talk via a protocol (postMessage, API, etc.), write the protocol down and have both sides match it exactly. "It probably works" is never good enough.

### The CSS Duplicate Display Bug
**Problem:** Fallback div in `newtab.html` had both `display: none` and `display: flex` in the same CSS rule — `flex` won, so the fallback was always visible on top of the iframe.
**Fix:** Used a `.hidden` utility class with `!important`.
**Lesson:** CSS properties in the same rule don't "stack" — the last one wins.

---

## Lessons for Future Projects

### 1. How Good Engineers Think About Architecture
The extension-as-bridge pattern is a real-world architectural decision. We couldn't give the dashboard chrome.tabs access directly (security), so we used postMessage as a communication layer. This is the same pattern used everywhere in software: when two things can't talk directly, you put a translator in between. APIs, message queues, event buses — same idea.

### 2. Cache Everything That's Expensive
The DeepSeek API call takes 2-3 seconds and costs money. By caching results keyed on the sorted list of tab URLs, we made subsequent loads instant and free. This is called **memoization** — "if the inputs haven't changed, the output won't either, so just return the last answer."

### 3. The Prompt IS the Product
The quality of Tab Out's AI clustering is entirely determined by the prompt we send to DeepSeek. When results were too broad ("Watching AI Videos" lumping 6 unrelated videos), we fixed it by adding rules to the prompt ("each video gets its own mission"). The code didn't change — only the English instructions to the AI changed. This is a new kind of engineering: **prompt engineering is product engineering**.

### 4. Sound and Animation Matter More Than You Think
Adding the swoosh sound and confetti turned "closing tabs" from a chore into a dopamine hit. The feature is identical (tabs get closed), but the *feeling* is completely different. Good products don't just work — they feel good. This is the difference between a tool and an experience.

### 5. Start Static, Add Intelligence Later
The default view groups tabs by domain using simple JavaScript — no AI, no API call, no cost. The AI is opt-in ("Organize with AI" button). This means the page loads instantly every time, and you only burn tokens when you want the smarter view. Design for the free/instant case first, then layer intelligence on top.

---

## Technologies I Learned

- **Chrome Extension Manifest V3** — the current standard for Chrome extensions. Service workers instead of background pages, stricter security model
- **better-sqlite3** — a synchronous SQLite library for Node.js (most DB libraries are async, this one is sync which makes code simpler)
- **macOS Launch Agents** — plist files that tell macOS to start programs on login, like invisible background services
- **Web Audio API** — synthesizing sounds in the browser without audio files (we built the swoosh sound from shaped noise + a bandpass filter sweep)
- **Chrome's History SQLite schema** — Chrome stores timestamps as microseconds since January 1, 1601 (a Windows thing). The offset to convert to Unix time is 11,644,473,600 seconds. Wild.
