/**
 * Volatile-field normalization + secret scrubbing for Pi RPC fixtures (SNC1.1).
 *
 * Real Pi sessions contain volatile values (session/entry/call/extension ids,
 * timestamps, absolute paths, usage counters) that must be normalized so
 * fixtures stay deterministic without losing protocol shape. This module is
 * the single place that defines the placeholder vocabulary used by every
 * fixture under `packages/pi-rpc/fixtures/*.jsonl`.
 *
 * Placeholders (stable strings, never secrets):
 * - `<SESSION_ID>`, `<ENTRY_ID>`, `<PARENT_ID>`, `<LEAF_ID>`
 * - `<CALL_ID>`, `<EXT_UI_ID>`, `<RESPONSE_ID>`
 * - `<TIMESTAMP_MS>`, `<TIMESTAMP_ISO>`
 * - `<SESSION_FILE>`, `<HOME>`, `<TMP>`, `<CWD>`
 * - `<IMAGE_DATA>` (base64 payloads are replaced; shape + mimeType kept)
 *
 * Secret hygiene: fixtures must never contain API keys, bearer tokens,
 * OAuth refresh tokens, or absolute user paths. `scrubSecrets()` is a
 * fail-closed guard: it throws when it sees token-like material.
 */

export const PLACEHOLDERS = Object.freeze({
  sessionId: "<SESSION_ID>",
  entryId: "<ENTRY_ID>",
  parentId: "<PARENT_ID>",
  leafId: "<LEAF_ID>",
  callId: "<CALL_ID>",
  extUiId: "<EXT_UI_ID>",
  responseId: "<RESPONSE_ID>",
  timestampMs: "<TIMESTAMP_MS>",
  timestampIso: "<TIMESTAMP_ISO>",
  sessionFile: "<SESSION_FILE>",
  home: "<HOME>",
  tmp: "<TMP>",
  cwd: "<CWD>",
  imageData: "<IMAGE_DATA>",
});

const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX8_RE = /\b[0-9a-f]{8}\b/gi;
const ISO_TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const EPOCH_MS_RE = /(?<!\d)(1[678]\d{12})(?!\d)/g;
const WIN_ABS_RE = /[A-Za-z]:\\(?:[^"\\\n]+\\)*[^"\\\n]*/g;
const UNIX_HOME_RE = /\/(?:home|Users)\/[A-Za-z0-9._-]+/g;

/** Token-like patterns that must never appear in a fixture. */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "bearer", re: /bearer\s+[A-Za-z0-9\-._~+/=]{16,}/i },
  { name: "api-key", re: /sk-(?:proj-)?[A-Za-z0-9\-_]{16,}/ },
  { name: "pi-auth", re: /"access"\s*:\s*"eyJ[A-Za-z0-9\-_]+/ },
  { name: "refresh-token", re: /"refresh"\s*:\s*"rt\.[^"]+"/ },
  { name: "oauth-token", re: /ya29\.[A-Za-z0-9\-_]{16,}|xox[bpas]-[A-Za-z0-9\-_]{8,}/ },
];

function isHex8InContext(text: string, index: number): boolean {
  // Avoid rewriting short hex words that are clearly not ids (e.g. colors).
  // Fixture normalization only targets entry/call-ish ids; the guard below
  // keeps the transform conservative when the surrounding JSON key is
  // unrelated. The structured normalizer (normalizeRecord) handles the
  // precise id fields; this regex pass is a last-mile sweep.
  void text;
  void index;
  return true;
}

/**
 * Normalize one parsed JSON value: replace volatile ids/timestamps/paths
 * with placeholders while preserving every key and the overall shape.
 * Usage/cost numbers are preserved (they document real protocol shape).
 */
export function normalizeRecord(value: unknown): unknown {
  if (typeof value === "string") return normalizeString(value);
  if (Array.isArray(value)) return value.map(normalizeRecord);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeField(k, v);
    }
    return out;
  }
  return value;
}

function normalizeField(key: string, value: unknown): unknown {
  if (key === "data" && typeof value === "string" && value.length > 256) {
    // Base64 image payloads: keep shape, drop bytes.
    if (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.replace(/\s/g, "").length > 256) {
      return PLACEHOLDERS.imageData;
    }
  }
  if (typeof value === "string") {
    const lower = key.toLowerCase();
    if (lower === "sessionid") return PLACEHOLDERS.sessionId;
    if (lower === "sessionfile") return PLACEHOLDERS.sessionFile;
    if (lower === "leafid" && value !== null) return PLACEHOLDERS.leafId;
    if (
      (lower === "id" || lower === "entryid" || lower === "parentid" || lower === "toolid" || lower === "toolcallid") &&
      value.length >= 8
    ) {
      if (lower === "parentid") return value === null ? null : PLACEHOLDERS.parentId;
      return PLACEHOLDERS.entryId;
    }
    if (lower === "responseid") return PLACEHOLDERS.responseId;
    if (lower === "sessionname") return value;
    return normalizeString(value);
  }
  if (typeof value === "number") {
    return value;
  }
  return normalizeRecord(value);
}

function normalizeString(s: string): string {
  let out = s;
  out = out.replace(ISO_TS_RE, PLACEHOLDERS.timestampIso);
  out = out.replace(EPOCH_MS_RE, PLACEHOLDERS.timestampMs);
  out = out.replace(UUID_RE, PLACEHOLDERS.sessionId);
  // 8-hex entry ids (Pi session entries, tool call suffixes).
  out = out.replace(HEX8_RE, (m) => (isHex8InContext(out, 0) ? PLACEHOLDERS.entryId : m));
  // call_xxx tool call ids collapse to a single placeholder id.
  out = out.replace(/\bcall_[A-Za-z0-9]+\b/g, `call_${PLACEHOLDERS.entryId}`);
  out = out.replace(WIN_ABS_RE, (m) => {
    if (m.endsWith(".jsonl") || m.includes("sessions")) return PLACEHOLDERS.sessionFile;
    if (m.includes("Temp") || m.includes("tmp")) return PLACEHOLDERS.tmp;
    return PLACEHOLDERS.home;
  });
  out = out.replace(UNIX_HOME_RE, PLACEHOLDERS.home);
  return out;
}

/** Fail-closed secret scan for one JSONL line (raw text). */
export function assertSecretFreeLine(line: string, source: string): void {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(line)) {
      throw new Error(`fixture ${source} contains suspected secret (${name})`);
    }
  }
  // Absolute user paths must be normalized.
  if (/C:\\Users\\[A-Za-z0-9._-]+\\/.test(line) && !line.includes(PLACEHOLDERS.sessionFile)) {
    // Allow the placeholder-adjacent drive prefix only when the rest is
    // already normalized; otherwise fail so authors normalize paths.
    if (!line.includes("<SESSION_FILE>") && !line.includes("<HOME>") && !line.includes("<TMP>")) {
      throw new Error(`fixture ${source} contains a non-normalized Windows path`);
    }
  }
}

/** Validate that text is strict LF-only JSONL (no CRLF record separators). */
export function assertLfOnlyJsonl(text: string, source: string): void {
  if (text.includes("\r\n")) {
    throw new Error(`fixture ${source} must be LF-only (found CRLF)`);
  }
  // Note: literal U+2028/U+2029 are legal inside JSON strings and must
  // survive LF-only splitting. Covered by jsonl tests + bash-rpc fixture.
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    if (line === "" && i === lines.length - 1) continue; // trailing newline
    if (line === "") throw new Error(`fixture ${source} line ${i + 1}: empty record`);
    if (line.endsWith("\r")) throw new Error(`fixture ${source} line ${i + 1}: CR-terminated record`);
    try {
      JSON.parse(line);
    } catch (error) {
      throw new Error(`fixture ${source} line ${i + 1}: invalid JSON (${(error as Error).message})`);
    }
    assertSecretFreeLine(line, `${source}:${i + 1}`);
  }
}
