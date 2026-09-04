# prompts/

Concise role prompts for the default scout → worker → reviewer flow
(OP1.6 / JEF-10). These files are human-readable copies of the built-in
inline prompts in `packages/core/src/profile/builtins.ts`
(`SCOUT/WORKER/REVIEWER_SYSTEM_PROMPT`); `profile.defaults.test.ts` enforces
they stay in sync (modulo trailing newline / CRLF normalization).

- `scout.md` — read-only inspection, evidence-backed handoff, no modifications.
- `worker.md` — bounded implementation, inspect-before-edit, focused validation.
- `reviewer.md` — independent fresh-context review, Blocking vs Non-blocking.

Role prompts never duplicate Orca `worker_done`/heartbeat lifecycle
instructions — Orca injects those at dispatch time.

See `../docs/EVALS.md` for manual qualitative eval prompts (auth fixture,
small tested change, flawed-implementation review).
