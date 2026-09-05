/**
 * Volatile-field normalization + secret scrubbing for Pi RPC fixtures (SNC1.1).
 *
 * Real Pi sessions contain volatile values (session/entry/call/extension ids,
 * timestamps, absolute paths) that must be normalized so fixtures stay
 * deterministic without losing protocol shape. Identity relationships are
 * preserved: the same raw id always maps to the same alias within one
 * normalization session, so `parentId` chains, `since` cursors, `leafId`,
 * and `toolCallId` correlations stay verifiable.
 *
 * Alias vocabulary (numbered, assigned in first-seen order per normalizer):
 * - `<SESSION_1>`, `<SESSION_2>`, … — session UUIDs (`sessionId`).
 * - `<ENTRY_1>`, `<ENTRY_2>`, … — session entry ids (8-hex `id`), shared by
 *   `parentId`, `entryId`, `leafId`, `since`, and fork cursors so chains stay
 *   checkable (`parentId` of entry N equals the id of entry N-1).
 * - `<CALL_1>`, `<CALL_2>`, … — tool call ids (`call_*`, `toolCallId`).
 * - `<EXT_UI_1>`, `<EXT_UI_2>`, … — extension UI request ids (UUIDs under
 *   `extension_ui_request` / `extension_ui_response`).
 * - `<RESPONSE_1>`, … — provider `responseId` values.
 *
 * Singleton placeholders (no identity needed):
 * - `<TIMESTAMP_MS>`, `<TIMESTAMP_ISO>`
 * - `<SESSION_FILE>`, `<HOME>`, `<TMP>`, `<CWD>`
 * - `<IMAGE_DATA>` (base64 payloads are replaced; shape + mimeType kept)
 *
 * Secret hygiene: fixtures must never contain API keys, bearer tokens,
 * OAuth refresh tokens, or absolute user paths. `assertSecretFreeLine()` is
 * fail-closed: any token-like pattern or any raw user path fails.
 */

export const PLACEHOLDERS = Object.freeze({
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
const HEX8_RE = /\b[0-9a-f]{8}\b/g;
const CALL_RE = /\bcall_[A-Za-z0-9]+\b/g;
const ISO_TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const EPOCH_MS_RE = /(?<!\d)(1[678]\d{12})(?!\d)/g;
const WIN_ABS_RE = /[A-Za-z]:\\(?:[^"\\\n]+\\)*[^"\\\n]*/g;
const UNIX_HOME_RE = /\/(?:home|Users)\/[A-Za-z0-9._-]+/g;
// Any raw Windows user path, regardless of placeholders elsewhere on the line.
const RAW_WIN_USER_PATH_RE = /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/;

/** Token-like patterns that must never appear in a fixture. */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "bearer", re: /bearer\s+[A-Za-z0-9\-._~+/=]{16,}/i },
  { name: "api-key", re: /sk-(?:proj-)?[A-Za-z0-9\-_]{16,}/ },
  { name: "pi-auth", re: /"access"\s*:\s*"eyJ[A-Za-z0-9\-_]+/ },
  { name: "refresh-token", re: /"refresh"\s*:\s*"rt\.[^"]+"/ },
  { name: "oauth-token", re: /ya29\.[A-Za-z0-9\-_]{16,}|xox[bpas]-[A-Za-z0-9\-_]{8,}/ },
];

function aliasFor(map: Map<string, string>, raw: string, prefix: string): string {
  const hit = map.get(raw);
  if (hit) return hit;
  const alias = `<${prefix}_${map.size + 1}>`;
  map.set(raw, alias);
  return alias;
}

/**
 * Stateful normalizer: one instance per capture/file so aliases stay
 * consistent across every record of that trace. Create a fresh instance per
 * fixture file (or per capture run).
 */
export function createRecordNormalizer() {
  const sessionIds = new Map<string, string>();
  const entries = new Map<string, string>();
  const calls = new Map<string, string>();
  const extUi = new Map<string, string>();
  const responses = new Map<string, string>();

  function entryAlias(raw: string): string {
    return aliasFor(entries, raw, "ENTRY");
  }

  function normalizeStringWithMaps(s: string): string {
    let out = s;
    out = out.replace(ISO_TS_RE, "<TIMESTAMP_ISO>");
    out = out.replace(EPOCH_MS_RE, "<TIMESTAMP_MS>");
    // call_* tokens first (they contain hex suffixes that HEX8_RE would eat).
    out = out.replace(CALL_RE, (m) => aliasFor(calls, m, "CALL"));
    out = out.replace(UUID_RE, (m) => aliasFor(sessionIds, m.toLowerCase(), "SESSION"));
    out = out.replace(HEX8_RE, (m) => aliasFor(entries, m.toLowerCase(), "ENTRY"));
    out = out.replace(WIN_ABS_RE, (m) => {
      if (m.endsWith(".jsonl") || m.includes("sessions")) return "<SESSION_FILE>";
      if (m.includes("Temp") || m.includes("tmp")) return "<TMP>";
      return "<HOME>";
    });
    out = out.replace(UNIX_HOME_RE, "<HOME>");
    return out;
  }

  function normalizeField(
    key: string,
    value: unknown,
    parent: Record<string, unknown> | null,
  ): unknown {
    // Image bytes (any length — the 1px test PNG is short by design).
    if (
      key === "data" &&
      typeof value === "string" &&
      parent !== null &&
      typeof parent["mimeType"] === "string" &&
      (parent["mimeType"] as string).startsWith("image/")
    ) {
      return "<IMAGE_DATA>";
    }
    if (typeof value === "string") {
      const lower = key.toLowerCase();
      if (lower === "sessionname") return value;
      if (lower === "sessionfile") return "<SESSION_FILE>";
      if (lower === "sessionid") return aliasFor(sessionIds, value.toLowerCase(), "SESSION");
      if (lower === "leafid") return entryAlias(value.toLowerCase());
      if (lower === "entryid" || lower === "since") return entryAlias(value.toLowerCase());
      if (lower === "parentid") return value === null ? null : entryAlias((value as string).toLowerCase());
      if (lower === "toolcallid") return aliasFor(calls, value, "CALL");
      if (lower === "responseid") return aliasFor(responses, value, "RESPONSE");
      if (lower === "id") {
        // Extension UI correlation ids are UUIDs inside extension_ui payloads.
        const isExtUi =
          parent !== null &&
          (typeof parent["method"] === "string" ||
            parent["type"] === "extension_ui_request" ||
            parent["type"] === "extension_ui_response");
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
          return isExtUi
            ? aliasFor(extUi, value.toLowerCase(), "EXT_UI")
            : aliasFor(sessionIds, value.toLowerCase(), "SESSION");
        }
        if (/^[0-9a-f]{8}$/i.test(value)) return entryAlias(value.toLowerCase());
        if (/^call_/i.test(value)) return aliasFor(calls, value, "CALL");
        return value;
      }
      return normalizeStringWithMaps(value);
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      return value;
    }
    return normalize(value);
  }

  function normalize(value: unknown, parent: Record<string, unknown> | null = null): unknown {
    if (typeof value === "string") return normalizeStringWithMaps(value);
    if (Array.isArray(value)) return value.map((v) => normalize(v, parent));
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = v === null ? null : normalizeField(k, v, obj);
      }
      return out;
    }
    return value;
  }

  return { normalize, normalizeField };
}

/**
 * One-shot normalization (fresh aliases per call). Prefer
 * `createRecordNormalizer()` when several records of one trace must share
 * aliases; this wrapper exists for single values and legacy callers.
 */
export function normalizeRecord(value: unknown): unknown {
  return createRecordNormalizer().normalize(value);
}

/** Fail-closed secret scan for one JSONL line (raw text). */
export function assertSecretFreeLine(line: string, source: string): void {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(line)) {
      throw new Error(`fixture ${source} contains suspected secret (${name})`);
    }
  }
  // Any raw Windows user path fails, even when a placeholder appears
  // elsewhere on the same line.
  if (RAW_WIN_USER_PATH_RE.test(line)) {
    throw new Error(`fixture ${source} contains a non-normalized Windows path`);
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
