# `packages/pi-rpc` fixtures (SNC1.1)

Real Pi 0.85.1 `--mode rpc` request/response/event sequences, normalized for
deterministic tests. See `docs/pi-rpc-contract.md` for the authoritative
contract and `../../fixtures/README.md` (this file) for capture details.

## Envelope

Every `*.jsonl` line is one envelope:

```json
{"v": 1, "dir": "c2s", "payload": {"id": "s1", "type": "get_state"}}
{"v": 1, "dir": "s2c", "payload": {"id": "s1", "type": "response", "command": "get_state", "success": true, "data": {}}}
{"v": 1, "dir": "sys", "payload": {"event": "process-exit", "code": 0}}
```

- `c2s` — client→server (stdin). `payload` is the command object, or
  `{"raw": "..."}` for malformed-byte probes.
- `s2c` — server→client (stdout). `payload` is a `response`, event, or
  `extension_ui_request`.
- `sys` — local lifecycle note (process exit), not Pi output.

## Normalization

Volatile values are replaced with stable numbered aliases (see
`src/normalize.ts` — one `createRecordNormalizer()` per trace, aliases
assigned in first-seen order). Identity is preserved: the same raw id always
maps to the same alias, so `parentId` chains, `since` cursors, `leafId`, and
`toolCallId` correlations stay verifiable:

- Session UUIDs → `<SESSION_1>`, `<SESSION_2>`, …
- Entry ids (`8-hex`) → `<ENTRY_1>`, `<ENTRY_2>`, … — shared by `parentId`,
  `entryId`, `leafId`, `since`, and fork cursors, so `parentId` of entry N
  equals the id of entry N-1 and `leafId` names the current node.
- Tool calls (`call_*`, `toolCallId`) → `<CALL_1>`, `<CALL_2>`, …
- Extension UI request ids → `<EXT_UI_1>`, `<EXT_UI_2>`, … — a request and
  its matching `extension_ui_response` share the number.
- Provider `responseId` → `<RESPONSE_1>`, …
- ISO timestamp strings → `<TIMESTAMP_ISO>`; numeric epoch-ms `timestamp`
  fields → the fixed sentinel `1700000000000` (shape-preserving: a string
  placeholder would change the JSON type). Other numbers (usage, costs,
  counts) stay raw as representative protocol data.
- Absolute paths → `<SESSION_FILE>` / `<HOME>` / `<TMP>`.
- Base64 image bytes → `<IMAGE_DATA>` (mimeType + shape kept).
- Usage/cost numbers are preserved as representative real values.
- `U+2028`/`U+2029` payloads are literal characters (LF-only proof).

Each fixture is internally coherent as one real RPC sequence: `get_tree` is
the same session view as `get_entries`, `leafId` names the last entry,
`get_fork_messages` lists that session's user turns, and message counts
match the entries shown.

## Secret hygiene

Fixtures are secret-free: no API keys, bearer/OAuth tokens, refresh tokens,
or user paths. `fixtures.test.ts` fails closed on token-like patterns and
non-normalized `C:\Users\...` paths.

## Capture

Live capture used the strict spike client (`src/spike-client.ts`) against a
real Pi binary with isolated `PI_CODING_AGENT_DIR` (auth copied, settings
minimal) except where user extensions were the subject (extension-UI
fire-and-forget). LLM turns used `opencode-go/glm-5.3-flash` with low/high
thinking for cost control. Full capture procedure: `spike/README.md`.
`baseline.json` records the Pi version and redacted catalog summary.

## Files

- `baseline.json` — version + redacted protocol metadata (no secrets).
- `startup-idle.jsonl` — idle `get_state`/`get_entries`/`get_tree`/stats.
- `text-streaming.jsonl` — minimal text turn (`alpha beta gamma`).
- `thinking.jsonl` — thinking deltas → `thinking` block (excerpt).
- `tool-execution.jsonl` — `read` tool + streaming `bash` tool updates.
- `bash-rpc.jsonl` — direct `bash` + literal U+2028/U+2029 round-trip.
- `abort-queue.jsonl` — abort, steer/follow-up, queue updates, streamingBehavior.
- `state-tree.jsonl` — state/entries/since/tree/fork-messages/last-text/stats.
- `models-thinking.jsonl` — model + thinking discovery/switch + queue modes.
- `images.jsonl` — prompt with 1px PNG (`<IMAGE_DATA>` normalized).
- `extension-ui.jsonl` — select/confirm dialogs + notify + fire-and-forget.
- `resume-branch.jsonl` — switch resume, fork reset, clone/new-session semantics.
- `malformed-exit.jsonl` — rejected/malformed ops + EOF exit 0.
