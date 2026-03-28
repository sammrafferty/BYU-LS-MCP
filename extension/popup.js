// =============================================
// CHANGE THIS after deploying to Railway:
// =============================================
const SERVER_URL = "https://byu-ls-mcp-production.up.railway.app";

// --- State management ---
function showState(id) {
  document.querySelectorAll(".state").forEach((el) => (el.style.display = "none"));
  document.getElementById(id).style.display = "block";
}

// --- Check if logged into Learning Suite ---
async function checkLogin() {
  const cookies = await chrome.cookies.getAll({ domain: "learningsuite.byu.edu" });

  if (cookies.length === 0) {
    showState("stateLogin");
    return;
  }

  // Check if we already have a connector URL saved
  const saved = await chrome.storage.local.get(["connectorUrl"]);
  if (saved.connectorUrl) {
    document.getElementById("connectorUrl").textContent = saved.connectorUrl;
    showState("stateDone");
    return;
  }

  showState("stateReady");
}

// --- Open Learning Suite ---
document.getElementById("openLS").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://learningsuite.byu.edu" });
  window.close();
});

// --- Connect button ---
document.getElementById("connectBtn").addEventListener("click", async () => {
  showState("stateLoading");

  try {
    // Get all LS cookies
    const cookies = await chrome.cookies.getAll({ domain: "learningsuite.byu.edu" });
    const cookieData = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expirationDate: c.expirationDate,
    }));

    // Try to get session code from open LS tab
    let sessionCode = "AUTO";
    const tabs = await chrome.tabs.query({ url: "*://learningsuite.byu.edu/*" });
    for (const tab of tabs) {
      const match = tab.url.match(/learningsuite\.byu\.edu\/\.(\w+)\//);
      if (match) {
        sessionCode = match[1];
        break;
      }
    }

    // Register with server
    const res = await fetch(`${SERVER_URL}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies: cookieData, sessionCode }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server returned ${res.status}`);
    }

    const data = await res.json();
    const connectorUrl = `${SERVER_URL}${data.mcpUrl}`;

    // Save for future popup opens
    await chrome.storage.local.set({ connectorUrl, token: data.token });

    document.getElementById("connectorUrl").textContent = connectorUrl;
    showState("stateDone");
  } catch (err) {
    document.getElementById("errorMsg").textContent = err.message;
    showState("stateError");
  }
});

// --- Copy button ---
document.getElementById("copyBtn").addEventListener("click", () => {
  const url = document.getElementById("connectorUrl").textContent;
  navigator.clipboard.writeText(url);
  const btn = document.getElementById("copyBtn");
  btn.textContent = "Copied!";
  btn.classList.add("copied");
  setTimeout(() => {
    btn.textContent = "Copy URL";
    btn.classList.remove("copied");
  }, 2000);
});

// --- Retry ---
document.getElementById("retryBtn").addEventListener("click", () => {
  chrome.storage.local.remove(["connectorUrl", "token"]);
  checkLogin();
});

// --- Init ---
checkLogin();
