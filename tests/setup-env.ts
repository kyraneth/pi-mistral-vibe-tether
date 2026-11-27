/**
 * Clear this extension's own knobs before any test runs.
 *
 * Every `PI_MISTRAL_VIBE_TETHER_*` variable changes what the tether does. The
 * suite clears them all, scrubs shell API keys, and gives each test fresh
 * runtime, data, and source state directories: a developer's real tether
 * home, runtime base, or official VIBE_HOME must never leak in.
 */
import { beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_MISTRAL_VIBE_TETHER_")) {
    delete process.env[key];
  }
}
delete process.env.MISTRAL_API_KEY;
delete process.env.MISTRAL_VIBE_API_KEY;

// Pin the scratch root once so per-test directories never nest (deeply
// nested paths would also break UNIX socket staging).
const ROOT = tmpdir();

beforeEach(() => {
  process.env.TMPDIR = mkdtempSync(join(ROOT, "t-"));
  process.env.PI_MISTRAL_VIBE_TETHER_RUNTIME_DIR = mkdtempSync(
    join(ROOT, "t-runtime-"),
  );
  process.env.PI_MISTRAL_VIBE_TETHER_DATA_DIR = mkdtempSync(
    join(ROOT, "t-data-"),
  );
  process.env.PI_MISTRAL_VIBE_TETHER_SOURCE_VIBE_HOME = mkdtempSync(
    join(ROOT, "t-src-"),
  );
});
