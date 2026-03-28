/**
 * Bookmarklet script — loaded dynamically when user clicks the bookmark.
 * Styled after 35mm film editorial aesthetic.
 *
 * Token persistence: stores the token in localStorage on the LS domain.
 * Clicking the bookmark again refreshes cookies behind the same token,
 * so the connector URL in Claude Desktop never needs to change.
 */

(function () {
  if (!location.hostname.includes("learningsuite.byu.edu")) {
    alert("Open Learning Suite first, then click this bookmark.");
    return;
  }

  var old = document.getElementById("_byu_mcp");
  if (old) old.remove();

  var cookies = document.cookie;
  // Session code is in the URL path: learningsuite.byu.edu/.XXXX/student/...
  // Must match the path segment, not ".edu/" from the domain
  var sessionMatch = location.pathname.match(/^\/\.(\w{3,6})\//);
  var sessionCode = sessionMatch ? sessionMatch[1] : "";

  if (!cookies || !cookies.includes("PHPSESSID")) {
    showOverlay("NOT LOGGED IN", "Log in to Learning Suite first, then click this bookmark again.", null, true);
    return;
  }

  // Check for existing token from a previous bookmarklet click
  var existingToken = null;
  try { existingToken = localStorage.getItem("_byu_mcp_token"); } catch (e) {}

  var isRefresh = !!existingToken;
  showOverlay(
    isRefresh ? "REFRESHING" : "CONNECTING",
    isRefresh ? "Updating your session..." : "Reading your session...",
    null, false
  );

  var SERVER = "%%SERVER_URL%%";

  fetch(SERVER + "/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cookies: cookies,
      sessionCode: sessionCode,
      existingToken: existingToken,
    }),
  })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data.error) throw new Error(data.error);
      // Store token for future clicks — same URL forever
      try { localStorage.setItem("_byu_mcp_token", data.token); } catch (e) {}
      var url = SERVER + data.mcpUrl;
      if (isRefresh) {
        showOverlay("REFRESHED", "Session updated — same URL, no changes needed in Claude", url, false);
      } else {
        showOverlay("CONNECTED", "Copy this URL into Claude Desktop", url, false);
      }
    })
    .catch(function (err) {
      showOverlay("ERROR", err.message, null, true);
    });

  function showOverlay(title, subtitle, url, isError) {
    var old = document.getElementById("_byu_mcp");
    if (old) old.remove();

    // Load font
    if (!document.getElementById("_byu_mcp_font")) {
      var link = document.createElement("link");
      link.id = "_byu_mcp_font";
      link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@900&family=Space+Mono:wght@400;700&display=swap";
      document.head.appendChild(link);
    }

    var overlay = document.createElement("div");
    overlay.id = "_byu_mcp";
    overlay.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(5,5,5,0.92);z-index:999999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px)";

    var card = document.createElement("div");
    card.style.cssText = "background:#0a0a0a;border:1px solid #222;padding:48px 40px;max-width:440px;width:90%;text-align:center";

    var h = document.createElement("div");
    h.style.cssText = "font-family:'Playfair Display',Georgia,serif;font-size:36px;font-weight:900;color:#fff;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px";
    h.textContent = title;
    card.appendChild(h);

    var sub = document.createElement("div");
    sub.style.cssText = "font-family:'Space Mono',monospace;font-size:12px;color:#555;letter-spacing:1px;text-transform:uppercase;margin-bottom:28px";
    sub.textContent = subtitle;
    card.appendChild(sub);

    if (url) {
      var line = document.createElement("div");
      line.style.cssText = "width:100%;height:1px;background:#222;margin-bottom:24px";
      card.appendChild(line);

      var input = document.createElement("input");
      input.value = url;
      input.readOnly = true;
      input.style.cssText = "width:100%;padding:14px;border:1px solid #222;background:#050505;color:#888;font-family:'Space Mono',monospace;font-size:11px;text-align:center;outline:none;box-sizing:border-box;margin-bottom:16px";
      input.onclick = function () { this.select(); };
      card.appendChild(input);

      var btn = document.createElement("button");
      btn.textContent = "COPY URL";
      btn.style.cssText = "width:100%;padding:16px;border:none;background:#fff;color:#0a0a0a;font-family:'Playfair Display',Georgia,serif;font-size:15px;font-weight:900;letter-spacing:3px;text-transform:uppercase;cursor:pointer;transition:all 0.15s";
      btn.onmouseover = function () { this.style.background = "#e0e0e0"; };
      btn.onmouseout = function () { this.style.background = "#fff"; };
      btn.onclick = function () {
        navigator.clipboard.writeText(url);
        btn.textContent = "COPIED";
        btn.style.background = "#1a1a1a";
        btn.style.color = "#fff";
        btn.style.border = "1px solid #333";
      };
      card.appendChild(btn);

      var steps = document.createElement("div");
      steps.style.cssText = "margin-top:24px;font-family:'Space Mono',monospace;font-size:11px;color:#444;line-height:1.8;text-align:left";
      steps.innerHTML = "Open <span style='color:#888'>Claude Desktop</span><br>Settings &rarr; Connectors &rarr; <span style='color:#888'>+</span><br>Paste the URL &rarr; <span style='color:#888'>Add</span>";
      card.appendChild(steps);
    }

    if (isError) {
      var closeBtn = document.createElement("button");
      closeBtn.textContent = "CLOSE";
      closeBtn.style.cssText = "margin-top:24px;padding:12px 32px;border:1px solid #333;background:transparent;color:#666;font-family:'Space Mono',monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;cursor:pointer";
      closeBtn.onclick = function () { overlay.remove(); };
      card.appendChild(closeBtn);
    }

    overlay.appendChild(card);
    overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
  }
})();
