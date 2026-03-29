export class SessionExpiredError extends Error {
  constructor() {
    super(
      "BYU Learning Suite session has expired. Go to learningsuite.byu.edu, log in, then click the 'Connect to Claude' bookmark again to reconnect."
    );
    this.name = "SessionExpiredError";
    this.code = "SESSION_EXPIRED";
  }
}

export class ParseError extends Error {
  constructor(page, detail) {
    super(`Failed to parse ${page}: ${detail}`);
    this.name = "ParseError";
    this.page = page;
    this.code = "PARSE_ERROR";
  }
}
