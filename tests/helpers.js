import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, "../debug");

export function loadFixture(filename) {
  return readFileSync(resolve(FIXTURE_DIR, filename), "utf-8");
}
