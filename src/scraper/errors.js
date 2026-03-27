export class SessionExpiredError extends Error {
  constructor() {
    super(
      "BYU Learning Suite session has expired. Run 'npm run auth' to re-authenticate."
    );
    this.name = "SessionExpiredError";
  }
}

export class ParseError extends Error {
  constructor(page, detail) {
    super(`Failed to parse ${page}: ${detail}`);
    this.name = "ParseError";
    this.page = page;
  }
}
