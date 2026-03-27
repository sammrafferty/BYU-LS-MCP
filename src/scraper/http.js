import { SessionExpiredError } from "./errors.js";

const BASE_URL = "https://learningsuite.byu.edu";

export function createHttpClient(authState) {
  const cookieHeader = authState.cookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  const sessionCode = authState.sessionCode;

  async function get(path) {
    const url = `${BASE_URL}/.${sessionCode}/${path}`;
    const res = await fetch(url, {
      headers: {
        Cookie: cookieHeader,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "manual",
    });

    // Session expired — LS redirects to CAS login
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location") || "";
      if (location.includes("cas.byu.edu")) {
        throw new SessionExpiredError();
      }
    }

    if (!res.ok && res.status < 300) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }

    return res.text();
  }

  async function getAbsolute(url) {
    const res = await fetch(url, {
      headers: {
        Cookie: cookieHeader,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/json,*/*;q=0.8",
      },
      redirect: "manual",
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location") || "";
      if (location.includes("cas.byu.edu")) {
        throw new SessionExpiredError();
      }
    }

    return res;
  }

  return { get, getAbsolute };
}
