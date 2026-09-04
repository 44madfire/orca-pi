# Manual qualitative evals (OP1.6 / JEF-10)

Automated guard tests (`profile.defaults.test.ts`, `profile.examples.test.ts`)
verify tool allowlists, ambient-off defaults, prompt sync, model-agnostic
overrides, fresh reviewer sessions, and context-summary output. The prompts
below are for human qualitative runs against a real Pi binary — they exercise
the scout → worker → reviewer flow end to end.

Prerequisites:

```sh
npm run build
node packages/cli/dist/main.js profile inspect scout --project-root . --context-summary
node packages/cli/dist/main.js profile inspect worker --project-root . --context-summary
node packages/cli/dist/main.js profile inspect reviewer --project-root . --context-summary
```

All three should resolve on a fresh install (no config files) via built-in
defaults. Override models in your own `profiles.yaml` while retaining role
policy:

```yaml
profiles:
  scout:
    model: <fast-model>
  worker:
    model: <coding-model>
  reviewer:
    model: <reasoning-model>
```

## 1. Scout fixture — locate auth, prove read-only

Repo: any project with login/session handling (or this repo — ask where
`doctor` version reporting is implemented).

Scout task (paste to Pi launched with the scout profile):

> Using only inspection, identify where authentication is implemented.
> Return: 2-4 sentence summary, key files (path — symbol — why),
> uncertainties, and 2-5 suggested worker files in priority order.
> Do not modify any files.

Pass criteria:

- Answer cites real paths/symbols with evidence, lists uncertainties, and
  suggests sensible worker files.
- `orca-pi profile inspect scout --context-summary` shows
  `tools: 4 (read, grep, find, ls)`, no `edit`/`write`, discovery off.
- No files change on disk (`git status` clean).

## 2. Worker fixture — small tested change with validation

Task (bounded, e.g. "add a unit test for `estimatePromptTokens(5) === 2`
and fix any off-by-one"):

> Inspect relevant files/tests first. Keep the change scoped — do not
> refactor unrelated code. Run the focused tests/typecheck/lint covering
> your change. Report: changed files, validation commands with results,
> and explicit unresolved concerns ("None" if empty).

Pass criteria:

- `orca-pi profile inspect worker` shows edit-capable tools
  (`read,grep,find,ls,bash,edit,write`) and `contextFiles: on`.
- Diff is scoped to the task; focused `npm test` / `tsc` passes.
- Summary lists changed files, validation output, and concerns.

## 3. Reviewer fixture — flawed implementation, blocking findings

Setup: introduce a deliberate flaw (e.g. worker tool that shells out with
unsanitized input, missing test, or swallowed error). Then run the reviewer:

> Independently evaluate the implementation against the task and acceptance
> criteria using only the task description, diff, and current files.
> Prioritize correctness, regressions, security, missing tests, and
> architecture violations. Cite file/symbol evidence. Label each finding
> Blocking or Non-blocking. Do not modify files.

Pass criteria:

- Verdict is "Request changes" with at least one Blocking finding citing
  file/symbol evidence (e.g. injection, missing test, regression).
- `orca-pi profile inspect reviewer` shows
  `tools: 5 (read, grep, find, ls, bash)` — no `edit`/`write` — and
  `session: ephemeral` (fresh context, never resumes worker history).
- No files change on disk; repairs are described as follow-ups, not applied.

## Regression notes

- Guard test blocks worker tools/skills leaking into scout/reviewer
  defaults (`profile.defaults.test.ts` → "worker tools/skills never leak").
- Context-budget check: compare
  `profile inspect <name> --context-summary` before/after prompt edits;
  token figures are `ceil(chars/4)` heuristics for catching bloat, not
  provider billing.
