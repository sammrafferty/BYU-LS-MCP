/**
 * Popup UI — reads status from the background service worker's storage.
 * No network calls happen here; background.js handles everything.
 */

function showState(id) {
  document.querySelectorAll(".state").forEach((el) => (el.style.display = "none"));
  document.getElementById(id).style.display = "block";
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

async function render() {
  const data = await chrome.storage.local.get([
    "status", "connectorUrl", "lastHeartbeat", "lastError"
  ]);

  if (data.status === "connected" && data.connectorUrl) {
    document.getElementById("connectorUrl").textContent = data.connectorUrl;
    document.getElementById("lastHeartbeat").textContent =
      data.lastHeartbeat ? `Last refresh: ${formatTime(data.lastHeartbeat)}` : "";
    showState("stateConnected");
  } else if (data.status === "error") {
    document.getElementById("errorMsg").textContent = data.lastError || "Unknown error";
    document.getElementById("lastHeartbeatError").textContent =
      data.lastHeartbeat ? `Last attempt: ${formatTime(data.lastHeartbeat)}` : "";
    showState("stateError");
  } else {
    showState("stateLogin");
  }
}

// Open Learning Suite
document.getElementById("openLS").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://learningsuite.byu.edu" });
  window.close();
});

// Copy button
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

// Re-render when storage changes (background heartbeat updates)
chrome.storage.onChanged.addListener(() => render());

render();
