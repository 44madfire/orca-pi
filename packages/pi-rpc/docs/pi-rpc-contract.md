# Pi RPC Contract (SNC1.1 — authoritative)

Validated against **real Pi `0.84.4`** in `--mode rpc` (not OMP/mocks).
Fixtures: `packages/pi-rpc/fixtures/*.jsonl` (normalized, secret-free,
LF-only). Spike client: `packages/pi-rpc/src/spike-client.ts` (strict
LF-only JSONL). Capture procedure: `packages/pi-rpc/spike/README.md`.

> Scope: Pi RPC → Orca `StructuredAgentSessionAdapter` compatibility.
> Orca owns Runs/Tasks/Dispatches/worktrees and completion; `orca-pi` is a
> thin Pi-facing wrapper. This doc pins the Pi side so SNC1.2 (transport) and
> SNC1.3 (bridge) build on proven semantics.

## 1. Baseline

- Binary: `pi --version` → `0.84.4` (`fixtures/baseline.json`).
- Hosts probed: `win32`, Node `v25.3.0`, Orca app `1.4.197` present but not
  required for RPC.
- Framing: **strict JSONL, LF (`\n`) only**. Clients split stdout on `\n`
  only, strip one trailing `\r` (CRLF tolerance), and never use Node
  `readline` (it splits on U+2028/U+2029, valid inside JSON strings).
- Proven: `bash` round-trip carrying literal `U+2028`/`U+2029` arrives as a
  single JSONL record when split on `\n` only (`fixtures/bash-rpc.jsonl`).
  `JSON.stringify` emits these as literal characters, so a `readline`-based
  client would corrupt the stream. `JsonlFramer`/`attachJsonlReader` implement
  the compliant path and are unit-tested with chunk splits, CRLF, multibyte,
  and embedded separators.
- Auth: provider OAuth/API keys stay in `PI_CODING_AGENT_DIR/auth.json` and
  are never captured. `set_steering_mode` / `set_follow_up_mode` /
  `set_auto_compaction` / `set_auto_retry` **mutate global settings.json** —
  capture scripts must use an isolated `PI_CODING_AGENT_DIR` (auth copied,
  settings minimal) to avoid polluting the user config.
- Extension caveat: user `~/.pi/agent/extensions/*.ts` (e.g.
  `orca-titlebar-spinner.ts`) inject `extension_ui_request setTitle` spinner
  events into every turn. Isolated-dir runs prove the base protocol without
  them; production clients must ignore unknown fire-and-forget UI requests.

## 2. Protocol shape

- **Commands** (`c2s`, stdin): one JSON object per line, optional `id` for
  correlation. `{"id":"s1","type":"get_state"}`.
- **Responses** (`s2c`, stdout): `{"id":"s1","type":"response",
  "command":"get_state","success":true,"data":{...}}`. `id` echoes when the
  command carried one. `success:false` carries `error` (never `data`).
- **Events** (`s2c`): agent lifecycle / deltas / queue / compaction /
  extension-UI. No `id` except `bash_execution_update.id` (correlates the
  originating `bash` command id).
- **Extension UI responses** (`c2s`): `{"type":"extension_ui_response",
  "id":"<EXT_UI_ID>", "value"|"confirmed"|"cancelled":...}`.
- `success:true` on `prompt` means *accepted/queued/handled*, not completed.
  Completion is `agent_end` + `agent_settled`. Failures after acceptance flow
  through the message stream, not a second `response`.
- `agent_end` carries `messages` + `willRetry`; `agent_settled` means Pi will
  not continue automatically (no retry/compaction/queued continuation left).
- `turn_start`/`turn_end`: one assistant response + its tool results.
  `turn_end` echoes the assistant `message` + `toolResults`.
- `message_start`/`message_end` carry full `AgentMessage`s;
  `message_update` carries deltas only (`assistantMessageEvent` + cumulative
  `usage`). Clients assemble live text from `text_start`/`text_delta`/
  `text_end` keyed by `contentIndex`; `message_end.message` is authoritative.
- Undocumented-but-observed stdout events (not in upstream `rpc.md` table):
  `thinking_level_changed {level}`, `session_info_changed {name}`,
  `queue_update {steering, followUp}` (also emitted by `clear_queue`/`steer`/
  `follow_up` alongside their responses).

## 3. Proven sequences (fixture → what it locks)

| Fixture | Proves |
|---|---|
| `startup-idle.jsonl` | Idle `get_state` (model/thinking/streaming flags, `sessionId`, counts), `get_entries`/`get_tree` with 2 bootstrap entries (`model_change` → `thinking_level_change`) + `leafId`, empty `get_messages`/`get_fork_messages`, `get_available_thinking_levels`, empty `get_last_assistant_text` returns `data:{}` (docs say `{"text":null}` — real Pi returns `{}`; bridge must handle both). |
| `text-streaming.jsonl` | `prompt` accept → `agent_start`/`turn_start`/`message_start(user)`/`message_end(user)`/`message_start(assistant, stopReason:pending)`/`text_start`/`text_delta`/`text_end(with content)`/`message_end(stop:stop)`/`turn_end(toolResults:[])`/`agent_end(willRetry:false)`/`agent_settled`; `get_last_assistant_text` → `{"text":"alpha beta gamma"}`. |
| `thinking.jsonl` | `thinking_start`/`thinking_delta(contentIndex:0)` interleaved with `text_* (contentIndex:1)`, `thinking_end(content)` + `text_end`; final `content:[{type:thinking,thinking,thinkingSignature:reasoning_content},{type:text}]`. Low thinking may emit no thinking block; `high` reliably does on `glm-5.3-flash`. |
| `tool-execution.jsonl` | `toolcall_start{id,toolName}` → `toolcall_delta` (arg JSON chunks) → `toolcall_end{toolCall}`; `tool_execution_start{toolCallId,toolName,args}` → zero or more `tool_execution_update{partialResult (accumulated, replace display)}` → `tool_execution_end{result,isError}`; `toolResult` message round-trip; second turn carries the final text. `read` yields no updates (instant); streaming `bash` tool yields `[]` → `tick-1` → `tick-1,2,3` updates. Correlate by `toolCallId`. |
| `bash-rpc.jsonl` | Direct `bash` (no LLM): `bash_execution_update{id,delta}` chunks stream even when the final `output` is truncated; response `{output,exitCode,cancelled,truncated[,fullOutputPath]}`; result becomes a `bashExecution` message visible via `get_messages` and included in next-prompt LLM context. Literal U+2028/U+2029 survive as one record (LF-only proof). |
| `abort-queue.jsonl` | `abort` mid-thinking → `message_end(stopReason:aborted, errorMessage:"Request was aborted")` → `turn_end` → `agent_end(willRetry:false)` → `agent_settled` → `abort` response `success:true` (response arrives *after* settle). Idle `steer`/`follow_up` succeed + `queue_update`; `clear_queue` returns `{steering[],followUp[]}` + `queue_update` empty. `prompt` with `streamingBehavior:"steer"` accepted while idle; queued steer delivered as a `user` message before the next LLM call (`turn_start` → `queue_update` drained). |
| `state-tree.jsonl` | `get_state` with `sessionFile`+`sessionName`; `get_entries` full chain + `leafId`; `since` cursor returns strictly-after entries + current `leafId`; `get_tree` `{entry,children} + leafId` (single root when well-formed); `get_fork_messages` lists forkable user turns; `get_last_assistant_text`; `get_session_stats` (tokens/cost/contextUsage; `contextUsage` omitted when no model/window). |
| `models-thinking.jsonl` | `get_available_models` (full `Model` objects), `set_model` success emits `thinking_level_changed` then response with new `Model`, invalid `set_model` → `Model not found`; `get_available_thinking_levels` per-model (e.g. `["low","high","max"]` on `glm-5.3-flash`); `set_thinking_level` emits `thinking_level_changed` + response; `cycle_thinking_level` returns `{level}`; **lenient**: bogus level succeeds and falls back to `minimal` + `thinking_level_changed(minimal)` (no error — bridge must validate levels itself). Queue/auto commands (`set_steering/follow_up_mode`, `set_auto_compaction/retry`, `abort/abort_bash/abort_retry` idle) all `success:true`. |
| `images.jsonl` | `prompt` with `images:[{type:image,data:<base64>,mimeType:image/png}]` accepted; `user` message preserves `{type:text}+{type:image,data,mimeType}`; model with `input:[text,image]` replies normally (`ONE-PIXEL` on 1px PNG); `get_entries` preserves image blocks. Models without image input (e.g. `deepseek-v4-flash`) must be guarded client-side. |
| `extension-ui.jsonl` | Dialog: `prompt /rpc-ask` → `extension_ui_request{select,title,options}` → client `extension_ui_response{value}` → `notify` fire-and-forget → `prompt` response `success:true` (request precedes response). `confirm` mirrors with `{confirmed}`. Fire-and-forget (`notify/setStatus/setWidget/setTitle/set_editor_text`) never expect a response — clients may display or ignore. Extension commands execute immediately even during streaming and leave no session entries (`get_entries` still only bootstrap entries). `get_commands` lists `{name,description,source,sourceInfo}`. |
| `resume-branch.jsonl` | `get_state.sessionFile/sessionId`; kill + new process + `switch_session{sessionPath}` → `cancelled:false` restores identical `entries/leafId`; `get_last_assistant_text` resumes at active leaf. `fork{entryId}` → `{text,cancelled:false}`, resets to a **new session** (new `sessionId`/`sessionFile`, `messageCount:0`, entries = fresh bootstrap chain parented under the old chain; old branch abandoned). `get_tree` after fork shows only the new chain + new `leafId`. `clone` on an unsaved (no assistant response) session → `success:false "This session has not been saved yet..."`. `new_session` → `cancelled:false` + fresh bootstrap. `set_session_name` → `session_info_changed` event + `get_state.sessionName`. |
| `malformed-exit.jsonl` | Raw `not-json` → `{command:parse,success:false}`; JSON-string body → `{success:false, error:"Unknown command: undefined"}`; unknown object type echoes `command`; `set_model` invalid, `fork` bad id (`"Invalid entry ID for forking"`), `get_entries since` missing (`"Entry not found: missing"`); `prompt`-while-streaming without behavior → `success:false "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."` (rejected turn leaves no `get_fork_messages` entry); `switch_session` to a nonexistent path **succeeds** (`cancelled:false`) and re-points `sessionFile` at that path with a fresh bootstrap (must be treated as *new empty session*, not an error); `compact` on tiny session emits `compaction_start(manual)` → `compaction_end{aborted:false,willRetry:false,errorMessage}` + response `success:false "Nothing to compact (session too small)"`; `export_html` with no conversation → `success:false "Nothing to export yet..."`; stdin EOF → clean exit `0`; SIGTERM fallback documented. |

## 4. Session tree / current-leaf / resume semantics

- The session is an **append-only tree** of entries with stable ids. Entry
  types observed: `model_change`, `thinking_level_change`, `message`
  (`user`/`assistant`/`toolResult`/`bashExecution` payloads).
- `leafId` (in `get_entries`/`get_tree`) is the **current leaf**; clients can
  detect branch moves in one round trip. `since:<entryId>` is a durable
  cursor returning strictly-after entries; unknown `since` → `success:false`.
- `get_tree` nests `{entry, children}`; well-formed sessions have one root;
  orphans appear as extra roots.
- `get_messages` returns the **active-branch flattened view** (excludes
  pre-compaction history and abandoned branches); `get_entries` includes them.
- Resume = `switch_session{sessionPath}` (or `--session/--session-dir` at
  spawn). The resumed process reports the same `entries/leafId`, and
  `get_last_assistant_text`/`get_state.messageCount` continue at the leaf.
- `fork{entryId}` abandons the current branch and starts a new session whose
  bootstrap entries parent onto the old chain; the old messages disappear
  from `get_entries`/`get_tree`. `clone` duplicates the active branch (fails
  closed until the session has been saved). `new_session` starts fresh
  (cancellable by `session_before_switch` extensions → `cancelled:true`).

## 5. Interactive UI / options / images

| Capability | Verdict |
|---|---|
| Text streaming (`text_start/delta/end`) | **Proven** (`text-streaming`). |
| Thinking (`thinking_start/delta/end` + `thinking` block) | **Proven** (`thinking`; level-dependent). |
| Tool progress/result (`tool_execution_*`, `toolcall_*`) | **Proven** (`tool-execution`; `partialResult` is accumulated). |
| Direct `bash` + `bash_execution_update` | **Proven** (`bash-rpc`). |
| Abort (`abort`, `stopReason:aborted`) | **Proven** (`abort-queue`). |
| Queued input (`steer`/`follow_up`/`clear_queue`/`queue_update`, `streamingBehavior`) | **Proven** (`abort-queue`; idle + during-streaming). |
| `get_state`/`get_entries`+`leafId`/`get_tree`/`get_messages`/`get_session_stats`/`get_fork_messages`/`get_last_assistant_text` | **Proven** (`state-tree`). |
| Model discovery/switch (`get_available_models`/`set_model`/`cycle_model`) | **Proven** (`models-thinking`; invalid fails closed). |
| Thinking discovery/switch (levels/`set`/`cycle`) | **Proven** with leniency note (bogus → `minimal`, no error). |
| Images (`prompt.images`, `ImageContent`) | **Proven** 1px PNG round-trip (`images`); guard models without `image` input. |
| Extension dialogs (`select`/`confirm`/`input`/`editor` + `extension_ui_response`) | **Proven** for `select`/`confirm`+`notify` (`extension-ui`); `input`/`editor` share the same `value`/`cancelled` shape per `rpc.md` but were not live-exercised — treat as **supported-by-protocol, single-sample**. |
| Extension fire-and-forget (`notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text`) | **Proven observed** (spinner `setTitle` + demo `notify`/`setStatus`/`setWidget`); safe to ignore. |
| Unsupported/degraded UI (`custom`, `setWorking*`, `setFooter/Header`, `getEditorText=""`, `getToolsExpanded=false`, `getAllThemes=[]`, `setTheme→{success:false}`) | **Marked per docs, not live-exercised** — bridge must not depend on them. |
| Resume at active leaf (`switch_session`, `--session`) | **Proven** (`resume-branch`). |
| Fork/clone/new_session/rename | **Proven incl. fail-closed edges** (`resume-branch`, `malformed-exit`). |
| Compaction (`compact`, `set_auto_compaction`, `compaction_*`) | **Proven fail-closed on tiny sessions**; successful compaction summary shape per `rpc.md` was not live-captured (cost) — treat summarization as **supported, shape-per-docs**. |
| Retry (`set_auto_retry`, `abort_retry`, `auto_retry_*`) | Commands proven (`success:true`); retry event loop not triggered in fixtures — **supported, events per docs**. |
| `export_html` | **Proven fail-closed when empty**; HTML export bytes not captured. |
| Process exit (EOF→0, SIGTERM) | **Proven** (`malformed-exit`). |
| `get_commands` (extension/prompt/skill) | **Proven** (extension entries + user skills observed in full runs). |
| `cycle_model` | Per-docs (`{model,thinkingLevel,isScoped}|null`); live cycle not captured — **supported, shape-per-docs**. Single-model hosts return `null` data. |

## 6. Rejected / malformed operations (fail-closed)

All cases in `malformed-exit.jsonl`: `parse` errors, unknown commands,
invalid model/fork/cursor, prompt-while-streaming without behavior, compact
too small, export empty. Every rejection is a `success:false` response with
an `error` string and **no partial state change** (fork list unchanged after
a rejected prompt). The two surprises for bridge authors: bogus thinking
levels do *not* reject (fallback to `minimal`), and `switch_session` to a
missing path *succeeds* as a new empty session.

## 7. Pi RPC → Orca `StructuredAgentSessionAdapter` compatibility matrix

Legend: ✅ direct map · 🔶 needs translation/policy · ❌ no counterpart.

| Pi RPC | Orca structured session | Notes |
|---|---|---|
| `prompt` accept → `agent_start`…`agent_settled` | message send → turn lifecycle → settled | ✅ Map `agent_settled` to Orca turn-settled; `willRetry:false` mirrors Orca completion. `prompt` response alone is not completion. |
| `message_update text_*` | streaming text deltas | ✅ Concatenate by `contentIndex`; `message_end` authoritative. |
| `message_update thinking_*` + `thinking` block | thinking/reasoning channel | 🔶 Route to Orca thinking UI; preserve `thinkingSignature` opaquely. Low thinking may omit the channel. |
| `toolcall_*` + `tool_execution_*` + `toolResult` | tool invocation/progress/result | ✅ Correlate by `toolCallId`; `partialResult` replaces display (accumulated). `isError` maps to Orca tool-error styling. |
| `bash` + `bash_execution_update` + `bashExecution` message | out-of-band execution | 🔶 Surface as a tool-style execution; note it enters LLM context only on the next `prompt`. |
| `abort` → `stopReason:aborted` | cancel/esc | ✅ `abort` response arrives after `agent_settled`; Orca must wait for settle before re-enabling input. Esc-pattern = `clear_queue` then `abort`, restore text from `clear_queue.data`. |
| `steer`/`follow_up`/`clear_queue`/`queue_update`/`streamingBehavior` | queued follow-ups / steering | 🔶 `steer` = before-next-LLM-call, `followUp` = after-settle; `one-at-a-time` vs `all` modes map to Orca queue policy. |
| `get_state{isStreaming,isCompacting,steeringMode,followUpMode,messageCount,pendingMessageCount,model,thinkingLevel,sessionId/Name/File}` | session status | ✅ Poll or cache; `isStreaming/isCompacting` gate Orca send buttons. |
| `get_entries{entries,leafId}` + `since` cursor | journal/history | ✅ `leafId` = Orca current-leaf; `since` = durable journal cursor across restarts. |
| `get_tree{tree,leafId}` | branch/tree view | ✅ Single-root assumption with orphan fallback matches Orca branch UX. |
| `get_messages` (active branch flat) | chat transcript | ✅ Render user/assistant/toolResult; `bashExecution` renders as execution block. |
| `get_fork_messages` / `fork` / `clone` / `new_session` / `switch_session` | history/branch/resume | 🔶 `fork` abandons current branch (warn before use); `clone` fails closed until saved; `switch_session` missing-path creates empty (confirm with user). Resume = `switch_session` to `sessionFile`. |
| `get_session_stats{user/assistant/toolCounts,tokens,cost,contextUsage}` | usage/cost footer | ✅ `contextUsage` may be omitted (no model/window) or `null` tokens post-compaction. |
| `get_available_models` / `set_model` / `cycle_model` | model picker | ✅ Filter by `input` for images; surface `contextWindow`; `cycle` may return `null`. Invalid `set_model` fails closed. |
| `get_available_thinking_levels` / `set_thinking_level` / `cycle_thinking_level` | thinking control | 🔶 Validate levels client-side (Pi is lenient: bogus → `minimal`). `xhigh`/`max` only on supporting models. |
| `set_steering/follow_up_mode`, `set_auto_compaction/retry`, `abort_retry`, `abort_bash` | session options | 🔶 All `success:true` idempotent; note they persist to Pi settings (bridge should set explicitly per session). |
| `compact` + `compaction_*` + `set_auto_compaction` | context compaction | 🔶 Map summary/firstKeptEntryId/tokens to Orca compaction UI; handle `Nothing to compact` fail-closed. |
| `export_html` | export/share | 🔶 Fails closed when empty; bytes not yet bridged. |
| `images` (`ImageContent`) | attachments | ✅ Gate on model `input` includes `image`; preserve `data/mimeType` opaquely. |
| `extension_ui_request select/confirm/input/editor` + `extension_ui_response` | options/dialogs | 🔶 Render as Orca options/input dialogs; `cancelled` → `undefined` (select/input/editor) or `false` (confirm); honor `timeout` as auto-resolve hint. Extension commands run immediately even during streaming. |
| `extension_ui_request notify/setStatus/setWidget/setTitle/set_editor_text` | status/widgets/title | ❌ Safe to ignore (or map title/status to Orca chrome); never block for a response. `custom()`/TUI-only APIs are no-ops in RPC — bridge must not offer them. |
| `get_commands` (extension/prompt/skill) | slash commands | ✅ Prefix `/`; built-in TUI commands excluded by Pi. |
| `get_last_assistant_text` | last-answer shortcut | ✅ Handle both `{"text":...}` and `{}` (empty) shapes. |
| Malformed ops (`parse`/unknown/invalid) | error toasts | ✅ Every failure is `success:false` + `error`; no partial mutation. |
| Process exit (EOF→0) | lifecycle/teardown | ✅ EOF stdin for clean shutdown; SIGTERM fallback; never leave duplicate owners (see SNC1.9 handoff). |

## 8. What SNC1.2/1.3 must enforce

1. Use the strict LF-only transport (`jsonl.ts` semantics); never `readline`.
2. Treat `agent_settled` (not `prompt` response) as completion.
3. Correlate `bash_execution_update` by command `id` and `tool_*` by
   `toolCallId`; `partialResult` replaces, deltas append.
4. Validate thinking levels + image support client-side (Pi is lenient).
5. Confirm destructive branch ops (`fork`, `switch` to missing path) in UX.
6. Isolate `PI_CODING_AGENT_DIR` in tests; never capture secrets.
7. Ignore unknown fire-and-forget UI requests forward-compatibly.
