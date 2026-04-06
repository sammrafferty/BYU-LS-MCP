/**
 * Background service worker — the core of reliable LS→Claude connectivity.
 *
 * Every 10 minutes (and on browser startup), this:
 * 1. Reads BYU Learning Suite cookies from Chrome
 * 2. Sends them to the Railway server
 * 3. Updates the badge to show connection status
 *
 * After a server restart, the next heartbeat automatically re-registers.
 * The user only ever needs to do one thing: log into LS with Duo.
 */

const SERVER_URL = "https://byu-ls-mcp-production.up.railway.app";
const ALARM_NAME = "byu-ls-heartbeat";
const HEARTBEAT_MINUTES = 10;

// --- Badge status ---

function setBadge(status) {
  const config = {
    ok:      { text: "ON",  color: "#22c55e" },
    stale:   { text: "...", color: "#eab308" },
    off:     { text: "OFF", color: "#ef4444" },
    error:   { text: "ERR", color: "#ef4444" },
  };
  const c = config[status] || config.off;
  chrome.action.setBadgeText({ text: c.text });
  chrome.action.setBadgeBackgroundColor({ color: c.color });
}

// --- Cookie reading ---

async function getLSCookies() {
  const cookies = await chrome.cookies.getAll({ domain: "learningsuite.byu.edu" });
  if (!cookies || cookies.length === 0) return null;
  if (!cookies.some((c) => c.name === "PHPSESSID")) return null;
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expirationDate: c.expirationDate,
  }));
}

// --- Session code detection ---

async function getSessionCode() {
  try {
    const tabs = await chrome.tabs.query({ url: "*://learningsuite.byu.edu/*" });
    for (const tab of tabs) {
      const match = tab.url.match(/learningsuite\.byu\.edu\/\.(\w+)\//);
      if (match) return match[1];
    }
  } catch {}
  return "AUTO"; // Server will auto-detect
}

// --- Heartbeat: send cookies to server ---

async function heartbeat() {
  const cookies = await getLSCookies();

  if (!cookies) {
    setBadge("off");
    await chrome.storage.local.set({ status: "no_cookies" });
    return;
  }

  setBadge("stale"); // Show yellow while we try

  const sessionCode = await getSessionCode();
  const stored = await chrome.storage.local.get(["token"]);
  const existingToken = stored.token || null;

  try {
    const res = await fetch(`${SERVER_URL}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies, sessionCode, existingToken }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    const connectorUrl = `${SERVER_URL}${data.mcpUrl}`;

    await chrome.storage.local.set({
      token: data.token,
      connectorUrl,
      status: "connected",
      lastHeartbeat: new Date().toISOString(),
    });

    setBadge("ok");
  } catch (err) {
    console.error("[BYU-LS] Heartbeat failed:", err.message);

    // Don't clear the token — the server might just be restarting
    await chrome.storage.local.set({
      status: "error",
      lastError: err.message,
      lastHeartbeat: new Date().toISOString(),
    });

    setBadge("error");
  }
}

// --- Alarm setup ---

chrome.alarms.create(ALARM_NAME, {
  delayInMinutes: 0.1, // First heartbeat ~6 seconds after install/startup
  periodInMinutes: HEARTBEAT_MINUTES,
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    heartbeat();
  }
});

// --- Also heartbeat when LS cookies change ---

chrome.cookies.onChanged.addListener((info) => {
  if (
    info.cookie.domain.includes("learningsuite.byu.edu") &&
    info.cookie.name === "PHPSESSID" &&
    !info.removed
  ) {
    // New PHPSESSID = user just logged in. Send it immediately.
    console.log("[BYU-LS] New PHPSESSID detected, sending heartbeat");
    heartbeat();
  }
});

// --- Initial state ---
setBadge("off");
