# Shenmay AI — Session Notes

> This file is the live handoff between Claude sessions.
> Update it at the end of every session. Claude reads it automatically via CLAUDE.md.

---

## Last updated: 2026-06-03 — **FULL-PRODUCT HEALTH SWEEP (v3.5.8)** — report-first, no code shipped (0 P0 / 3 P1 / ~13 P2 / ~20 P3)

Austin asked for a full "is the product still working as intended" sweep across backend / frontend / on-prem / cloud, as a `/goal` at ultracode. REPORT-FIRST: findings catalogued, fixes deferred to his triage. **First action was reconciling git** — the local working copy was 17 commits behind (v3.4.3); fast-forwarded to origin/main `7573e27` (v3.5.8) after stashing a stale SESSION_NOTES draft.

### Evidence the product is healthy
- **5×5 repeatability gate**: fresh dispatch [run 26846022297](https://github.com/jafools/shenmay-ai/actions/runs/26846022297) → **11/11 green** (5 SaaS + 5 on-prem + verdict); nightly cron green every day. Local unit suites 187 green (tokenizer 46 + openai-adapter 29 + brand-learning 91 + integration-unit 21).
- **Prod** shenmay.ai: ext+int `/api/health` 200, images `:3.5.8`, containers up 2wks, legacy nomii→301. **Staging** healthy, refresh timer active.
- **Live staging walk** (Chrome MCP, throwaway tenant, cleaned up): real `/api/onboard/register` ✓, login UI ✓, onboarding wizard ✓, all 10 dashboard surfaces render clean ✓, 16 settings sections ✓, widget session ✓ + chat path verified (graceful `NoApiKeyError` → friendly message, HTTP 200) ✓.
- **Audit confirmed clean**: multi-tenant isolation (every query scoped by tenant_id), AES-256-GCM correct, `resolveApiKey` platform-fallback correctly `isSelfHosted()`-gated (regression #1 ✓), model-drift via `getDefaultModel` (regression #2 ✓), lazy-require SDK (#6 ✓), friendly-error-destination (#5 ✓), widget boundary (JWT scope/XSS/CORS/sanitization), PG≤16 idempotency (except mig 019), parameterized SQL throughout, 0 exploitable deps.

### Headline findings (full list in the sweep report + audit task outputs)
- **P1 — SaaS trial still 1/20, not 3/50.** `onboard.js:236` hardcodes `(1,20)` instead of `PLAN_LIMITS.trial` (=`3/50`, plans.js:45); `admin-routes.js:88-89` has a 2nd stale `1/20` copy. v3.4.2 bumped the constant + backfilled rows but never touched the signup INSERT → **every new SaaS signup hits the unusable 1-customer/20-msg wall** v3.4.2 thought it fixed. (Confirmed by 2 agents + my live read.)
- **P1 — Platform-admin login brute-forceable.** `loginLimiter` is on onboard/auth login (index.js:185/192) but NOT on `/api/platform/auth` (index.js:198) — highest-priv account, only the 150/min global net.
- **P1 — PII phone-number leak.** PHONE regex (piiTokenizer/detectors/index.js:91) needs separators; contiguous `5551234567` passes tokenizer AND breach-detector (shares same regex set) → raw phone reaches the LLM, violating the privacy promise.
- **P2 cluster**: Stripe webhook accepts unsigned events when `STRIPE_WEBHOOK_SECRET` unset (stripe-webhook.js:50-59); Stripe no event-idempotency (retried checkout double-issues self-hosted licenses); SaaS trial/free message counter never resets (monthly reset gated to self-hosted only); `/api/auth/detect-tenant` unthrottled enumeration oracle; JWT alg unpinned; brand-learning embedding pre-pass sends un-re-audited candidate text to OpenAI before Layer-3 PII scan; PII lowercase-IBAN + dotted-SSN/personnummer residue; **input-visibility regression #4 re-introduced** in 4 hand-styled settings sections (Labels/Connectors/Webhooks/DataApi — CompanyProfile etc. are fine); Conversations bulk-select checkbox invisible; migration 019 bare `RENAME` → boot-loop on re-run (latent, on-prem/DR risk).
- **P3 (~20)**: server npm audit 0→3 (qs DoS, unreachable); orphaned tests/api.test.js; client vitest harness unused; .env.example missing ~20 tunables; GCM IV 16B; mock-provider 500 / staging mock-canary technique broken (set-one-tenant-to-mock fails because mock is gated on env `LLM_PROVIDER`, not tenant column); Team-page footer copy lies (fix the COPY, not the role gate — agent corrected an inverted diagnosis); Data API example curls hardcoded to shenmay.ai; a11y label/id gaps; etc.

### Fixes shipped this session (Austin greenlit "everything P1+P2"; report-first → fix)
- ✅ **[#196](https://github.com/jafools/shenmay-ai/pull/196) trial-limits (P1)** — route onboard.js + admin-routes.js set-plan through `PLAN_LIMITS`; added `free` to `PLAN_LIMITS`; new SaaS trials now 3/50 (was the stale 1/20). **MERGED** (squash `0790d2b`). +2 unit guards (free-limits + "every admin plan has a PLAN_LIMITS entry").
- ✅ **[#197](https://github.com/jafools/shenmay-ai/pull/197) auth-hardening (P1 + 2×P2)** — `loginLimiter` on `/api/platform/auth/login` (was unthrottled); JWT `algorithms:['HS256']` pinned at all 6 `jwt.verify` sites; `registerLimiter` on `/api/auth/register` + a 20/min limiter on `/api/auth/detect-tenant`. **MERGED**. +2 JWT unit tests (HS256 round-trip + alg:none rejection).
- ⏳ **[#198](https://github.com/jafools/shenmay-ai/pull/198) pii-residue (P1 + 2×P2)** — keyword-anchored separator-less PHONE detector ("call 5551234567") + compact-lowercase IBAN + dotted SSN/personnummer + 5 fixtures. **Subtle bug caught**: an `i`-flag on the uppercase IBAN detector let the BBAN class swallow a trailing lowercase word ("…32 thanks") → mod-97 fail → real IBAN leaked (brand-learning fuzz iter 10). Fixed with a separate compact-lowercase detector + regression guard. CI green, **merging** (5×5 not required — no release tag cut this session).

### Remaining greenlit P2s — QUEUED for the next session (2 PRs)
1. **`fix/stripe-webhook`** — (a) reject unsigned events in prod when `STRIPE_WEBHOOK_SECRET` unset ([stripe-webhook.js:50-59](server/src/routes/stripe-webhook.js#L50) currently dev-bypasses; its Resend sibling refuses this); (b) event idempotency — a retried `checkout.session.completed` double-issues self-hosted license keys → needs a `processed_stripe_events` table + migration 043 (DO-block per the PG≤16 rule).
2. **`fix/billing-frontend-migration`** — (a) SaaS trial/free **message counter never resets** (monthly reset gated to self-hosted only); (b) **input-visibility regression #4** in 4 hand-styled settings sections — LabelsSection.jsx:102, ConnectorsSection.jsx:201, WebhooksSection.jsx:189, DataApiSection.jsx:185 → use the shared `inputStyle`; (c) Conversations **bulk-select checkbox invisible** (missing `group` class); (d) **migration 019** bare `RENAME` → DO-block `IF EXISTS` guard (boot-loop risk on re-run).

### Lower-priority deferred (from the sweep, not yet greenlit for fixing)
- detect-tenant response-trim; bare separator-less personnummer (needs date-validation); breach-detector independence (P3, architectural); platform/tenant **shared `JWT_SECRET`** (P3); **Team-page footer copy** (P3 — fix the COPY at ShenmayTeam.jsx:278, NOT the role gate — an audit verifier corrected an inverted diagnosis); admin set-plan stale copy was fixed in #196.
- Full per-finding detail (severity/repro/file:line/fix) in the two audit task outputs (`whbjabje9` structured + `w3qjm8352` prose, under the session temp dir) + the sweep report message.

---

## Last updated: 2026-05-16 — **v3.5.8 LIVE** — v3.5.7 follow-ups (canary + TS migration + threshold tune)

Sub-session arc: Austin asked to close out all 5 carry-overs from the v3.5.7 SESSION_NOTES in one batched ship. Four were known follow-ups; the fifth (live OpenAI canary) surfaced a real bug — the embedding distance threshold v3.5.6 shipped with was empirically wrong against live `text-embedding-3-small` vectors. Threshold tuning got rolled into the same PR + tag rather than deferring.

### Headline numbers

| | Result |
|---|---|
| PR merged | **[#194](https://github.com/jafools/shenmay-ai/pull/194)** — v3.5.7 follow-ups · squash commit `6e6c0f2` |
| Tag | **v3.5.8** |
| Production deploy | 1 — Hetzner SSH, health-checked clean, zero rollbacks |
| 5×5 release gate | **11/11 green** ([run 25962242245](https://github.com/jafools/shenmay-ai/actions/runs/25962242245)) |
| Per-PR CI | **5/5 green** ([run 25962166739](https://github.com/jafools/shenmay-ai/actions/runs/25962166739)) |
| Unit tests | tokenizer 46 + openai-adapter 29 + brand-learning **91/91** (was 90 — +1 pinpoint threshold test) = 166/166 |
| Files touched | 16 (12 deletions + 4 modifications) |
| Wall-clock per-PR CI → prod live | ~30 min (5×5 ~15 min the long pole) |

### What v3.5.8 ships (commit-by-commit)

**Commit 1 — `chore(repo)`:** delete `Covenant Trust/` folder
- 12 stale Phase-1 demo artifacts (initial schema, 3 fictional-customer JSON pairs — Jim Thompson / Margaret Chen / Rivera Family — old promptBuilder, 5 architecture/decision docs). Already in `.dockerignore`; never shipped. Names looked like real customers in the repo listing.

**Commit 2 — `fix(conversations)`:** surface bulk-action error toasts
- `client/src/pages/shenmay/dashboard/ShenmayConversations.jsx` — both bulk handlers (`handleBulkResolve`, `handleBulkLabel`) had bare `console.error` on failure → now also surface via `toast({ variant: "destructive" })`, matching the project's existing `use-toast` convention (e.g. `ShenmayBrandLearning`).
- Kept `console.error` alongside — toasts are for users, console is for engineers.
- No new dependency; `toast` was already imported by 13 sibling files.

**Commit 3 — `refactor(api-client)`:** migrate `shenmayApi.js` → `.ts`
- 473 lines, 104 exports, **zero behaviour change**. Every consumer (19 settings sections + dashboard pages + auth context) keeps identical imports.
- New exported TS types: `ApiError`, `HttpMethod`, `ProductRecord`, `ConversationFilters`, `LoginError`, `Tenant`, `Admin`, `AuthResponse`, `BrandLearningTarget`.
- `apiRequest<T = unknown>` is now generic; `verifyEmail` returns typed `AuthResponse`, privacy/anonymous-only toggles return `{ ok: true, ... }`, `completeSetup` returns typed `{ token, tenant }`.
- Vite path alias `@/lib/shenmayApi` resolves to `.ts` without any config change (same-basename `.js` → `.ts` is the default resolver order). `tsc --noEmit` clean.
- The git mv landed in commit 2 as a pure rename and the content rewrite landed in commit 3 — squash collapses that cosmetic split.

**Commit 4 — `fix(brand-learning)`:** tune embedding distance threshold 0.18 → 0.30 (canary)
- **Surfaced by the live OpenAI canary on staging** — see "Canary findings" below for the full data table.
- New constant: `DEFAULT_DISTANCE_THRESHOLD = 0.30` (within the documented "conservative (0.10–0.30)" envelope, so the existing range test still passes). New pinpoint test asserts the exact 0.30 value so future drift requires a fresh canary.
- Comment block above the constant captures the canary data + "if you change this, re-run the canary" rule.

### Canary findings (this is the interesting part)

Per yesterday's carry-over note, I ran a live OpenAI canary on the staging container (`shenmay-backend-staging`, `:edge`). Two-step:

1. **Wire-format smoke**: `curl https://api.openai.com/v1/embeddings` with the test key → HTTP 200, 1536-dim vectors from `text-embedding-3-small`. Wire format works as expected by `embeddings.js`.

2. **End-to-end via the module's own code path**: `docker exec -i shenmay-backend-staging node` running a script that calls `bl.resolveEmbedFn({ apiKey, provider: 'openai' })` and exercises `cosineSimilarity` + `cosineDistance` + `findBestMatch` against 9 realistic FAQ paraphrase pairs.

Real `text-embedding-3-small` output (1536-dim):

| Pair | Sim | Dist | Old (0.18) | New (0.30) |
|---|---:|---:|---|---|
| "pricing plans" ↔ "pricing plans you offer" | 0.94 | 0.06 | MERGE | MERGE |
| "ship internationally" ↔ "ship overseas" | 0.92 | 0.08 | MERGE | MERGE |
| "pricing plans" ↔ "your prices" | 0.72 | 0.28 | ❌ kept apart | MERGE |
| **"Do you offer refunds?" ↔ "What's your refund policy?"** | **0.74** | **0.26** | ❌ **kept apart (BUG)** | ✓ MERGE |
| "pricing plans" ↔ "Can you tell me about pricing?" | 0.66 | 0.34 | ❌ kept apart | ❌ kept apart |
| "ship internationally" ↔ "delivered to Europe" | 0.50 | 0.50 | ❌ kept apart | ❌ kept apart |
| "offer refunds" ↔ "get my money back" | 0.57 | 0.43 | ❌ kept apart | ❌ kept apart |
| "pricing plans" ↔ "What time do you close?" | 0.21 | 0.79 | ✓ kept apart | ✓ kept apart |

The bolded row is the bug: a textbook semantic paraphrase ("refunds?" vs "refund policy?") that v3.5.6 was specifically designed to catch but the 0.18 threshold missed. 0.30 catches it. Unrelated pairs are all ≥ 0.43 distance — comfortably outside the new threshold.

**Root cause of the calibration error**: the v3.5.6 unit tests used handcrafted/random mock vectors that don't reflect real `text-embedding-3-small` spread behaviour. The 0.18 default was an honest guess that turned out to be too tight. Caught exactly the way `feedback_static_tests_dont_catch_wire_quirks` predicted: mock tests pass, real wire-format reveals the gap.

### Verification

Pre-merge:
- `npm run build` ✓ (Vite 5.55s, 2535 modules)
- `npm run lint` ✓ (0 errors, 13 pre-existing warnings)
- `npx tsc --noEmit` ✓ (client)
- Unit tests: 166/166 (tokenizer 46 + openai-adapter 29 + **brand-learning 91**)
- Per-PR CI: client-build 26s / server-test 48s / e2e-saas 2m20s / onprem-e2e 2m54s / selfhosted-smoke 45s → **5/5 green**

Post-merge:
- 5×5 release gate: **11/11 green** (5 SaaS + 5 on-prem + verdict)

Deploy:
- Hetzner SSH `git checkout v3.5.8` → `docker compose pull` + `up -d`
- Internal `/api/health` (127.0.0.1:3001) → `{"status":"ok"}`
- External `https://shenmay.ai/api/health` → 200 + same payload
- `docker inspect`: backend + frontend both `ghcr.io/jafools/shenmay-{backend,frontend}:3.5.8`

### Where things stand on prod

| Surface | State |
|---|---|
| https://shenmay.ai | backend + frontend both `:3.5.8` |
| Hetzner repo | checked out at `v3.5.8` |
| Internal `/api/health` | 200 OK |
| External `/api/health` | 200 OK via Cloudflare |
| Brand-learning worker | still running, **0 opted-in tenants** on prod — the threshold change is a no-op for customer-impact until a tenant opts in with an OpenAI BYOK |
| DB | unchanged — no migration in this tag |

### Carry-over patterns memorised

- `feedback_static_tests_dont_catch_wire_quirks` was reactivated — pattern confirmed AGAIN: 90/90 unit tests passed against mock vectors for v3.5.6, real wire-format canary surfaced the bug. The mitigation that's worked twice now: pin a `LIMITATION` or pinpoint test that asserts the canary-validated value, so future drift requires a fresh canary run (not just `git push`).

### Carry-over (NOT done, flagged for future sessions)

1. **TS migration of `client/src/contexts/ShenmayAuthContext.jsx`** — would be the next-highest-leverage TS conversion since auth-context state is consumed by every dashboard page.
2. **tsconfig strict-mode flip** — explicitly deferred this session per Austin's call. Revisit when more files have TS surface.
3. **`Covenant Trust` cleanup spawn** (rotate `OPENAI_API_KEY`) — the canary key pasted into chat should be rotated by Austin. NOT a code task.
4. **Threshold backoff verification** — current 0.30 is canary-validated against 9 pairs. Worth a re-canary against 20-30 pairs in 1-2 months when real tenant data exists.

### Files modified

```
Covenant Trust/                                          (12 files removed)
client/src/lib/shenmayApi.{js → ts}                      (TS migration)
client/src/pages/shenmay/dashboard/ShenmayConversations.jsx
server/src/services/brandLearning/embeddings.js
tests/brand-learning.test.js
```

---

## Previous: 2026-05-16 — **v3.5.7 LIVE** — Overnight /codebase-cleanup pass

Sub-session arc: Austin paged at bedtime — *"We have a lot of tokens to burn, just do a /codebase-cleanup and patch up whatever you find. Im going to bed."* Autonomous run from an isolated worktree on branch `claude/ecstatic-curie-f10057`. The `anthropic-skills:codebase-cleanup` skill spawned 8 specialist subagents in parallel (dedup, type consolidation, unused code, circular deps, weak types, defensive programming, deprecated/legacy, AI slop), each scoped to a single cleanup dimension. Austin returned in the morning, said "squash merge and push to prod," and the chore-class release flow ran top-to-bottom in ~7 min wall-clock.

### Headline numbers

| | Result |
|---|---|
| PR merged | **[#192](https://github.com/jafools/shenmay-ai/pull/192)** — codebase-cleanup pass · squash commit `5efee59` |
| Tag | **v3.5.7** |
| Production deploy | 1 — Hetzner SSH, health-checked clean, zero rollbacks |
| 5×5 release gate | **11/11 green** (run [25955654175](https://github.com/jafools/shenmay-ai/actions/runs/25955654175)) |
| Unit tests | 165/165 local (tokenizer 46 + openai-adapter 29 + brand-learning 90); integration deferred to CI |
| Files touched | 9 (8 source files + .gitignore for `cleanup-reports/` artifact dir) |
| Wall-clock merge → live | ~7 min (5×5 gate completed in ~4 min — unusually fast since no real code paths exercise; image build ~3 min; SSH deploy ~1 min) |
| Migration | **none** — pure refactor + chore, no schema, no API contract change |

### Agent fan-out result

| # | Agent              | Tool used         | Files | Verdict |
|---|--------------------|-------------------|-------|---------|
| 1 | Dedup & DRY        | jscpd             | 3     | 3 helpers extracted, ~80 lines collapsed |
| 2 | Type Consolidation | grep              | 0     | TS surface too small (6 .ts/.tsx files of shadcn primitives) |
| 3 | Unused Code        | knip + grep       | 3     | 7 module-private demotions (no behaviour change) |
| 4 | Circular Deps      | madge + dep-cruise| 0     | Zero cycles in server (87 mods) or client (81 mods) |
| 5 | Weak Types         | grep              | 0     | Zero `any`/`unknown`/`@ts-ignore` |
| 6 | Defensive Prog.    | grep              | 0     | All 350 try/catches legitimate |
| 7 | Deprecated/Legacy  | grep + git blame  | 2     | 2 stale narrative comments refreshed |
| 8 | AI Slop / Comments | grep              | 0     | WHY-style comments enforced project-wide |

**Headline: the codebase is unusually clean** — 5 of 8 agents found zero high-confidence work because the codebase already follows the conventions each agent was looking for.

### What v3.5.7 ships (commit-by-commit)

**Commit 1 — `refactor(server-routes)`:** three behaviour-preserving dedup extractions
- `server/src/routes/onboard.js` — `buildAuthResponse(token, row, {widgetVerified})` collapses 2× the 20-line `{token, tenant, admin}` JSON shape in `/verify` + `/login` (~35 lines saved). Shape consumed by `ShenmayAuthContext`.
- `server/src/routes/portal/customers-routes.js` — `verifyCustomerOwnership(res, customerId, tenantId)` collapses 4× repeated `SELECT id FROM customers WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL` tenant-isolation check (~20 lines). Helper writes the 404 + returns false → caller bare-returns.
- `server/src/routes/dataApi.js` — `resolveCustomerByExternalId(res, tenantId, externalId, msg?)` collapses 4× lookup-by-`external_id` (~25 lines). Preserves the custom POST 404 message; GET/DELETE use default.

**jscpd impact:** clones 148 → 141 (−7), duplicated lines 1745 → 1665 (−80).

**Commit 2 — `chore(server)`:** noise removal
- `llmService.js` — `tokenizationEnabledFor` demoted (internal to `buildTokenizer`)
- `brandLearning/embeddings.js` — `embed`, `fetchStoredEmbeddings`, `upsertEmbedding`, `mergeBucketViaEmbeddings`, `EMBED_MODEL` demoted. Verified zero external consumers via grep across tests + routes + `services/brandLearning/index.js` barrel.
- `brandLearning/curate.js` — `locateArray` demoted (internal helper for `deleteItem`/`promoteItem`)
- `routes/portal.js:391` — refreshed stale comment claiming legacy `@visitor.nomii` was *also recognised*; migration 033 unified all such rows onto `@visitor.shenmay` and the helpers in `server/src/constants/anonDomains.js` only match the canonical domain.
- `brandLearning/promote.js:30` — refreshed Phase 3 forecast (*"Phase 3 will replace the token-overlap heuristic with AgentDB HNSW"*); Phase 3 (v3.5.6) actually shipped as an OpenAI-embedding pre-pass stacked above this file (`worker.js mergeAllCandidates`), with the token-overlap heuristic kept as the fallback layer.
- `.gitignore` — ignore `cleanup-reports/` (skill artifacts, regenerated per run).

### Verification

Pre-merge (PR #192):
- Build: `npm run build` ✓ (Vite production build, 4.91s, 2535 modules)
- Lint: `npm run lint` ✓ (0 errors, 13 pre-existing warnings unchanged)
- Unit tests: tokenizer **46/46** + openai-adapter **29/29** + brand-learning **90/90** = **165/165**
- `node --check` on all 8 modified files + `routes/portal/brand-learning-routes.js` downstream consumer
- Per-PR CI: client-build / server-test / e2e-saas / onprem-e2e / selfhosted-smoke — **5/5 green**

Post-merge:
- Post-merge CI on main (squash `5efee59`): **green**
- 5×5 release gate: **11/11 green** (5 SaaS repeats + 5 on-prem repeats + verdict job)

Deploy:
- Hetzner SSH: `git checkout v3.5.7`, `docker compose pull` + `up -d`
- Both containers recreated, DB container untouched
- Internal `/api/health` (127.0.0.1:3001) → `{"status":"ok"}`
- External `https://shenmay.ai/api/health` → 200 + same payload
- `docker inspect`: backend `ghcr.io/jafools/shenmay-backend:3.5.7`, frontend `ghcr.io/jafools/shenmay-frontend:3.5.7`

### Where things stand on prod

| Surface | State |
|---|---|
| https://shenmay.ai | backend + frontend both `:3.5.7` |
| Hetzner repo | checked out at `v3.5.7` |
| Internal `/api/health` | 200 OK |
| External `/api/health` | 200 OK via Cloudflare |
| Brand-learning worker | still running, 0 opted-in tenants on prod (unchanged from v3.5.6) |
| DB | unchanged — no migration in this tag |
| Staging (Proxmox) | `:edge` rebuilt post-merge, systemd timer picks up within 5 min |

### Notable gotcha caught + memorised

**knip flagged 172 "unused files" on this CommonJS Node + React codebase — every single one was a false positive.** knip cannot trace:
- Express dynamic route mounts: `app.use('/api/x', require('./routes/x'))`
- React-Router page registration (pages in `client/src/pages/...` wired into `<Route>` elements)
- Worker entry points loaded by `require('./workers/...').start()` at server boot in `server/src/index.js`
- Static files served from `server/public/`
- Files referenced only from non-code (docker-compose env, Dockerfiles, CI workflows, npm scripts)
- Even `concurrently` flagged as unused npm dep (false positive — used in `dev` script)

Spot-checked ~20 flagged files; zero true positives. Memorised as `feedback_knip_false_positives_commonjs_dynamic.md`. **Generalises:** on any CJS Node + React codebase, file-level deletion findings from knip need much more scrutiny than export-level findings. The 7 export-level demotions in this PR were reliable; the 172 file-level deletions would have been catastrophic.

### Stray-file aside (worth a memory cross-reference)

Sub-agents spawned via grep one-liners accidentally created zero-byte files at worktree root from quoted-shell mishaps (`1000)`, `embed(text`, `p.canonical_key`, etc.). Same shape as the existing `feedback_git_bash_stray_file_quirk` memory. Cleaned up via `rm` before staging — no commit pollution. Reminder for future parallel-agent runs: scan `git status` for unexpected file names before staging.

### Carry-over (NOT done — flagged for Austin's judgment)

1. **`Covenant Trust/` root folder** — a true orphan (historical artifact, already in `.dockerignore`), but ambiguous per skill safety rules. Flagged in `cleanup-reports/03-unused-code.md`, not deleted.
2. **`ShenmayConversations.jsx:544,556` bulk-action catches** — use `console.error` only; could surface a toast since optimistic UI hides failures from the user. UX polish, not a code-quality issue.
3. **TS migration of `client/src/lib/shenmayApi.js`** + auth contexts — would be the highest-leverage type-safety win (API response shapes become first-class types). Out of scope for cleanup.
4. **`tsconfig.json` has `strict: false`** / `strictNullChecks: false` / `allowJs: true` — flipping these is a separate architectural decision that would cascade through the `.js` codebase.
5. **Live OpenAI canary for v3.5.6 brand-learning Phase 3** — still pending from the previous session. The wire-format verification for embedding round-trips on a real opted-in tenant.

### Patterns lifted to MEMORY.md

- `feedback_knip_false_positives_commonjs_dynamic` — knip's CJS dynamic-loading blind spot; cross-reference grep is mandatory before deleting any file from a knip "unused" list.
- The existing `feedback_git_bash_stray_file_quirk` was re-validated — agents creating zero-byte stray files from shell-quoting still happens; scan `git status` for unexpected names before staging.

### Files modified

```
.gitignore                                       |  3 +
server/src/routes/dataApi.js                     | 65 ++++++++++----------
server/src/routes/onboard.js                     | 81 ++++++++++++-------------
server/src/routes/portal.js                      |  3 +-
server/src/routes/portal/customers-routes.js     | 44 +++++++-------
server/src/services/brandLearning/curate.js      |  1 -
server/src/services/brandLearning/embeddings.js  |  5 --
server/src/services/brandLearning/promote.js     |  7 ++-
server/src/services/llmService.js                |  3 +-
9 files changed, 105 insertions(+), 107 deletions(-)
```

Net: ~−2 lines diff total, but ~80 lines of *duplicated* code collapsed into 3 named helpers — the dedup metric is the meaningful one.

---

## Previous: 2026-05-15 — **v3.5.6 LIVE** — Brand-learning Phase 3 (embedding semantic dedup)

Sub-session arc: third + final ship of the brand-learning trilogy `/goal` (sub-goal 3 of 3, same day as sub-goals 1 + 2). Replaces the v3.5.3 Szymkiewicz–Simpson token-overlap heuristic with embedding-similarity dedup for the cases token-overlap couldn't handle (synonyms, transitive paraphrases across cycles). The `LIMITATION` test from v3.5.3 that pinned "transitive linking is not supported in v1" is now provably fixed for the embedding path.

### Headline numbers

| | Result |
|---|---|
| PR merged | **[#190](https://github.com/jafools/shenmay-ai/pull/190)** — Phase 3 embedding-based semantic dedup · merge commit `d573fcf` |
| Tag | **v3.5.6** |
| Production deploy | 1 — Hetzner SSH, health-checked clean, zero rollbacks |
| 5×5 release gate | **11/11 green** (run [25921996242](https://github.com/jafools/shenmay-ai/actions/runs/25921996242)) |
| Unit tests | brand-learning **90/90** (61 from v3.5.5 + 29 new under "Embedding semantic dedup") |
| Files touched | 6 (1 new migration · 1 new module · 4 modified) |
| Migration | **042** auto-applied on backend startup — `brand_learning_embeddings` table created cleanly on prod |
| Per-PR CI | 1 round-trip after fixing env-forwarding (see below) — 5/5 green |

### Deliberate design pivot vs the original plan

Pre-flight surfaced two material findings that required user input mid-implementation:

1. **pgvector is NOT installed** on Hetzner prod OR Proxmox staging — `postgres:16.9-alpine` doesn't ship it, and adding it would force an on-prem image upgrade. **Decision: store embeddings as JSONB float-arrays, compute cosine in JS.** Sub-ms for Shenmay's per-tenant scale (~40–200 keys/bucket); revisit if any tenant approaches 10k vectors.
2. **`$OPENAI_API_KEY` is NOT set platform-wide** on Hetzner — Shenmay uses BYOK. **Decision: reuse the tenant's existing BYOK via `resolveApiKey(tenant)`; fall back to v3.5.3 token-overlap when no OpenAI-compatible key is resolvable.** Opt-in is never blocked by missing embeddings.

Both decisions documented in `feedback_pgvector_not_available_on_postgres_alpine` + sister memory.

### What v3.5.6 does

**`server/db/migrations/042_brand_learning_embeddings.sql`** — new table `brand_learning_embeddings (tenant_id, bucket, canonical_key, embedding jsonb, model, created_at)` with PK on `(tenant_id, bucket, canonical_key)` + index on `(tenant_id, bucket)`. CHECK constraint on `bucket` enum wrapped in `DO`-block (PG ≤16 idempotency rule per `feedback_pg_add_constraint_no_if_not_exists`).

**`server/src/services/brandLearning/embeddings.js`** (NEW, 384 LoC) — pure cosine math (`cosineSimilarity`, `cosineDistance`, `findBestMatch`), fail-soft DB ops (`fetchStoredEmbeddings`, `upsertEmbedding`, `deleteEmbedding`), pure-logic merge (`mergeBucketPure` — testable without DB), DB-touching wrapper (`mergeBucketViaEmbeddings`), top-level entry (`mergeAllCandidates` — walks all 6 buckets), provider dispatch (`resolveEmbedFn` returns null for non-OpenAI), curation-side helpers (`curateTargetToEmbeddingBucket`, `canonicalKeyFromCurateItem`).

**`server/src/services/brandLearning/worker.js`** — wires `mergeAllCandidates` between distill (step 5) and `applyAndPromote` (step 6). Pre-decryption from v3.5.5 feeds both the distill anchor AND the embedding pre-pass — zero extra crypto cost. Try/catch keeps the pre-pass fail-soft.

**`server/src/services/brandLearning/index.js`** — re-exports the new public surface.

**`server/src/routes/portal/brand-learning-routes.js`** — `/items/delete` also deletes the matching embedding row; `/kill-switch` wipes all embeddings for the tenant. Keeps the table in sync with `brand_soul` / `brand_memory` after owner curation.

**`tests/brand-learning.test.js`** — 29 new tests under a new "Embedding semantic dedup" section, including:
- Cosine math correctness (identical / orthogonal / opposite / mismatched dims / empty)
- `findBestMatch` threshold + dimension-skip behavior
- `mergeBucketPure` rewrites display text on match, queues inserts on miss, fail-soft on null embed
- **Phase 3 fixes the transitive-paraphrase LIMITATION** — the 3 pricing FAQ paraphrases that v3.5.3 left as 2 parallel candidate rows now merge into 1 promoted FAQ
- `resolveEmbedFn` null-for-non-OpenAI gate
- `curateTargetToEmbeddingBucket` + `canonicalKeyFromCurateItem` mappers

### Mid-PR debug — env-forwarding lint

First per-PR CI run had server-test fail on `scripts/check-env-forwarding.js` — the PR #98 bug-class catcher detected `LLM_BRAND_LEARNING_EMBED_MODEL` referenced in code but not forwarded by either compose file. Added the variable to `docker-compose.yml` + `docker-compose.selfhosted.yml` with the same default the code uses (`text-embedding-3-small`). Local env-forwarding lint then passed, CI re-ran green. **Pattern caught: any new `process.env.X` in server code must land in both compose files in the same PR.**

### Prod smoke (on the running shenmay-backend container)

```
$ docker exec shenmay-backend node -e "const bl=require('./src/services/brandLearning'); …"
cosineSimilarity([1,0,0],[1,0,0]): 1
cosineSimilarity([1,0,0],[0,1,0]): 0
EMBEDDING_BUCKETS: faqs,processes,voice_cues,audience_pain_points,audience_objections,audience_request_types
mergeAllCandidates is fn: true
resolveEmbedFn(anthropic): null         # non-OpenAI → silent skip
resolveEmbedFn(openai): true            # OpenAI + key → embed fn returned

$ psql -c "SELECT filename FROM schema_migrations WHERE filename LIKE '042%';"
 042_brand_learning_embeddings.sql

$ psql -c "\d brand_learning_embeddings"
tenant_id  uuid       NOT NULL  ON DELETE CASCADE
bucket     text       NOT NULL  CHECK (in 6 enum values)
canonical_key  text   NOT NULL
embedding  jsonb      NOT NULL
model      text       NOT NULL
created_at timestamptz NOT NULL DEFAULT now()
PRIMARY KEY (tenant_id, bucket, canonical_key)
```

Backend startup logs: migration 042 applied cleanly ("Running" → "✓ Done"), brand-learning worker started, initial cycle "No tenants opted in" (expected — prod still has 0 opted-in tenants). No errors.

### Where things stand on prod

| Surface | State |
|---|---|
| https://shenmay.ai | backend + frontend both `:3.5.6` |
| Hetzner repo | checked out at `v3.5.6` |
| Migration 042 | applied — `brand_learning_embeddings` table exists |
| Internal `/api/health` | 200 OK |
| External `/api/health` | 200 OK via Cloudflare |
| Brand-learning worker | running, 0 opted-in tenants on prod, embedding path silently skipped (correct — no opted-in tenants to exercise) |
| Token-overlap fallback (v3.5.3) | still in place as the second layer for non-OpenAI BYOK tenants |

### Trilogy complete — what's the cumulative defense now

For LLM paraphrase divergence, brand-learning now has 3 complementary layers:

1. **Generation-time anchoring** (v3.5.5) — feed existing canonical_keys to Haiku as "reuse-or-skip" list → LLM converges on existing phrasings
2. **Embedding semantic dedup** (v3.5.6, this ship) — for paraphrases that escape anchoring, embed at distill time + rewrite to existing entry's text → applyAndPromote sees byte-equal match
3. **Token-overlap heuristic** (v3.5.3) — fallback when no OpenAI-compatible key, OR safety net when embedding service blips → catches the easier paraphrase cases

A new paraphrase has to evade all 3 to land as a parallel candidate row.

### Carry-over

The trilogy `/goal` is **complete**. Three sub-goals shipped same day with three tags + zero rollbacks. Goal status in `.claude/goal/active.md` → achieved.

Follow-ups (none blocking):

1. **Live OpenAI canary on a real opted-in tenant.** The LIMITATION-flip unit test proves the algorithm with deterministic mocks; the prod-container smoke proves the wiring + exports are correct on the running v3.5.6. A live canary with real OpenAI calls + a real tenant's `text-embedding-3-small` round-trips would add wire-format confidence (per `feedback_static_tests_dont_catch_wire_quirks`). Set this up by: spinning up a fresh staging tenant with the master-plan recipe, adding an OpenAI BYOK, opting it into brand-learning, seeding anon conversations across 3 cycles with paraphrased questions, and watching the `[BrandLearning] Embedding pre-pass for X: N merged, M inserted, ...` log line in the worker.
2. **Threshold tuning.** `DEFAULT_DISTANCE_THRESHOLD=0.18` is empirically reasonable but unwitnessed against real tenant data. After a real opted-in tenant has run a few cycles, audit the merge stats to confirm the threshold is in the right spot (too low → paraphrases miss; too high → unrelated concepts collide).
3. **Backfill existing tenants.** Tenants who opted into brand-learning on or before v3.5.5 have `brand_soul` / `brand_memory` entries with NO embeddings stored. The worker lazy-backfills — when it encounters a new candidate that doesn't match anything in the (empty) stored set, it inserts. Over a few cycles, the embedding table self-populates. No explicit backfill migration needed.

### Patterns lifted to MEMORY.md

- `feedback_pgvector_not_available_on_postgres_alpine` — pre-flight any vector-based feature against the actual installed extensions before writing the migration; `postgres:N-alpine` images don't include pgvector.
- `feedback_text_rewrite_pattern_keeps_promote_unchanged` — when you need a new "merge similar candidates" layer on top of an existing exact-match dedup engine, REWRITE the candidate display text to match an existing entry instead of changing the dedup engine's API. The exact-match fast path picks up the rewrite naturally.
- (Already in memory) — `feedback_compose_fallback_overrides_code_default` reactivated by env-forwarding lint catching `LLM_BRAND_LEARNING_EMBED_MODEL` not being forwarded.

---

## Previous: 2026-05-15 — **v3.5.5 LIVE** — Brand-learning distill-prompt anchoring

Sub-session arc: same-day second ship after the v3.5.4 canary walk (sub-goal 1 of the trilogy `/goal`). Sub-goal 2: feed existing `brand_soul` + `brand_memory` canonical keys to the Haiku distiller as a "reuse-or-skip" anchor list at generation time. Complements the v3.5.3 fuzzy-match post-filter (which catches paraphrases AFTER distillation) by preventing them BEFORE — the LLM sees the existing phrasings up front and converges on them instead of inventing parallel variants each cycle. Phase 3 (HNSW semantic dedup) is still the planned permanent fix; anchoring is the complementary generation-time stopgap.

### Headline numbers

| | Result |
|---|---|
| PR merged | **[#188](https://github.com/jafools/shenmay-ai/pull/188)** — distill-prompt anchoring · merge commit `36fb8c8` |
| Tag | **v3.5.5** |
| Production deploy | 1 — Hetzner SSH, health-checked clean, zero rollbacks |
| 5×5 release gate | **11/11 green** (run [25919656528](https://github.com/jafools/shenmay-ai/actions/runs/25919656528)) |
| Unit tests | brand-learning **61/61** (52 existing + 9 new under "Distill anchoring" section) |
| Files touched | 4 (1 service change + 1 worker change + 1 index change + 1 test extension) |
| Wall-clock per-PR CI → prod live | ~40 min (5/5 per-PR CI ~3 min → squash-merge → 5×5 dispatch ~14 min → tag → GHCR rebuild ~1 min → Hetzner deploy + smoke ~5 min) |
| Migration | **none** — pure code change, no schema / no API contract change |

### What v3.5.5 does

**`server/src/services/brandLearning/distill.js`** gets three new exports:

- `buildAnchorList(currentSoul, currentMemory, opts)` — pure helper, capped at `ANCHOR_MAX_PER_BUCKET=20` items per bucket, dedupes case-insensitively across soul + memory, returns `''` when nothing to anchor.
- `buildDistillSystem(currentSoul, currentMemory)` — returns `DISTILL_SYSTEM` unchanged when no anchor; otherwise APPENDS the anchor section AFTER the absolute-rules block (so the PII anti-extraction rules stay at the top of the prompt, load-bearing position preserved).
- The existing `distillBrandObservations` now accepts optional `currentSoul` + `currentMemory` params and feeds them through `buildDistillSystem`.

Anchor list draws from 6 buckets: `soul.faqs/processes/voice_cues` + `memory.candidate_audience.{pain_points|objections|request_types}`. Audience candidates are pulled from `brand_memory.candidate_audience.*` (objects with `.value` strings) since `audience_profile.*` (raw strings, promoted) is read-only from distill's perspective.

**`server/src/services/brandLearning/worker.js`** moves the `safeDecryptJson` calls for `currentSoul` + `currentMemory` + `currentAudience` from step 6 (`applyAndPromote`) to step 4b (right after scrub, before distill). Zero extra DB / crypto cost — same 3 reads, just reordered so the decrypted state is available for the anchor list at distill time.

**`server/src/services/brandLearning/index.js`** re-exports `buildAnchorList` + `buildDistillSystem` so tests can import them via the package surface.

**Tests** — 9 new tests under a fresh "Distill anchoring" section in `tests/brand-learning.test.js`:
1. Empty inputs → `''`
2. Soul.faqs → renders with correct header
3. Soul + memory dedupe on lowercase
4. All 6 buckets covered when populated
5. Cap respects `opts.maxPerBucket`
6. Default cap is `ANCHOR_MAX_PER_BUCKET=20`
7. `buildDistillSystem` empty → identical to `DISTILL_SYSTEM`
8. `buildDistillSystem` populated → appends, base prompt still at the top
9. Garbage entries (non-object, missing field, wrong field type) are filtered out

Lint clean. Server smoke `require()` of the brand-learning module confirms exports + behavior. Per-PR CI: 5/5 green (client-build, e2e-saas, onprem-e2e, selfhosted-smoke, server-test).

### Prod smoke

```
$ docker exec shenmay-backend node -e "const bl=require('./src/services/brandLearning'); …"
buildAnchorList OK
buildDistillSystem OK
distillBrandObservations OK
normalizeObservations OK

$ buildAnchorList({}, {}) → ""
$ buildAnchorList({faqs:[{question:'What are your hours?'}]}, {}) → contains "What are your hours?"
$ buildDistillSystem with one FAQ → length > DISTILL_SYSTEM.length (appends correctly)

$ curl https://shenmay.ai/api/health → {"status":"ok","service":"shenmay-ai", …}
$ docker inspect shenmay-backend  --format '{{.Config.Image}}' → ghcr.io/jafools/shenmay-backend:3.5.5
$ docker inspect shenmay-frontend --format '{{.Config.Image}}' → ghcr.io/jafools/shenmay-frontend:3.5.5
```

Backend logs on startup: migrations 040/041 skipped (already applied), brand-learning worker started, initial cycle ran cleanly with "No tenants opted in — cycle complete" (expected — prod has 0 opted-in tenants since the Apples canary reset in May). No errors.

### Where things stand on prod

| Surface | State |
|---|---|
| https://shenmay.ai | backend + frontend both `:3.5.5` |
| Hetzner repo | checked out at `v3.5.5` |
| Internal `/api/health` | 200 OK |
| External `/api/health` | 200 OK via Cloudflare |
| Brand-learning worker | running, 0 opted-in tenants on prod (anchor logic loaded + smoke-verified on the running container) |

### Carry-over

Sub-goal 2 of the active `/goal` complete. Awaiting user OK before starting:

- **Sub-goal 3 — Phase 3 HNSW semantic dedup** (the big one). Replace v3.5.3 Szymkiewicz–Simpson with OpenAI `text-embedding-3-small` + pgvector HNSW. Install pgvector extension via migration 042, new `brand_learning_embeddings` table with HNSW index, wire `promote.js` to embed canonical_keys + ANN-search same-bucket entries with cosine distance threshold (target ~0.15-0.20, tune via staging canary). Fallback to v3.5.3 token-overlap when no embedding key configured (doesn't block opt-in). Extend `promote.test.js` with deterministic embedding mock. Flip the `LIMITATION` test from pinned-passing-with-known-limitation to actual-passing. Ship as `v3.5.6` with 5×5 gate + Hetzner deploy clean. Confirm via staging canary on a fresh tenant: ≥1 fewer parallel-row per bucket vs v3.5.3 baseline OR audience_profile populating with previously-missed synonyms.

### Patterns to lift into MEMORY.md

- **Anchoring complements fuzzy dedup, doesn't replace it.** Generation-time + post-hoc form a defense-in-depth pair: anchor list catches cases where the LLM would otherwise emit a fresh phrasing for the same concept; fuzzy-match catches cases where anchoring didn't fire (e.g. legitimately new wording that maps to an existing concept). Phase 3 HNSW will catch a third tier: cross-language, transitive (anchored on first-seen vs anchored on similarity).
- **Pre-decrypt-once pattern.** Worker decrypts brand_soul/memory/audience at step 4b instead of step 6 — same 3 reads, available to both distill (anchor) and applyAndPromote (merge) in one decryption round. Pattern generalizes: any time a service needs decrypted state at two consecutive pipeline stages, decrypt once at the earliest stage.

---

## Previous: 2026-05-15 — **v3.5.4 canary walk on staging — CLEAN, no code changes**

Sub-session arc: 3 days after the v3.5.4 ship, close the carry-over loop from the wrap notes — "Apples canary on the new buttons: seed candidates, click trash + Approve-now via Chrome MCP / direct UI to prove the round-trip works in a browser session. Static bundle verification + unit tests don't cover the live React state machine — should walk it once." Did it on a fresh staging tenant instead of touching Apples on prod. Sub-goal 1 of a 3-step `/goal` covering the trilogy carry-over (canary → distill anchoring → Phase 3 HNSW).

### Headline numbers

| | Result |
|---|---|
| Surfaces walked | **7 list sections / 8 distinct curate actions** (3 brand_soul lists, 1 Watching candidates list with delete + promote, 3 audience_profile lists) |
| Defects found | **0** |
| Code changes | **none** — audit-only ship |
| Tag cut | none — pure verification |
| Network panel | **8/8 POSTs hit 200** (7 → `/items/delete`, 1 → `/items/promote`) |
| Audit table | **8 rows** in `brand_learning_incidents` (7 `manual_delete` + 1 `manual_promote`) with correct `{source, bucket, canonical_key}` payloads |
| React state machine | **8/8 lists updated without reload** — counters re-rendered (Learned facts 3→2→3, Pending 2→0), items disappeared from their sections, toasts fired, promoted FAQ migrated to Frequent questions section live |
| Wall-clock | ~30 min including seed-script authoring |

### How the canary ran

1. **DB-seeded fresh staging tenant** (`Canary Co`, id `11111111-2222-3333-4444-555555555555`) on `pontenprox / shenmay_ai_staging` via single transaction: INSERT `tenants` with `brand_learning_enabled=true` + plain-JSONB `brand_soul`/`brand_memory`/`audience_profile` (per `reference_db_seed_soul_memory` — `safeDecryptJson` passes plain objects through), INSERT `tenant_admins` with bcrypt-hashed password + `email_verified=true`, INSERT `subscriptions` row with `plan='master'` `status='active'` to clear `SubscriptionGate` (every dashboard page is gated, including brand-learning — this is a setup quirk for fresh canary tenants, not a v3.5.4 bug). All 7 lists seeded with at least one entry; `candidate_faqs` got 2 entries so both buttons could be tested independently.
2. **Pre-flight via curl**: `POST /api/onboard/login` → portal JWT → `GET /api/portal/brand-learning` returned all artifacts decrypted with `summary: {soul:{faqs:1,processes:1,voice_cues:1}, memory:{candidate_faqs:2}, audience:{1,1,1}}`. Pre-walk state confirmed.
3. **Browser walk via Claude-in-Chrome MCP** (Main Desktop): navigated to `/dashboard/brand-learning`, injected the portal token via `localStorage.setItem('shenmay_portal_token', ...)`, overrode `window.confirm = () => true` (each delete prompts a native confirm dialog that would block automation), then clicked each button via DOM `querySelector('button[aria-label="..."]')` — `CurateActions` exposes a stable per-item `aria-label` so the click target is deterministic.
4. **Per-action verification** via `read_network_requests` (URL pattern `/brand-learning/items`) — caught all 8 POSTs with `200` status codes in arrival order matching click order.
5. **Post-walk verification**: re-fetched `GET /api/portal/brand-learning` — soul had exactly 1 FAQ (the promoted one, with `manually_promoted: true` flag set per `curate.js:175`), all other 6 lists at 0. Audit log showed 8 rows with correct types/sources/buckets.
6. **Cleanup**: `DELETE FROM tenants WHERE id = '...'` cascaded to `tenant_admins`, `subscriptions`, `brand_learning_incidents` — staging back to 0 in all 4 tables.

### What v3.5.4 was verified against

| Surface | Action | Endpoint hit | Status | DB mutation | Audit row | UI updated |
|---|---|---|---|---|---|---|
| `brand_soul.faqs` ("What are your business hours?") | delete | `/items/delete` | 200 | faq removed | `manual_delete soul/faqs` | "No questions have crossed…" empty state, Learned facts 3→2 |
| `brand_memory.candidate_faqs` ("Do you offer free shipping?") | delete | `/items/delete` | 200 | candidate removed | `manual_delete memory/candidate_faqs` | row gone from Watching |
| `brand_memory.candidate_faqs` ("Can I cancel my subscription anytime?") | promote | `/items/promote` | 200 | candidate moved → `soul.faqs` with `manually_promoted:true` + `last_seen_at`/`promoted_at`/`session_count` populated | `manual_promote memory/candidate_faqs` | Frequent questions section now shows the promoted FAQ with 2× SESSIONS, Watching empty, Learned facts 2→3 |
| `brand_soul.processes` ("Refund request flow") | delete | `/items/delete` | 200 | process removed | `manual_delete soul/processes` | empty-state message |
| `brand_soul.voice_cues` ("Visitors prefer concise replies…") | delete | `/items/delete` | 200 | voice cue removed | `manual_delete soul/voice_cues` | empty-state message |
| `audience_profile.common_pain_points` | delete | `/items/delete` | 200 | raw string removed (canonicalized on both sides per `curate.js:122`) | `manual_delete audience_profile/common_pain_points` | row gone |
| `audience_profile.common_objections` | delete | `/items/delete` | 200 | raw string removed | `manual_delete audience_profile/common_objections` | row gone |
| `audience_profile.common_request_types` | delete | `/items/delete` | 200 | raw string removed | `manual_delete audience_profile/common_request_types` | row gone, Audience profile section now empty-state |

### Where things stand on prod

| Surface | State |
|---|---|
| https://shenmay.ai | backend + frontend both `:3.5.4` — unchanged (no deploy this session) |
| Staging `:edge` | exercised end-to-end on a fresh tenant; staging DB clean post-cleanup |
| Brand-learning worker | 0 opted-in tenants on prod (staging tenant deleted) |
| v3.5.4 curation buttons | confirmed live React state machine matches static bundle verification + unit tests from May 12 |

### Carry-over

Sub-goal 1 of the active `/goal` (`docs/SESSION_NOTES.md` updated, `.claude/goal/active.md` reflects sub-goal 1 complete). Awaiting user OK before starting:

1. **Sub-goal 2 — distill-prompt anchoring** (~1hr, self-contained). Feed existing `brand_memory` canonical_keys to the Haiku distiller as a "reuse-or-skip" anchor list in the system prompt. Goal: LLM converges on existing phrasings at generation time, complementing the v3.5.3 fuzzy-match post-filter. Plan stub: read `server/src/services/brandLearning/distill.js`, modify system prompt to include anchor list, unit test that anchor list reaches the prompt + degrades on empty brand_memory, ship as v3.5.5 with 5×5 gate + Hetzner deploy.
2. **Sub-goal 3 — Phase 3 HNSW semantic dedup** (the big one). Replace v3.5.3 Szymkiewicz–Simpson with `text-embedding-3-small` + pgvector HNSW. Plan stub: install pgvector via migration 042, new `brand_learning_embeddings` table, wire `promote.js` to embed + ANN-search same-bucket existing entries, fallback to v3.5.3 token-overlap when no embedding key, flip the `LIMITATION` test, ship as v3.5.6 with 5×5 gate + staging canary showing fewer parallel rows.

### Patterns to lift into MEMORY.md

- **DB-seed + master-subscription canary recipe** — bypasses the 14-day trial + onboarding wizard + subscription gate in one transaction. Combines `reference_db_seed_soul_memory` + `reference_db_skip_onboarding` + new finding (every dashboard page is `SubscriptionGate`-wrapped, so canary tenants need a `subscriptions` row with `plan='master'` or `status='active'`). ~30sec setup, ~5sec cleanup via DELETE cascade.
- **localStorage token injection + DOM aria-label click** as a faster Chrome MCP pattern than form-fill login + visible-button click. Skips the login form entirely (extra coords + key presses) and survives opacity/visibility quirks (per `feedback_chrome_mcp_hover_no_css_hover`).
- **`window.confirm = () => true` override** before destructive button clicks in Chrome MCP — native confirms block automation otherwise.

---

## Previous: 2026-05-12 (PM) — **v3.5.4 LIVE** — Brand-learning Phase 2 (owner curation)

Sub-session arc: with v3.5.3 just shipped and Apples' prod canary confirming the dedup actually works, the next gap is owner control. Without curation, a brand owner can watch their AI learn but can't intervene — they can't delete an FAQ that promoted by mistake, and they can't manually promote a pending candidate they already know is correct. Ship Phase 2 same-day: pure helper + 2 portal routes + migration 041 + frontend wiring across 6 dashboard surfaces.

### Headline numbers

| | Result |
|---|---|
| PR merged | **[#186](https://github.com/jafools/shenmay-ai/pull/186)** — owner curation (delete + manually promote) |
| Tag | **v3.5.4** |
| Production deploy | 1 — Hetzner SSH, health-checked clean, zero rollbacks |
| 5×5 release gate | **11/11 green** (run [25731540707](https://github.com/jafools/shenmay-ai/actions/runs/25731540707)) |
| Unit tests | brand-learning **52/52** (40 prior + 12 new curate tests) |
| Files touched | 6 (2 new server: curate.js + migration 041; 1 server route extension; 1 test extension; 2 client: API helpers + dashboard) |
| Wall-clock merge → prod live | ~17 min (merge → 5×5 → tag → GHCR → Hetzner → smoke) |

### What v3.5.4 does

**`server/src/services/brandLearning/curate.js`** — pure helpers `deleteItem` + `promoteItem` operating on a `{ soul, memory, audience }` bundle. Returns new state + the affected item. SOURCES allow-list covers the 4 valid sources (`soul` / `memory` / `audience_profile` / `audience_candidate`) with per-source bucket whitelists. Promoted entries get `manually_promoted: true` for audit visibility. Audience-profile asymmetry (raw strings vs entry objects) handled by canonicalizing both sides — client can pass raw display strings.

**2 new portal endpoints** (owner-gated):
- `POST /api/portal/brand-learning/items/delete`
- `POST /api/portal/brand-learning/items/promote`

Each emits a `manual_delete` / `manual_promote` row in `brand_learning_incidents` with admin_id + target + affected item.

**Migration 041** extends the incidents.type CHECK enum to accept the 2 new audit types. Wrapped in `DO`-block with `_check_v2` name-detection so re-runs are no-ops (mirrors 040's idempotency pattern). Dry-run verified against prod schema pre-tag — old `brand_learning_incidents_type_check` dropped cleanly, new `_check_v2` installed.

**Frontend** — `<CurateActions>` atom (trash icon + optional up-arrow). Wired into all 6 visible surfaces on `/dashboard/brand-learning`:
- Promoted FAQs / processes / voice cues in brand_soul (delete-only)
- Pending FAQ candidates in the "Watching" section (delete + Approve-now)
- All 3 audience_profile lists via updated `AudienceList` component (delete-only)

Destructive deletes prompt via `window.confirm`; promotions are non-destructive so no prompt. 2 new `INCIDENT_LABELS` entries for the audit log section.

### Where things stand on prod

| Surface | State |
|---|---|
| https://shenmay.ai | backend + frontend both `:3.5.4` |
| Hetzner repo | checked out at `v3.5.4` |
| Internal `/api/health` | 200 OK |
| Brand-learning worker | running, 0 opted-in tenants |
| `/dashboard/brand-learning` | now has owner-only trash + Approve-now buttons across 6 list surfaces |
| 5×5 release gate | 11/11 green pre-tag |
| Prod bundle | `index-CTUT5yym.js`, contains all 4 new curation strings |

### Carry-over

1. **Phase 2.5 polish (smaller):** weekly approval-gate emails when `brand_learning_auto_apply=false`, audit-log filter view in the dashboard, edit-the-answer UI (currently only delete + promote, not edit).
2. **Phase 3 — semantic dedup via HNSW:** still bumped in priority. Replaces the token-overlap heuristic from v3.5.3 with embedding similarity → catches synonyms, multi-language, transitive across cycles. Closes the LIMITATION test pin.
3. **Distill-prompt anchoring (complementary 1-hr win):** feed existing brand_memory canonical_keys to the LLM as a "reuse-or-skip" list so it converges on existing phrasings at generation time. Pairs naturally with both the v3.5.3 fuzzy match AND with whatever Phase 3 brings.
4. **Apples canary on the new buttons:** seed candidates, click trash + Approve-now via Chrome MCP / direct UI to prove the round-trip works in a browser session. Static bundle verification + unit tests don't cover the live React state machine — should walk it once.

---

## Previous: 2026-05-12 — **v3.5.3 LIVE** — Brand-learning Phase 1.5 (semantic dedup + Settings toggle + migration patch)

Sub-session arc: yesterday's v3.5.2 canary on Apples confirmed Haiku rephrases the same concept each cycle, so byte-equal `canonical_key` matching produced parallel `candidate_faqs` rows at `session_count=1` instead of one row at `session_count=3`. Nothing promoted past stable-phrasing FAQs (hours, order). Today: ship one stacked PR with the dedup fix + Settings UI gap-close + migration idempotency patch. Merge → 5×5 → tag → Hetzner → prod re-canary in ~25 min wall clock.

### Headline numbers

| | Result |
|---|---|
| PR merged | **[#184](https://github.com/jafools/shenmay-ai/pull/184)** — semantic dedup + Settings toggle + migration idempotency |
| Tag | **v3.5.3** |
| Production deploy | 1 — Hetzner SSH, health-checked clean, zero rollbacks |
| 5×5 release gate | **11/11 green** (run [25726635661](https://github.com/jafools/shenmay-ai/actions/runs/25726635661)) |
| Unit tests | brand-learning **40/40** (29 existing + 11 new) |
| Files touched | 5 (1 server / 1 migration / 1 test / 2 client) |
| Prod canary cycle-3 promotions | **5** (vs 3 on v3.5.2) — `audience_profile` populated for the first time ever |

### What v3.5.3 does

**A) `promote.js` — Phase 1.5 semantic dedup.** Szymkiewicz–Simpson overlap (`|A ∩ B| / min(|A|, |B|)`) on stopword-stripped canonical_key tokens. Threshold `0.6`, gated on `≥2` content tokens each side. Wired into all 4 buckets (faqs / processes / voice_cues / audience cues). Per-bucket `touchedThisCycle` Set prevents intra-cycle double-counting when LLM emits 3 paraphrases in one call. Exact-match fast path preserved byte-for-byte. Limitation: anchored on first-seen `canonical_key`, NOT transitive — pinned by `LIMITATION` test, Phase 3 HNSW will replace.

**B) `BrandLearningSection.jsx` — Settings page card.** Owner-gated, slotted between AgentSoul and Widget on `/dashboard/settings`. Inline on/off toggle + 3-stat grid + last-cycle timestamp + link to `/dashboard/brand-learning`. Closes the Phase 1 carry-over "no UI to flip it on" gap.

**C) Migration 040 idempotency.** `ADD CONSTRAINT brand_learning_min_sessions_range` wrapped in `DO`-block + `pg_constraint` check. PG ≤16 has no `ADD CONSTRAINT IF NOT EXISTS`. Verified against prod's existing constraint pre-tag — `DO` block no-op'd cleanly.

### Prod canary results — apples-to-apples vs yesterday

| Bucket | v3.5.2 yesterday | v3.5.3 today |
|---|---|---|
| `brand_soul.faqs` promoted | 2 | 2 ✓ |
| **`audience_profile.pain_points`** | **0** | **1 ("Pricing transparency...")** |
| **`audience_profile.request_types`** | **0** | **1 ("Business hours inquiry")** |
| `candidate_faqs` parallel rows | 3 | 2 (-33%) |
| `candidate_audience.pain_points` | 6 | 3 (**-50%**) |
| `candidate_audience.request_types` | 8 | 4 (**-50%**) |

Audience-profile populating is the killer result — was always empty before because Haiku rephrased and byte-equal missed.

### Where things stand on prod

| Surface | State |
|---|---|
| https://shenmay.ai | backend + frontend both `:3.5.3` |
| Hetzner repo | checked out at `v3.5.3` |
| Internal `/api/health` | 200 OK |
| Brand-learning worker | running, 0 opted-in tenants (Apples reset post-canary) |
| Settings page (`/dashboard/settings`) | now has Brand-learning section between AgentSoul and Widget |
| 5×5 release gate | 11/11 green pre-tag |

### Carry-over

1. **Phase 2 polish:** edit/delete UI for individual learned facts, weekly approval-gate emails when `brand_learning_auto_apply=false`, audit-log filter view in the dashboard.
2. **Phase 3 (the real semantic dedup):** AgentDB HNSW with embeddings. Catches synonyms (refund/return), handles multi-language, transitive across cycles. Bumped in priority — Phase 1.5 helps but doesn't close it.
3. **Threshold tuning:** `FUZZY_THRESHOLD = 0.6` was empirically picked. May lower to 0.55 if Phase 2 walks still show residual parallel candidates. Don't go below 0.5 (false-positive zone for 2-token sets).
4. **Marketing line:** "Your AI gets smarter the more it talks." Now actually true for FAQs AND audience patterns, not just stable-phrasing FAQs.

---

## Previous: 2026-05-11 — **v3.5.2 LIVE** — react-doctor cleanup (3 PRs, 2 release tags, 2 prod deploys)

Sub-session arc: Austin shared an Aiden Bai tweet about [react-doctor](https://www.react.doctor) v2 ("your agent writes bad React code, this catches it"). Loaded computer-use + Claude-in-Chrome MCPs to read the tweet through Austin's main desktop, ran the tool on `client/`, triaged the 624-issue / 74-score report into real-bug PRs vs noise, shipped two release cycles in one session.

### Headline numbers

| | Result |
|---|---|
| PRs merged | **[#180](https://github.com/jafools/shenmay-ai/pull/180)** correctness · **[#181](https://github.com/jafools/shenmay-ai/pull/181)** a11y · **[#182](https://github.com/jafools/shenmay-ai/pull/182)** round 2 |
| Tags | **v3.5.1** (covers #180+#181) → **v3.5.2** (adds #182) |
| Production deploys | 2 — Hetzner SSH-deploy, both health-checked clean, zero rollbacks |
| 5×5 release gates | 2 dispatches, **11/11 + 11/11 green** (runs 25610077327, 25658456255) |
| react-doctor score | **74 → 79** ("Needs work" → "Great") |
| Total issues | **624 → 548** (-76, -12%) |
| Rules fully cleared | `react/jsx-key`, `react-doctor/effect-needs-cleanup`, `jsx-a11y/label-has-associated-control`, `jsx-a11y/click-events-have-key-events`, `jsx-a11y/no-autofocus`, `react-doctor/js-batch-dom-css` |
| Files touched | 25 across client/ (no server changes; no DB migrations) |
| Lint/build | 0 new lint errors across all 3 PRs; pre-existing 13 warnings unchanged |

### Per-PR breakdown

**#180 (v3.5.1) — fix(client): react-doctor correctness — JSX keys + setTimeout cleanup**
- `ShenmayOnboarding.jsx:171-178` — added stable string keys (`company`, `products`, `customers`, `api-key`, `tools`, `install-widget`) to the `stepComponents` array literal. Latent bug since the array renders one-at-a-time via `stepComponents[activeStep]`, but lint-flagged anyway.
- `ShenmayVerifyEmail.jsx:33-48` — captured the post-verify `setTimeout` id in `redirectTimer`, added `clearTimeout` to the cleanup function alongside the existing `cancelled` guard. Real leak under unmount-during-1500ms-grace.
- **Skipped** the 2× `mutable-in-deps` warnings on `ShenmayDashboardLayout.jsx:323-324` — `location` there is from react-router-dom's `useLocation()` (reactive), not `window.location`. Linter pattern-matches the identifier name. Documented in commit.

**#181 (v3.5.1) — chore(client,a11y): pair labels + add keyboard handlers**
- 52 `<label>` → input `htmlFor`/`id` pairings across 14 files. Per-file prefix convention (`cp-*`, `ws-*`, `ps-add-*`/`ps-edit-*-${pid}`, `wh-add-*`/`wh-edit-*-${h.id}`, `et-*`, `ak-*`, `ctm-*`, `etm-*`, `tm-*`, `prim-*`, `s1-*`, `s2-*`, `cd-*`, `conv-*`).
- 4 `<label>` demoted to `<div>` where the element was labeling a status badge / `<pre>` / event-list flex-row (not a real form control).
- 8 click-only divs got `role`/`tabIndex`/`onKeyDown` — conversation row checkbox, dashboard overview row link, mobile nav backdrop, customer-detail category headers + 2× modal backdrops. For modal "stop propagation" inner shells, added `role="presentation"` + matching `onKeyDown={e => e.stopPropagation()}`.
- A11y category dropped 166 → 98 (-68; extra 8 from knock-on effects of adding role/tabIndex).

**#182 (v3.5.2) — chore(client): react-doctor round 2 — autoFocus + batch .style**
- 5× `autoFocus` removed (ShenmaySetup steps 1/2/3, LabelsSection inline form, CreateToolModal name input). Trades the per-step focus affordance for screen-reader / keyboard-nav predictability. Can be re-added later via useRef + useEffect if anyone complains.
- 16× sequential `e.currentTarget.style.X = ...; .style.Y = ...` collapsed to single `Object.assign(e.currentTarget.style, { X, Y })` calls across 8 sites: `ShenmayUI.jsx` (inputFocusHandlers + Button hover), `SelfHostedView.jsx` (license-key input), `ShenmayCustomers.jsx` (search input + grid-card hover), `ShenmayTeam.jsx` (remove-button hover), `ShenmayLogin.jsx` (input focus/blur), `CreateToolModal.jsx` (tool-type card hover). Reduces hover/focus layout thrashing.
- Performance category 53 → 37, Accessibility 98 → 93.

### Where things stand on prod

| Surface | State |
|---|---|
| https://shenmay.ai | backend + frontend both `:3.5.2` |
| Hetzner repo | checked out at `v3.5.2`, `IMAGE_TAG=3.5.2` running |
| Internal `/api/health` | 200 OK |
| Cloudflare-routed health | 200 OK |
| Staging | `:edge` auto-refresh timer continues — same code as v3.5.2 |

### What didn't get fixed this round

- **41× array-index-as-key** — sampled and triaged but **deliberately skipped**. Most are loading-state skeleton placeholders (`[...Array(n)].map((_, i) => <div key={i} ...>)`) or read-only soul/memory display lists where the underlying array doesn't reorder during user interaction. Proper triage of the real-bug subset is round 3 material.
- **287× Architecture** — em dashes (the LLM fingerprint — funny but cosmetic), inline styles (×130), redundant `w-N h-N` → `size-N` (×70, Tailwind 3.4 codemod opportunity), useReducer suggestions. All style/policy preferences, no functional bugs.
- **88× tiny-text** (font-size: 10px) — real UX debt but a design-policy question, not mechanical.
- **14× hydration mismatch** — known false positive (we're a SPA, no SSR).
- **2× mutable-in-deps** in `ShenmayDashboardLayout` — false positive (react-router `useLocation`).

### Patterns to lift into MEMORY.md (round 3 or next session)

- **MCP-driven third-party tool eval**: load computer-use → switch monitor → read browser tab via screenshot → swap to Claude-in-Chrome MCP for DOM access → fetch tweet content that WebFetch 402'd on. Repeatable pattern for "what's this link Austin sent me" questions.
- **react-doctor v0.1.4** as a periodic quarterly audit (NOT in CI — false-positive rate on SPA+styled components is too high to gate on). Run from `client/`, takes ~9s for 82 files. Score ≥ 80 worth aiming for; beyond that diminishing returns vs effort.
- **Two-tag release marathon in one session** is fine when both tag deltas are surgical/additive and 5×5 stays green. Cost ≈ 25 min per tag (5×5 + docker publish + SSH deploy + verify).

### Release-cycle housekeeping

- `.claude/worktrees/affectionate-jepsen-024ec5/` worktree is now on `chore/react-doctor-round2` (merged-to-main → safe to remove). 3 PR branches still on origin (`fix/react-doctor-correctness`, `chore/react-doctor-a11y`, `chore/react-doctor-round2`) — Austin can `gh pr` cleanup or leave them.
- Sibling worktrees `heuristic-wing-e3e4af` (`docs/v3-5-0-wrap`) and `nifty-northcutt-6ed5b5` (`docs/session-notes-v330`) untouched.

---

## Last updated: 2026-05-09 — **PR #178 OPEN** — Brand Learning Phase 1 (anon-visitor learning loop) + dashboard surface

Sub-session arc: Austin asked to scope and build a "brand AI learns over time from anonymous-visitor conversations" feature. Followed scope → build → self-review → ship pattern. Wrote `docs/BRAND_LEARNING_SCOPE.md` first with 7 explicit decision points; Austin returned with "all stars" + new requirement (dashboard surface so tenants can SEE the AI is learning) + go-AFK instruction. Built autonomously end-to-end through PR.

### Headline numbers

| | Result |
|---|---|
| PR | **[#178](https://github.com/jafools/shenmay-ai/pull/178)** — feat: anon-visitor brand learning loop — Phase 1 + dashboard |
| Branch | `feat/brand-learning-anon` |
| Migration | 040 (`brand_learning` cols on tenants + `brand_learning_incidents` table) |
| Files added | 12 (6 backend services + 1 portal route + 1 dashboard page + 1 migration + 1 scope doc + 1 unit test) |
| Files modified | 8 (App.tsx, dashboard layout, shenmayApi.js, package.json, server/index.js, portal.js, widget.js, piiTokenizer/detectors/index.js) |
| Tests | 25 new unit tests + 100-payload PII fuzz; total 100/100 unit-test green (46 + 29 + 25) |
| Lint | server clean; client 0 errors (13 pre-existing warnings, none from new code) |
| Build | Vite production build green |
| Production state | **v3.4.3 unchanged** — feature not yet merged or tagged |

### What PR #178 ships (Phase 1 — read-only dashboard, default OFF per tenant)

**Backend** (`server/src/services/brandLearning/`)
- `scrub.js` — wraps `piiTokenizer` for pre-distillation regex pass
- `distill.js` — Haiku call with anti-extraction system prompt + output normalizer (oversize trim + shape validation)
- `promote.js` — frequency-threshold promotion (N=3 default; tunable per tenant via `tenants.brand_learning_min_sessions` with `1..50` CHECK constraint)
- `worker.js` — nightly orchestrator (24h `setInterval`, mirrors `jobs/dataRetention.js` lifecycle pattern)
- `render.js` — renders `brand_soul` into the anon-widget system prompt (capped at top 12 FAQs / 8 processes / 6 voice cues; includes "NEVER reference this section explicitly" directive)
- `index.js` — module barrel

**Wiring**
- `widget.js` system prompt — injects `brand_soul` only when `tenant.brand_learning_enabled === true && isAnonVisitorEmail(customer.email)`
- `portal.js` — mounts `/api/portal/brand-learning` sub-router
- `server/src/index.js` — starts worker on listen alongside `dataRetention`
- `routes/portal/brand-learning-routes.js` — GET (read state), POST `/toggle`, POST `/run-now` (5-min cooldown), POST `/kill-switch`. Toggle / run-now / kill-switch are owner-gated.

**Frontend**
- `client/src/pages/shenmay/dashboard/ShenmayBrandLearning.jsx` — celebratory progress UX with stat tiles, candidate progress bars (count/threshold), audience profile, audit log, owner-only run-now + kill-switch
- New "Brand learning" sidebar nav with Brain icon + PAGE_TITLES entry
- 4 new API client methods in `shenmayApi.js`

**Migration 040**
- `tenants` gets 7 new cols: `brand_learning_enabled` (default FALSE), `brand_learning_min_sessions` (default 3 + 1..50 CHECK), `brand_learning_auto_apply` (default TRUE), `brand_soul`/`brand_memory`/`audience_profile` (JSONB nullable), `brand_learning_processed_at`/`brand_learning_last_run_at`/`brand_learning_sessions_processed`
- `brand_learning_incidents` table with type CHECK enum: `pii_breach | distill_skip_no_key | distill_failed | promotion_blocked | kill_switch_used | auto_disabled`

**PII detector** — extended `POSTCODE` regex to recognize Canadian postal codes (A1A 1A1 / A1A1A1). Strictly additive, all 46 existing tokenizer tests still green. Surfaced by the new fuzz test.

### Six layers of PII defense (per scope doc §5)

1. **Pre-distillation regex scrub** via existing piiTokenizer (email, phone, SSN, CC, IBAN, postcode incl. Canadian, account #, DOB)
2. **LLM-prompt anti-extraction** — distillation system prompt forbids any sentence containing identifying detail; treats embedded prompt-injection as visitor's input, doesn't follow it
3. **Outbound audit** — `quickScanForResidualPii` on the final brand_soul JSON before any DB write; aborts and logs `pii_breach` on residue
4. **Frequency promotion** — N=3 distinct sessions default before a fact promotes from `brand_memory` → `brand_soul`
5. **Tenant review UI** — Phase 1 ships read-only; Phase 2 adds edit/delete
6. **Owner-only kill-switch** — wipes all 3 artifacts, resets watermark, disables learning, logs incident

### Default decisions locked (per scope §13, all ★)

| # | Decision | Default |
|---|---|---|
| 1 | Cadence | Nightly batch worker |
| 2 | Auto-apply | TRUE |
| 3 | Artifacts | Three columns (brand_soul / brand_memory / audience_profile) |
| 4 | Threshold | N=3 distinct sessions |
| 5 | Anon→identified | Pull anon turns up to identification moment |
| 6 | BYOK | Use tenant's key; log `distill_skip_no_key` if none |
| 7 | New tenants | OFF — opt-in |

### Verification done

- `npm run lint:server` — clean
- `npm run lint:client` — 0 errors (13 pre-existing warnings, none from new files)
- `npm run build` — green (Vite production)
- `node tests/tokenizer.test.js` — **46/46**
- `node tests/openai-adapter.test.js` — **29/29**
- `node tests/brand-learning.test.js` — **25/25** (incl. 100-payload PII fuzz)
- Self-review against bug-class memories (||-fallback drift, stale-key, server-error-leak, Object.entries+find, HTML5 pre-empt, etc.) — clean

### Carry-over for next session

**Before v3.5.0 tag:**
- Manual canary: enable `brand_learning_enabled=true` on a test tenant via DB or `/toggle` API, walk ≥3 anon sessions through widget, confirm dashboard surfaces candidates and watermark advances
- Dispatch `e2e-repeatability.yml` 5×5 against `main` after merge — required release gate per CLAUDE.md
- After 1+ week clean canary on test tenant, tag `v3.5.0` and deploy to Hetzner per `docs/RELEASING.md`

**Phase 2 (separate PR after Phase 1 GA):**
- Edit/delete UI for individual learned facts in the dashboard
- Weekly approval-gate emails when `brand_learning_auto_apply=false`
- Settings page toggle (currently controlled via owner-gated POST /toggle endpoint only)
- Audit log filter UI (currently shows last 25 incidents read-only)

**Phase 3 (later):**
- Conversion-weighted quality signals
- Cross-conversation pattern detection ("12 visitors this week asked about X" → suggest tenant adds X to company profile)
- Vector retrieval via existing AgentDB HNSW for semantic Q&A lookup at chat time
- Multi-language partition of brand_soul (currently English-assumed)

**Marketing copy when Phase 2 ships:**
- "Your AI gets smarter the more it talks." Marketing pitch lands when Settings toggle is exposed.

> New feedback worth keeping: **lazy-load LLM-SDK requires inside functions, not at module top, when the module also exports pure helpers.** Caught when `tests/brand-learning.test.js` couldn't load `normalizeObservations` from `distill.js` because the top-level `require('../llmService')` transitively pulled in the Anthropic SDK (not installed in the worktree). Fix: move the require inside `distillBrandObservations`. Pattern: any service module that's a mix of pure helpers + LLM caller should lazy-load the LLM dep so tests can use the helpers without the SDK installed.

---

## Previous: 2026-04-29 (afternoon, very late) — **v3.4.2 LIVE** — UX bundle: Settings inputs visible + trial limits actually-usable

Sub-session arc: After v3.4.1 shipped, Austin smoke-tested production and flagged two UX issues with screenshots: (1) the trial usage widget showed "CUSTOMERS 3 / 1 · LIMIT REACHED · UPGRADE" — the limit of 1 customer is comically low and prevents real evaluation; (2) Settings page form fields are nearly invisible until focused — user can't tell where to click. Both diagnosed as 1-2 line fixes, bundled into [PR #175](https://github.com/jafools/shenmay-ai/pull/175), shipped as v3.4.2.

### Headline numbers (v3.4.1 → v3.4.2 sub-session)

| | Result |
|---|---|
| Production tag | **v3.4.2** (was v3.4.1) |
| PRs merged | 1 ([#175](https://github.com/jafools/shenmay-ai/pull/175), 4 files) |
| 5×5 release gate | **11/11 green** ([Run 25109017769](https://github.com/jafools/shenmay-ai/actions/runs/25109017769)) |
| Migration | 1 (039) — backfill existing trials matching 1/20 → 3/50 (UPDATE 0 in prod since no trials matched the old defaults) |
| Wall-clock from v3.4.1 → v3.4.2 | ~50 min |

### What v3.4.2 ships

| File | Change |
|---|---|
| [`client/src/pages/shenmay/dashboard/settings/_shared.js`](client/src/pages/shenmay/dashboard/settings/_shared.js) | `inputStyle` was using `paperDeep` for both bg + border — same colour as the surrounding card → invisible. Aligned to canonical `ShenmayUI <Input/>` style: `background: #FFFFFF` + `border: 1px solid #D8D0BD` (paperEdge). One-line change, propagates across all 8 Settings sub-sections (CompanyProfile, ApiKeySection, AgentSoulSection, ProductsSection, etc.). |
| [`server/src/config/plans.js`](server/src/config/plans.js) | `PLAN_LIMITS.trial` bumped from `{ max_customers: 1, max_messages_month: 20 }` to `{ 3, 50 }`. Old trial was unusably small (1/50× of starter at 50/1000). New 3/50 lets users genuinely evaluate the product. |
| [`server/db/migrations/039_bump_trial_limits.sql`](server/db/migrations/039_bump_trial_limits.sql) | Idempotent backfill: `UPDATE subscriptions SET max_customers = 3, max_messages_month = 50 WHERE plan = 'trial' AND max_customers = 1 AND max_messages_month = 20`. Only matches the exact old-default shape; tenants with custom-set limits left alone. |
| [`tests/integration.test.js`](tests/integration.test.js) | Updated PLAN_LIMITS unit test assertions + under/at-limit message-cap fixtures to match the new 3/50 trial. |

Initial proposal was 5/100; Austin amended to 3/50 before merge.

### Production state after migration

`UPDATE 0` on Hetzner — no trial subscriptions matched the exact `1 AND 20` filter. All current prod trials are at 3/50 (they were either custom-set previously or got the new defaults via tenant creation post-deploy). Behaviour going forward: every new trial gets 3/50 from `PLAN_LIMITS.trial`.

### Pre-v3.4.2 ledger note

The session ran 4 production deploys back-to-back: v3.3.27 → v3.4.0 → v3.4.1 → v3.4.2. ~3 hours wall-clock total. Zero rollbacks. Three 5×5 release gates each 11/11. Two live wire walks (one OpenAI, one Anthropic) verifying multi-LLM v1 end-to-end.

### Carry-over for next session (still queued)

**Ops / Austin-only:**
- Decide master/admin tenant `managed_ai_enabled=true` flag
- UptimeRobot monitor #3 type flip

**Cosmetic:**
- `nomii-*` GHCR repos cleanup — gh CLI token lacks `read:packages` scope, do via UI

**Future phases:**
- ponten-solutions marketing-site copy update — "Choose between Claude (recommended) or OpenAI" positioning. Lovable manual-publish required.
- Phase 2 base-URL providers (Together / Groq / Azure OpenAI / Ollama / vLLM / OpenRouter)
- Soul/memory prompt re-tuning if early OpenAI customers report quality drift
- Audit other settings sub-sections for any other invisible-styling drift; ShenmayUI canonical `<Input/>` should be the only sanctioned input style across the app

> No new feedback memories captured this sub-session — both fixes were textbook design-system drift (settings hand-rolled instead of using ShenmayUI canonical) and product-economics misconfiguration. Single feedback worth surfacing for the next session: **CSS where `bg === border` is invisible** — captured via the canonical fix, no separate memory needed.

---

## Previous: 2026-04-29 (afternoon, late) — **v3.4.1 LIVE** — quick-follow release with carry-over hygiene fixes

Sub-session arc: Austin gave permission to keep working after v3.4.0 shipped. Picked up two carry-over items that had been sitting in the queue, plus opportunistic Hetzner cleanup. Both fixes shipped, dispatched the 5×5 gate, cut v3.4.1 ~2 hours after v3.4.0.

### Headline numbers (v3.4.0 → v3.4.1 sub-session)

| | Result |
|---|---|
| Production tag | **v3.4.1** (was v3.4.0) |
| PRs merged | 2 — [#172](https://github.com/jafools/shenmay-ai/pull/172) (auto-regen fix) + [#173](https://github.com/jafools/shenmay-ai/pull/173) (npm audit clearing) |
| 5×5 release gate | **11/11 green** ([Run 25107502044](https://github.com/jafools/shenmay-ai/actions/runs/25107502044)) |
| Vulns closed | 2 high-severity (nodemailer DoS + path-to-regexp ReDoS) — `npm audit` now reports **0** |
| Hetzner disk reclaimed | ~4 GB (docker image prune kept :3.3.26/:3.3.27/:3.4.0 for rollback, dropped older) |
| Wall-clock from v3.4.0 → v3.4.1 | ~2 hours |

### What v3.4.1 ships

| PR | What |
|---|---|
| [#172](https://github.com/jafools/shenmay-ai/pull/172) | fix(portal): repair soul auto-regen on company profile update — `company-routes.js` was calling `require('../../services/apiKeyService')` for a `decrypt(x)` that doesn't exist (file removed in the v2→v3 rename), reading legacy `api_key_encrypted` column instead of `llm_api_key_encrypted`, and using single-arg decrypt instead of the canonical two-arg `decrypt(encrypted, iv)`. Bare `catch {}` swallowed the `Cannot find module` error so apiKey always stayed null. Net effect: every tenant who updated their company profile got a silent no-op on soul regeneration. Fix replaces the broken block with `resolveApiKey(tenant)` — the canonical post-v3.3.27 resolver, same one widget chat uses. |
| [#173](https://github.com/jafools/shenmay-ai/pull/173) | chore(deps): clear npm audit — nodemailer ^6.9.14 → ^8.0.7 (semver-major) closes 5 advisories incl. high-severity addressparser DoS + SMTP command injection via CRLF in EHLO/HELO. path-to-regexp transitive bumped via `npm audit fix`. Email service uses only canonical `createTransport({ host, port, secure, auth, pool, maxConnections, maxMessages })` + `sendMail({ from, to, subject, html, text, replyTo })` APIs that have been stable since nodemailer v3+; e2e-saas + onprem-e2e jobs (which exercise email-sending paths) green on PR CI. |

### Hetzner ops cleanup (this sub-session)

- Deleted `~/backups/pre-phase7-rename-2026-04-23-082027.sql` (641KB, stale post-Phase-7 rebrand backup, post-May-1 was the safe-to-clean date)
- `docker system prune -a -f --filter 'until=24h'` reclaimed 1.418 GB of dead images (kept :3.3.26/:3.3.27/:3.4.0 for rollback) + cleared 1.174 GB build cache
- After-state: 7 images total, 1.01 GB on disk, only 252MB reclaimable (last 24h images), build cache 0
- Verified no orphan `nomii-ai_pgdata` volume (the Phase 7 rename via pg_dump/restore left zero `nomii-*` artifacts)

### Carry-over for next session (still queued, not addressed this run)

**Ops / Austin-only:**
- Decide master/admin tenant `managed_ai_enabled=true` flag
- UptimeRobot monitor #3 type flip
- Anthropic key rotation already done mid-session (new $3 key in use)

**Cosmetic:**
- `nomii-*` GHCR repos cleanup — gh CLI token lacks `read:packages` scope to script it, manual via UI

**Future phases:**
- ponten-solutions marketing-site copy update — "Choose between Claude (recommended) or OpenAI" positioning. Lovable manual-publish required after copy update.
- Phase 2 base-URL providers (Together / Groq / Azure OpenAI / Ollama / vLLM / OpenRouter)
- Soul/memory prompt re-tuning if early OpenAI customers report visibly worse agent quality

> No new feedback memories captured in this sub-session — both fixes were textbook applications of patterns already in memory.

---

## Previous: 2026-04-29 (afternoon) — **v3.4.0 LIVE** — multi-LLM v1 ships, OpenAI provider on prod, wire-test catch validated the release-gate principle

Session arc: Austin came back with the OpenAI key we'd been holding the v3.4.0 tag for. Plan was a 6-step staging walk → 5×5 gate → tag → Hetzner. The walk found the exact bug class the hold was designed to catch: static schema-translation tests (24/24 in [tests/openai-adapter.test.js](tests/openai-adapter.test.js)) pass, but real wire round-trip fails because the dispatch sites pass a **stale Claude model name** to the OpenAI adapter. Fixed it ([PR #170](https://github.com/jafools/shenmay-ai/pull/170)), re-ran the chat round-trip on staging (both providers ✅), passed the 11/11 release gate, tagged v3.4.0, deployed to Hetzner. Multi-LLM v1 is live — every Shenmay tenant can now pick OpenAI as their LLM provider in Settings.

### Headline numbers

| | Start | End |
|---|---:|---:|
| Production tag | v3.3.27 | **v3.4.0** |
| PRs merged this session | — | 1 ([#170](https://github.com/jafools/shenmay-ai/pull/170)) — surgical wire-bug fix |
| Files changed | — | 4 (+64 / −5) |
| New unit tests | — | 5 (29 total in openai-adapter.test.js, was 24) |
| 5×5 release gate | — | **11/11 green** ([Run 25106021661](https://github.com/jafools/shenmay-ai/actions/runs/25106021661)) |
| OpenAI live verification | unverified | **6/6 PASS** end-to-end |
| Anthropic regression check | — | **PASS** end-to-end (live wire) |
| Wall-clock | — | ~75 min |
| OpenAI cost (entire session) | — | < $0.10 |

### Ship log

| Tag / PR | SHA | What |
|---|---|---|
| [#170](https://github.com/jafools/shenmay-ai/pull/170) | `9fea7c4` | fix(llm): use provider-correct default model at chat dispatch sites — adds `getDefaultModel(provider, role)` helper to `services/llm/index.js`, replaces `conv.llm_model` reads at 3 dispatch sites (`widget.js` standard path, `widget.js` tool-loop path, `tools-routes.js` test-tool path) so dispatch trusts the active provider's adapter default instead of the (potentially stale) stored column. 5 regression tests added. |
| **v3.4.0** | `9fea7c4` | shipped to GHCR + deployed to Hetzner (`ghcr.io/jafools/shenmay-backend:3.4.0`, `ghcr.io/jafools/shenmay-frontend:3.4.0`) |

### The bug we caught (validates the wire-test release-gate principle)

The Phase 1b multi-LLM PR ([#168](https://github.com/jafools/shenmay-ai/pull/168), shipped overnight Apr 28→29) cleanly added the OpenAI provider:
- Dispatch layer correctly routes by `tenant.llm_provider`
- 24 schema-translation unit tests cover the OpenAI ↔ Anthropic message + tool-call shape conversion
- 5×5 release gate passed under `LLM_PROVIDER=mock`

But: **`tenants.llm_model` is set once at signup-time** with the Anthropic default (`claude-sonnet-4-20250514`) and is **never updated** when the tenant later switches provider via Settings → AI API key. So a tenant who picks OpenAI ends up in this state:

```
llm_provider          = 'openai'      ← updated on key save
llm_api_key_provider  = 'openai'      ← updated on key save
llm_model             = 'claude-sonnet-4-20250514'  ← STALE, never touched
```

Widget chat passes `conv.llm_model` to the openaiAdapter, which forwards `claude-sonnet-4-20250514` to OpenAI's API → 404 → customer sees "Sorry, I had trouble responding." Static tests cover the algorithm; only the live wire call exercises `tenants.llm_model` × provider drift.

This is exactly what `feedback_static_tests_dont_catch_wire_quirks.md` predicted last night. **The memory paid for itself.**

### Why the fix is read-side, not write-side

Three options on the table:
1. **Write-side**: update `llm_model` in `api-key-routes.js` when provider changes. Surgical (~5 lines), but doesn't help any tenant already in a drifted state, and any future drift (direct DB update, missing migration step) recreates the bug.
2. **Adapter-side**: make openaiAdapter detect Claude-shaped model names and override. Generic, but adds branching to a hot path and weirdens the adapter's contract.
3. **Read-side at dispatch**: resolve a provider-correct model at chat-call time, ignoring the stored column. ← chosen.

Option 3 matches the resolution pattern already used by `soulGenerator.js` (which is why soul gen worked while chat didn't during the staging walk — soul gen ignored the stored column, widget chat trusted it). `tenants.llm_model` is now effectively a vestigial column — Shenmay doesn't currently let tenants pick a custom model anyway.

The general bug class: **fallback expressions of the form `stored_value || default` only fire when stored_value is null/empty. They don't catch drift, where stored_value is set but stale/wrong.** `tools-routes.js:361` had this exact pattern (`tenant.llm_model || (tenant.llm_provider === 'openai' ? gpt-4o : claude-default)`) — fixed in the same PR. New feedback memory captures this generically.

### What got walked on staging (8/8 PASS, including the failure → re-test cycle)

Test tenant `992e20b9-…` on `nomii-staging.pontensolutions.com`:

1. ✅ Tenant signup via Mailinator + DB-skip onboarding
2. ✅ Settings → AI API key — provider dropdown, warning banner with 3 risk bullets, OpenAI placeholder + console.openai.com link
3. ✅ **Validate & save key** — first live OpenAI wire call. Header flips to "OpenAI · GPT-4o", status "GPT-4o key …BQ4A active and validated"
4. ✅ **Test connection** button — second wire call, "Connection OK" toast + inline ✓
5. ✅ **Soul regen** via Generate Soul — third wire call, structured output round-trip (Identity + Communication Principles, all fields populated). Minor "personalised personalised" duplicate word — generic LLM hiccup, not OpenAI-specific
6. 🚨 **Chat round-trip** — initial run **FAILED** with "Sorry, I had trouble responding." Pulled backend logs, found `404 The model claude-sonnet-4-20250514 does not exist`. Traced to widget.js dispatch passing `conv.llm_model` raw.
7. (off-screen) Branched, fixed, tested, opened PR #170, CI 5/5 pass, squash-merged, pulled `:edge` on staging
8. ✅ **Chat round-trip retry** — succeeded. OpenAI gpt-4o returned a coherent (if generic) response about "v340 Live Walk Co"
9. ✅ **Anthropic toggle + chat round-trip** (post-fix regression check) — Austin pasted his replaced Anthropic key, "Anthropic · Claude" header rendered, widget chat returned a richer persona-shaped response

### Pre-existing bug FLAGGED (not addressed this session, still queued)

`server/src/routes/portal/company-routes.js:50-59` auto-regenerate path uses the legacy `api_key_encrypted` column name + single-arg `decrypt()` call. Already documented in last session's wrap-up; carry-over for next session.

### Cleanup done this session

- ✅ Test tenant `992e20b9-…` cascade-deleted from staging
- ✅ PR #170 squash-merged + branch deleted
- ✅ Tag v3.4.0 pushed to GHCR (rebuild succeeded)
- ✅ Hetzner deployed: `docker inspect shenmay-backend --format '{{.Config.Image}}'` → `ghcr.io/jafools/shenmay-backend:3.4.0` ✓
- ✅ Health check: `curl https://shenmay.ai/api/health` → 200, body `{"status":"ok"}`
- ✅ Stray git-bash quirk files cleaned (still bites, still captured)

### Carry-over for next session

**Bug fixes (small, independent):**
- `company-routes.js` decrypt + column-name bug (still pre-existing, soul auto-regenerate path)

**Ops / Austin-only:**
- Anthropic key was **rotated** mid-session — old $3-budget key is now retired, new key is the one used for the Anthropic regression test
- Decide master/admin tenant `managed_ai_enabled=true` flag
- UptimeRobot monitor #3 type flip
- Volume rename backup cleanup is now safe (post May 1 — that's *yesterday*)

**Cosmetic:**
- `nomii-*` GHCR repos cleanup (manual, harmless)

**Future phases:**
- ponten-solutions marketing-site copy update — "Choose between Claude (recommended) or OpenAI" positioning
- Phase 2 base-URL providers (Together / Groq / Azure OpenAI / Ollama / vLLM / OpenRouter) — separate scoping pass when self-hosted prospects ask
- npm audit fix for the 2 high-severity transitive vulns flagged on `openai` install
- Soul/memory prompt re-tuning if early OpenAI customers report visibly worse agent quality

> Cross-repo work belongs in the vault under `projects/`, not here. Shenmay-only.

---

## Previous: 2026-04-28 (night) — **v3.3.27 SHIPPED** — Pure BYOK on SaaS + Settings → AI API key UI

Session arc: Austin asked about kicking the platform-key fallback when trial tenants subscribe, and whether we should support any-LLM-provider. After auditing `resolveApiKey` it turned out the leak was wider than thought — Tier 3 (env-var fallback) fired for ANY tenant without a BYOK or `managed_ai_enabled` flag, including paid plans, so paid SaaS customers were transparently spending the platform's `$ANTHROPIC_API_KEY` budget. Austin chose pure BYOK (every plan including trial = BYOK only). Implemented + shipped the close-the-leak path AND realized mid-PR that the friendly "Add your API key in Settings" error message was a lie — there was no Settings → API key section. Added that + an onboarding walkthrough in the same PR so the BYOK story shipped complete. Multi-LLM-provider support deferred to a future phase.

### Headline numbers

| | Start | End |
|---|---:|---:|
| Production tag | v3.3.26 | **v3.3.27** |
| PRs merged | — | 1 (#163) — feat-not-fix, biggest customer-impact change since v3.3.0 |
| Files changed | — | 10 (7 backend + 3 frontend, +405 / −45) |
| New files | — | 1 (`ApiKeySection.jsx`) |
| 5×5 release gate | — | 11/11 success ([Run 25057407904](https://github.com/jafools/shenmay-ai/actions/runs/25057407904)) |
| Rollbacks | — | 0 |
| Bundle hash on prod | `index-Kv81G5Qa.js` | `index-CdTof1SI.js` |
| Post-deploy walk | — | 3/3 modes verified live (StepApiKey walkthrough + Settings Mode 3 + Settings Mode 1) |

### Ship log (Apr 28 night)

| Tag / PR | SHA | What |
|---|---|---|
| [#163 commit 1](https://github.com/jafools/shenmay-ai/pull/163) | `0c1c8f5` | **Backend pure-BYOK.** New `NoApiKeyError` class in [llmService.js](server/src/services/llmService.js). `resolveApiKey` env-var fallback gated on `isSelfHosted()`. `callClaude` + `callClaudeWithTools` no longer fall back to env on null arg — `resolveApiKey` is now the single source of truth. `getAgentResponse` throws `NoApiKeyError` instead of silent mock. [widget.js:1376](server/src/routes/widget.js) catches it → friendly customer message + tagged `[Widget][chat][no-key] tenant=… conv=…` log. [stripe-webhook.js](server/src/routes/stripe-webhook.js) hard-sets `managed_ai_enabled=false` on every checkout. [plans.js](server/src/config/plans.js) `managed_ai: false` for every plan including enterprise/master. [soulGenerator.js](server/src/engine/soulGenerator.js) drops env-var fallback (rule-based fallback covers null-key case). Conversations force-summarize bails cleanly when no key. |
| [#163 commit 2](https://github.com/jafools/shenmay-ai/pull/163) | `ce5a998` | **Frontend BYOK UI.** New [ApiKeySection.jsx](client/src/pages/shenmay/dashboard/settings/ApiKeySection.jsx) — three render modes auto-pick from `getMe()` data: (1) `managed_ai_enabled=true` → "Managed AI is active" notice no edit; (2) validated BYOK → last4 + Anthropic·Claude label + Test/Replace/Delete actions; (3) no key → red warning + paste form + collapsible "How do I get an API key?" walkthrough + walkthrough's free-credits + cost-context tip. Self-hosted gets a footnote about env-var fallback. Mounted second in [ShenmaySettings.jsx](client/src/pages/shenmay/dashboard/ShenmaySettings.jsx) right after Company Profile. [StepApiKey.jsx](client/src/components/shenmay/onboarding/StepApiKey.jsx) replaces "Skip for now" with the same collapsible walkthrough + cross-references Settings → AI API key as the rotate/remove path. |
| 5×5 gate v3.3.27 | `ea9eb67` | [Run 25057407904](https://github.com/jafools/shenmay-ai/actions/runs/25057407904) — 11/11 success (5× saas + 5× onprem + verdict). |
| **v3.3.27** | tag at `ea9eb67` | GHCR rebuilt + Hetzner deployed `:3.3.27`. Bundle `index-CdTof1SI.js`. Mailinator-signup post-deploy walk: onboarding StepApiKey walkthrough renders all 5 steps + "Skip for now" gone; Settings Mode 3 (no key) renders red warning + paste form + walkthrough; Mode 1 (managed_ai_enabled=true via DB toggle) renders "Managed AI is active for this account." |

### What got captured this session

- **The platform-key fallback leak was wider than expected.** The audit thought it was "trial tenants without BYOK"; it was actually "any tenant without BYOK and without managed_ai_enabled." Since `PLAN_LIMITS[plan].managed_ai` was `false` for trial / starter / growth / professional, **paid SaaS customers** fell through Tier 3 to the env-var key the same as freeloading trials. Austin's instinct was right but the exposure was 3× wider. Bug-class lesson: when a fallback chain has a "default to platform credentials" tier, it leaks for anyone the prior tiers didn't catch — by definition the population that needs the most attention.
- **A "friendly error" that points to a non-existent UI is a worse lie than a generic error.** Mid-PR realized the friendly "Add your API key in Settings" message we'd just added was technically false — Settings had no such section. Fixing this in a stacked follow-up would have shipped a half-broken story. Adding the Settings section in the same PR (and the onboarding walkthrough) made the release internally coherent. Lesson: when an error message names a destination, verify that destination exists *in the same PR*, not as a follow-up.
- **The `config_fields`/`getMe()` schema-driven UI pattern keeps paying off.** Like v3.3.26's tool-builder validation drove off the server-supplied `config_fields`, this section's mode selection drives off `tenant.llm_api_key_validated` + `tenant.llm_api_key_last4` + `subscription.managed_ai_enabled` + `deployment_mode` already returned by `/api/portal/me`. Zero new endpoints — pure UI on top of the existing data contract.
- **Post-deploy walk via Mailinator + DB-skip is the canonical recipe now.** Signed up fresh tenant via prod signup → grabbed verification token from DB → DB-skipped onboarding to dashboard → toggled `managed_ai_enabled` to flip Mode 3 ↔ Mode 1 → DELETE FROM tenants cascade-cleaned. ~6 min end-to-end. The seed-test-admin pattern wouldn't have worked here because we needed to test the **first-touch** flow (no validated key yet) which requires a fresh tenant.

### What got verified end-to-end

| Check | Result |
|---|---|
| `npm run build` (client) before push | ✅ 2533 modules, +10kB bundle |
| All 5 PR CI checks | ✅ Green |
| 5×5 release gate (10 cells + verdict) | ✅ 11/11 green |
| GHCR `:3.3.27` image rebuild after tag push | ✅ |
| Hetzner `/api/health` after `compose up -d` | ✅ |
| Hetzner backend image | ✅ `ghcr.io/jafools/shenmay-backend:3.3.27` |
| Public bundle hash | ✅ `index-CdTof1SI.js` (was `index-Kv81G5Qa.js`) |
| Onboarding StepApiKey "How do I get an API key?" expandable | ✅ All 5 steps + cost note + cross-ref to Settings |
| Onboarding "Skip for now" gone | ✅ Replaced with the walkthrough |
| Settings → AI API key Mode 3 (no key) | ✅ Red warning + paste form + walkthrough + disabled "Validate & save key" button |
| Settings → AI API key Mode 1 (managed_ai_enabled=true via DB toggle) | ✅ Green-ringed "Managed AI is active for this account." notice, no edit affordance |
| Cleanup | ✅ Test tenant `shenmay-byok-walk-v3327@mailinator.com` cascade-deleted |

### Cleanup done this session

- ✅ Branch `fix/pure-byok-no-platform-fallback` deleted on remote.
- ✅ Test tenant cascade-deleted.
- ✅ Stray Git Bash quirk files cleaned.

### Still-open queue for next session

**MCP-testable surfaces remaining**
- AI tools — TestModal (sandbox + real-customer test runs) NOT exercised
- AI tools — Edit modal flow (saving config changes, deletion) NOT exercised
- Team — invite flow
- Plans & billing — Stripe upgrade path
- **Settings → AI API key Mode 2 (validated BYOK)** — only Mode 1 + Mode 3 walked live; Mode 2 verified via code-review only, not visually. Low risk (simple state-driven render, all paths build green) but worth a 30-sec re-walk next session with a real key.

**Cosmetic / housekeeping**
- `nomii-*` GHCR repos cleanup (manual, harmless)

**Ops / Austin-only**
- UptimeRobot monitor #3 type flip
- Volume rename backup cleanup (recheck on/after May 1)
- **Rotate the $3-budget Anthropic key** — was already on the queue; now finally safe to rotate since trial freeloaders no longer depend on it
- Decide whether your master/admin tenant in prod needs `managed_ai_enabled=true` flagged in the DB (currently unknown state — never verified). If false, you'll need a BYOK pasted in Settings to use your own dashboard.

**Future phases**
- **Multi-LLM provider support** (deferred from this session). Schema is decoratively ready (`tenants.llm_provider`, `llm_api_key_provider`) but the logic is hardcoded to Anthropic. Next phase would be an `Anthropic + OpenAI + OpenAI-compatible adapter` pass, with a small ProviderAdapter interface to normalize tool-call schemas across SDKs. ~2-3 days when prioritized.

> Cross-repo work (Polygon UK W1, Lateris, ponten-solutions, etc.) belongs in
> the vault under `projects/`, not here. This file is Shenmay-only.

---

## Previous: 2026-04-28 (late evening) — **v3.3.26 SHIPPED** — Tool-builder client-side validation for required config fields

Session arc: After the audit-only Concerns+4-surfaces walk, picked up the AI tools tool-creation flow walk (had been deferred from the Concerns-walk session). Walked the 3-step builder modal across all 5 tool types (`lookup`, `calculate`, `report`, `escalate`, `connect`), surfacing 1 UX gap: Step 3 had no client-side validation for required config fields, so the 3 types with required fields (lookup/calculate/connect) sent empty config to the server, got a 400 with a dev-facing error like `"lookup tools require a data_category in config"`, and that raw string surfaced in the modal's ErrorBanner. Step 2 already had nice friendly validation — Step 3 was the outlier.

### Headline numbers

| | Start | End |
|---|---:|---:|
| Production tag | v3.3.25 | **v3.3.26** |
| PRs merged | — | 1 (#161) + this docs wrap |
| Tool types walked | — | 5/5 (lookup/calculate/report/escalate/connect) |
| Bugs fixed | — | 1 (3 of 5 types affected by the same shape) |
| 5×5 release gate | — | 11/11 success ([Run 25053180753](https://github.com/jafools/shenmay-ai/actions/runs/25053180753)) |
| Rollbacks | — | 0 |
| Bundle hash on prod | `index-Dibo3Sxe.js` | `index-Kv81G5Qa.js` |

### Ship log (Apr 28 late evening)

| Tag / PR | SHA | What |
|---|---|---|
| [#161](https://github.com/jafools/shenmay-ai/pull/161) | `89691fa` | fix(tools): client-side validation for required config fields in builder + edit. Three of five tool types have a `required: true` config field per [tools-routes.js:43-131](server/src/routes/portal/tools-routes.js#L43): `lookup`/`calculate` need `data_category`, `connect` needs `webhook_url`. Step 3 of `CreateToolModal` had no guard before submit — empty config sent to server, 400 returned with `"lookup tools require a data_category in config"` (dev-facing string), surfaced raw in the ErrorBanner. Same modal's Step 2 already had friendly validation. New `findFirstMissingRequiredField(configFields, config)` helper in `_shared.js`; both `CreateToolModal.handleSave` and `EditToolModal.handleSave` call it before submitting and surface `"Please fill in: <field label>"` via `setError`. EditToolModal also got a missing `displayName.trim()` guard. |
| 5×5 gate v3.3.26 | `89691fa` | [Run 25053180753](https://github.com/jafools/shenmay-ai/actions/runs/25053180753) — 11/11 success. |
| **v3.3.26** | tag at `89691fa` | GHCR rebuilt + Hetzner deployed `:3.3.26`. Bundle `index-Kv81G5Qa.js`. Verified live: friendly toast "Please fill in: Which category of data?" shown for `lookup` with empty config; no server call fired (intercepted client-side). |

### What got captured this session

- **Server-error-leak-into-UI is a sibling pattern to silent-fail.** Both come from incomplete client-side validation paths; silent-fail (v3.3.20-22 era) returns nothing visible, server-error-leak surfaces a developer-facing string instead of a friendly one. Same fix shape applies — guard the field client-side before the server has to reject. Worth noting for future audits: any modal/form that includes "Final settings" + dynamic config fields driven by a server-supplied schema (`config_fields`, `field_definitions`, etc.) is a candidate.
- **The `config_fields` schema on the server is the natural contract** — required-status + label + key are all defined server-side, fetched via `GET /api/portal/tools/types`, and the client just renders and submits. The fix uses the same schema (`typeInfo?.config_fields`) to drive validation, so adding new tool types with new required fields automatically gets validated without further client changes. Schema-driven validation FTW.
- **Walking 5 of 5 tool types vs walking 1 found the same hit ratio.** Hitting all 5 took ~3× longer than testing one, but it confirmed the bug was the bug class (3 affected) not just one site. Worth doing for type-driven UIs to prevent shipping a fix that only addresses the obvious case.

### What got verified end-to-end

| Check | Result |
|---|---|
| `npm run build` (client) before push | ✅ 2532 modules, 4.30s |
| All 5 PR CI checks | ✅ Green |
| 5×5 release gate (10 cells + verdict) | ✅ 11/11 green |
| GHCR `:3.3.26` image rebuild after tag push | ✅ |
| Hetzner `/api/health` after `compose up -d` | ✅ |
| Hetzner backend image | ✅ `ghcr.io/jafools/shenmay-backend:3.3.26` |
| Public bundle hash | ✅ `index-Kv81G5Qa.js` (was `index-Dibo3Sxe.js`) |
| In-prod fix verification (Chrome MCP) | ✅ Friendly toast "Please fill in: Which category of data?" shown; no server POST fired |

### Cleanup done this session

- ✅ Branch `fix/tool-builder-required-config-validation` deleted on remote.
- ✅ Test tenant `5339cf1b-73e5-4442-b99f-069483124ba2` (DT Tools Walk / shenmay-tools-walk-apr28@mailinator.com) cascade-deleted.
- ✅ Stray Git Bash quirk files cleaned.

### Still-open queue for next session

**MCP-testable surfaces remaining**
- AI tools — only the create-flow now done; **TestModal** (sandbox + real-customer test runs) NOT exercised.
- AI tools — Edit modal validation fix lands here too but Edit flow itself (saving config changes, deletion) NOT exercised.
- Team — invite flow.
- Plans & billing — Stripe upgrade path.

**Cosmetic / housekeeping**
- `nomii-*` GHCR repos cleanup (manual, harmless).

**Ops / Austin-only**
- UptimeRobot monitor #3 type flip
- Volume rename backup cleanup (recheck on/after May 1)
- Rotate the $3-budget Anthropic key

> Cross-repo work (Polygon UK W1, Lateris, ponten-solutions, etc.) belongs in
> the vault under `projects/`, not here. This file is Shenmay-only.

---

## Previous: 2026-04-28 (evening) — **Audit-only walk** — Concerns + Team + Plans & billing + AI tools + Profile (5 surfaces, ALL CLEAN, no PR)

Session arc: After v3.3.25 closed the stale-key-drift bug class via project-wide sweep, picked up the Concerns sidebar deep-walk (queued since v3.3.17 era — UI never walked despite the source-verified `COALESCE(ended_at, NOW())` shape) plus opportunistic clean-walks of Team / Plans & billing / AI tools / Profile while logged into the same fresh tenant. **All five surfaces clean.** No code changes shipped. Production stays on v3.3.25.

### Headline numbers

| | Result |
|---|---:|
| Production tag | unchanged at **v3.3.25** |
| PRs merged | 0 (audit-only) + this docs wrap |
| Surfaces walked | **5 fresh surfaces** — Concerns (full), Team (basic), Plans & billing (basic), AI tools (empty-state), Profile (v3.3.25 verify) |
| Bugs found | 0 |
| Rollbacks | 0 |
| Bundle hash on prod | `index-Dibo3Sxe.js` (unchanged from v3.3.25) |

### What got walked

**1. Concerns sidebar — full walk.**
- `/dashboard/concerns` lists conversations where `status='escalated'` (no `flags` table involvement; concerns are just escalated conversations).
- Top-bar PAGE_TITLES correctly shows "Concerns".
- Sidebar nav badge "4" → "3" → "0 (hides)" correctly tracks open count.
- Notice banner shows "{N} open concerns" + "{M} NEW" pill (unread count).
- Customer-name fallback: empty `first_name + last_name` renders as "Unknown" cleanly.
- Read vs unread distinction: red dot prefix + "Jump in" button (unread) vs no dot + "View" button (read).
- **Resolve flow verified end-to-end via DB inspection**: PATCH `/api/portal/concerns/:id/resolve` returns 200, conversation flips `status='ended'` + `ended_at` populated to brand-new timestamp (matches v3.3.18 bulk-Resolve shape — `COALESCE(ended_at, NOW())`). Resolved row removed from list. Toast "Concern resolved" appears. Sidebar badge decrements.
- Jump-in navigates to `/dashboard/conversations/:id`.
- Refresh button re-fetches the list.
- Empty state: "All clear." display + green CheckCircle icon + "No open concerns" kicker + helpful copy.

**2. Team — basic walk.** Renders cleanly. Top-bar "Team". "1 / 1 agents on the trial plan" + "Invite agent" affordance (didn't test invite flow). Agent table shows owner row with "Owner / Active" status. Trial banner: "Trial includes 1 seat. Upgrade to invite more agents."

**3. Plans & billing — basic walk.** Renders cleanly. Top-bar "Plans & billing". Trial badge + "Plan limit reached" warning + Customers usage 3/1 (DB-seeded past trial limit, expected) + Messages 0/20. "Recommended next: Starter" plan comparison + "Contact sales" CTA.

**4. AI tools — empty-state walk.** Renders cleanly. Top-bar "AI tools". Empty state: "Your AI has no tools yet" + helpful copy + "Add your first tool" button. Did not exercise tool-creation flow (deeper walk for next session).

**5. Profile — v3.3.25 verification.** Renders cleanly. Top-bar "Profile". **"Owner" badge correctly displays** (was the v3.3.25 fix target — `roleBadge.admin` → `member` rename + `|| "owner"` default; owner-role users were never affected, but it's good to confirm the fix didn't regress this path). Personal info + Change password sections render correctly.

### What got captured

- **The Concerns surface is one of the cleanest customer-facing surfaces** I've audited so far — clean enough to be the model for what other surfaces should look like. Single-purpose endpoint, simple list + Resolve interaction, tight empty-state, sidebar-badge integration, source-verified backend with no fancy logic. Likely "boring" by design = correctly nothing to fix.
- **DB-seed pattern works for non-conversation-attribute UI testing too.** Same SQL DO-block seeded conversations with mixed status/unread/empty-name combinations, exercising the "Unknown" customer-name fallback + read-vs-unread + multi-customer rendering paths in one fixture.
- **Audit-only sessions are valid release-cycle outputs** when the surfaces are genuinely clean. Per the v3.3.21 silent-fail-sweep precedent, no PR needed when no bugs surface — just SESSION_NOTES + vault docs catalog the "vaccinated" sites for next-cycle decision-making.

### What got verified end-to-end

| Check | Result |
|---|---|
| Concerns single-Resolve sets `ended_at` (4 concerns × `COALESCE(ended_at, NOW())`) | ✅ DB confirms 4/4 ended with sequential timestamps |
| Top-bar PAGE_TITLES holds for `/dashboard/{concerns,team,plans,tools,profile}` | ✅ All 5 correct |
| Sidebar "Concerns" badge tracks open count + hides when zero | ✅ |
| Empty-name customer falls back to "Unknown" | ✅ |
| v3.3.25 Profile fix in prod | ✅ "Owner" badge renders correctly |
| Test tenant cleanup | ✅ Cascade-delete (`DELETE FROM tenants WHERE id = '7c8d530f-...'`) |

### Cleanup done this session

- ✅ Test tenant `7c8d530f-1e40-4310-b9ff-73036dd9602d` (DT Concerns Walk / shenmay-concerns-walk-apr28@mailinator.com) cascade-deleted (3 customers + 4 conversations + 9 messages).
- ✅ Local-only seed script not committed.

### Still-open queue for next session

**MCP-testable surfaces remaining**
- AI tools — only empty-state walked; tool-creation flow still untouched (more setup-heavy due to LLM-test requirement).
- Team invite flow — only the empty-team state walked.
- Plans & billing — upgrade flow / Stripe checkout NOT exercised.
- Conversations sidebar walk surfaces actually all clean now post-v3.3.23 + v3.3.24 + v3.3.25 fixes.

**Cosmetic / housekeeping**
- `nomii-*` GHCR repos cleanup (manual, harmless).

**Ops / Austin-only**
- UptimeRobot monitor #3 type flip
- Volume rename backup cleanup (recheck on/after May 1)
- Rotate the $3-budget Anthropic key

> Cross-repo work (Polygon UK W1, Lateris, ponten-solutions, etc.) belongs in
> the vault under `projects/`, not here. This file is Shenmay-only.

---

## Previous: 2026-04-28 (late afternoon) — **v3.3.25 SHIPPED** — Stale-key-drift project-wide sweep (bug class CLOSED)

Session arc: After v3.3.24 PR #156 surfaced two stale-key drifts in one PR (the third occurrence following v3.3.16 PAGE_TITLES), promote-on-third-duplicate triggered a project-wide sweep grepping every DB CHECK constraint enum value + every API response field name against `client/src` lookup tables and read sites. 2 more drifts found, 0 false positives, 1 PR ([#158](https://github.com/jafools/shenmay-ai/pull/158)), 1 release tag, 1 5×5 gate (11/11 success), 0 rollbacks. Bug class CLOSED.

### Headline numbers

| | Start | End |
|---|---:|---:|
| Production tag | v3.3.24 | **v3.3.25** |
| PRs merged | — | 1 (#158) + this docs wrap |
| Files audited | — | All 16 CHECK constraint enums + 25 portal `_at` columns + every `(role|status|mode|severity) === "..."` site |
| Confirmed drifts | — | 2 |
| False positives ruled out | — | All `_at`-suffix-stripped reads (`last_message`, `widget_verified` are intentional derived fields) |
| 5×5 release gate | — | 11/11 success ([Run 25050961128](https://github.com/jafools/shenmay-ai/actions/runs/25050961128)) |
| Rollbacks | — | 0 |
| Bundle hash on prod | `index-fF5Jp6Z8.js` | `index-Dibo3Sxe.js` |

### Ship log (Apr 28 late afternoon)

| Tag / PR | SHA | What |
|---|---|---|
| [#158](https://github.com/jafools/shenmay-ai/pull/158) | `edd9c0d` | chore(audit): close stale-key-drift bug class with project-wide sweep. **Two drifts in one PR.** (1) `ShenmayProfile.jsx:67` — `roleBadge` keyed on `admin` (with default `role = admin?.role \|\| "admin"`). DB enum `tenant_admins.role` ∈ `{owner, member, agent}` — `admin` is never a real value. `ShenmayTeam.jsx:7-11` already uses canonical `member: { label: "Admin" }`. Profile was the outlier — `member`-role admins viewing their own profile saw the literal string "member" as the badge text. Renamed lookup key + flipped loading default to `"owner"`. (2) `ShenmayOverview.jsx:233` — `c.status === "closed" ? T.mute : T.teal`. DB enum `conversations.status` ∈ `{active, ended, escalated}` — `closed` is never a real value. Dead branch meant ended convos on the dashboard's Recent Conversations panel rendered teal instead of the intended muted grey. Flipped to `"ended"`. |
| 5×5 gate v3.3.25 | `edd9c0d` | [Run 25050961128](https://github.com/jafools/shenmay-ai/actions/runs/25050961128) — 11/11 success. |
| **v3.3.25** | tag at `edd9c0d` | GHCR rebuilt + Hetzner deployed `:3.3.25`. Bundle `index-Dibo3Sxe.js`. |

### What got captured this session

- **Stale-key-drift bug class is CLOSED.** Audit covered 16 DB CHECK enums + 25 portal `_at` columns + all `(role|status|mode|severity) === "..."` comparison sites. Two drifts found and fixed; rest of codebase confirmed clean. The same recipe (grep DB enums → grep client lookup tables; grep `_at` columns → grep client property reads) catches future drifts of this shape.
- **Audit time vs find rate.** Total wall-clock ~30 min for the sweep — same envelope as the v3.3.21 silent-fail sweep. 2 hits in 16 enums + 25 `_at` columns + ~50 comparison sites is roughly the expected drift rate for a codebase that's been through 3 prior reactive fixes.
- **The "vaccinated" sites are now cataloged.** Every CHECK enum has been verified against client lookups; every `_at` column has been verified against client reads. Future regressions of this shape would be NEW code introducing the bug, not pre-existing untouched sites. Worth a feedback memory entry.

### What got verified end-to-end

| Check | Result |
|---|---|
| `npm run build` (client) before push | ✅ 2532 modules, 4.17s |
| All 5 PR CI checks | ✅ Green |
| 5×5 release gate (10 cells + verdict) | ✅ 11/11 green |
| GHCR `:3.3.25` image rebuild after tag push | ✅ Backend + frontend pulled cleanly |
| Hetzner `/api/health` after `compose up -d` | ✅ `{"status":"ok","service":"shenmay-ai"}` |
| Hetzner backend image | ✅ `ghcr.io/jafools/shenmay-backend:3.3.25` |
| Public bundle hash | ✅ `index-Dibo3Sxe.js` (was `index-fF5Jp6Z8.js` on v3.3.24) |

### Cleanup done this session

- ✅ Branch `chore/stale-key-drift-sweep` deleted on remote after squash-merge.
- ✅ No prod tenant data created — pure code-audit sweep.
- ✅ Stray Git Bash quirk files cleaned.

### Still-open queue for next session

**Bug-class status: stale-key-drift is now CLOSED.** All 16 CHECK enums + 25 `_at` columns + all comparison sites audited. If the pattern resurfaces it'll be a new variant or a regression in newly-added code, not a known unfixed instance.

**MCP-testable surfaces remaining**
- Concerns sidebar deep-walk — never UI-walked; source-verified `COALESCE(ended_at, NOW())` shape on `PATCH /api/portal/concerns/:id/resolve`.
- AI tools / Team / Plans & billing — never deep-walked.

**Cosmetic / housekeeping**
- `nomii-*` GHCR repos cleanup (manual, harmless).

**Ops / Austin-only**
- UptimeRobot monitor #3 type flip
- Volume rename backup cleanup (recheck on/after May 1)
- Rotate the $3-budget Anthropic key

> Cross-repo work (Polygon UK W1, Lateris, ponten-solutions, etc.) belongs in
> the vault under `projects/`, not here. This file is Shenmay-only.

---

## Previous: 2026-04-28 (afternoon) — **v3.3.23 + v3.3.24 SHIPPED** — Conversations + Customer-detail walks

Session arc: After v3.3.22 closed the Settings UI walk, picked up the still-queued **Conversations sidebar / detail walk** (re-validate v3.3.18 `ended_at` + v3.3.19 `sent_by_admin_id` since shipping) and the **Customer detail Soul/Memory walk** (queued since v3.3.17 era — needed real chat round-trip OR DB-seed). Two separate fresh-tenant Mailinator passes against prod, two PRs, two release tags. Bug discovered: the encryption layer's `safeDecryptJson` is transparent (passes plain objects through unchanged), so DB-INSERTed plain JSONB into `customers.soul_file` / `memory_file` renders identically to LLM-generated encrypted blobs — no LLM key required for the Soul/Memory walk.

### Headline numbers

| | Start | End |
|---|---:|---:|
| Production tag | v3.3.22 | **v3.3.24** |
| PRs merged | — | 2 (#155 + #156) + this docs wrap |
| Surfaces walked | — | Conversations sidebar + detail (full) + Customer detail (Soul/Memory full + partial + empty paths) |
| Bugs fixed | — | 3 |
| 5×5 release gates | — | 2 × 11/11 success ([Run 25048526812](https://github.com/jafools/shenmay-ai/actions/runs/25048526812), [Run 25049590967](https://github.com/jafools/shenmay-ai/actions/runs/25049590967)) |
| Rollbacks | — | 0 |
| Bundle hash on prod | `index-CSI75vkp.js` | `index-fF5Jp6Z8.js` |

### Ship log (Apr 28 afternoon)

| Tag / PR | SHA | What |
|---|---|---|
| [#155](https://github.com/jafools/shenmay-ai/pull/155) | `10fe08a` | fix(conv-detail): plug silent-fail Label button on tenants with no labels. `ShenmayConversationDetail.jsx:359` had `disabled={allLabels.length === 0}`, so on a fresh tenant with no Conversation Labels created yet, clicking "Label" on a conversation did literally nothing — no toast, no tooltip, no link to Settings. Same shape as the v3.3.20-22 silent-fail bug class but applied to a view affordance instead of a submit path. Drop the all-labels-empty disable, render the popover even when empty, add a `<Link to="/dashboard/settings">No labels yet — manage in Settings →</Link>` empty-state row. |
| 5×5 gate v3.3.23 | `10fe08a` | [Run 25048526812](https://github.com/jafools/shenmay-ai/actions/runs/25048526812) — 11/11 success. |
| **v3.3.23** | tag at `10fe08a` | GHCR rebuilt + Hetzner deployed `:3.3.23`. Bundle `index-DDonfrPQ.js`. Verified in prod via Chrome MCP — dark popover renders "No labels yet — manage in Settings →" link. |
| [#156](https://github.com/jafools/shenmay-ai/pull/156) | `2435a92` | fix(customer-detail): correct stale onboarding-status key + last-seen field. **Two bugs in one PR, both stale-key-drift class.** (1) `ShenmayCustomerDetail.jsx:11` keyed `statusStyle` on `completed` (with -d) but DB enum is `complete` — every customer past initial state fell back to `statusStyle.new` and rendered as "New" badge. List page at `ShenmayCustomers.jsx:10` already used the canonical `complete`; detail page was the only outlier. (2) `ShenmayCustomerDetail.jsx:127` read `customer.last_interaction` but server returns `last_interaction_at` (matching DB column + Overview page at `ShenmayOverview.jsx:348`) — always rendered "Last seen Never". Both verified via direct API call (`{onboarding_status: "complete", last_interaction_at: <timestamp>}` returned, UI ignored both). |
| 5×5 gate v3.3.24 | `2435a92` | [Run 25049590967](https://github.com/jafools/shenmay-ai/actions/runs/25049590967) — 11/11 success. |
| **v3.3.24** | tag at `2435a92` | GHCR rebuilt + Hetzner deployed `:3.3.24`. Bundle `index-fF5Jp6Z8.js`. Verified in prod via Chrome MCP — green "COMPLETE" badge + "LAST SEEN APRIL 28, 2026" both render correctly. |

### What got captured this session

- **DB-seed plain-JSONB Soul/Memory works because the crypto layer is transparent.** `server/src/services/cryptoService.js` `safeDecryptJson` calls `isEncrypted(val)` first — a plain object (no `__enc`/`__iv` envelope) is returned as-is (passthrough). So Customer detail walks no longer need an LLM key + real chat round-trip — INSERT a plain JSON object into `customers.soul_file` and `customers.memory_file` and the read path renders it identically. This unblocks the entire Soul/Memory walk path that was queued behind "needs real LLM round-trip first" since v3.3.17.
- **Stale-key-drift is the new bug class for v3.3.24-era walks.** v3.3.16 (PAGE_TITLES `find(startsWith)` first-match) was the first instance; v3.3.24 added two more (`statusStyle` keyed `completed` vs DB `complete`, plus `customer.last_interaction` vs API `last_interaction_at`). All three follow the same pattern: a lookup table or property name diverges from its source-of-truth, and the consumer silently falls back to a default branch (the `||` fallback or the lookup miss fallback) instead of erroring. Worth a memory entry on **how to find these** — grep all enum values used in the DB schema's CHECK constraints against client/src + server/src lookups, plus diff-check every API-response property name against client read sites. PR #156 closed two such drifts; the audit pass would close the rest.
- **The Apr-28 walks together prove the v3.3.18 + v3.3.19 fixes are still good.** Bulk Resolve sets `ended_at` end-to-end (DB-seeded 5 conversations, bulk-selected 2 active Alex convos via the hover-checkbox path, clicked Resolve, verified DB rows now show `ended_at` populated to a brand-new timestamp + Cory's pre-existing `ended_at` preserved by `COALESCE`). HUMAN attribution renders correctly across both the inline detail panel + standalone `/dashboard/conversations/:id` page (green HUMAN badge + sender name "Conv Walk" appears on every `sent_by_admin_id`-tagged message; auto-injected handback message correctly shows NO HUMAN tag).
- **Promote-on-third-duplicate triggered for stale-key-drift.** v3.3.16 (PAGE_TITLES) was occurrence 1; v3.3.24 PR #156 was occurrences 2+3 in a single PR. Per the documented rule, the next session should sweep all enum/property lookups in `client/src` against their authoritative sources (DB CHECK constraints, server response shapes). Catalog the "vaccinated" sites (already-correct) so they don't need re-checking.

### What got verified end-to-end

| Check | Result |
|---|---|
| `npm run build` (client) before each PR push | ✅ both 2532 modules, ~4.5s |
| All 5 PR CI checks ×2 (client-build / server-test / e2e-saas / onprem-e2e / selfhosted-smoke) | ✅ 10/10 green |
| 5×5 release gate ×2 (10 cells + verdict each) | ✅ 22/22 green |
| GHCR `:3.3.23` + `:3.3.24` image rebuilds after tag pushes | ✅ Backend + frontend pulled cleanly both times |
| Hetzner `/api/health` after each `compose up -d` | ✅ both `{"status":"ok","service":"shenmay-ai"}` |
| Hetzner backend image after each deploy | ✅ `ghcr.io/jafools/shenmay-backend:3.3.23` then `:3.3.24` |
| Public bundle hashes | ✅ `index-DDonfrPQ.js` (v3.3.23) → `index-fF5Jp6Z8.js` (v3.3.24) |
| v3.3.18 bulk-Resolve `ended_at` regression check | ✅ End-to-end via DB-seeded conversations + UI bulk-Resolve + DB `SELECT` |
| v3.3.19 `sent_by_admin_id` regression check | ✅ Both detail + inline panel render green HUMAN badge + sender name |
| v3.3.16 PAGE_TITLES regression check | ✅ Holds for both `/dashboard/conversations/:id` and `/dashboard/customers/:id` |
| v3.3.17 stale-selection regression check | ✅ Filter swap auto-falls-back to first item when previous selection no longer in list |
| v3.3.23 Label popover empty-state | ✅ Verified live on prod after deploy — dark popover with Settings link |
| v3.3.24 status badge + last-seen | ✅ Verified live on prod after deploy — "COMPLETE" badge + formatted date |
| Test tenant cleanup | ✅ Cascade-delete (`DELETE FROM tenants WHERE id = 'd8c6518b-...'`) |

### Cleanup done this session

- ✅ Branches `fix/conv-detail-label-empty-state` + `fix/customer-detail-status-and-last-seen` deleted on remote after squash-merge.
- ✅ Test tenant `d8c6518b-2408-4afa-9a02-7818d7299fbd` (DT Conv Walk / shenmay-conv-walk-apr28@mailinator.com) cascade-deleted from prod (3 customers + 5 conversations + 21 messages all removed).
- ✅ Stray Git Bash quirk files cleaned before each `git add`.
- ✅ Local-only seed scripts not checked in.

### Still-open queue for next session

**MCP-testable surfaces remaining**
- Concerns sidebar deep-walk — never touched; surfaces `flags` + concerns-routes single-Resolve flow (v3.3.18 `COALESCE(ended_at, NOW())` shape applies here too, source-verified but UI not walked).
- AI tools surface — never deep-walked.
- Team / Plans & billing — never deep-walked.

**Project-wide audit pass (next session)**
- Stale-key-drift sweep: grep DB CHECK enum values + API response property names against `client/src` lookup tables and read sites. v3.3.16 + v3.3.24 PR #156 closed three sites; the audit closes the bug class.

**Cosmetic / housekeeping**
- `nomii-*` GHCR repos cleanup (manual, harmless).

**Ops / Austin-only**
- UptimeRobot monitor #3 type flip
- Volume rename backup cleanup (recheck on/after May 1)
- Rotate the $3-budget Anthropic key

> Cross-repo work (Polygon UK W1, Lateris, ponten-solutions, etc.) belongs in
> the vault under `projects/`, not here. This file is Shenmay-only.

---

## Previous: 2026-04-28 (mid-morning) — **v3.3.22 SHIPPED** — Settings UI deep-test walk

Session arc: After v3.3.21 closed the silent-fail bug class via project-wide audit, ran the still-queued FULL Settings UI walk via Chrome MCP — fresh Mailinator tenant, signup → verify-email → DB-skip onboarding (`UPDATE tenants SET onboarding_steps = '...', widget_verified_at = NOW()`) → walked all 11 sections (Company Profile / Agent Soul / Widget / Email Templates / Webhooks / Data API / Products / Conversation Labels / Connectors / Privacy / Anonymous-only). 3 customer-facing issues surfaced + fixed in one PR.

### Headline numbers

| | Start | End |
|---|---:|---:|
| Production tag | v3.3.21 | **v3.3.22** |
| PRs merged | — | 1 (#153) + this docs wrap |
| Sections walked | — | 11 |
| Bugs fixed | — | 3 |
| Sections clean (no fix needed) | — | 8 |
| 5×5 release gate | — | 11/11 success ([Run 25041902026](https://github.com/jafools/shenmay-ai/actions/runs/25041902026)) |
| Rollbacks | — | 0 |
| Bundle hash on prod | `index-C8-f5yvh.js` | `index-CSI75vkp.js` |

### Ship log (Apr 28 mid-morning)

| Tag / PR | SHA | What |
|---|---|---|
| [#153](https://github.com/jafools/shenmay-ai/pull/153) | `8fbdd34` | fix(settings): plug 3 dead-end UX gaps from Apr-28 Settings deep-test walk. (1) `DataApiSection.jsx` lines 65/75 — inline curl examples in "Example API calls" referenced `api.pontensolutions.com` instead of `shenmay.ai` (rebrand leak in customer-facing API docs visible inside `/dashboard/settings`). Both URLs resolve (legacy alias) but docs should match the host customer is on. Flipped both to `https://shenmay.ai/api/v1/customers`. (2) `ConnectorsSection.jsx` line 17 — `human.takeover` event labeled "Advisor took over" (legacy Knomi financial-advisor wording). Conversations sidebar standardized on "Take over" + green HUMAN badge in v3.3.19; customer-facing notify-on label should match. Flipped to "Human took over". Event value (`human.takeover`) and webhook payload shape unchanged. (3) `LabelsSection.jsx` line 45 — `handleSave` had `if (!formName.trim()) return;` bare return. Submit button has `disabled={!formName.trim()}` guard but the input's `onKeyDown={e => e.key === "Enter" && handleSave()}` bypasses it — Enter on whitespace fired handleSave, hit bare return, no toast. Same canonical fix as v3.3.21. |
| 5×5 gate v3.3.22 | `8fbdd34` | [Run 25041902026](https://github.com/jafools/shenmay-ai/actions/runs/25041902026) — 11/11 success. |
| **v3.3.22** | tag at `8fbdd34` | GHCR rebuilt + Hetzner deployed `:3.3.22`. Bundle `index-CSI75vkp.js`. |

### What got captured this session

- **Source-level audit + light browser verification beats full UI exhaustion for known bug shapes.** Spent ~5 min on signup + DB onboarding skip, ~10 min visually walking all 11 sections to enumerate structure + spot wording issues, ~10 min reading source for the 6 sections that needed deeper analysis, ~5 min applying fixes + grep audit. Total ~30 min triage. Compare to ~60-90 min for a full button-by-button click-through. The Chrome MCP visual walk is good for "do these sections render correctly + do their controls exist" — source review is faster for "do these handlers have correct validation + do these strings match the rebrand."
- **Enter-key path can bypass disabled-button guards.** v3.3.21 swept the `required` + `.trim()` + bare-return pattern across all forms, but missed a sibling pattern: input has `onKeyDown={Enter && submit}` while button is `disabled={!trim()}`. Click is blocked, Enter isn't. The `LabelsSection.jsx` fix is essentially the v3.3.21 sweep continuing — bug class is wider than just `required`-attribute paths. Worth noting in the next sweep.
- **`pontensolutions.com` audit stayed clean** apart from this one Data API site. 19 other matches in `client/src` were intentional (corporate links, marketing site refs, code-provenance comments). Bug class for marketing-site-leak inside the SaaS dashboard is now closed.
- **`Advisor` audit stayed mostly clean** apart from the one Connectors label. 3 mentions in `ShenmayConversationDetail.jsx` are JSX comments only (lines 90 / 312 / 406) — internal terminology, not rendered. Customer-visible string "Rate AI" already correct.
- **DB-skip-onboarding pattern is now the standard for non-LLM-blocked deep-tests.** `UPDATE tenants SET onboarding_steps = '{...}'::jsonb, widget_verified_at = NOW()` lets you reach `/dashboard/*` in ~5 seconds without LLM key + without the 6-step wizard. Same shape as the customer-CSV-API + DB-seed patterns from earlier deep-tests. Worth a memory entry.

### What got verified end-to-end

| Check | Result |
|---|---|
| `npm run build` (client) before push | ✅ 2532 modules, 4.19s |
| All 5 PR CI checks (client-build / server-test / e2e-saas / onprem-e2e / selfhosted-smoke) | ✅ Green |
| 5×5 release gate (10 cells + verdict) | ✅ 11/11 green |
| GHCR `:3.3.22` image rebuild after tag push | ✅ Backend + frontend pulled cleanly |
| Hetzner `/api/health` after `compose up -d` | ✅ `{"status":"ok","service":"shenmay-ai"}` |
| Hetzner backend image | ✅ `ghcr.io/jafools/shenmay-backend:3.3.22` |
| Public bundle hash | ✅ `index-CSI75vkp.js` (was `index-C8-f5yvh.js` on v3.3.21) |
| Test tenant cleanup | ✅ Cascade-delete (`DELETE FROM tenants WHERE id = '9d8f0b8e-...'`) |

### Cleanup done this session

- ✅ Branch `fix/settings-walk-apr28` deleted on remote after squash-merge.
- ✅ Test tenant `9d8f0b8e-15a7-4631-b1ac-d9f39842c4e6` (DT Settings Lab / shenmay-set-walk-apr28@mailinator.com) cascade-deleted from prod.
- ✅ Stray Git Bash quirk files cleaned before each `git add`.

### What got verified clean (8 sections, no fixes needed)

| Section | Notes |
|---|---|
| Company Profile | v3.3.20 fix holds — `required` dropped on Company Name + `.trim()` toast + URL onBlur error display all working |
| Agent Soul | "No soul yet" empty state + Generate button — no input forms to test |
| Widget | Read-only widget key + verification status + embed snippet — all pulling correct shenmay.ai origin |
| Email Templates | Reply-To uses onBlur regex check + `setReplyToError`; not-required field; empty allowed; invalid email caught |
| Webhooks | Empty + invalid URL toasts already present (PR #149/v3.3.20 era); `<input type="url">` lives outside `<form>` so HTML5 doesn't pre-empt React |
| Products & Services | v3.3.20 fix holds — both handleAdd + handleEditSave have toast on whitespace |
| Privacy & PII Protection | Owner-only toggle, no input forms; Apr 19 v1.1.0 baseline still correct |
| Anonymous-only mode | Owner-only toggle, no input forms; v3.3.0 baseline still correct |

### Still-open queue for next session

**Bug-class status: silent-fail across all known surfaces is now CLOSED** through three layers:
- v3.3.12 / v3.3.16 / v3.3.20: reactive fixes for `required` + `.trim()` shape on submit buttons
- v3.3.21: project-wide audit — closed the `required`-attribute path
- v3.3.22: enter-key path bypassing disabled-button guard (Labels)

**More MCP-testable surfaces**
- Customer detail with realistic Soul/Memory data — still queued. Needs a real chat round-trip first to populate Soul/Memory rendering paths.
- Conversations sidebar deep-walk — last visited in v3.3.17; could re-walk now that v3.3.18 (`ended_at`) and v3.3.19 (human attribution) shipped.

**Cosmetic / housekeeping**
- `nomii-*` GHCR repos cleanup (manual, harmless).

**Ops / Austin-only**
- UptimeRobot monitor #3 type flip
- Volume rename backup cleanup (recheck on/after May 1)
- Rotate the $3-budget Anthropic key

> Cross-repo work (Polygon UK W1, Lateris, ponten-solutions, etc.) belongs in
> the vault under `projects/`, not here. This file is Shenmay-only.

---

## Previous: 2026-04-28 (morning) — **v3.3.21 SHIPPED** — Project-wide silent-fail sweep (3rd-occurrence promote)

Session arc: After v3.3.20 closed three more silent-fail sites in `/dashboard/settings`, the `required` + `.trim()` + bare-return pattern was now on its **third occurrence** (v3.3.12 Profile names → v3.3.16 Customer Data Category/Label → v3.3.20 Products + CompanyProfile). Per the documented "promote on the third duplicate" rule, ran a project-wide sweep for any remaining instances of this bug class. Triaged all 22 `client/src` files containing the literal `required` token; found **3 confirmed hits across 2 onboarding-step files** (Step1CompanyProfile + Step2Products). All other matches were false positives (display-only text, prop names, or already-validated handlers with proper toast/error display). Code-level audit only — no UI walk needed since the bug shape is fully documented from prior fixes.

### Headline numbers

| | Start | End |
|---|---:|---:|
| Production tag | v3.3.20 | **v3.3.21** |
| PRs merged | — | 1 (#151) + this docs wrap |
| Files audited | — | 22 (all `client/src` files containing `required`) |
| Confirmed silent-fail hits | — | 3 (Step1CompanyProfile name + Step2Products handleAdd + handleEditSave) |
| False positives ruled out | — | 19 (already-validated, button-disabled guards, display-only) |
| 5×5 release gate | — | 11/11 success ([Run 25040399630](https://github.com/jafools/shenmay-ai/actions/runs/25040399630)) |
| Rollbacks | — | 0 |
| Bundle hash on prod | `index-D4uJCw1T.js` | `index-C8-f5yvh.js` |

### Ship log (Apr 28 morning)

| Tag / PR | SHA | What |
|---|---|---|
| [#151](https://github.com/jafools/shenmay-ai/pull/151) | `3f7e0a6` | fix(onboarding): plug 3 silent-fail submit paths in Step1/Step2 — project-wide audit. Same shape as v3.3.12/v3.3.16/v3.3.20: HTML5 `required` accepts whitespace, React `.trim()` rejects with bare return, no toast. (1) `Step1CompanyProfile.jsx handleSubmit` — `required` on Company Name input but submit only validated URL — whitespace company name HTML5-passed and persisted as `" "` in `tenants.name`, breaking dashboard header + widget greeting. Mirrors v3.3.20 case 3. Drop `required` + add explicit `.trim()` toast. (2) `Step2Products.jsx handleAdd` — bare return on empty/whitespace name + `required` on input. Mirrors v3.3.20 case 1. Drop `required` + toast. (3) `Step2Products.jsx handleEditSave` — bare return on empty/whitespace name. Inline-edit form lives in a `<table>` not a `<form>` so no `required` to drop, but UX still wrong. Add toast. |
| 5×5 gate v3.3.21 | `3f7e0a6` | [Run 25040399630](https://github.com/jafools/shenmay-ai/actions/runs/25040399630) — 11/11 success (10 saas/onprem cells × 5 + repeatability-verdict). |
| **v3.3.21** | tag at `3f7e0a6` | GHCR rebuilt + Hetzner deployed `:3.3.21`. Bundle `index-C8-f5yvh.js`. |

### What got captured this session

- **Promote-on-third-duplicate works for closing a bug class without waiting for the 4th occurrence to surface in deep-test.** When v3.3.20 fixed the same shape for the 3rd time, the heuristic said: stop reacting, sweep proactively. The sweep itself was ~30 min wall-clock end-to-end (read 22 files in parallel batches, apply 3 fixes, build, PR, 5×5, deploy). Compare to ~1h+ of UI-walk + bug-find + fix-on-the-fly per deep-test cycle. Net cost much lower than waiting for hit #4.
- **22-file triage in 4 parallel `Read` calls is faster than 22 sequential reads.** Tools like Read take a few seconds each; batching them in a single message makes the triage I/O-parallel rather than sequential. Total triage wall-clock: ~3 minutes for 22 files.
- **The fix-shape catalog is now strong enough to be applied without a UI walk.** v3.3.20 already proved code-audit can substitute for a fresh-tenant Mailinator deep-test on this specific bug class. v3.3.21 confirms it scales: project-wide sweep, no human verification, 11/11 5×5 gate green, deploy clean. Worth keeping the rule tight: applies only to bug shapes fixed ≥2 times before. New bug classes still need a UI walk.
- **The "false positive" review is the load-bearing step.** 19 grep hits required reading the actual handler to confirm they weren't silent-fails. The patterns that turned out OK (already-fixed, button-disabled-on-empty-trim guards, display-only with no submit) are themselves worth cataloging — they're the "vaccinated" sites that won't need re-checking next time.

### What got verified end-to-end

| Check | Result |
|---|---|
| `npm run build` (client) before push | ✅ 2532 modules, 4.67s, no warnings |
| All 5 PR CI checks (client-build / server-test / e2e-saas / onprem-e2e / selfhosted-smoke) | ✅ Green |
| 5×5 release gate (10 cells + verdict) | ✅ 11/11 green |
| GHCR `:3.3.21` image rebuild after tag push | ✅ Backend + frontend pulled cleanly |
| Hetzner `/api/health` after `compose up -d` | ✅ `{"status":"ok","service":"shenmay-ai"}` |
| Hetzner backend image | ✅ `ghcr.io/jafools/shenmay-backend:3.3.21` |
| Hetzner frontend image | ✅ `ghcr.io/jafools/shenmay-frontend:3.3.21` |
| Public bundle hash | ✅ `index-C8-f5yvh.js` (was `index-D4uJCw1T.js` on v3.3.20) |

### Cleanup done this session

- ✅ Branches `chore/silent-fail-required-trim-sweep` deleted on remote after squash-merge.
- ✅ Stray Git Bash quirk files cleaned before each `git add`.
- ✅ No prod tenant data created — pure code-audit sweep.

### Still-open queue for next session

**Bug-class status: silent-fail `required` + `.trim()` is now CLOSED.** All four known sites + project-wide audit complete. If the pattern resurfaces it'll be a new variant or a regression in newly-added code, not a known unfixed instance.

**More MCP-testable surfaces**
- Customer detail with realistic Soul/Memory data — still queued. Needs a real chat round-trip first to populate Soul/Memory rendering paths (bio fields + family + personality tags + goals/concerns).
- A FULL Settings UI walk — last done at code-level only (Apr 27 night). Fresh-tenant Chrome MCP walk through Webhooks/Labels/Connectors/DataApi/EmailTemplates is still on the table for UI-only issues.

**Cosmetic / housekeeping**
- `nomii-*` GHCR repos still public + pulling clean for pre-rebrand image tags. Manual GHCR delete via dashboard if you want them GC'd. Otherwise harmless.

**Ops / Austin-only**
- UptimeRobot monitor #3 type flip
- Volume rename backup cleanup (recheck on/after May 1)
- Rotate the $3-budget Anthropic key

> Cross-repo work (Polygon UK W1, Lateris, ponten-solutions, etc.) belongs in
> the vault under `projects/`, not here. This file is Shenmay-only.

---

## Previous: 2026-04-27 (night) — **v3.3.18 + v3.3.19 + v3.3.20 SHIPPED** — Triple-tag session: Resolve `ended_at` + human-reply attribution + Settings audit

Session arc: Austin came in tired of deep-test fatigue ("when will there be a fully successful one?") and asked to grind through three workstreams in one session: (1) the small bulk-Resolve `ended_at` backend fix flagged out-of-scope from v3.3.17, (2) the bigger human-reply attribution feature (also flagged out-of-scope from v3.3.17 — schema migration + backend wiring + UI), and (3) a `/dashboard/settings` deep-test. Shipped all three as separate releases with separate 5×5 release gates, no rollbacks, no incidents. WS3 used a code-level pattern audit instead of a UI walk — found 3 instances of the documented v3.3.12/v3.3.16 `required` + `.trim()` silent-fail pattern via grep alone, ~10x faster than a fresh-tenant Chrome MCP walk.

### Headline numbers

| | Start | End |
|---|---:|---:|
| Production tag | v3.3.17 | **v3.3.20** |
| Release tags | — | 3 (v3.3.18, v3.3.19, v3.3.20) |
| PRs merged | — | 3 (#147, #148, #149) + this docs wrap |
| 5×5 release gates | — | 3/3 success (each 11/11) |
| Migrations applied to prod DB | — | 1 (`038_messages_sent_by_admin`) |
| Bugs flagged out-of-scope from v3.3.17 | 2 | 0 |
| Rollbacks | — | 0 |
| Bundle hash on prod | `index-O9ew0zlh.js` | `index-D4uJCw1T.js` |

### Ship log (Apr 27 night)

| Tag / PR | SHA | What |
|---|---|---|
| [#147](https://github.com/jafools/shenmay-ai/pull/147) | `84c6be2` | fix(conversations): set `ended_at = COALESCE(ended_at, NOW())` on bulk Resolve + concern resolve. Both portal endpoints (`POST /api/portal/conversations/bulk` action=resolve and `PATCH /api/portal/concerns/:id/resolve`) were leaving `ended_at IS NULL` while flipping `status='ended'`, breaking analytics queries that filter on `ended_at`. Widget side already correct. |
| 5×5 gate v3.3.18 | `84c6be2` | [Run 25017571288](https://github.com/jafools/shenmay-ai/actions/runs/25017571288) — 11/11 success. |
| **v3.3.18** | tag at `84c6be2` | GHCR rebuilt + Hetzner deployed `:3.3.18`. |
| [#148](https://github.com/jafools/shenmay-ai/pull/148) | `2960010` | feat(conversations): per-message human-reply attribution. New migration `038_messages_sent_by_admin.sql` adds `messages.sent_by_admin_id UUID REFERENCES tenant_admins(id) ON DELETE SET NULL` (mirroring the FK shape from migration 013's `conversations.human_agent_id`). `POST /:id/reply` now persists `req.portal.admin_id`. `GET /:id` and `GET /:id/transcript` LEFT JOIN `tenant_admins` to return `sender_first_name + sender_last_name`. Sidebar ThreadView and detail page render human-sent agent bubbles with a green `HUMAN` tag + sender name + 3px green right border. AI replies + customer messages unchanged. Widget poll selects `role + content` only — customer perspective is unchanged. |
| 5×5 gate v3.3.19 | `2960010` | [Run 25018039550](https://github.com/jafools/shenmay-ai/actions/runs/25018039550) — 11/11 success. |
| **v3.3.19** | tag at `2960010` | GHCR rebuilt + migration 038 applied to prod DB + Hetzner deployed `:3.3.19`. Verified: `SELECT column_name FROM information_schema.columns WHERE table_name='messages' AND column_name='sent_by_admin_id'` returns the new column, type uuid, nullable yes. |
| [#149](https://github.com/jafools/shenmay-ai/pull/149) | `506dd79` | fix(settings): plug 3 silent-fail submit paths from Apr-27 deep-test code audit. Same v3.3.12/v3.3.16 shape (HTML5 `required` accepts whitespace, React `.trim()` rejects with bare return → no toast). Sites: (a) `ProductsSection handleAdd` — whitespace name silent no-op, (b) `ProductsSection handleEditSave` — same shape on edit form, (c) `CompanyProfile save()` — `required` on Company Name input but no `.trim()` check, whitespace persists to `tenants.name` breaking the dashboard header + widget greeting. All 3: drop `required` + add toast on the trim() check. |
| 5×5 gate v3.3.20 | `506dd79` | [Run 25018683461](https://github.com/jafools/shenmay-ai/actions/runs/25018683461) — 11/11 success. |
| **v3.3.20** | tag at `506dd79` | GHCR rebuilt + Hetzner deployed `:3.3.20`. Bundle `index-D4uJCw1T.js`. |

### What got captured this session

- **Code-level pattern audit can substitute for a fresh-tenant UI walk when the bug shape is well-documented.** WS3 didn't need a new Mailinator signup or a 6-step onboarding walk-through — `grep -E 'required|\.trim\(\)' client/src/pages/shenmay/dashboard/settings` plus a 3-minute read of each handler matched the documented v3.3.12/v3.3.16 pattern shape and pinpointed all 3 sites in <10 minutes. After the second time a fix-shape ships, the third occurrence is faster to find by code review than by UI walk. UI walks remain superior for *new* bug classes; pattern-known bugs prefer the audit.
- **The silent-fail pattern is now ON ITS THIRD OCCURRENCE.** v3.3.12 (Profile names), v3.3.16 (Customer Data Category/Label), v3.3.20 (Products + CompanyProfile). Promote-on-third-duplicate threshold reached — worth considering a project-wide audit for any `required` text input not paired with a `.trim()`-aware React-side toast in its submit handler. Could be a one-shot grep+fix sweep across the whole client/src tree.
- **5×5 release gates work fine for 3-back-to-back releases in one session.** Total wall-clock for 3 separate dispatch + green-wait + tag + GHCR rebuild + Hetzner deploy cycles: ~45 min. No process friction. Each cycle is independent and the 5×5 caught nothing problematic. Worth keeping the per-tag separate-gate convention rather than bundling.
- **Migration ordering matters when adding a new column.** v3.3.19 deploy order on Hetzner: `git checkout v3.3.19` → run migration 038 (adds nullable column, safe under old code) → `compose pull + up -d` (new code starts, queries new column). Doing the migration AFTER `compose up` would risk the new code 500ing for ~2-3s during pull until the column exists. Migration before code-flip is the right pattern.

### What got verified end-to-end

| Check | Result |
|---|---|
| v3.3.18: `/api/health` ok, backend on `:3.3.18`, frontend on `:3.3.18` | ✅ |
| v3.3.19: `/api/health` ok, both containers on `:3.3.19`, `messages.sent_by_admin_id` column present | ✅ |
| v3.3.20: `/api/health` ok, both containers on `:3.3.20`, bundle `index-D4uJCw1T.js` | ✅ |
| 3/3 5×5 gates green | ✅ |
| Console errors during deploys | None |
| Hetzner Cloudflare Origin CA still valid | ✅ |

### Cleanup done this session

- ✅ All 3 feature/fix branches deleted on remote after squash-merge.
- ✅ Stray Git Bash quirk files (`{,-`, `{})`, `0)`, `[id`, `{,`) removed before each `git add`.
- ✅ No test tenants created on prod this session — WS3 used pure code review, not a UI walk.

### Still-open queue for next session

**Code-level audit candidates**
- Project-wide grep for `required` text inputs not paired with React-side `.trim()` + toast — there may be more sites across `/dashboard/profile`, `/onboarding/step-N`, `/dashboard/team`, etc. The pattern is well-known now; a one-shot sweep would close the door on this bug class.

**More MCP-testable surfaces**
- Customer detail with realistic Soul/Memory data — still queued. Needs a real chat round-trip first to populate Soul/Memory rendering paths (bio fields + family + personality tags + goals/concerns).
- A FULL Settings UI walk — this session did code-level only. A fresh-tenant Chrome MCP walk through Webhooks/Labels/Connectors/DataApi/EmailTemplates is still on the table and might surface UI-only issues that grep can't see (rendering, hover states, modal interactions, console errors).

**Cosmetic / housekeeping**
- `nomii-*` GHCR repos still public + pulling clean for pre-rebrand image tags. Manual GHCR delete via dashboard if you want them GC'd. Otherwise harmless.

**Ops / Austin-only**
- UptimeRobot monitor #3 type flip
- Volume rename backup cleanup (recheck on/after May 1)
- Rotate the $3-budget Anthropic key

> Cross-repo work (Polygon UK W1, Lateris, ponten-solutions, etc.) belongs in
> the vault under `projects/`, not here. This file is Shenmay-only.

---

## Previous: 2026-04-27 (later late evening) — **v3.3.17 SHIPPED** — Conversations deep-test pass (filter-clears-selection + flipped message alignment)

Session arc: Picked up after v3.3.16 ship — Austin authorized continuing through the deep-test queue. Walked the Conversations sidebar + detail page against prod v3.3.16 via Chrome MCP on a fresh test tenant. Seeded 3 customers + 3 conversations + 12 messages directly via DB (bypassing widget chat which would require an LLM key on this trial tenant). Surfaced 4 findings, 2 fixable in this PR + 2 out-of-scope (backend/schema). **Bonus:** verified the v3.3.16 PAGE_TITLES fix works on `/dashboard/conversations/:id` — top-bar correctly shows "Conversations".

### Headline numbers

| | Start | End |
|---|---:|---:|
| Production tag | v3.3.16 | **v3.3.17** |
| PRs merged | — | 1 (#145) |
| Surfaces walked | — | Conversations sidebar + detail page (search, status pills × 4, mode pills × 3, Unread, bulk-select + Resolve, Take over, Reply box, escalated banner, full-detail navigation) |
| Bugs fixed | — | 2 (filter-clears-selection + detail-page message alignment flipped) |
| Bugs flagged out-of-scope | — | 2 (human-reply attribution + bulk Resolve missing `ended_at`) |
| 5×5 release gate | — | 11/11 success ([Run 25014252235](https://github.com/jafools/shenmay-ai/actions/runs/25014252235)) |
| Rollbacks | — | 0 |
| Bundle hash on prod | `index-DpDo_SDR.js` | `index-O9ew0zlh.js` |

### Ship log (Apr 27 later late evening)

| Tag / PR | SHA | What |
|---|---|---|
| [#145](https://github.com/jafools/shenmay-ai/pull/145) | `c908c2c` | fix(conversations): plug 2 UX gaps from Apr-27 conversations deep test. (1) `fetchList` only auto-set `selectedId` when null — now also re-selects when the current selection is filtered out (clears entirely on empty list). Reproduced cleanly: select Sarah (active), click Escalated pill → list shrinks to escalated convo but right-panel kept showing Sarah's thread with actionable Take over button. Operator could mutate an unseen conversation. (2) Message alignment + bubble corner-radius flipped between sidebar ThreadView (agent right, customer left — operator-as-you convention) and detail page (agent left, customer right). Same data, opposite layouts. Flipped detail page to match sidebar. |
| 5×5 gate v3.3.17 | `c908c2c` | [Run 25014252235](https://github.com/jafools/shenmay-ai/actions/runs/25014252235) — 11/11 success. |
| **v3.3.17** | tag at `c908c2c` | GHCR rebuilt + Hetzner deployed `:3.3.17`. Bundle `index-O9ew0zlh.js` (verified contains `.some(z=>(z._id||z.id` minified signature of the new Finding #1 fix logic). |

### What got verified end-to-end

Pre-fix walk on prod v3.3.16 (DB-seeded 3 conversations: 1 active+named Sarah Mitchell, 1 escalated+anon, 1 ended+anon+csat=2):

| Surface | Result |
|---|---|
| List initial render (3 of 3, statuses, csat thumbs-up, ESCALATED badge, unread dots) | ✅ |
| Search "sarah" → debounced narrow to 1 of 1 | ✅ |
| Status pills (Active / Escalated / Ended / All) | ✅ list filters correctly |
| Mode pills (AI / Human / All modes) | ✅ list filters correctly |
| Unread toggle | ✅ |
| Empty-state copy when filters yield nothing | ✅ |
| **Filter excludes selected → right panel stays stale (Finding #1)** | ❌ → fixed |
| Open-full-arrow → `/dashboard/conversations/:id` (verifies v3.3.16 PAGE_TITLES fix) | ✅ top-bar shows "Conversations" |
| Take over button | ✅ banner + handback note + Reply box appear; DB confirms `mode=human` + `human_agent_id` set |
| Send human reply via Reply box (Enter to send) | ✅ message lands in DB with `role='agent'` |
| **Detail-page message alignment flipped vs sidebar (Finding #2)** | ❌ → fixed |
| Sidebar HUMAN green badge after takeover | ✅ |
| Mode=Human filter shows only Sarah | ✅ |
| Escalated thread red banner | ✅ |
| Bulk select via DOM checkbox click | ✅ "2 selected" toolbar appears |
| Bulk Resolve action | ✅ rows update status; ⚠ but `ended_at` not set (Finding #4 — out of scope) |
| Console errors during walk | None app-side |
| `/api/portal/conversations/*` requests | All 200 |

Post-fix on prod `:3.3.17`: `/api/health` ok, both backend + frontend on `:3.3.17`, public bundle `index-O9ew0zlh.js` contains the new `.some(...selectedId)` longest-match signature.

### What got captured this session

- **Don't trust `Object.entries(MAP).find(startsWith)` patterns** OR similar single-pass dispatch tables. Same root issue as v3.3.16's PAGE_TITLES bug. The Conversations selection logic had a sibling pattern: `if (!selectedId) setSelectedId(...)` only auto-set when null, never re-validated whether `selectedId` was still valid. Generalized lesson: **on any state-derived-from-list pattern, always re-validate the existing state against the new list before using it.**
- **Human-sent reply attribution is a real schema gap.** Take over a conversation, reply as a human — the message goes into DB with `role='agent'` indistinguishable from AI replies. No `human_agent_id` column on `messages` (it's only on `conversations`). Reviewers / QA / auditors looking at the transcript can't tell which agent voice came from a human. **Logged for follow-up — needs a migration adding `messages.sent_by_user_id` plus UI treatment to surface it.**
- **Bulk Resolve doesn't set `ended_at`.** Backend bug — `bulkConversations(ids, "resolve")` updates `status='ended'` but skips the timestamp. Analytics queries filtering on `ended_at IS NOT NULL` (e.g. "convs ended this week") will miss bulk-resolved convos. **Logged for follow-up.**
- **Direct DB-seed pattern works for non-LLM-blocked deep-tests.** Trial tenants without a configured LLM API key can't use widget chat (chat endpoint will 500 on LLM call). DB-seeding `customers + conversations + messages` directly is the fastest way to set up a realistic Conversations deep-test fixture. ~5 min from signup-to-walking once the SQL pattern is captured. **Worth a memory entry alongside the customer-CSV-API pattern from yesterday's v3.3.16.**
- **Some hybrid SQL gotchas:** (a) `customers.onboarding_status` CHECK constraint allows only `pending|in_progress|complete` (NOT "completed" — bit me on first seed). (b) `conversations.session_type` allows `chat|onboarding|review|escalation`. (c) `messages.role` allows `customer|agent|system`. The schema is well-bounded but the discrepancies between "completed" (ConvoDetail page state) and "complete" (DB CHECK) are easy to flip on.

### Cleanup done this session

- ✅ Test tenant `897e3cb9-930d-42d3-80c8-b706d12ba528` (DT Convo Lab / shenmay-dt-convo-apr27@mailinator.com) cascade-deleted from prod via `DELETE FROM tenants WHERE id = ...`.

### Still-open queue for next session

**Out-of-scope findings from this session (deferred to dedicated PRs)**
1. **Human-reply attribution** — needs `messages.sent_by_user_id` migration + UI treatment to mark human-sent replies as distinct from AI in the transcript view.
2. **Bulk Resolve missing `ended_at`** — backend fix in `bulkConversations(..., 'resolve')` to set `ended_at = NOW()` alongside `status='ended'`.

**More MCP-testable surfaces** (queue continues to shrink)
- **`/dashboard/settings` re-walk** — last walked v3.3.8 (when it crashed) → v3.3.9 fixed PRESET_COLORS + 2 unmasked orphans. Lots has shipped since. Settings is heavy (Webhooks, Labels, Connectors, DataApi, EmailTemplates) — high finding-density potential.
- Customer detail with realistic Soul/Memory data — needs a real chat round-trip first to populate Soul/Memory rendering paths (bio fields + family + personality tags + goals/concerns).

**Cosmetic / housekeeping**
- `nomii-*` GHCR repos still public + pulling clean for pre-rebrand image tags. Manual GHCR delete via dashboard if you want them GC'd. Otherwise harmless.

**Ops / Austin-only**
- UptimeRobot monitor #3 type flip
- Volume rename backup cleanup (recheck on/after May 1)
- Rotate the $3-budget Anthropic key

> Cross-repo work (Polygon UK W1, Lateris, ponten-solutions, etc.) belongs in
> the vault under `projects/`, not here. This file is Shenmay-only.

---

## Previous: 2026-04-27 (late evening) — **v3.3.16 SHIPPED** — Customer detail deep-test pass (whitespace silent-fail + plural + Overview header)

Session arc: Austin asked to start the next deep-test surface — Customer detail page with Customer Data records (last untested MCP-testable surface from v3.3.15's queue). Walked the full surface against prod v3.3.15 via Chrome MCP on a fresh `shenmay-dt-customer-apr27@mailinator.com` tenant. Surfaced 3 findings — bundled into [#143](https://github.com/jafools/shenmay-ai/pull/143), CI green, 5×5 gate 11/11, tagged **v3.3.16**, deployed to Hetzner, verified all 3 fixes are live in the public bundle. Test tenant cascade-deleted from prod.

### Headline numbers

| | Start | End |
|---|---:|---:|
| Production tag | v3.3.15 | **v3.3.16** |
| PRs merged | — | 1 (#143) |
| Surfaces walked | — | Customer detail (header + Soul + Memory + Conversations + Customer Data section + Export + Delete) |
| Bugs fixed | — | 3 (1 silent-fail validation + 1 plural string + 1 page-title mapping) |
| 5×5 release gate | — | 11/11 success ([Run 25012531840](https://github.com/jafools/shenmay-ai/actions/runs/25012531840)) |
| Rollbacks | — | 0 |
| Bundle hash on prod | (v3.3.15 server-side change, no bundle delta) | `index-DpDo_SDR.js` |

### Ship log (Apr 27 late evening)

| Tag / PR | SHA | What |
|---|---|---|
| [#143](https://github.com/jafools/shenmay-ai/pull/143) | `d1140ba` | fix(dashboard): plug 3 dead-end UX gaps from Apr-27 customer-detail deep test. (1) Drop HTML5 `required` on Category + Label inputs in CustomerDataSection — replace with React-side toast on the early-return so whitespace-only no longer silently no-ops. Same shape as v3.3.12 Profile name bug. (2) Pluralize "1 record"/"N records" in Clear category modal body — pattern already used by the badge two sections up. (3) Sort `PAGE_TITLES` by key length DESC + require exact-segment match in `ShenmayDashboardLayout` — fixes top-bar header showing "Overview" on every detail page (`/dashboard/customers/:id`, `/dashboard/conversations/:id`, etc.) instead of the parent's title. |
| 5×5 gate v3.3.16 | `d1140ba` | [Run 25012531840](https://github.com/jafools/shenmay-ai/actions/runs/25012531840) — 11/11 success. |
| **v3.3.16** | tag at `d1140ba` | GHCR rebuilt + Hetzner deployed `:3.3.16`. Bundle `index-DpDo_SDR.js`. |

### What got verified end-to-end

**Pre-fix walk on prod v3.3.15 (Customer Margaret Whitfield, bulk-imported via CSV API):**

| Surface | Result |
|---|---|
| Customer detail page initial render (Soul / Memory / Conversations / Customer Data / Export / Delete sections) | ✅ All sections render, zero console errors |
| Add Record happy path (4 fields filled) | ✅ Toast + record renders, count increments |
| Add 2nd record same category | ✅ Grouping count updates (Portfolio: 2 records) |
| Add 3rd record different category | ✅ 2-category render, alphabetical sort (Goals before Portfolio) |
| Empty submit (HTML5 popup blocks) | ✅ Popup fires |
| **Whitespace-only submit (`"   "` in Category + Label)** | **❌ FINDING #1 — silent fail. HTML5 `required` accepts whitespace, React `.trim()` early-return rejects with no toast** |
| Category expand/collapse via header chevron | ✅ |
| Single-record delete → confirm modal → Cancel | ✅ Modal closes, record intact |
| Single-record delete → confirm modal → Delete | ✅ Toast + record gone |
| Click outside modal closes it without action | ✅ |
| **Clear category confirm body when category has 1 record** | **❌ FINDING #2 — modal says "1 records"** |
| Clear category → Delete | ✅ Toast + category gone |
| Page hard-reload preserves all records | ✅ |
| **Top-bar header on `/dashboard/customers/:id`** | **❌ FINDING #3 — shows "Overview" instead of "Customers" (affects ALL detail pages — confirmed `/dashboard/conversations` shows "Conversations" correctly because it's a list page with an exact PAGE_TITLES entry, but `/dashboard/customers/:id` falls through to the prefix-match bug)** |
| Console errors during the entire walk | Only Chrome extension noise (MetaMask SES lockdown), zero app-side errors |
| `/api/portal/customers/*` requests | All 200 |

**Post-fix verification on prod `:3.3.16`:**
- `/api/health` returns `{"status":"ok"}` ✅
- `docker inspect shenmay-{backend,frontend}` both show `:3.3.16` ✅
- Public bundle `index-DpDo_SDR.js` contains string `Category and Label are required` (1 match — the new toast) ✅
- Public bundle contains 6 occurrences of the longest-match sort pattern (post-minification, the `[a],[b]` sort + `startsWith(k+"/")` together) ✅

### What got captured this session

- **HTML5 `required` + React `.trim()` is a silent-fail trap regardless of whether the React handler has a toast or not.** v3.3.12's Profile bug had a dead toast branch (`required` short-circuited it). Customer Data form's bug was subtler — there WAS no toast, just an early-return — so even with `required` removed the original code would have silently no-op'd. **Lesson: on any required-field form with a `.trim()` check, EITHER drop `required` AND add inline-validation, OR keep `required` and accept that whitespace-only is the only escape hatch (which is bad UX).** Memory entry deferred — captures should reference both the v3.3.12 Profile fix AND this v3.3.16 Customer Data fix.
- **`PAGE_TITLES` prefix-match-first-key bug is a 2-year-old latent issue.** Every detail page in the dashboard (customers/:id, conversations/:id, future settings/:section, etc.) has been resolving to "Overview" since the layout was written, because `Object.entries(PAGE_TITLES).find(startsWith)` returns the first match — and `/dashboard` is the first key, matching every dashboard URL. Sort by length DESC + exact-segment match (`=== k || startsWith(k + "/")`) is the canonical fix. Worth a memory entry.
- **Chrome MCP's hover doesn't trigger CSS `:hover` reliably for `opacity-0 group-hover:opacity-100` patterns.** The Customer Data row's X delete button uses this exact pattern and never became visible via `mcp__Claude_in_Chrome__computer` hover action. Workaround: find the button via DOM (`button[title="Delete this record"]`) and `.click()` it directly via JS. Worth a memory entry — this hits us recurring in deep-tests.
- **Chrome password-save popup intercepts the page document during signup.** Same as `feedback_chrome_mcp_more_gotchas.md`. Recovery: open a new MCP tab and continue from there — the prior signup form submit may or may not have fired. Login attempt verifies. **New gotcha sub-pattern: when the popup hijacks the page, screenshots return "chrome-extension URL of different extension" errors and JS execution silently fails.** New tab is the only fix.
- **Chrome MCP `form_input` skips React onChange (already a documented gotcha).** Used the value-setter-descriptor JS trick consistently throughout.
- **`/api/portal/me` is the right portal session endpoint** (not `/api/auth/me`). Returns `{ admin, tenant, subscription, deployment_mode }`. Auth via `Bearer ${localStorage.getItem('shenmay_portal_token')}`. Useful for any future deep-test that needs to grab tenant_id + widget_key in-place.
- **`POST /api/portal/customers/upload` with `{ csv: "first_name,last_name,email,phone\\nName,Last,e@x.com,+1..." }` seeds a customer in ~50ms** — much faster than CSV file picker (which is blocked by MCP `file_upload` returning -32000) AND much faster than widget chat. **Use this pattern any time a deep-test needs a customer fixture.**

### Cleanup done this session

- ✅ Test tenant `1f7f3f32-ced4-4cc6-806f-b3becf8b7781` (DT Customer Lab / shenmay-dt-customer-apr27@mailinator.com) cascade-deleted from prod via `DELETE FROM tenants WHERE id = ...`.

### Still-open queue for next session

**Code follow-ups from this session**
1. **Capture the 2 reusable testing patterns as memory entries** — (a) Chrome MCP hover doesn't trigger `:hover` CSS pseudoclass; find DOM elements + `.click()` directly. (b) `/api/portal/customers/upload` JSON CSV is the fastest customer-fixture seeding path.
2. **Memory entry for the PAGE_TITLES bug** — exact-match → length-DESC sort → require segment match is the canonical fix for any prefix-match dispatch.

**More MCP-testable surfaces** (the queue continues to shrink)
- Conversations sidebar full coverage (sort/filter chips, take-over button, Reply box) — partially walked Apr 27 PM but only with one conversation
- Customer detail page **with realistic Soul/Memory data** — once a real conversation exists, exercise the bio fields + family + personality tags + goals/concerns rendering. Today's walk had `No soul data yet` because Margaret was bulk-imported with no conversations.

**Cosmetic / housekeeping**
- `nomii-*` GHCR repos still public + pulling clean for pre-rebrand image tags. Manual GHCR delete via dashboard if you want them GC'd. Otherwise harmless.

**Ops / Austin-only**
- UptimeRobot monitor #3 type flip
- Volume rename backup cleanup (recheck on/after May 1)
- Rotate the $3-budget Anthropic key

> Cross-repo work (Polygon UK W1, Lateris, ponten-solutions, etc.) belongs in
> the vault under `projects/`, not here. This file is Shenmay-only.

---

## Previous: 2026-04-27 (evening) — **v3.3.15 SHIPPED** — layered widget rate-limits (per-session 30/min + per-tenant 1000/min, defense-in-depth)

Session arc: Austin asked to pick up the deferred follow-up from v3.3.14 — the per-IP rate-limit was a bandaid; the real fix is layered limits keyed by session JWT + tenant. Built it in ~50 lines (extracted shared `makeRateLimiter` helper, added 2 new express-rate-limit instances mounted after `requireWidgetAuth`), shipped v3.3.15, verified both layers with two purpose-built load tests on staging.

### Headline numbers

| | Start | End |
|---|---:|---:|
| Production tag | v3.3.14 | **v3.3.15** |
| PRs merged | — | 1 (#141) + 1 docs (this PR) |
| Release tags pushed | — | 1 (v3.3.15) |
| 5×5 release gate | — | 11/11 success ([Run 24999911257](https://github.com/jafools/shenmay-ai/actions/runs/24999911257)) |
| Verification load tests | — | 2 of 2 PASSED |
| Bundle hash | (unchanged from v3.3.14 — server-side change) | (same) |

### Ship log (Apr 27 evening)

| Tag / PR | SHA | What |
|---|---|---|
| [#141](https://github.com/jafools/shenmay-ai/pull/141) (server) + chore commit (compose) | `4be663c` | feat(widget): layered chat rate-limits — per-session 30/min + per-tenant 1000/min via 2 new express-rate-limit instances mounted AFTER `requireWidgetAuth` so they can decode the session JWT and key on `conversation_id` / `tenant_id` rather than IP. Each returns its own JSON error code (`per_session_rate_limit` / `per_tenant_rate_limit`) for distinct widget UX. Per-IP outer ring (100/min from v3.3.14) stays as third defense layer. |
| | | Refactor: extracted `makeRateLimiter` from `index.js` to `server/src/middleware/rate-limit.js` so widget.js can import the shared install-or-passthrough wrapper. |
| | | env-forwarding: env-forwarding lint caught the 2 new vars; added `WIDGET_CHAT_PER_SESSION_MAX` + `WIDGET_CHAT_PER_TENANT_MAX` to both compose files. **Bonus:** the existing `WIDGET_SESSION_RATE_LIMIT_MAX` + `WIDGET_CHAT_RATE_LIMIT_MAX` compose `:-` fallbacks were still on the pre-v3.3.14 values (6, 10) — bumped to (60, 100) so a customer running with no .env override actually gets the new code defaults at the container level. |
| 5×5 gate v3.3.15 | `4be663c` | [Run 24999911257](https://github.com/jafools/shenmay-ai/actions/runs/24999911257) — 11/11 success. |
| **v3.3.15** | tag at `4be663c` | GHCR rebuilt + Hetzner deployed `:3.3.15` + staging force-pulled. |

### What got verified end-to-end (against staging on `:3.3.15`)

**Test 1: 50 unique sessions, each sends 1 chat (per-session OK at 1<30, per-tenant OK at 50<1000)**
```
Phase 1 sessions: 50/50 OK in 908ms wall, p99=872ms
Phase 2 chats:    50/50 OK in 1138ms wall, p99=1136ms
                  Reply chars: min=100 p50=121 p95=165
```

**Test 2: 1 session spams 35 sequential chats (per-session limit kicks in at 31)**
```
Session opened: conversation_id=1a64c440-13f2-4a2f-9cf6-815e1de5c85a
Sequence:       ..............................XXXXX
OK:             30 / 35
429:            5
First 429 at:   message 31
Error code:     'per_session_rate_limit'  ← the new code, exactly as designed
```

Both layers behave correctly. Per-tenant 1000/min limit not stress-tested (would need 1000+ messages from many sessions in one minute) but wiring is identical to per-session and verified to compile/run.

### What got captured this session

- **Compose `:-` fallback overrides code defaults at the container level.** A customer running with no .env override gets `compose's` fallback value (e.g. `${WIDGET_CHAT_RATE_LIMIT_MAX:-10}` → env=10), and the code's `process.env.X || '100'` reads "10" (truthy) → fallback "100" never fires. Means **bumping a code default without bumping the compose fallback is silently a no-op for any customer not setting the env.** v3.3.14 ALMOST had this bug — caught by env-forwarding lint when this v3.3.15 PR touched the same area.
- **env-forwarding lint script earned its keep again.** When PR #139 added `WIDGET_CHAT_RATE_LIMIT_MAX` to .env.example but didn't touch compose files, the lint passed (var was already in compose). When PR #141 added the 2 new caps to widget.js, lint immediately failed CI — pointed at exactly which compose files were missing the wiring.
- **`req.widgetSession.conversation_id` is the per-session identifier** for keying rate-limits. Each widget session opens its own conversation, so 1:1 with session for the lifetime of the JWT. Don't have to invent a separate `session_id` field.

### Cleanup done this session

- ✅ Staging LoadTest2 tenant cascade-deleted (`f4f8ccfd-de80-46fe-a66c-aa0d7f91c919`).

### Still-open queue for next session

**Code follow-ups**
1. **Set `WIDGET_CHAT_RATE_LIMIT_MAX` + new caps explicitly in prod and staging .env** — code/compose defaults are now sane (100, 30, 1000), but explicit env in prod .env improves ops transparency. Optional.
2. **Per-tenant cap stress test** — never exercised the 1000/min path. Would need a script that opens N sessions then fires 1000+ chats round-robin. Low priority — wiring is identical to per-session, which IS verified.

**More MCP-testable surfaces**
- Customer detail page **with Customer Data records** — Add Record button never exercised.
- Conversations sidebar full coverage (sort/filter chips, take-over button, Reply box).

**Cosmetic / housekeeping**
- `nomii-*` GHCR repos still public + pulling clean for pre-rebrand image tags. Manual GHCR delete via dashboard if you want them GC'd. Otherwise harmless.

**Ops / Austin-only**
- UptimeRobot monitor #3 type flip
- Volume rename backup cleanup (recheck on/after May 1)
- Rotate the $3-budget Anthropic key

> Cross-repo work (Polygon UK W1, Lateris, ponten-solutions, etc.) belongs in
> the vault under `projects/`, not here. This file is Shenmay-only.

---

## Previous: 2026-04-27 (PM later) — **v3.3.13 + v3.3.14 SHIPPED** — UserPill polish + multi-agent copy + widget rate-limit fix from 50-concurrent load test

Session arc: Austin reviewed the v3.3.12 customer-data verify screenshots and flagged 3 things — (a) UserPill in onboarding shows raw email (truncated, looks weird with long real-customer emails), (b) "your agent" singular copy doesn't match the multi-agent "personal agent per customer" positioning, (c) "will the widget hold up to 50 concurrent sessions on the same site?" Walked through findings, agreed on plan C: ship the small polish bundle first (v3.3.13), then run a real load test on staging to answer the concurrency question with data (v3.3.14 if the data warrants a fix — and it did, hard).

### Headline numbers

| | Start | End |
|---|---:|---:|
| Production tag | v3.3.12 | **v3.3.14** (jumped 2) |
| PRs merged | — | 2 (#138 polish, #139 rate-limit + load test) |
| Release tags pushed | — | 2 (v3.3.13, v3.3.14) |
| 5×5 release gates | — | 2 (both 11/11 success) |
| Real prod-impacting bugs found | — | **1 — and it was a hard one** (chat rate-limit 10/min/IP throttled real shared-NAT traffic) |
| Load tests run | — | 4 (3 baseline failures, 1 confirmed-fix) |
| Rollbacks | — | 0 |
| Bundle hash | `index-DAslfMi8.js` | `index-eC-4aVGB.js` (v3.3.13 polish) |

### Ship log (Apr 27 PM later)

| Tag / PR | SHA | What |
|---|---|---|
| [#138](https://github.com/jafools/shenmay-ai/pull/138) | `d0bac02` | fix(ui): UserPill shows name instead of email + plural "agents" copy in 4 aggregate-view places. Email moved to title attribute (hover tooltip). Config-view copy stays singular ("Give your agent abilities" etc.). |
| 5×5 gate v3.3.13 | `d0bac02` | [Run 24997582947](https://github.com/jafools/shenmay-ai/actions/runs/24997582947) — 11/11 success. |
| **v3.3.13** | tag at `d0bac02` | GHCR rebuilt + Hetzner deployed `:3.3.13`. Bundle `index-eC-4aVGB.js`. |
| [#139](https://github.com/jafools/shenmay-ai/pull/139) | `0450967` | fix(widget): bump per-IP rate-limit defaults — chat 10→100, session 6→60. Adds `scripts/widget-load-test.js` reusable concurrent load runner. Updates `.env.example` to document both vars. |
| 5×5 gate v3.3.14 | `0450967` | [Run 24998223128](https://github.com/jafools/shenmay-ai/actions/runs/24998223128) — 11/11 success. |
| **v3.3.14** | tag at `0450967` | GHCR rebuilt + Hetzner deployed `:3.3.14` + staging force-pulled. |

### What got verified end-to-end

**Polish (v3.3.13):** Build green, CI 5/5, 5×5 11/11, deployed to Hetzner. Visual confirmation deferred (cosmetic — would just verify the strings rendered).

**Load-test sequence (v3.3.14 fix verification):**

| Run | Setting | Result |
|---|---|---|
| Baseline (v3.3.13, default chat=10) | 50 concurrent chat from 1 IP | **0/50 OK** — 40× 429 "rate limit", 10× 403 "widget_unavailable" (LoadTest tenant had no subscription row — load-test artifact, not a real bug) |
| Post-fix (v3.3.14, default chat=100), no subscription | 50 concurrent chat | 50/50 sessions OK; **0/50 chats** — all 50 hit 403 widget_unavailable (subscription gate). **Rate-limit fix confirmed: no 429.** |
| Post-fix, with trial subscription seeded | 50 concurrent chat | Hit global limiter (150/min/IP) and session limiter window (still mid-test residue). Investigated. |
| Post-fix, after restart staging backend (clear in-memory rate state) | 50 concurrent chat | **🎉 50/50 sessions + 50/50 chats SUCCEED.** Sessions p99=961ms, chats p99=2145ms wall (LLM round-trip dominates). |

**Final post-fix numbers (50 concurrent, 1 source IP, against staging on `:edge` = v3.3.14):**

```
Phase 1 (POST /api/widget/session):
  Wall time:   962 ms (all 50 done)
  Success:     50/50
  Per-request: min=519 p50=744 p95=931 p99=961 ms

Phase 2 (POST /api/widget/chat with LLM round-trip):
  Wall time:   2148 ms (all 50 done)
  Success:     50/50
  Per-request: min=1826 p50=1856 p95=2136 p99=2145 ms
  Reply chars: min=100 p50=121 p95=165
```

### What got captured this session

- **Per-IP widget rate-limiting was a real prod-impacting issue.** 50 visitors behind any shared-NAT (corporate office, mobile carrier, Cloudflare exit pool) shared the 10/min budget. Bumped to 100/min/IP for chat, 60/5min/IP for session. Documented as a memory: `feedback_per_ip_widget_rate_limit_too_tight.md` (TODO this session).
- **Defense-in-depth follow-up deferred:** per-IP is the wrong axis for cost protection on a multi-tenant chat product. The right axis is per-session JWT (anti-spam) AND per-tenant widget_key (cost). Doing that requires moving `widgetChatLimiter` from `app.use()` (mounted before `requireWidgetAuth`) into the route handler so we can decode the JWT and key on session_id or widget_key. ~30-line refactor in `index.js` + `widget.js`. Not blocking.
- **DB pool max=10 is fine for 50 concurrent.** Sessions with default pool=10 hit 519-961ms p99 — well within budget. The pool bump idea from initial planning is **NOT needed** based on the data. Ship-rule: don't change settings without justification from data.
- **Global rate-limit (150/min/IP) and session rate-limit (100/5min/IP on staging via .env override) are easy to trip during repeat load testing.** A fresh load test on staging needs either (a) `docker compose restart backend` first to clear in-memory rate state, or (b) wait the full 5 min window. Worth a memory.
- **`scripts/widget-load-test.js` is now in the repo** as the reusable concurrent load runner. Use for any future scale-validation work.

### Cleanup done this session

- ✅ Deleted staging LoadTest tenant (`40596173-bdec-411b-b725-1393e9d6e481`) and its synthetic subscription via cascade.

### Still-open queue for next session

**Code follow-ups from this session**
1. **Per-tenant + per-session widget rate limiting** (defense-in-depth) — move `widgetChatLimiter` into the route handler after `requireWidgetAuth`, key by widget_key + session_id. Per-IP becomes a wide outer ring (the current 100/min). ~30-line refactor.
2. **Set `WIDGET_CHAT_RATE_LIMIT_MAX` explicitly in prod and staging .env** — code default is now 100, but prod has session=200 explicit and chat unset. Setting chat=200 explicitly in both .env files would mirror the session pattern and make ops more transparent. (Optional — code default of 100 already handles it.)

**More MCP-testable surfaces** (last batch)
- Customer detail page **with Customer Data records** (Add Record button never exercised — would test the "+ Add Record" inline-add flow)
- Conversations sidebar full coverage (sort/filter chips, take-over button, Reply box) — partially walked Apr 27 PM but only with one conversation

**Cosmetic / housekeeping**
- `nomii-*` GHCR repos still public + pulling clean for pre-rebrand image tags. If you want them GC'd, requires manual GHCR delete via dashboard. Otherwise harmless.

**Ops / Austin-only**
- UptimeRobot monitor #3 type flip (still deferred from prior sessions)
- Volume rename backup cleanup (recheck on/after May 1)
- Rotate the $3-budget Anthropic key (still pending)

> Cross-repo work (Polygon UK W1, Lateris, ponten-solutions, etc.) belongs in
> the vault under `projects/`, not here. This file is Shenmay-only.

---

## Previous: 2026-04-27 (PM) — **v3.3.12 SHIPPED** — second deep-test pass: Customers / Concerns / Notification bell / Profile / Team

Session arc: Austin asked to start the next agenda item — the deferred surfaces deep-test pass (Customers / Concerns / Notification bell / Profile / Team). Spun up a fresh test tenant via Chrome MCP (`shenmay-dt-apr27pm@mailinator.com`), walked all 6 surfaces (the 5 + Plans-via-upgrade-link). All rendered with **zero console errors**. Surfaced 3 findings — bundled into [#135](https://github.com/jafools/shenmay-ai/pull/135), CI green, 5×5 gate 10/10, tagged **v3.3.12**, deployed to Hetzner, verified the new copy is visible. Both Apr 27 test tenants cascade-deleted from prod.

### Headline numbers

| | Start | End |
|---|---:|---:|
| Production tag | v3.3.11 | **v3.3.12** |
| PRs merged | — | 1 (#135) |
| Surfaces walked | — | 6 (Customers, Concerns, Notification, Profile, Team, Plans) |
| Bugs fixed | — | 3 (1 UX gap + 4 stale-nav locations + 1 silent-fail validation) |
| Real prod-impacting bugs | — | 0 (all polish — none crash, broken-back was the worst) |
| 5×5 release gate | — | 11/11 success ([Run 24992841182](https://github.com/jafools/shenmay-ai/actions/runs/24992841182)) |
| Rollbacks | — | 0 |
| Bundle hash | `index-Dfrw0FPh.js` | `index-DAslfMi8.js` |

### Ship log (Apr 27 PM)

| Tag / PR | SHA | What |
|---|---|---|
| [#135](https://github.com/jafools/shenmay-ai/pull/135) | `be9a9a4` | fix(dashboard): plug 3 dead-end UX gaps from Apr-27 PM deep-test. Customers empty-state copy + setup link, drop stale `/shenmay/dashboard/...` from 4 internal navs (URL flicker + broken back-button history), Profile name fields drop HTML5 `required` + add React-side inline validation matching the password-mismatch pattern. |
| 5×5 gate v3.3.12 | `be9a9a4` | [Run 24992841182](https://github.com/jafools/shenmay-ai/actions/runs/24992841182) — 11/11 jobs success. |
| **v3.3.12** | tag at `be9a9a4` | GHCR rebuilt + Hetzner deployed `:3.3.12`. Bundle `index-DAslfMi8.js`. Internal + external `/api/health` green. Customers empty-state new copy verified visible. |

### What got verified end-to-end (prod, tenant `shenmay-dt-apr27pm@mailinator.com`)

- ✅ `/dashboard/customers` — empty state shows new copy "Customers appear automatically as visitors chat with your agent. To bulk-import a list, **open setup**." with teal underlined link
- ✅ `/dashboard/concerns` — clean "All clear." empty state with green check
- ✅ Notification bell dropdown — clean "No notifications yet" panel
- ✅ `/dashboard/profile` — both Personal Info + Change Password sections render, password mismatch shows correct red caption ("PASSWORDS DON'T MATCH")
- ✅ `/dashboard/team` — trial-seat amber bar from PR #128 confirmed live (1/1 seats), disabled "Invite agent" button has correct tooltip ("Agent limit reached (1). Upgrade to add more.")
- ✅ "Upgrade to invite more agents" link → `/dashboard/plans` → renders usage + recommended-next + 3 tier cards
- ✅ Zero console errors on any of the 6 surfaces

### What got captured this session

- **Stale `/shenmay/dashboard/...` internal navigations** — found 4 places where post-rebrand internal nav still uses the legacy `/shenmay/` prefix. They don't 404 (the `ShenmayLegacyRedirect` route at App.tsx:144 strips the prefix), but they cause visible URL flicker and break browser-back (clicking back goes to `/shenmay/...` which immediately redirects forward). Internal nav should be direct. Worth a future grep on any new internal `to=`/`navigate(` for `/shenmay/` to keep this from regressing.
- **HTML5 `required` + React toast = silently dead toast branch** — same trap as PR #131. Profile.jsx had a `toast({ title: "Please fill in both name fields..." })` guard that *never fired* in practice because HTML5 `required` short-circuited the form submit and just focused the first invalid field. The user sees focus jump but no message. Standard fix: drop `required`, add React-side inline error caption matching the existing password-mismatch pattern. **Already in vault as feedback memory `feedback_html5_validation_preempts_react.md` from prior session — this entry confirms the same memory applies to `required` (not just `type=email`/`type=url`).**
- **`tenant_admins` is the table name** (not `admins`) — slow rediscovery. Worth noting if writing future ad-hoc cleanup queries.
- **Cascade-delete on `tenants` works clean** — single `DELETE FROM tenants WHERE id IN (...)` removed both Apr 27 test tenants and their `tenant_admins` rows in one transaction. No need for a `delete_tenant.js` helper script for this case.

### Cleanup done this session

- ✅ Deleted prod test tenant `shenmay-deeptest-apr27@mailinator.com` (id `f0c48905-427a-461c-bad9-587e6d2e2112`, the still-open item from morning session).
- ✅ Deleted prod test tenant `shenmay-dt-apr27pm@mailinator.com` (id `10355af8-172c-4c71-b7b0-988576e9b407`, this session's tenant).

### Still-open queue for next session

**More MCP-testable surfaces** (next deep-test pass)
- Customers page **with real customer data** (need conversation traffic to populate; or onboarding Step 3 CSV import to stage some)
- Customer detail page (`/dashboard/customers/:id`) — never reached this session because Deep Test PM had 0 customers
- Conversations page **with real conversation data** + the customer/conversation links we just fixed (verify the back button works correctly post-fix)
- Conversations sidebar full coverage (sort/filter chips, take-over button, Reply box)
- ~~Onboarding wizard end-to-end~~ ✅ **walked Apr 27 PM (later)** — see "Onboarding wizard pass" section below. Zero bugs, zero PRs needed.

**Cosmetic / housekeeping**
- `Step1CompanyProfile.jsx` URL field already implements onBlur+caption (verified in source: `setUrlError` at line 32 + onBlur at line 124 + red-border style at 130 + caption at 132). The "could mirror PR #131" note was based on a memory description, not a source check. Pattern is established and working — couldn't visually verify because programmatic JS `.blur()` doesn't fire React's synthetic onBlur (existing memory `feedback_html5_validation_preempts_react.md`). Closing this item — no parity work needed.
- `nomii-*` GHCR repos still public + pulling clean for pre-rebrand image tags. If you want them GC'd, requires manual GHCR delete via dashboard. Otherwise harmless.

**Ops / Austin-only**
- UptimeRobot monitor #3 type flip (still deferred from prior sessions)
- Volume rename backup cleanup (recheck on/after May 1)
- Rotate the $3-budget Anthropic key (still pending)

> Cross-repo work (Polygon UK W1, Lateris, ponten-solutions, etc.) belongs in
> the vault under `projects/`, not here. This file is Shenmay-only.

### Onboarding wizard pass (Apr 27 PM later, on top of v3.3.12)

Walked the full 6-step setup wizard on a fresh tenant (`shenmay-ob-apr27pm@mailinator.com`, Onboard Test). Used `verify-email` token pulled directly from prod DB to bypass a Resend mailinator delay (~5+ min, the OB email never arrived in inbox during the session — investigated separately, not Shenmay code).

**Zero bugs surfaced. Zero PRs shipped from this pass.**

| Step | Surface | Result |
|---|---|---|
| 1 | Company profile | ✅ Renders cleanly. Pre-fills Company + Agent name from signup. URL onBlur validation already in place (couldn't trigger via programmatic JS — synthetic React event quirk, real keyboard tab works). |
| 2 | Products & services | ✅ 3 import paths (AI / manual / CSV). PR #126 prose-vs-URL fix verified — pasting prose keeps button as "Extract with AI", no mode flip. "Skip this step" link present. |
| 3 | Customer data | ✅ Compliance notice clear. CSV-only path. (`file_upload` MCP-blocked — same gap as prior deep-tests.) "Skip for now" link present. |
| 4 | Connect AI | ✅ **PR #126 invalid-key fix verified live** — typing a bogus `sk-ant-api03-...` and clicking Validate shows the clean human message "Invalid API key. Please check and try again." (not the raw error code). "Skip for now — add one later in Settings" link present. |
| 5 | AI tools | ✅ Excellent UX. 4 toggles (Look up / Run calculations / Generate reports / Know when to involve team). Toggling ON reveals sub-fields (when-to-use prompt + which-data hint). **Continue button copy dynamically updates to "Save N tool[s] and continue".** Validation specifically names the missing tool ("Please fill in the required data field for: Look up client information"). |
| 6 | Add the widget | ✅ Per-platform tabs (WordPress / Webflow / Squarespace / Wix / Shopify / React Next.js / Other). Snippet shows widget_key interpolated correctly. React snippet is full useEffect with cleanup + auth-state dependency — production-quality. **No explicit "Done" button** — only "Skip to dashboard" footer or wait for widget auto-detection. By design (auto-detect is the actual completion signal); not a bug. |

**Skip-to-dashboard cleanly preserves the "Complete setup" banner** so user can return at any time to finish the widget step.

### What got captured this onboarding pass

- **Resend mailinator email delay** (informational, not a bug) — verification email for `shenmay-ob-apr27pm@mailinator.com` never arrived in mailinator during the session. Bypassed by pulling the `email_verification_token` directly from prod DB. Could be: Resend rate limit, mailinator throttling on test domains, or genuine slow delivery. Worth a glance at the Resend dashboard if it recurs.
- **Programmatic verification of magic-link signup is doable via DB token** — `SELECT email_verification_token FROM tenant_admins WHERE email = ?` then navigate `/verify-email?token=...`. Useful when mailinator is slow or ignored.
- **Step 1 URL field uses onBlur+caption** (`setUrlError` at line 32 + onBlur at line 124 of Step1CompanyProfile.jsx). The earlier "queue" note ("could mirror PR #131's pattern") was based on description, not source-check. Pattern is correct and consistent with PR #131. No parity work needed.

---

## Previous: 2026-04-27 — **v3.3.10 + v3.3.11 SHIPPED** — SaaS deep-test bundle + on-prem deep-test pass + NOMII_* env-var fallback

Session arc: cleared the entire cosmetic queue from v3.3.9 (INDUSTRIES dead-const sweep + Settings → CompanyProfile URL inline-validation parity) → tagged **v3.3.10** → ran a fresh Chrome-MCP deep-test pass on prod (Email Templates / Webhooks / Custom Tools / Conversations) → bundled the surfaced UX gaps into one PR → tagged **v3.3.10** with the polish bundle (#132) → walked the same 4 surfaces on the on-prem test VM (`10.0.100.25`) → caught the silent-revert-to-trial bug from the post-rebrand `envVar()` helper not reading `NOMII_*` → bundled with 3 wording fixes → tagged **v3.3.11** → both Hetzner + on-prem deployed.

### Headline numbers

| | Start | End |
|---|---:|---:|
| Production tag | v3.3.9 | **v3.3.11** (jumped 2) |
| PRs merged | — | **5** (#130 #131 #132 #133 + docs PR) |
| Release tags pushed | — | **2** (v3.3.10, v3.3.11) |
| 5×5 release gates | — | **2** (both 10/10 + verdict success) |
| Deep-test passes run | — | **2** (SaaS + on-prem) |
| Surfaces walked | — | 4 SaaS + 4 on-prem + on-prem-only Plans/billing |
| Bugs fixed | — | 7 (1 P1, 3 UX, 3 wording) |
| Bugs ruled out | — | 1 ("Unicode mojibake" was Git Bash Windows-locale, not Shenmay) |
| Rollbacks | — | 0 |
| Bundle hash | `index-619Yzz2P.js` | `index-Dfrw0FPh.js` |

### Ship log (Apr 27)

| Tag / PR | SHA | What |
|---|---|---|
| [#130](https://github.com/jafools/shenmay-ai/pull/130) | `9641989` | chore(settings): drop dead `INDUSTRIES` const from 10 sub-section files. Cosmetic post-v3.3.1 split cleanup; 110 deletions, 0 insertions. CompanyProfile.jsx is the only legit consumer. |
| [#131](https://github.com/jafools/shenmay-ai/pull/131) | `05f9cc2` | fix(settings): inline URL validation on Settings → CompanyProfile (mirrors #126 onboarding pattern). |
| **v3.3.10** | tag at `f09c6e8` | GHCR rebuild + Hetzner deploy. Bundle `index-BZFPC8pK.js`. |
| [#132](https://github.com/jafools/shenmay-ai/pull/132) | `f09c6e8` | fix(settings): plug 3 dead-end UX gaps from Apr-27 SaaS deep-test — Email Templates Reply-To inline validation + Webhooks empty-URL toast + `required` attr + a11y `aria-label` on edit/delete icons. |
| [#133](https://github.com/jafools/shenmay-ai/pull/133) | `b416dfc` | fix(self-hosted): `envVar()` falls back to `NOMII_<suffix>` when `SHENMAY_<suffix>` unset (P1 surfaced on the on-prem test VM whose .env still had `NOMII_LICENSE_KEY=...`) + license placeholder mentions both prefixes + trial banner headline branches on which limit triggered + Tools sandbox copy drops "using your configured key". |
| **v3.3.11** | tag at `b416dfc` | GHCR rebuild + Hetzner deploy + on-prem refresh. Bundle `index-Dfrw0FPh.js`. |
| 5×5 gate v3.3.10 | `49ec0ec` | [Run 24984837746](https://github.com/jafools/shenmay-ai/actions/runs/24984837746) — 10/10 + verdict success. |
| 5×5 gate v3.3.11 | `b416dfc` | [Run 24986285003](https://github.com/jafools/shenmay-ai/actions/runs/24986285003) — 10/10 + verdict success. |

### What got verified end-to-end

**SaaS deep-test (Chrome MCP, prod tenant `shenmay-deeptest-apr27@mailinator.com`):**

- ✅ `/dashboard/settings` renders cleanly on v3.3.9 → confirms PR #125 fix from prior session held
- ✅ Email Templates: empty-save → green ✓ (correct: all fields optional). Long valid values persist across reload, footer keeps newlines.
- ✅ Webhooks happy path: secret reveal, "Active" status, test-ping toast, pause toggle, delete cascade
- ✅ Custom Tools 3-step wizard: type-pick → name + when-to-use → category → "Tool added" toast → list rendered. Sandbox test against the new tool runs successfully (counts 1 message against trial allowance — fallback Anthropic key in play).
- ✅ Conversations: real chat 4 round-trips → renders in dashboard with full thread + sidebar preview + status badges + take-over button + filter chips.
- 🔴 1 P1 false alarm (Unicode mojibake) → diagnosed as Git Bash Windows-locale artifact; bytes from a real browser fetch store as clean UTF-8 (`c3b6` for `ö`). Real customers won't hit this. **Not a Shenmay bug.**

**On-prem deep-test (Chrome MCP via LAN to `10.0.100.25`, refreshed `nomii-*:stable` → `shenmay-*:stable`):**

- ✅ All 4 surfaces render identically to SaaS
- ✅ PR #132 Webhooks "Endpoint URL is required" toast confirmed live
- ✅ PR #132 EmailTemplates inline validation **in bundle** (`replyToError` x3 in `index-BZFPC8pK.js`) — programmatic JS `.blur()` doesn't fire React's synthetic onBlur, so visible-test gap is harness-only; real keyboard-tab works.
- ✅ Plans & billing renders self-hosted-specific "License & usage" view (not SaaS Stripe — gated by `tenants.subscription.plan` + presence of license)
- ✅ Marketing URL `pontensolutions.com/shenmay/license` returns HTTP 200
- ✅ NOMII_* env-var fallback **proven via in-container Node REPL**: SHENMAY_ wins when set, NOMII_ fallback when SHENMAY_ unset, fallback when neither.

### What got captured this session

- **HTML5 native validation preempts React onSubmit** (new feedback memory `feedback_html5_validation_preempts_react.md`) — `type="email"` and `type="url"` inputs trigger the browser's native validation popup BEFORE React's submit handler runs. Means PR #126 / #131 / #132 inline-validation fixes only fire via the **onBlur path**, not the submit path. Don't try to test the submit path with invalid input — HTML5 will short-circuit it. Programmatic JS `.blur()` also doesn't reliably fire React's synthetic onBlur — use real keyboard tab navigation OR trust the bundle-grep + production smoke.
- **Empty-string env vars block `??` fallback** (new feedback memory `feedback_nullish_coalesce_empty_string.md`) — Test 4 of the on-prem env-var verification: `process.env.SHENMAY_FOO = ""` (literal empty string) does NOT fall through to `process.env.NOMII_FOO` because `??` only catches `null`/`undefined`. Edge case in practice (install.sh either sets values or omits entirely) but worth knowing for any future env-var fallback work — use `||` if "empty should fall through too".
- **On-prem test VM at `10.0.100.25`** (new reference memory `reference_onprem_test_vm.md`) — connection details that took 30 minutes to rediscover from the vault: SSH via `pontenprox` jump, `root@10.0.100.25` (publickey, hostname `nomii`), compose at `/home/jafools/nomii/docker-compose.selfhosted.yml`, project name `nomii`, DB roles still `knomi`/`knomi_ai` (heritage from pre-rebrand install — pinned by DATABASE_URL), default admin `tier2@example.test` (test password reset to `DeepTest2026!` this session), backups left at `/home/jafools/nomii/{docker-compose.selfhosted.yml,.env}.bak.*`.
- **`docker-publish.yml` does NOT dual-publish `nomii-*`** — confirmed in workflow header. There were no real `nomii-*` GHCR customers at cutover, so the rebrand was a clean cut. Means a customer pulling `ghcr.io/jafools/nomii-backend:stable` today would be silently frozen at the v2.6.0 build. ON-PREM-2 finding ruled out as a non-issue (population is empty).

### Still-open queue for next session

**Code (Shenmay)**
1. **Test tenant on prod** still live: `shenmay-deeptest-apr27@mailinator.com`, tenant id `f0c48905-427a-461c-bad9-587e6d2e2112`. Has 1 webhook, 1 tool, 1 conversation (4 messages), trial limit reached. Run `delete_tenant.js`-style cleanup script when convenient.
2. **On-prem test VM** has password reset to `DeepTest2026!` for `tier2@example.test` (was unknown before). Reset back to a real password OR leave for next session's testing. Backups `/home/jafools/nomii/{docker-compose.selfhosted.yml,.env}.bak.*` are harmless.
3. **Anthropic key rotation** — the $3-budget key Austin shared in the Apr-26 evening session is still on his plate. Console → API Keys → revoke.

**Cosmetic / housekeeping**
- `Step1CompanyProfile.jsx` URL field could mirror PR #131's inline-validation pattern (currently uses the older onBlur+caption variant — works fine, but slightly different code path). Not blocking.
- `nomii-*` GHCR repos still public + pulling clean for pre-rebrand image tags. If you want them GC'd, requires manual GHCR delete via dashboard. Otherwise harmless.

**More MCP-testable surfaces (next deep-test pass)**
- Customers page (CSV import path; `file_upload` MCP-blocked, need human assist)
- Concerns page
- Notification bell (top-right of dashboard)
- Profile / Team pages

**Ops / Austin-only**
- UptimeRobot monitor #3 type flip (still deferred from prior sessions)
- Volume rename backup cleanup (recheck on/after May 1)
- Rotate the $3-budget Anthropic key (still pending)

> Cross-repo work (Polygon UK W1, Lateris, ponten-solutions, etc.) belongs in
> the vault under `projects/`, not here. This file is Shenmay-only.

---

## Previous: 2026-04-26 night — **v3.3.9 SHIPPED** — full deep-test queue patched + 2 more PRESET_COLORS-class bugs the spec caught on its first run

Session arc: Austin asked to "patch up all of those tasks from the deep-test" → built 4 PRs covering the entire queue from the prior session → **the route-smoke spec immediately caught two more module-scope-binding regressions on `/dashboard/settings` that v3.3.8's PRESET_COLORS fix had unmasked** → bundled the two fixes into the spec PR → merged all 4 → 5×5 gate green → tagged v3.3.9 → deployed to Hetzner.

### Headline numbers

| | Start | End |
|---|---:|---:|
| Production tag | v3.3.8 | **v3.3.9** |
| PRs merged | — | 4 (#125 #126 #127 #128) |
| Bugs fixed | — | **9** (7 deep-test items + 2 caught by the new spec) |
| Real prod-impacting bugs | — | 2 (CONNECTOR_EVENTS + ALL_EVENTS — `/dashboard/settings` was likely broken on v3.3.8 prod, hidden by PRESET_COLORS being the first to throw) |
| 5×5 release gate | — | 10/10 green + verdict success |
| Rollbacks | — | 0 |
| Bundle hash | `index-DoKZYlGp.js` | `index-619Yzz2P.js` |

### Ship log (Apr 26 night)

| Tag / PR | SHA | What |
|---|---|---|
| [#125](https://github.com/jafools/shenmay-ai/pull/125) | `4cfa913` | **test(e2e): dashboard route-smoke + 2 fixes it caught (CONNECTOR_EVENTS, ALL_EVENTS)**. New `tests/e2e/12-dashboard-route-smoke.spec.js` walks every dashboard route + asserts 0 console.errors + non-empty body. Failed on first run → caught two more PRESET_COLORS-class regressions in the same Settings sub-section cluster. Both moved into their consumers. |
| [#126](https://github.com/jafools/shenmay-ai/pull/126) | `e0eefe3` | fix(onboarding): URL detection + human error mapping + inline email/URL validation. Three deep-test items in one PR — Step 2 Import-with-AI no longer flips prose into URL mode; Step 4 Anthropic invalid-key now shows the human message; signup email + Step 1 URL get red-caption inline validation matching the existing `passwordsMismatch` pattern. |
| [#127](https://github.com/jafools/shenmay-ai/pull/127) | `a0f0153` | fix(widget): silent JWT auto-renew + session-expired UX, bump TTL to 24h. New `POST /api/widget/session/refresh` endpoint, sendMessage/pollForMessages transparently retry on 401, "Your session expired. Please refresh the page to continue chatting." replaces generic LLM error string when refresh fails. 3 new e2e specs cover the endpoint. |
| [#128](https://github.com/jafools/shenmay-ai/pull/128) | `49ec0ec` | fix(dashboard): redirect /billing → /plans + soften trial seat-meter to amber. Sidebar labels "Plans & billing" but route lives at /plans — now `/dashboard/billing` redirects there instead of falling through to the catch-all. Trial 1/1 seats no longer renders as full-red "over quota"; trial uses amber + "Trial includes 1 seat. Upgrade to invite more agents." Paid-plan-at-limit keeps the strong red signal. |
| 5×5 release gate | `49ec0ec` | [Run 24966220413](https://github.com/jafools/shenmay-ai/actions/runs/24966220413) — 10/10 green + verdict. |
| **v3.3.9** | tag at `49ec0ec` | GHCR rebuilt (run 24966288052, success in <60s). Hetzner deployed `:3.3.9`. New bundle hash `index-619Yzz2P.js`. Internal + external `/api/health` green. |

### The unplanned find — v3.3.8 was probably also broken on /dashboard/settings

The route-smoke spec failed instantly on its first CI run with the same pure dark-blue blank page from the v3.3.8 retro screenshot. Two more module-scope-binding bugs from the same v3.3.1 ShenmaySettings.jsx 1,873 → 36 LOC split:

- **`CONNECTOR_EVENTS`** declared in `LabelsSection.jsx:175`, only consumed by `ConnectorsSection.jsx`. Moved to ConnectorsSection; orphan dropped from LabelsSection.
- **`ALL_EVENTS`** declared in `DataApiSection.jsx:225`, only consumed by `WebhooksSection.jsx`. Moved to WebhooksSection; orphan dropped from DataApiSection.

v3.3.8 fix unmasked these — once `PRESET_COLORS` started resolving, the next module init order would hit one of these and re-crash. The route-smoke spec exists to catch exactly this class of regression and earned its keep on the very first CI run.

### Status of the deep-test queue from the prior session

| # | Item | Outcome |
|---|---|---|
| 1 | Add the route-smoke e2e spec | ✅ shipped in #125 (and immediately found 2 more bugs) |
| 2 | "Import with AI" URL parse | ✅ shipped in #126 |
| 3 | Anthropic invalid-key raw error code | ✅ shipped in #126 |
| 4 | Widget JWT 2h silent expiry | ✅ shipped in #127 (auto-renew + UX message + TTL 2h → 24h) |
| 5 | Inline-error consistency | ✅ shipped in #126 (signup email + Step 1 URL) |
| 6 | /dashboard/billing redirect | ✅ shipped in #128 |
| 7 | Team page trial-seat bar styling | ✅ shipped in #128 |

Plus the bonus: 2 more `/dashboard/settings` blank-page bugs (#125).

### Captured this session

- **Module-scope const sweep is recursive** — fixing one orphan const can unmask the next one. After any extraction-class fix, run the route-smoke spec on the affected page, then sweep ALL_CAPS module-scope consts in the cluster (`grep -E "^const [A-Z_]{3,}\\s*="`) against their consumers. Tracked: every settings sub-section file currently has a dead `const INDUSTRIES = [...]` that's only used in CompanyProfile.jsx. Cosmetic — separate PR sometime.
- **The route-smoke spec is the diagnostic the v3.3.8 retro identified as missing.** Worth its weight on the first run. New rule: every dashboard route gets a `body.innerText.length > 20` + 0 console.errors smoke. New routes added later need to be added to the `DASHBOARD_ROUTES` array in `tests/e2e/12-dashboard-route-smoke.spec.js`.
- **apiRequest now prefers `data.message` over `data.error`.** Endpoints that want to surface a human-readable string while still keeping a machine code can return `{ error: 'machine_code', message: 'human readable' }`. `err.code` continues to come from `data.code` so existing branching (`email_unverified`, `company_name_taken`) is unaffected.
- **Widget JWT model:** `widget_api_key` is the gate, JWT TTL is defense-in-depth. With auto-renew wired up, an open tab can refresh indefinitely while the widget_key remains valid — a key rotation is the only thing that forces a "session expired" message. 24h TTL is the new default.

### Still-open queue for next session

**Cosmetic / housekeeping**
1. **Drop the dead `const INDUSTRIES = [...]`** from 10 of 11 settings sub-section files (only `CompanyProfile.jsx` uses it). No render impact, just clutter from the v3.3.1 split. Single-PR sweep.
2. **Drop the dead `const INDUSTRIES = [...]`** from `Step1CompanyProfile.jsx` if it's not used there either (haven't checked).
3. Settings → CompanyProfile.jsx URL field could get the same inline-validation treatment as the onboarding Step 1 URL field in #126. 5-min PR for parity.

**More MCP-testable surfaces to cover** (deferred from prior session)
- Email templates UI inside Settings (now-rendering page).
- Webhook config inside Settings.
- Custom tools (the "+ New tool" button on `/dashboard/tools`).
- Conversations list with real conversation data.

**Ops / Austin-only**
- **Rotate the $3-budget Anthropic key** Austin shared in the prior session (transcript + 2 deleted-tenant DB rows + Cloudflare logs). Console → API Keys → revoke. Still on his plate.
- UptimeRobot monitor #3 type flip (still deferred).
- Volume rename backup cleanup (recheck on/after May 1).

> Cross-repo work (Polygon UK W1, Lateris, ponten-solutions, etc.) belongs in
> the vault under `projects/`, not here. This file is Shenmay-only.

---

## Previous: 2026-04-26 evening — **v3.3.8 SHIPPED** — Chrome-MCP deep-test pass surfaces critical /dashboard/settings bug, fixed in ~50 min

Session arc: standard "boot up" → triaged stale queue → first-time signup smoke test (full E2E green except a side-quest widget JWT silent-expiry bug) → Austin asked for a deeper Chrome-MCP-driven test of every button + every onboarding step + every dashboard nav item. Walked it. Surfaced one P0 bug + 6 lower-priority bugs/UX nits.

### Headline numbers

| | Start | End |
|---|---:|---:|
| Production tag | v3.3.7 | **v3.3.8** |
| PRs merged | — | 5 (#120 #121 #122 #123 + tag) |
| Critical bugs found | — | 1 (P0, fixed in ~50 min) |
| Other real bugs surfaced | — | 3 |
| UX nits surfaced | — | 5 |
| Test tenants spawned + cleaned | — | 2 |
| Rollbacks | — | 0 |

### Ship log (Apr 26 evening)

| Tag / PR | SHA | What |
|---|---|---|
| [#120](https://github.com/jafools/shenmay-ai/pull/120) | `68ccddb` | docs(session-notes): defer UR monitor flip + park volume backup until May 1 |
| [#121](https://github.com/jafools/shenmay-ai/pull/121) | `c43c454` | docs(session-notes): drop cross-repo Polygon item from Shenmay queue + guardrail comment |
| [#122](https://github.com/jafools/shenmay-ai/pull/122) | `0f9c770` | docs(session-notes): drop NOMII- master-key rotation TODO (provision fresh on next use beats rotation) |
| [#123](https://github.com/jafools/shenmay-ai/pull/123) | `0001ec7` | **fix(settings): move PRESET_COLORS into LabelsSection so /dashboard/settings stops crashing** |
| **v3.3.8** | tag at `0001ec7` | GHCR rebuilt; Hetzner deployed `:3.3.8`. New bundle hash `index-DoKZYlGp.js`. Internal + external `/api/health` green. |

### The critical bug

`/dashboard/settings` was completely broken on prod v3.3.7 — opened to a pure dark-blue blank page with the React tree throwing `ReferenceError: PRESET_COLORS is not defined`.

Root cause: regression from the v3.3.1 `ShenmaySettings.jsx` 1,873 → 36 LOC split. The `PRESET_COLORS` const (10-color label-swatch palette) was declared at module scope in `WebhooksSection.jsx:425` but the only consumer is `LabelsSection.jsx` (lines 30, 43, 114). LabelsSection had no import. WebhooksSection had ZERO references to it. Vite happens to bundle both into the same chunk so parse-time succeeds, but each module's render closure doesn't see the OTHER module's top-level binding — so the reference fails at render time, not build time. CI's e2e-saas / onprem-e2e specs evidently don't navigate to `/dashboard/settings` post-onboarding.

Fix: move const into LabelsSection.jsx; drop dead declaration from WebhooksSection.jsx. 2 files, 5 insertions, 5 deletions, no behaviour change beyond making the page render.

### Other real bugs surfaced (still open)

1. **"Import with AI" backend treats freeform descriptions as URLs** — Step 2 onboarding. Promised UX is "URL **or** describe what you sell" (per the Import-with-AI panel description), but backend always prepends `https://` and calls `new URL(...)` → throws `Failed to parse URL from https://We sell two things: a $19/month consumer plan...`. Cheap fix: detect spaces/no-dots in input → treat as text instead of URL.
2. **Anthropic invalid-key error shows raw API code `api_key_invalid`** — Step 4 onboarding. Should be human-readable: "This API key is invalid. Check that you copied the full key from console.anthropic.com."
3. **Widget JWT 2h silent expiry** — already filed in `project_widget_jwt_silent_expiry_bug.md` pre-session; deep-test reconfirmed via prod nginx access logs (all `/chat` + `/poll` from a 3h-old tab return 401, widget catch-block renders generic "Sorry, I had trouble responding").

### UX nits surfaced

- Inline-error inconsistency: password mismatch + product-form validation render red captions, but invalid email + invalid URL only get the browser-native HTML5 popup (no inline UI signal).
- `/dashboard/billing` silently redirects to Overview — actual route is `/dashboard/plans`. Add a 301 or fix the sidebar link target.
- Team page 1/1 trial seats shows full **red** progress bar — implies "over quota" when really just trial-tier. Could be styled more neutral.
- Default agent name auto-fills as `<Company> Assistant` — works but the customization affordance isn't loud; many users will probably ship the default.
- Onboarding step 1: invalid URL silently rejected on submit (no inline caption, just the form sits there). Same inconsistency as the email field.

### Surfaces NOT testable from Chrome MCP (need human follow-up)

- **CSV upload** (`mcp__Claude_in_Chrome__file_upload` returns `-32000 Not allowed` — security restriction)
- **Notification bell** (top-right of dashboard) — skipped, no test data to surface there anyway
- **Color picker click-to-pick** from native color dialog (set values via JS works; dialog itself is blocked)
- **Clipboard "Copy" buttons** (MCP can't read clipboard contents to verify)
- **Cross-origin iframe widget send-button** (typing reaches input via MCP, click doesn't propagate; same class as the existing `feedback_chrome_mcp_react_events.md` Stripe Checkout finding)

### Process improvement to schedule

**Add an e2e spec that navigates every dashboard nav item and asserts `console.error` count == 0.** Would have caught the PRESET_COLORS bug before tag-time. This class of bug (silent runtime ReferenceError) is invisible to type-check + build + most happy-path e2e — only a route-level smoke catches it.

### Captured this session

- **Module-scope consts must move WITH their consumer during file splits** (`feedback_module_scope_const_during_split.md`) — bundler lets parse pass; runtime ReferenceError. Always grep `[A-Z_]{4,}` in new files vs imports. Add the route-smoke e2e spec.
- **Chrome MCP gotchas batch 2** (`feedback_chrome_mcp_more_gotchas.md`) — Google password popup blocks MCP visibility; `file_upload` blocked; cross-origin iframe send-button needs human assist.
- **Hot-find diagnostic recipe** when widget shows generic "Sorry, I had trouble responding": backend access logs hide HTTP status codes; check **nginx access log on the FRONTEND container** (`docker compose logs frontend --tail=300 | grep widget/chat`) to see actual status. 401 = JWT expired, 5xx = real error, 2xx = LLM error path (look for `[Widget][chat][llm]` line).

### Still-open queue for next session

**Bugs to fix** (rough priority order)
1. **Add the route-smoke e2e spec** — process improvement that prevents the next PRESET_COLORS-class bug.
2. **"Import with AI" URL parse** — fixes the UX promise of "URL or describe".
3. **Anthropic invalid-key raw error code** — single-string mapping fix.
4. **Widget JWT 2h silent expiry** — full plan in `project_widget_jwt_silent_expiry_bug.md`.
5. **Inline-error consistency pass** — invalid email + invalid URL should get red captions like password mismatch does.
6. **`/dashboard/billing` redirect** — add 301 or fix sidebar link target.
7. **Team page trial-seat bar styling** — neutral, not red.

**More MCP-testable surfaces to cover** (next deep-test pass)
- The now-working `/dashboard/settings` page itself on a fresh tenant on v3.3.8 (this session's deep-test was on tenants whose Settings broke; need to validate the rendered page works end-to-end).
- Email templates UI inside Settings (not yet seen).
- Webhook config inside Settings.
- Custom tools (the "+ New tool" button on `/dashboard/tools`).
- Conversations list with real conversation data (need a tenant that's actually been chatted with).

**Ops / Austin-only**
- **Rotate the $3-budget Anthropic key** Austin shared this session (in transcript + 2 deleted-tenant DB rows + Cloudflare transit logs). Console → API Keys → revoke.
- UptimeRobot monitor #3 type flip (still deferred).
- Volume rename backup cleanup (recheck on/after May 1).

> Cross-repo work (Polygon UK W1, Lateris, ponten-solutions, etc.) belongs in
> the vault under `projects/`, not here. This file is Shenmay-only.

---

## Previous: 2026-04-25 morning — **v3.3.6 + v3.3.7 SHIPPED** — portal.js sub-router cleanout (2,471 → 547 LOC, −78% in one day)

Single coherent session. Austin: "we have time today to kill em all off, go crazy i can monitor the situation today so feel free."  Cleared the entire substantive backlog from yesterday's session-notes queue.

### Headline numbers

| | Start | End | Δ |
|---|---:|---:|---:|
| portal.js LOC | 2,471 | **547** | **−1,924 (−78%)** |
| ShenmayPlans.jsx LOC | 476 | 107 | −369 |
| Sub-routers under `server/src/routes/portal/` | 9 | **16** | +7 |
| Production tag | v3.3.5 | **v3.3.7** | +2 |
| Hetzner deploys | — | 2 | — |
| 5×5 release gates | — | 1 (10/10 green) | — |
| PRs merged | — | 8 | — |
| Rollbacks | — | 0 | — |

### Ship log (Apr 25 morning, single session)

| Tag / PR | SHA | What |
|---|---|---|
| **v3.3.6** | tag at `092e9ee` | Pure infra/refactor bundle (PRs #102–#111 from yesterday). Pre-existing 5×5 from 07:58Z confirmed 10/10 green before tagging. Hetzner deployed `:3.3.6`. |
| [#112](https://github.com/jafools/shenmay-ai/pull/112) | `0ac279e` | portal.js `/concerns` + `/badge-counts` → `concerns-routes.js` + `badge-counts-routes.js` (−50 LOC). Warm-up. |
| [#113](https://github.com/jafools/shenmay-ai/pull/113) | `fb69b0d` | portal.js `/subscription` + `/billing/*` → `subscription-routes.js` + `billing-routes.js`. Stripe init moves with the billing routes. (−135 LOC). `/plans` + `/admin/set-plan` left inline. |
| [#114](https://github.com/jafools/shenmay-ai/pull/114) | `1b2f0a3` | portal.js `/settings/*` + `/company` + `/email-templates` → 3 sub-routers. bcrypt fallback + `generateDataApiKey` move with settings. Redundant per-handler `requirePortalAuth` on agent-soul/generate-soul dropped. (−278 LOC). |
| [#115](https://github.com/jafools/shenmay-ai/pull/115) | `0f59ef2` | portal.js `/me` + `/admin/profile/password/set-plan` → `me-routes.js` + `admin-routes.js`. Five orphan imports dropped (DEPLOYMENT_MODES, isSelfHosted, VALID_ADMIN_PLANS, requireActiveSubscription, isWithinCustomerLimit). (−183 LOC). |
| [#116](https://github.com/jafools/shenmay-ai/pull/116) | `15ecf90` | portal.js `/customers/*` (largest cluster — 11 endpoints, two disjoint blocks) → `customers-routes.js`. Six orphans dropped (csvParse, callClaude, buildTokenizer, BreachError, anonymizeCustomer + the 4 `/customers/:id/data` per-handler `requirePortalAuth`s). Two dead-variable declarations inside `/upload` (`mappedFields`, `handledCols`) dropped. (−725 LOC). |
| [#117](https://github.com/jafools/shenmay-ai/pull/117) | `1ae47b2` | portal.js `/conversations/*` (last big cluster — 11 endpoints, two disjoint blocks) → `conversations-routes.js`. Conversation-attached label POST/DELETE moved INTO conversations-routes (share `/conversations/:id` prefix, not `/labels`). Eight orphans dropped (decrypt, resolveApiKey, 4× memoryUpdater, writeAuditLog, encryptJson, safeDecryptJson, fireNotifications, envVar, markStepComplete). (−553 LOC). |
| [#118](https://github.com/jafools/shenmay-ai/pull/118) | `32710dc` | ShenmayPlans.jsx 476 → 107 LOC, mirroring the ShenmayTools split pattern. Seven new files under `client/src/pages/shenmay/dashboard/plans/` (PlanChip, UsageMeter, UpgradeNudge, SelfHostedView 195 LOC, EnterpriseView 31 LOC, SaaSView 101 LOC, _constants 14 LOC). |
| 5×5 release gate | `32710dc` | [Run 24927446997](https://github.com/jafools/shenmay-ai/actions/runs/24927446997) — 10/10 green + verdict. |
| **v3.3.7** | tag at `32710dc` | GHCR rebuilt; Hetzner deployed `:3.3.7`. Internal + external `/api/health` green. |

### portal.js progression (single session)

| After | LOC | Δ from prev |
|---|---:|---:|
| Baseline (start of session) | 2,471 | — |
| #112 concerns + badge-counts | 2,421 | −50 |
| #113 subscription + billing | 2,286 | −135 |
| #114 settings cluster | 2,008 | −278 |
| #115 me + admin | 1,825 | −183 |
| #116 customers | 1,100 | −725 |
| #117 conversations | **547** | −553 |

### Production state at handoff

| | |
|---|---|
| main HEAD | `32710dc` (PR #118 squash) |
| Release tag | `v3.3.7` (last customer-facing tag) |
| Hetzner prod | **Live on `ghcr.io/jafools/shenmay-*:3.3.7`**. Internal + external `/api/health` green. |
| Sub-routers under `server/src/routes/portal/` | 16 total: api-key, admin, badge-counts, billing, company, concerns, connectors, conversations, customers, email-templates, labels, license, me, notifications, products, settings, subscription, team, tools, webhooks (some count multi-file: connectors+webhooks, concerns+badge-counts) |
| Monitoring | UptimeRobot 3/3 still green, env-forwarding CI lint still active, Resend bounce pipeline still end-to-end |
| Rollbacks | 0 |

### Still-open queue for next session

**Optional / quick**
1. `portal.js` is now down to 547 LOC. Remaining inline routes: `/dashboard`, `/analytics`, `/visitors`, `/search`, `/plans`, `/admin/set-plan` (wait, set-plan moved in #115), and the `/email-templates` (no, those moved in #114). Let me re-check at next session — looks small enough that nothing more is worth splitting unless we hit a 3rd-duplicate forcing function.
2. ~~UptimeRobot monitor #3 type flip~~ — **deferred Apr 26**, Austin to do whenever (UI-only, no API key in repo so I can't drive it from here). Endpoint side verified ready: `https://shenmay.ai/embed.js` HTTP 200, contains `widget-key` 9× — Keyword check will match the moment it's flipped.
3. Volume rename backup cleanup on Hetzner — **recheck on/after May 1** (`~/volume-rename-backup-20260424-201225.sql`, dated Apr 24 20:12; only 2 days old as of Apr 26). Verified file still present. Hold per the "wait ~1 week of healthy runtime" rule.

**Substantive (no urgency)**
4. **Resend bounce dashboard UI** — `email_suppressions` view with remove-by-email. Gated on first real bounce.
5. **Phase 9 USPTO ITU filing** — still parked per the "ITU is LAST" feedback memory.

> Cross-repo work (Polygon UK W1, Lateris, ponten-solutions, etc.) belongs in
> the vault under `projects/`, not here. This file is Shenmay-only.

**Dropped Apr 26:** ~~NOMII- master-key rotation~~ — Austin doesn't actively
use the master account; will just provision a fresh `SHENMAY-` master if the
need ever arises. Legacy `NOMII-` validator stays as compat-shim until the
"sunset on usage" rule trips.

### Captured this session

- **Stray-file shell quirk:** Git Bash on Windows generated 0-byte files like `{,`, `{,-`, `0)`, `{})`, `[id` between commands (probably hook-output piped into something with brace-expansion). Defensively `rm -f` them before each `git add -A` so they don't end up staged.
- **Convention departure pattern:** When extracting a cluster that spans multiple prefixes (e.g. `/subscription` + `/billing/*` + `/plans` + `/admin/set-plan`), prefer two convention-compliant sub-routers + leaving small remainders inline over one root-mounted catch-all that breaks the prefix-per-file convention. Did this for billing — extracted `/subscription` and `/billing/*` separately, left `/plans` + `/admin/set-plan` inline. Then bundled `/admin/set-plan` into `admin-routes.js` later when `/admin/profile`/`/admin/password` got their split (#115) — same prefix at last.
- **Per-handler `requirePortalAuth` is always redundant** in portal.js sub-routers because the parent applies `router.use(requirePortalAuth)` at line 77. Found 6 instances across this session (2 in settings agent-soul/generate-soul, 4 in customers/:id/data*) — all dropped as no-ops.
- **portal.js orphan-import sweep accumulates fast** when extracting handlers — by PR #117 we'd dropped 19 orphan imports total across the session. Always grep imports after each split; ESLint's no-unused-vars doesn't trigger on destructured imports here.

---

## Previous: 2026-04-24 fifth session — FULL WRAP (**v3.3.2 → v3.3.5 SHIPPED** + massive refactor pile on main unreleased)

Austin went to bed after the volume rename; I kept flying through three more autonomous legs (ShenmayTools split, nomii-ref sweep, orphan-doc delete, env-forwarding lint + real-miss fixes, dispatch 5×5, four portal.js splits). Ended at 17 PRs merged, 4 release tags, 4 Hetzner deploys, 1 volume rename, 0 rollbacks, every 5×5 gate 10/10 green.

### Full ship log (Apr 24 fifth session)

| Tag / PR | SHA | What |
|---|---|---|
| [#94](https://github.com/jafools/shenmay-ai/pull/94) | `6dbb9e0` | Harness hardening (widget false-green fix, jsonTransport fallback, afterAll guards) |
| [#95](https://github.com/jafools/shenmay-ai/pull/95) | `2f26807` | Session notes wrap for PR #94 |
| [#96](https://github.com/jafools/shenmay-ai/pull/96) | `7439e00` | Deep `/api/health` + `MONITORING.md` refresh |
| [#97](https://github.com/jafools/shenmay-ai/pull/97) | `53b147a` | Session notes wrap for v3.3.2 |
| **v3.3.2** | tag at `7439e00` | Deep-health live |
| [#98](https://github.com/jafools/shenmay-ai/pull/98) | `9e0fe56` | Resend bounce webhook + migration 037 + transporter wrapper + spec 11 |
| **v3.3.3** | tag at `9e0fe56` | Webhook live |
| [#99](https://github.com/jafools/shenmay-ai/pull/99) | `a388f28` | Hotfix: refuse dev-mode webhook bypass in production |
| **v3.3.4** | tag at `a388f28` | Bypass-gate live |
| [#100](https://github.com/jafools/shenmay-ai/pull/100) | `c4a6a6d` | Session notes wrap v3.3.2 → v3.3.4 |
| [#101](https://github.com/jafools/shenmay-ai/pull/101) | `edc87c5` | Forward `RESEND_WEBHOOK_SECRET` to backend container (missed from #98) |
| **v3.3.5** | tag at `edc87c5` | Webhook in full signed-verification mode |
| [#102](https://github.com/jafools/shenmay-ai/pull/102) | `028fb52` | Env-forwarding CI lint + 5 real compose misses fixed |
| 5×5 dispatch | against `028fb52` | 10/10 green — confirms no drift from all the infra churn |
| Volume rename (manual) | on Hetzner | `nomii-ai_pgdata` → `shenmay-ai_pgdata` via dump/restore — 60s downtime, 34/34 tenants preserved. Backup at `~/volume-rename-backup-20260424-201225.sql` on Hetzner. |
| [#103](https://github.com/jafools/shenmay-ai/pull/103) | | Session notes wrap after volume rename |
| [#104](https://github.com/jafools/shenmay-ai/pull/104) | `828f935` | Flipped 5 stale `nomii-ai` refs (CLAUDE.md pin sentence, install URLs, palette comments) |
| [#105](https://github.com/jafools/shenmay-ai/pull/105) | `66a1ce2` | Deleted pre-Hetzner orphan docs `SESSION_HANDOFF.md` + `CLAUDE_CODE_SETUP.md` (−2,168 LOC) |
| [#106](https://github.com/jafools/shenmay-ai/pull/106) | `c7e2af2` | `ShenmayTools.jsx` 1,109 → 194 LOC (split into 9 per-component files under `tools/`) |
| [#107](https://github.com/jafools/shenmay-ai/pull/107) | `c755cbe` | portal.js connectors + webhooks extracted — 5×5 green on branch |
| [#108](https://github.com/jafools/shenmay-ai/pull/108) | `f4b08e5` | portal.js `/tools/*` extracted — 5×5 green on branch |
| [#109](https://github.com/jafools/shenmay-ai/pull/109) | `93917cb` | portal.js `/notifications/*` extracted — 5×5 green on branch |
| [#110](https://github.com/jafools/shenmay-ai/pull/110) | `51d0593` | portal.js `/labels/*` CRUD extracted — 5×5 green on branch |

### portal.js progression this session

| After | LOC |
|---|---:|
| Baseline (start of session) | 3,203 |
| #107 integrations extract | 2,936 |
| #108 tools extract | 2,570 |
| #109 notifications extract | 2,528 |
| #110 labels extract | **2,471** |

**Total: −732 LOC, −23% this session.** Plus ShenmayTools.jsx −915 LOC, orphan docs −2,168 LOC, volume-rename cleanup, and the env-forwarding lint's 5 real compose fixes.

### Production state at handoff

| | |
|---|---|
| main HEAD | `51d0593` (PR #110 squash) |
| Release tag shipped to customers | `v3.3.5` at `edc87c5` |
| **Unreleased on main** | PRs #102 through #110 — 9 PRs of pure infra/refactor/docs. Zero customer behaviour change. Ready to tag `v3.3.6` when Austin wakes up (optional — no urgency, prod works fine on `:3.3.5`). |
| Hetzner prod | **Live on `ghcr.io/jafools/shenmay-*:3.3.5`**. Volume `shenmay-ai_pgdata`. Docker project `shenmay-ai`. Migrations 036+037 applied. |
| Monitoring | UptimeRobot 3/3 green, Resend bounce pipeline end-to-end, env-forwarding CI lint active |
| Sub-routers under `server/src/routes/portal/` | 8 total: `api-key`, `connectors`, `labels`, `license`, `notifications`, `products`, `team`, `tools`, `webhooks` (9 files) |

### Austin-side items complete this session

- ✅ UptimeRobot 3 monitors created + email alert
- ✅ Resend dashboard webhook endpoint configured
- ✅ `RESEND_WEBHOOK_SECRET` set on Hetzner + container recreated

### Still-open queue for next session

**Optional**
1. **Tag `v3.3.6`** covering #102–#110 (pure infra, no urgency — ships free when next customer-behaviour tag cuts)
2. **UptimeRobot monitor #3 type flip** (plain HTTP → Keyword with `widget-key`, 30 sec in the UI)
3. **Volume rename backup cleanup** after ~1 week of healthy runtime: `ssh nomii@204.168.232.24 "rm ~/volume-rename-backup-20260424-201225.sql"`

**Substantive**
4. **portal.js further splits** — largest remaining clusters:
   - `/customers/*` (~700 LOC, two disjoint blocks) — high blast radius, needs careful work
   - `/conversations/*` (~500 LOC, two disjoint blocks) — high blast radius
   - `/concerns` + `/badge-counts` — small remainder of the inbox cluster
   - `/subscription` + `/billing/*` + `/plans` (~280 LOC) — Stripe-touching, medium risk
   - `/settings/*` cluster (~350 LOC) — privacy/PII-adjacent, medium risk
   - `/me` + `/admin/profile` + `/admin/password` — auth-sensitive, highest risk
5. **`ShenmayPlans.jsx`** (~460 LOC) — next client-side file by size
6. **Resend bounce webhook UI** — dashboard view for `email_suppressions` (remove-by-email). Gated on first real bounce.
7. **NOMII- master-key rotation** — Austin needs to locate the live key first
8. **Phase 9 USPTO ITU filing** — still parked per the "ITU is LAST" feedback memory

### Captured gotchas this session

- **`.count()` includes hidden DOM** — Playwright lesson from PR #94. Always use `.isVisible()` on a stable id for conditional-UI state detection.
- **docker-compose `environment:` block is explicit whitelist** — a var in `.env` that isn't listed in the compose `environment:` block never reaches the container. This bit us on `RESEND_WEBHOOK_SECRET` (PR #98 → #99 → #101). Now guarded by `scripts/check-env-forwarding.js` CI lint.
- **Git Bash `printf '\n...'` can leak stray `n`** — Austin's `.env` ended up with `nRESEND_WEBHOOK_SECRET=...` instead of `RESEND_WEBHOOK_SECRET=...` because of shell-escape quirks. `nano` or `echo >>` is less error-prone than `printf '\n'`.
- **GitHub 301 repo-rename redirect is a trap** — `jafools/nomii-ai` still 301s to `jafools/shenmay-ai`, so install URLs keep working AFTER a repo rename. Silent-correctness until the redirect rotates. Fix direct references.
- **Lovable SPA-200-on-every-route** — route-slug probes via curl return 200 for routes that don't exist. For "does this page exist?" checks, grep the bundle hash.
- **Committing to main locally** — I slipped once this session. Branch protection caught it. Recovery: `git branch <feat>`, `git reset --hard origin/main`, `git checkout <feat>`, push. Clean but avoidable with branch-first discipline.

### What NOT to re-raise

- **Per-customer opt-in on anonymous-only mode** — deferred, Austin explicitly closed this loop during v3.3.0 session
- **Widget-side visible privacy indicator** — deferred, response carries `anonymous_only: true` already
- **No real-card Stripe smoke test** — Austin has negative Stripe balance from prior real-card refund cycles; trust test-mode E2E + first real customer is the smoke
- **`/tools/:toolId/test` 167-LOC handler further split** — already extracted in #108, leave as-is

---

## Previous: 2026-04-24 fifth session interim (v3.3.2 → v3.3.5 + env-forwarding lint + 5×5 green + volume rename)

Full shift — 9 PRs, 4 release tags, 4 Hetzner deploys, 3 UptimeRobot monitors live, Resend bounce pipeline end-to-end, env-forwarding lint blocking the PR #98 bug class, 10/10 release gate green, and the final `nomii-*` filesystem artifact (the pgdata volume) renamed to `shenmay-ai_pgdata`.

### Ship log (Apr 24 fifth session, full)

| Tag / PR | SHA | What |
|---|---|---|
| [shenmay #94](https://github.com/jafools/shenmay-ai/pull/94) | `6dbb9e0` | Harness hardening: widget capacity-skip false-green fix + emailService `jsonTransport` fallback + afterAll guards on `hasDbAccess()`. |
| [shenmay #95](https://github.com/jafools/shenmay-ai/pull/95) | `2f26807` | Session notes for PR #94. |
| [shenmay #96](https://github.com/jafools/shenmay-ai/pull/96) | `7439e00` | `/api/health` → `SELECT 1` (503 on DB fail) + MONITORING.md refresh. |
| [shenmay #97](https://github.com/jafools/shenmay-ai/pull/97) | `53b147a` | Session notes for v3.3.2. |
| **v3.3.2** | tag at `7439e00` | Deep health live on Hetzner. |
| [shenmay #98](https://github.com/jafools/shenmay-ai/pull/98) | `9e0fe56` | Resend bounce webhook: migration 037 `email_suppressions` + inline Svix verify + transporter wrapper monkey-patches `sendMail` to check suppression list + spec 11. |
| **v3.3.3** | tag at `9e0fe56` | Webhook live on Hetzner. |
| [shenmay #99](https://github.com/jafools/shenmay-ai/pull/99) | `a388f28` | Hotfix: refuse dev-mode bypass in production. |
| **v3.3.4** | tag at `a388f28` | Webhook bypass-gate live. |
| [shenmay #100](https://github.com/jafools/shenmay-ai/pull/100) | `c4a6a6d` | Session notes for v3.3.2→v3.3.4. |
| [shenmay #101](https://github.com/jafools/shenmay-ai/pull/101) | `edc87c5` | Fix: forward `RESEND_WEBHOOK_SECRET` through docker-compose to the backend container (miss from PR #98). |
| **v3.3.5** | tag at `edc87c5` | Webhook in full signed-verification mode on prod. |
| [shenmay #102](https://github.com/jafools/shenmay-ai/pull/102) | `028fb52` | Env-forwarding lint: `scripts/check-env-forwarding.js` runs in `server-test` CI. Found 5 real compose misses on first run (fixed in same PR): `TENANT_NAME` (onprem), `WIDGET_CHAT/GLOBAL/PORTAL_RATE_LIMIT_MAX` (SaaS), `DATA_API_RATE_LIMIT` + `PII_TOKENIZER_ENABLED` (both). |
| 5×5 release gate | `028fb52` | [Run 24909519863](https://github.com/jafools/shenmay-ai/actions/runs/24909519863) — 10/10 green (5× saas-repeat + 5× onprem-repeat + verdict). |
| Volume rename (manual) | on Hetzner | `nomii-ai_pgdata` → `shenmay-ai_pgdata`. pg_dump → stop → flip `COMPOSE_PROJECT_NAME=nomii-ai` → `=shenmay-ai` in .env → up db on fresh volume → restore → up backend/frontend → verify → delete old volume. Downtime ~60s. 34/34 tenants preserved. Backup retained at `~/volume-rename-backup-20260424-201225.sql` on Hetzner as rollback artifact. |

### Production state at handoff

| | |
|---|---|
| main HEAD | `028fb52` (PR #102 squash) |
| Release tag | `v3.3.5` pushed (last customer-facing tag) |
| Hetzner prod | **Live on `ghcr.io/jafools/shenmay-*:3.3.5`**. Volume now `shenmay-ai_pgdata`. Docker project now `shenmay-ai`. Internal + external `/api/health` green. |
| Database | 34 tenants preserved across volume migration; migration 037 applied; Resend webhook signature-verification active |
| Monitoring | UptimeRobot 3/3 green; Resend bounce pipeline end-to-end |
| CI | `e2e-saas` + `onprem-e2e` + `server-test` (now with env-forwarding lint) + `selfhosted-smoke` + `client-build` — all green at HEAD. 5×5 release gate freshly cleared. |
| Unreleased on main | PR #102 (CI lint + compose env plumbing) — no customer behaviour, rides the next tag for free |

### Austin-side items that are DONE this session

- ✅ Resend dashboard webhook endpoint configured; `RESEND_WEBHOOK_SECRET` set on Hetzner
- ✅ UptimeRobot 3 monitors created + email alert contact
- ✅ Volume rename executed (no Austin intervention needed — Claude had SSH)

### Still-open queue for next session

1. **UptimeRobot monitor #3 type flip** (~30 sec) — plain HTTP → Keyword with `widget-key`.
2. **NOMII- master-key rotation** — Austin needs to locate the live key first.
3. **Phase 9 USPTO ITU filing** — still parked per the "ITU is LAST" feedback memory.
4. **Spec tagging migration** — `test.skip(isOnprem(), …)` → Playwright `@saas` / `@onprem` tags. Defer until we outgrow 11 specs.
5. **Anonymous-only mode follow-ups** — per-customer opt-in, visible privacy indicator. No signal yet.
6. **Dashboard UI for `email_suppressions`** — remove-by-email. Not needed until a real bounce + an unbounce case happens.
7. **Housekeeping**: delete `~/volume-rename-backup-20260424-201225.sql` on Hetzner after ~1 week of prod-healthy runtime.

---

## Previous: 2026-04-24 fifth session interim (v3.3.2 → v3.3.4)

Six PRs, three release tags, three Hetzner deploys. Started as a test-harness cleanup, ended with a full customer-deliverability suppression pipeline live on prod.

### Ship log (Apr 24 fifth session, full)

| Tag / PR | SHA | What |
|---|---|---|
| [shenmay #94](https://github.com/jafools/shenmay-ai/pull/94) | `6dbb9e0` | Test-harness hardening. Widget `.count()` on hidden `#capacity-screen` was firing skip every CI run → two tests had zero coverage. Switched to `isVisible()`. emailService `jsonTransport` fallback when SMTP creds missing. afterAll guards on `hasDbAccess()` in specs 05/06/08. |
| [shenmay #95](https://github.com/jafools/shenmay-ai/pull/95) | `2f26807` | Session-notes entry for PR #94. |
| [shenmay #96](https://github.com/jafools/shenmay-ai/pull/96) | `7439e00` | `/api/health` now runs `SELECT 1` and returns 503 on DB failure. `docs/MONITORING.md` refreshed for shenmay.ai + added `/embed.js` monitor config. |
| [shenmay #97](https://github.com/jafools/shenmay-ai/pull/97) | `53b147a` | Session-notes entry for v3.3.2. |
| **v3.3.2** | tag at `7439e00` | GHCR rebuilt; Hetzner deployed. Deep `/api/health` live. |
| [shenmay #98](https://github.com/jafools/shenmay-ai/pull/98) | `9e0fe56` | Resend bounce/complaint webhook. Migration 037 `email_suppressions` table. `POST /api/webhooks/resend` with inline Svix verification (no SDK dep). Transporter wrapper auto-skips suppressed recipients across all 10 existing `sendMail` call sites. Spec 11 covers signed/tampered/soft paths. `docs/MONITORING.md` Resend section flipped from future-follow-up to live. |
| **v3.3.3** | tag at `9e0fe56` | GHCR rebuilt; Hetzner deployed. Migration 037 applied automatically. Webhook endpoint reachable. |
| [shenmay #99](https://github.com/jafools/shenmay-ai/pull/99) | `a388f28` | **Hotfix.** Webhook's dev-mode bypass (unset `RESEND_WEBHOOK_SECRET`) was accepting unsigned POSTs on prod — an attacker could insert arbitrary suppression rows, blocking legitimate mail. Gated bypass on `NODE_ENV !== 'production'`. Prod + unset secret → 400 `webhook_secret_unset_in_production`. |
| **v3.3.4** | tag at `a388f28` | GHCR rebuilt; Hetzner deployed. External curl confirms bare POST now 400s. Window closed. |
| UptimeRobot | 3 monitors live | `shenmay.ai/`, `/api/health`, `/embed.js`. 5-min, alert-after-2-failures, email. 100% uptime at handoff. |

### Production state at handoff

| | |
|---|---|
| main HEAD | `a388f28` (PR #99 squash) |
| Release tag | `v3.3.4` pushed; GHCR `:stable` / `:3.3.4` / `:3.3` / `:latest` published |
| Hetzner prod | **Live on `ghcr.io/jafools/shenmay-*:3.3.4`**. Migrations 036 + 037 applied. Internal + external `/api/health` green. Webhook endpoint returns 400 on unsigned POSTs until `RESEND_WEBHOOK_SECRET` is set. |
| Monitoring | UptimeRobot 3/3 green |

### What Austin needs to do next (≤ 10 min total)

1. **Configure Resend webhook in the dashboard** — 6-step recipe in [`docs/MONITORING.md`](MONITORING.md#resend-dashboard-setup-one-time-austin):
   - `resend.com/webhooks` → Add Endpoint
   - URL: `https://shenmay.ai/api/webhooks/resend`
   - Events: `email.bounced` + `email.complained` only
   - Copy the `whsec_...` secret
   - SSH Hetzner: `cd ~/shenmay-ai && printf "\nRESEND_WEBHOOK_SECRET=whsec_...\n" >> .env && docker compose up -d backend`
   - Back in Resend dashboard → Send test event → confirm 200 OK
2. **Optional** (30 sec): flip UptimeRobot monitor #3 (`/embed.js`) from HTTP → Keyword with keyword `widget-key` in its settings.

### Still-open queue for next session

1. **Volume rename** (`nomii-ai_pgdata` → `shenmay-ai_pgdata` on Hetzner). Destructive, needs maintenance window.
2. **NOMII- master-key rotation** — Austin's one live master key still on the old prefix.
3. **Phase 9 USPTO ITU filing** — still parked per the "ITU is LAST" feedback memory.
4. **Spec tagging** — migrate `test.skip(isOnprem(), …)` to Playwright `@saas` / `@onprem` tags once we outgrow ~10 specs. We're at 11 now.
5. **Anonymous-only mode follow-ups** (deferred, low urgency until signal).
6. **Future deliverability UI** — dashboard view for `email_suppressions` (remove-by-email). Single SQL `DELETE` works fine until this matters.

---

## Previous: 2026-04-24 fifth session interim (v3.3.2)

Three PRs merged, one release tag cut, one infra change deployed to Hetzner, three UptimeRobot monitors live on prod.

### Ship log (Apr 24 fifth session)

| Tag / PR | SHA | What |
|---|---|---|
| [shenmay #94](https://github.com/jafools/shenmay-ai/pull/94) | `6dbb9e0` | Test-harness hardening. Widget `.count()` on hidden `#capacity-screen` was firing skip every CI run → `SPA logout reloads widget` + `close button inside iframe` had zero coverage. Switched to `isVisible()`. emailService falls back to nodemailer `jsonTransport` when SMTP creds missing (kills CI 550 warn noise). afterAll cleanup in specs 05/06/08 guarded on `hasDbAccess()`. |
| [shenmay #95](https://github.com/jafools/shenmay-ai/pull/95) | `2f26807` | Session-notes entry for PR #94. |
| [shenmay #96](https://github.com/jafools/shenmay-ai/pull/96) | `7439e00` | `/api/health` now runs `SELECT 1` and returns 503 on DB failure (was hardcoded 200). `docs/MONITORING.md` refreshed: primary URL `nomii.pontensolutions.com` → `shenmay.ai`, keyword `ok` → `shenmay-ai`, added embed.js monitor, noted Resend bounce webhook as a future follow-up (no server endpoint yet). |
| **v3.3.2** | tag at `7439e00` | Annotated tag pushed. GHCR rebuilt `:3.3.2` / `:3.3` / `:stable` / `:v3.3.2` / `:latest`. |
| Hetzner deploy | `:3.3.2` live | `docker compose pull backend frontend && up -d` — internal + external `/api/health` green. |
| UptimeRobot | 3 monitors live | `shenmay.ai/`, `shenmay.ai/api/health`, `shenmay.ai/embed.js`. 5-min interval. 100% uptime at handoff. All 3 currently `HTTP` type — #3 should eventually flip to `Keyword` (`widget-key`) so a Cloudflare error page can't pass as 200. |

### Production state at handoff

| | |
|---|---|
| main HEAD | `7439e00` (PR #96 squash) |
| Release tag | `v3.3.2` pushed; GHCR `:stable` / `:3.3.2` / `:3.3` / `:latest` published |
| Staging | Auto-refreshes to `:edge` within 5 min |
| Hetzner prod | **Live on `ghcr.io/jafools/shenmay-*:3.3.2`**. Deep `/api/health` active — DB-down outages now return 503 instead of silently 200. |
| Monitoring | 3 UptimeRobot monitors (5-min, email alert on 2 consecutive failures). Resend bounce webhook = future |

### Diagnosis divergence worth capturing

The v3.3.0 post-mortem blamed the widget self-skip on `WIDGET_SESSION_RATE_LIMIT_MAX`. That was wrong — the rate limiter returns a plain JSON error, not the capacity screen. `#capacity-screen` is only flipped on by `customer_limit_reached` (subscription seat limit), and TEST_ADMIN's `master` plan is in `UNRESTRICTED_PLANS`, so it can never actually fire in CI. The real bug was `.count()` matching the always-in-DOM hidden element. Kept the capacity-skip branch in place (still real in prod tenants near their seat limit) but made it visibility-aware. Captured as `feedback_playwright_count_always_in_dom.md` in memory.

### Still-open queue for next session

1. **Resend bounce webhook** — add `POST /api/webhooks/resend` handler + UptimeRobot heartbeat monitor. See `docs/MONITORING.md` for the 3-step plan. Gate on first real bounce.
2. **UptimeRobot monitor #3 type flip** — currently plain HTTP, should be Keyword with `widget-key`. 30 seconds in the UI.
3. **Volume rename** (`nomii-ai_pgdata` → `shenmay-ai_pgdata` on Hetzner). Destructive, needs maintenance window.
4. **NOMII- master-key rotation** — Austin's one live master key still on the old prefix.
5. **Phase 9 USPTO ITU filing** — still parked per the "ITU is LAST" feedback memory.
6. **Anonymous-only mode follow-ups** (deferred, low urgency until signal): per-customer opt-in, widget-side visible privacy indicator, optional sweep of existing customers when first flipped.
7. **Spec tagging** — migrate `test.skip(isOnprem(), …)` to Playwright `@saas` / `@onprem` tags once we outgrow ~10 specs. We're at 10 now.

---

## Previous: 2026-04-24 fifth session (E2E harness hardening — initial draft before tagging)

Quick follow-up on the three latent test-coverage issues flagged in the v3.3.0 session notes below. Shipped as a single test+infra PR, no customer behaviour change, no release tag.

### Ship log (Apr 24 fifth session)

| Tag / PR | SHA | What |
|---|---|---|
| [shenmay #94](https://github.com/jafools/shenmay-ai/pull/94) | `6dbb9e0` | Test-harness hardening: (1) fixed widget capacity-skip false-green in `03-widget.spec.js` — the two skip guards used `.count() > 0` on a regex that also matched the always-in-DOM hidden `#capacity-screen`, so `SPA logout reloads widget to anonymous mode` + `close button inside iframe closes the panel` were skip-green every CI run. Switched to `iframe.locator('#capacity-screen').isVisible()` — both tests now actually execute (log shows 3.6s + 2.8s runtime). (2) `emailService.getTransporter()` now returns nodemailer's `jsonTransport` no-op when `SMTP_USER`/`SMTP_PASS` unset — kills the CI 550 warn noise from stripe-upgrade's fire-and-forget license email (Hetzner still has real creds). (3) Guarded `afterAll` cleanup (+ `beforeAll` seed in spec 8) in specs 05/06/08 on `hasDbAccess()` — no more empty `[spec] cleanup failed:` lines in the on-prem-e2e log. 5 files changed, +38/-18. Merged 5-checks-green. |

### Diagnosis divergence worth capturing

The v3.3.0 post-mortem blamed the widget self-skip on `WIDGET_SESSION_RATE_LIMIT_MAX`. That was wrong — the rate limiter returns a plain JSON error, not the capacity screen. `#capacity-screen` is only flipped on by `customer_limit_reached` (subscription seat limit), and the TEST_ADMIN's `master` plan is in `UNRESTRICTED_PLANS`, so it can never actually fire in CI. The real bug was the `.count()` matcher itself matching always-in-DOM hidden elements. Kept the capacity-skip branch in place (it's real in a prod tenant near its seat limit) but made it actually visibility-aware.

### Production state at handoff

| | |
|---|---|
| main HEAD | `6dbb9e0` (PR #94 squash) |
| Release tag | still `v3.3.0` — no new tag (test-harness only) |
| Staging | Auto-refreshes to `:edge` within 5 min; nightly e2e-repeatability cron still active from PR #86 |
| Hetzner prod | Unchanged — still on `:3.3.0` |

### Still-open queue for next session

1. **UptimeRobot** — `/api/health` + Resend bounce webhook. Needs Austin login; not automatable in-session.
2. **Volume rename** (`nomii-ai_pgdata` → `shenmay-ai_pgdata` on Hetzner). Destructive, needs maintenance window.
3. **NOMII- master-key rotation** — Austin's one live master key still on the old prefix.
4. **Phase 9 USPTO ITU filing** — still parked per the "ITU is LAST" feedback memory.
5. **Anonymous-only mode follow-ups** (deferred, low urgency until signal): per-customer opt-in, widget-side visible privacy indicator, optional sweep of existing customers when first flipped.
6. **Spec tagging** — migrate `test.skip(isOnprem(), …)` to Playwright `@saas` / `@onprem` tags once we outgrow ~10 specs. We're at 10 now.
7. **Optional**: dispatch 5×5 `e2e-repeatability.yml` against main to reconfirm the harness with the new widget coverage + jsonTransport fallback before the next customer-behavioural tag.

---

## Previous: 2026-04-24 third session (**v3.3.0 SHIPPED** — anonymous-only mode + widget anon-claim SQL fix)

Started as a root-directory cleanup ask, ended with a shipped minor-version release covering a latent production bug and a net-new privacy feature. Two PRs merged clean, release gate 10/10 green, Hetzner on `:3.3.0` ~30 min after the last code change. 34 tenants on prod, 0 flipped — default-OFF preserved.

### Ship log

| Tag / PR | SHA | What |
|---|---|---|
| [shenmay #86](https://github.com/jafools/shenmay-ai/pull/86) | `3e943c4` | Nightly cron on `e2e-repeatability.yml` (07:00 UTC) + `SESSION_NOTES.md` prod-state update. CI-only; no customer behaviour change. |
| [shenmay #87](https://github.com/jafools/shenmay-ai/pull/87) | `b49360e` | **Fix:** `POST /api/widget/session/claim` was silently 500'ing on every anon→authenticated handoff due to a SET on `conversations.updated_at` — a column that never existed in migration 001. Orphaning anon chat history under the anon customer row. Present since the initial schema. One-line SQL fix + DB-backed hardening of the existing UI-only test. |
| [shenmay #88](https://github.com/jafools/shenmay-ai/pull/88) | `32837c6` | **Feature:** Tenant-wide "Anonymous-only mode" toggle. When ON, the widget forces anonymous sessions for every visitor regardless of host-page identity. Migration 036 + `/session` silently routes to anon + `/session/claim` returns 403 `anonymous_only_mode` + widget catches that error and stays on anon + owner-only Settings card + new E2E spec 10. Default OFF. |
| **v3.3.0** | tag at `32837c6` | Annotated tag pushed, GHCR rebuilt `:3.3.0` / `:3.3` / `:stable` / `:v3.3.0` / `:latest`. |
| E2E Repeatability Proof run [24888812489](https://github.com/jafools/shenmay-ai/actions/runs/24888812489) | against `32837c6` | **10/10 green** (5× saas-repeat + 5× onprem-repeat + verdict). Includes the new `10-anonymous-only-mode.spec.js` running 5× on each mode. Release gate cleared before tagging per the CLAUDE.md rule. |

### Production state at handoff

| | |
|---|---|
| main HEAD | `32837c6` (PR #88 squash) |
| Release tag | `v3.3.0` pushed; GHCR `:stable` + `:3.3.0` + `:3.3` + `:v3.3.0` + `:latest` published |
| Staging | Auto-refreshes to `:edge` within 5 min; nightly 07:00 UTC dispatch of `e2e-repeatability` now active from PR #86 |
| Hetzner prod | **Live on `ghcr.io/jafools/shenmay-*:3.3.0`** (both backend + frontend), containers recreated 12:16 UTC. Migration 036 applied. Internal + external `/api/health` green. |
| Tenant state | 34 tenants on prod, 0 with `anonymous_only_mode=true`. Zero customer-visible change until an owner flips the toggle. |

### What landed this session

1. **Root-directory housekeeping** — 34 shell-fragment garbage files deleted (byproducts of Git Bash misinterpreting pipes across prior Claude sessions; all zero-byte except one 70-byte file containing `which.exe` stderr). 2 legit design handoffs archived to `raw-sources/assets/` in Austin's Obsidian vault (Direction-B Shenmay mockup + hero handoff zip). 3 redundant Stripe `.png` exports deleted (`.svg` sources already tracked).
2. **Widget `updated_at` production bug** — see PR #87 above. Surfaced during an investigation into why `e2e-saas` was completing in 1m45s (suspected silent test-skipping — honest answer: 64 tests ran, Playwright's just that fast). But the backend log showed `[WebServer] error: column "updated_at" of relation "conversations" does not exist`. Traced to `server/src/routes/widget.js:505`. Fix + test hardening.
3. **Anonymous-only mode feature** — see PR #88 above. Austin's idea mid-session: *"a setting in the Dashboard to ONLY spawn Branded AI agents… give customers the option to not store any data ever on their customers who perhaps request it."* V1 scope is tenant-level only; per-customer opt-in deferred until real signal.
4. **Release all the way to prod** — PR #87 merged → PR #88 rebase + merge → release gate 10/10 → `v3.3.0` tag → GHCR build → Hetzner checkout + migrate + deploy + verify.

### Three latent test-coverage issues surfaced but NOT fixed this session

1. **`03-widget.spec.js:208` self-skips every CI run.** The SPA-logout-reloads-widget test has a runtime `test.skip(inCapacity, …)` that fires because the widget-session rate limiter blows through during batched runs. Currently zero coverage despite appearing green. Fix: bump `WIDGET_SESSION_RATE_LIMIT_MAX` in CI env or restructure so the test doesn't burn through the quota.
2. **`06-stripe-upgrade.spec.js` fires real Resend email in CI.** Returns `550 Authentication required` (no Resend creds in the CI env), test passes because the assertion is on license creation — not email send. Should mock the email call in test mode or feature-flag it off under `LLM_PROVIDER=mock`.
3. **On-prem `afterAll` cleanup noise.** On SaaS-only specs that skip in on-prem mode, the `afterAll` hooks still run and log empty `[spec] cleanup failed:` lines. Low priority — just noise. Guard cleanup on `hasDbAccess()` or the spec-level skip condition.

### Decisions / closed loops (DO NOT re-raise)

- **Manual UI smoke of the Settings toggle** — skipped this session. The 5×5 release gate already ran the new spec 5 times on each mode. The remaining gap (portal toggle click → save → widget behaviour in a real browser) needs Austin's login — not automatable. Default-OFF means zero customer blast radius if there's a render issue. Any owner flipping the toggle will catch it.
- **Per-customer opt-in** as part of anonymous-only — deferred. V1 is tenant-level. Austin explicitly agreed that mixing both in v1 muddles the UX.
- **Widget-side visible privacy indicator to end users** — deferred. Response already carries `anonymous_only: true`; UI disclosure is a small follow-up if we want it visible.

### Open queue for next session

1. **UptimeRobot** — `/api/health` + Resend bounce webhook. Needs Austin login; not automatable in-session. I can draft the monitor config for paste-in.
2. **Fix the 3 latent test issues above.** Widget SPA-logout self-skip is highest value — it's currently a false-green. ~30 min.
3. **Volume rename** (`nomii-ai_pgdata` → `shenmay-ai_pgdata` on Hetzner). Destructive, needs maintenance window.
4. **NOMII- master-key rotation** — Austin's one live master key still on the old prefix.
5. **Phase 9 USPTO ITU filing** — still parked per the "ITU is LAST" feedback memory.
6. **Anonymous-only mode follow-ups** (deferred, low urgency until signal): per-customer opt-in, widget-side visible privacy indicator, optional sweep of existing customers when first flipped.
7. **Spec tagging** — migrate `test.skip(isOnprem(), …)` to Playwright `@saas` / `@onprem` tags once we outgrow ~10 specs. We're at 10 now.

### Gotchas captured this session (memory + vault)

- **Main-agent edit-on-main-branch slip.** When editing a workflow file, I initially targeted the main repo's working tree instead of the worktree — caught by `git status` showing a modification on the `main` branch. `git checkout <file>` reverted; re-applied to the worktree path. Same hazard as `feedback_subagent_commit_to_branch.md`, applies to the main agent equally.
- **`gh pr merge --auto` not enabled on this repo.** Queueing auto-merge fails with `Auto merge is not allowed for this repository`. Fall-back: `gh run watch <id>` blocks until CI completes, then `gh pr merge --squash --delete-branch`. Local-branch-delete fails when the worktree has it checked out — remote gets deleted, local stays until worktree is torn down.
- **Fast CI run times are not inherently suspicious.** 58 Playwright tests in 58s is roughly the warm-stack expected rate. Look at the total-tests + skipped line in the log tail, not at wall time, when assessing coverage.
- **UI-only assertions mask silent backend failures.** Spec 03's auth-handoff test passed every run despite a 500 on every call — the widget kept rendering the anon session, and `#chat-wrapper` was visible either way. Fix pattern: add a DB-backed check when exercising state that's invisible in the UI.

---

## Previous: 2026-04-24 evening (E2E harness sprint — **v3.2.0 TAGGED**, 5× SaaS + 5× on-prem all green, customer-ready)

Austin: "Nah fam i want both SaaS and On prem E2E testing to be done until both are customer ready. Go crazy." Sprint executed end-to-end in one session: 4 Playwright specs → 9 specs, 0 CI coverage → 2 CI jobs + 10-cell repeatability matrix, all green. `v3.2.0` pushed. GHCR `:stable` will rebuild automatically; Hetzner deploy is Austin-pick-the-moment (command at the bottom of this section).

### Ship log (Apr 24 evening)

| Tag / PR | Where | What |
|---|---|---|
| [shenmay #83](https://github.com/jafools/shenmay-ai/pull/83) | shenmay-ai main | Squash-merged as `d8c821d`. 9 commits squashed (phased 1→5 + four CI fix rounds). 1819/-18 LOC. Branch deleted. |
| **v3.2.0** | shenmay-ai tag | `git tag -a v3.2.0 ... && git push origin v3.2.0` → GHCR rebuild triggered. Annotation summarises the sprint. |
| E2E Repeatability Proof run [24883018506](https://github.com/jafools/shenmay-ai/actions/runs/24883018506) | GH Actions | `workflow_dispatch` against main @ d8c821d. 10 cells: 5× saas-repeat + 5× onprem-repeat + 1 verdict. **ALL GREEN.** This is Austin's "5 times in a row" bar cleared. |

### What's in the harness now

- **9 specs** across `tests/e2e/` — 4 existing (login/dashboard/widget/onboarding) refreshed to post-rebrand copy + 5 new:
  - `05-signup-funnel.spec.js` — /signup → DB-read verify token → /onboarding → /dashboard
  - `06-stripe-upgrade.spec.js` — webhook-driven, no real card (synthesises `checkout.session.completed` + `invoice.paid` events, asserts `SHENMAY-*` keys + subscription promotion)
  - `07-marketing-ctas.spec.js` — **the regression-killer**: crawls `pontensolutions.com/products/shenmay-ai` via Chromium, asserts zero `/nomii/*` hrefs + ≥1 `shenmay.ai/signup` CTA + HEAD-probes every absolute shenmay.ai link. Would have auto-caught the Apr 24 `/nomii/signup` CTA bug.
  - `08-portal-magic-link.spec.js` — full request-login → DB-read token → verify → /licenses → logout cycle + enumeration-defense pin
  - `09-onprem-setup.spec.js` — on-prem-only: setup-status, /api/health service=shenmay-ai, embed.js content-type, portal-routes-404-in-selfhosted, registration-disabled-returns-403
- **2 CI jobs** in `.github/workflows/ci.yml` (run on every PR + main push):
  - `e2e-saas` — Postgres service → migrate → globalSetup seeds TEST_ADMIN → spin up server+client via Playwright webServer blocks → run full suite
  - `onprem-e2e` — `docker-compose.selfhosted.yml` up → `/api/setup/complete` provisions admin → SQL bump to master tier + `llm_provider='mock'` → run suite with `PLAYWRIGHT_MODE=onprem` (SaaS-only specs skip themselves)
- **5×5 repeatability workflow** in `.github/workflows/e2e-repeatability.yml` — `workflow_dispatch` only. 10 parallel cells + a `repeatability-verdict` summary that fails closed if any cell failed. Re-run this once per sprint to catch drift before tagging a release.
- **Helpers**: `tests/e2e/helpers/db.js` (lazy pg pool + typed token lookups + idempotent license seeder + suffix-based cleanup with prod-refuse guard); `tests/e2e/helpers/mode.js` (`isOnprem()` / `isSaasCi()` / `hasDbAccess()` for spec-level guards); `tests/e2e/global-setup.js` (runs the seed unless PLAYWRIGHT_MODE=onprem/staging).

### Load-bearing fixes along the way

- `server/db/seed-test-admin.js` — idempotent UPSERT of tenant + admin + master-sub, keyed on pinned UUIDs. Refuses to run against DBs that look like production. Sets `llm_provider='mock'` so widget tests get canned responses.
- `client/vite.config.ts` — added Vite dev proxy for `/api`, `/widget`, `/embed.js`, `/health` → :3001. Mirrors the nginx proxy self-hosted uses; previously the 4 existing UI specs silently 404'd in dev because the client made relative API calls against :5173 with no proxy.
- `server/src/index.js` — exposed `GLOBAL_RATE_LIMIT_MAX` env var (was hardcoded to 150/min, tripped the batched suite). Now matches the existing override pattern for LOGIN/REGISTER/WIDGET_SESSION.
- `docker-compose.selfhosted.yml` — passes `GLOBAL_RATE_LIMIT_MAX` / `WIDGET_CHAT_RATE_LIMIT_MAX` / `PORTAL_RATE_LIMIT_MAX` into the backend container.
- `package.json` — added `pg` to root devDeps so specs can require it from the root Playwright runner.
- Spec assertions refreshed to match Direction B rebrand copy (login h1 is "Welcome back." not "Sign in to Shenmay AI"; "Forgot?" not "Forgot password?"; on-prem `/signup` hides the sign-up link).

### Production state at handoff

| | |
|---|---|
| main HEAD | `d8c821d` (PR #83 squash) |
| Release tag | `v3.2.0` pushed; GHCR builds `:stable` + `:3.2.0` + `:3.2` + `:v3.2.0` |
| Staging | `nomii-staging.pontensolutions.com` auto-refreshes to `:edge` within 5 min (main build already running) |
| Hetzner prod | **Live on `v3.2.0`/`d8c821d`** (backend + frontend both `ghcr.io/jafools/shenmay-*:3.2.0`). Deployed Apr 24 late morning UTC. `/api/health` green externally + internally. |

### Deploy v3.2.0 to Hetzner (when Austin is ready)

```bash
ssh nomii@204.168.232.24 "cd ~/shenmay-ai && git fetch --tags && git checkout v3.2.0 && IMAGE_TAG=3.2.0 docker compose pull backend frontend && IMAGE_TAG=3.2.0 docker compose up -d backend frontend"
ssh nomii@204.168.232.24 "curl -s http://127.0.0.1:3001/api/health"
```

### Decisions / closed loops (DO NOT re-raise)

- **Real-card Stripe smoke in CI** — still out; spec 06 does the webhook simulation instead. Matches Austin's prior "no real-card smoke" decision (memory `feedback_no_real_card_smoke.md`).
- **Email-inbox integration test** — skipped in favour of DB-direct token reads from `portal_login_tokens` / `email_verification_tokens`. Fast, deterministic, CI-friendly. Deliverability itself is covered by Resend's dashboard (memory `reference_resend_transactional_email.md`).
- **Running specs against the live staging URL** — deferred. The per-PR + nightly `e2e-saas` job is backed by its own CI Postgres; running against shared staging would pollute `shenmay_ai_staging` and race against the 5-min refresh timer. If we decide otherwise later, the config supports it (set `PLAYWRIGHT_BASE_URL=https://nomii-staging.pontensolutions.com` + `PLAYWRIGHT_SKIP_SEED=1` + pre-seed the staging DB out-of-band).

### Open queue for next session

1. ~~**Deploy v3.2.0 to Hetzner**~~ — ✔ done Apr 24 late-morning. Prod on `:3.2.0`.
2. **UptimeRobot** — still on the list. `/api/health` + Resend bounce webhook. 15-min quick win. Needs Austin login; not automatable in-session.
3. ~~**Nightly dispatch of `e2e-repeatability`**~~ — ✔ schedule trigger added (nightly 07:00 UTC / 03:00 ET). Slack webhook deferred — GitHub's default admin-email notification is sufficient for drift detection; re-open if noise or missed alerts become an issue.
4. **Spec tagging** — migrate the `test.skip(isOnprem(), ...)` pattern to Playwright `@saas` / `@onprem` tags when we outgrow ~10 specs. Cleaner than per-test skip() calls.
5. **Stripe test-card spec** — _if_ we ever reverse the "no real-card smoke" decision, the missing piece is driving checkout.stripe.com in Playwright (the MCP blocker doesn't apply here). Add `06b-stripe-checkout.spec.js` at that time.
6. **Everything from last session's queue** — GTM channel decision, docs/EMAIL.md, portal-table sweep cron, volume rename, NOMII- master-key rotation, Phase 9 USPTO ITU.

### Gotchas captured this session (memory + vault)

- **Lovable SPAs return empty HTML to raw curl** — the React app mounts into `<div id="root">` in JS. Marketing-CTA specs MUST navigate via Chromium (Playwright) or Headless Chrome; `request.get()` sees the shell and asserts "shenmay" on empty content.
- **`tenant.llm_provider` overrides env `LLM_PROVIDER`** — default tenant row has `llm_provider='claude'` (migration 001). Env `LLM_PROVIDER=mock` alone is not enough for the widget spec to get mock responses; the test seed pins the column to 'mock' too. On-prem CI does the same via post-setup SQL.
- **Vite dev has no default proxy** — if the client uses relative `/api/...` fetches and lives on :5173, those 404 unless a proxy is set. Now wired permanently in `client/vite.config.ts`.
- **Playwright `require('pg')` resolution** — specs run from the root; root `node_modules/pg` must exist. Added `pg` to root devDeps + lazy-require inside `getPool()` so onprem-mode specs that skip DB access don't crash at import time.
- **`LOGIN_RATE_LIMIT_MAX` is only one of several.** Full suite needs `REGISTER_`, `WIDGET_SESSION_`, `WIDGET_CHAT_`, `PORTAL_`, and `GLOBAL_` bumped. The last one didn't exist as an env var before today — the hardcoded 150/min global limiter was the invisible cap. Now parameterised.

---

## Previous: 2026-04-24 afternoon (First-customer hardening — **v3.1.4 + v3.1.5 LIVE**, Resend SMTP swap, broken signup-CTA fix Published)

Austin: "Whats next on the agenda before I get my first paying customers?" Closed four hardening loops in one afternoon sitting. Marketing → signup → authenticated-session funnel is now end-to-end unblocked with strong auth signals for transactional email.

### Ship log (Apr 24 afternoon)

| Tag / PR | Where | What |
|---|---|---|
| **v3.1.4** | shenmay-ai prod | PR [#80](https://github.com/jafools/shenmay-ai/pull/80) — Fire-and-forget for 6 remaining `await sendMail` callers: `onboard.js` signup-verification + resend-verification + password-reset, `widget.js` human-mode-reply × 2, `team-routes.js` agent-invite. Each was a 504 risk if SMTP transient-slowed. `send_document.js` deliberately left awaited (agent-tool loop, not HTTP response path). |
| Hetzner `.env` | no PR — config only | SMTP transport swapped **One.com → Resend**. 3-var flip in `.env` (`SMTP_HOST=smtp.resend.com`, `SMTP_USER=resend`, `SMTP_PASS=re_…`), zero code change thanks to nodemailer's SMTP-interface compatibility. Backup at `~/shenmay-ai/.env.pre-resend-20260424-075046.bak`. Resend was already configured in DNS from a past session — DKIM TXT at `resend._domainkey.pontensolutions.com` + `send.pontensolutions.com` SES return-path — but the app was never pointed at it. Post-swap auth verified via magic-link email headers: **`dkim=pass` (selector `resend`) + `dkim=pass` (amazonses.com, bonus) + `spf=pass` + `dmarc=pass`**. Response time 321ms (was 30s+ on flaky One.com days). |
| **v3.1.5** | shenmay-ai prod | PR [#81](https://github.com/jafools/shenmay-ai/pull/81) — `shenmay.ai/` apex redirect for unauthenticated SaaS visitors → `https://pontensolutions.com/products/shenmay-ai`. 17-line change in [client/src/App.tsx:37-61](client/src/App.tsx:37) `SetupRedirect`. Closes the "type brand into browser bar → drop on login wall" conversion killer. Existing sessions (token in localStorage), staging, self-hosted, legacy `nomii.pontensolutions.com` all unaffected by design. |
| [ponten #9](https://github.com/jafools/ponten-solutions/pull/9) | marketing (Lovable) | Fixed the **single biggest conversion leak** — all 5 "Start free trial" CTAs on `/products/shenmay-ai` were pointing at `https://shenmay.ai/nomii/signup`, which fell through the Shenmay React Router catch-all to `/login`. Zero signups possible from the marketing page since the v3.0.4 rebrand. Flipped to `https://shenmay.ai/signup` (3 direct refs + 1 dynamic pricing-tier CTA). Same PR renamed `public/nomii-ai-overview.docx` → `shenmay-ai-overview.docx`. Required two Lovable Publish attempts (first one picked wrong Version History entry — captured gotcha is now twice-realized). Bundle-hash verified post-second-Publish: all 5 CTAs resolve to `shenmay.ai/signup` in production. |

### Production state at handoff (v3.1.5)

| | |
|---|---|
| Hetzner image | `ghcr.io/jafools/shenmay-{backend,frontend}:3.1.5` |
| Hetzner `git checkout` | `v3.1.5` (`cf8ee20`) |
| `/api/health` | `{"status":"ok","service":"shenmay-ai","timestamp":"2026-04-24T08:20:54.433Z"}` |
| SMTP | Resend via `smtp.resend.com:587` STARTTLS. `dkim=pass` triple-auth verified end-to-end. |
| Marketing → signup funnel | UNBLOCKED end-to-end. `pontensolutions.com/products/shenmay-ai` → "Start free trial" → `shenmay.ai/signup` → signup form renders → (Stripe test-mode E2E already closed Apr 20). |
| Apex brand URL | `shenmay.ai/` (unauthenticated) → `pontensolutions.com/products/shenmay-ai` (302 via client-side replace). Authenticated sessions continue to dashboard. |

### Decisions / closed loops (DO NOT re-raise)

- **Real-card Stripe smoke test** — Austin declined, has negative Stripe balance from prior card→refund non-refundable-fee cycle. Trust test-mode E2E + let first real customer be the smoke. Captured as `feedback_no_real_card_smoke.md`.
- **Resend API key rotation** — key appeared in chat transcript during the swap. Austin accepted the risk ("I don't think this will leak"). Do NOT re-raise unless concrete compromise signal (Resend dashboard shows unknown sends, bounce spike, etc.). Captured in `reference_resend_transactional_email.md`.
- **DMARC tightening `p=none` → `p=quarantine`** — deferred indefinitely per Austin. Do NOT re-propose unless spoofing incident or deliverability regression.

### Honest E2E coverage answer (from Austin's direct question)

"Have we tried E2E for both SaaS and on-prem successfully, like, 5 times in a row?" Answer: **no, not even once automated.** What exists:
- 4 Playwright specs (login/dashboard/widget/onboarding) — **local-only, broken locally** due to missing TEST_ADMIN seed (known blocker, memory `feedback_playwright_local_env.md`)
- `npm test` (tokenizer unit + server integration) — in CI, Postgres fixture
- `selfhosted-smoke` CI job — only pings `/api/health`, not a real E2E
- Manual SaaS walk-throughs — unscripted, not repeatable

The `/nomii/signup` CTA bug fixed today is a perfect example of what an automated E2E would have caught: one `expect(href).toMatch(/\/signup$/)` in a marketing-page spec would have failed on every CI run since the v3.0.4 rebrand.

**Sprint scoped for next session — see [[projects/nomii/e2e-harness-sprint-plan]] in vault.** Austin: "I want you to knock it out of the park." Estimate: ~1 solid day of work.

### Open queue for next session (priority order)

1. **E2E harness sprint** — top priority. Full plan at `[[projects/nomii/e2e-harness-sprint-plan]]`. Goal: 5 consecutive clean runs SaaS + on-prem before first customer.
2. **Uptime monitoring** — UptimeRobot on `/api/health` + Resend bounce alerts. 15-min quick win. Covers the "prod dies at 3am, find out from a customer DM" gap.
3. **GTM channel decision** — upstream of all remaining tech work. Cold outreach / ProductHunt / warm network / content? Austin-only decision.
4. **`docs/EMAIL.md`** — no email design doc; worth writing while template decisions are fresh.
5. **Portal table sweep cron** — `portal_login_tokens` / `portal_sessions` / `portal_rate_limits`. Cosmetic.
6. **Volume rename** `nomii-ai_pgdata` → `shenmay-ai_pgdata` — internal-only, needs dump/restore window.
7. **Austin's 1 NOMII- master-key rotation** — at leisure.
8. **Phase 9 USPTO ITU filing** — $700, priority-date-sensitive, external admin.

### Gotchas captured this session (memory + vault)

- **Lovable Publish picks displayed entry (SECOND occurrence today — lesson is hardened).** First Publish attempt on PR #9's merge entry didn't change the bundle because Lovable Version History was still pointing at a pre-PR entry. Clicking the merge-commit entry explicitly before Publish is non-negotiable. Verify via bundle-filename-hash change + grep for the new content.
- **One.com DKIM requires support ticket for external DNS.** One.com auto-DKIM only works when nameservers are theirs. For Cloudflare-NS domains, they sign with selectors `rsa1` + `ed1` but public keys are never published externally → `dkim=permerror`. The "fix via One.com" path is a support email, 24-72hr turnaround. Switching to Resend (self-serve DNS-verified DKIM) took 5 minutes instead.
- **Resend already configured on `pontensolutions.com` — app was just never using it.** Past-Austin had set up Resend domain verification at some point. Only needed an API key from Resend dashboard + 3 env-var flips. DNS (DKIM TXT + SES subdomain) already in place.

---

## Previous: 2026-04-24 morning (Shenmay-only portal **LIVE end-to-end on `:3.1.3`** — 4 prod tags, 2 Lovable Publishes, 0 rollbacks)

Morning runbook executed cleanly + bonus polish + cleanup queue closed. Austin signed in at https://pontensolutions.com/license with `ajaces@gmail.com` and saw his SHENMAY-7285 trial license rendering with the proper Shenmay wordmark.

### Ship log (Apr 24 morning, single sitting)

| Tag | PR | What |
|---|---|---|
| **v3.1.0** | [#76](https://github.com/jafools/shenmay-ai/pull/76) | Shenmay-native magic-link + Bearer portal auth (overnight build) |
| **v3.1.1** | [#77](https://github.com/jafools/shenmay-ai/pull/77) | Direction B palette refactor across all 10 transactional email templates |
| v3.1.2 | [#75](https://github.com/jafools/shenmay-ai/pull/75) | `/nomii/license` → `/shenmay/license` outbound href flip (4 files) |
| **v3.1.3** | [#78](https://github.com/jafools/shenmay-ai/pull/78) | Fire-and-forget magic-link send + drop legacy `POST /licenses` Worker-proxy (−118 LOC) |

(v3.1.2 superseded by v3.1.3 — Hetzner only deployed v3.1.3 since #75 + #78 land together at that SHA.)

**+ 2 ponten-solutions Publishes (Lovable):**
- [#7](https://github.com/jafools/ponten-solutions/pull/7) — Shenmay-only `CustomerPortal.tsx` + `portalApi.ts` (rip Kaldryn, point at `nomii.pontensolutions.com/api/public/portal/*`)
- [#8](https://github.com/jafools/ponten-solutions/pull/8) — Replace bare "Shenmay" word + small icon with `<ShenmayWordmark>` (italic Shen · teal dot · roman may · AI superscript) in dashboard + login headers

**+ 3 inline ops fixes (no PR — config only):**
- Hetzner `.env`: `SMTP_PORT 465 → 587` (Hetzner blocks outbound 465 — captured as `wiki/concepts` memory)
- Hetzner `.env`: `SMTP_SECURE true → false` (STARTTLS instead of implicit SSL)
- Hetzner `.env`: `SMTP_FROM "Nomii AI" → "Shenmay AI"` (sender name was the loudest spam tell)
- Backups left at `~/shenmay-ai/.env.pre-smtp-587-bak-20260424-080904`

### Production state at handoff (v3.1.3)

| | |
|---|---|
| Hetzner image | `ghcr.io/jafools/shenmay-{backend,frontend}:3.1.3` |
| Hetzner `git checkout` | `v3.1.3` (`e84ef05`) |
| `/api/health` | `{"status":"ok","service":"shenmay-ai"}` |
| Migration applied | `035_portal_auth.sql` (3 new tables: `portal_login_tokens` + `portal_sessions` + `portal_rate_limits`) |
| Portal endpoint surface | 4 routes, all Shenmay-native: `POST /request-login`, `POST /verify`, `GET /licenses` (Bearer), `POST /logout` (Bearer). Legacy Worker-proxy `POST /licenses` removed. |
| SMTP | Working — One.com via 587 STARTTLS. Hetzner blocks 465 outbound (latent bug pre-Apr-24, no real-customer impact since no one had been emailing). |
| Lovable customer portal | Live at https://pontensolutions.com/license — Shenmay-only, ShenmayWordmark branded, calls Shenmay backend directly (no Worker in path) |
| Test license issued | `SHENMAY-7285-AD1A-130D-E9DD` (trial, `ajaces@gmail.com`, expires 2026-05-08) for end-to-end smoke validation |

### One unsolved smoke-quality nag

Austin said "ngl this email looks like spam" before the v3.1.1 palette refactor. Sender-name flip + Direction B palette greatly improved it visually but **deeper spam-scoring concerns remain unaddressed:**
1. **SPF / DKIM / DMARC** for `pontensolutions.com` — Gmail/Outlook score sender-domain authentication regardless of body design. Worth checking the DNS state next session.
2. The `Inter` font won't load reliably in Outlook desktop / older Gmail web — falls back to Helvetica. Cosmetic, not deliverability.

### Gotchas captured this morning (saved as memory + vault)

- **Hetzner blocks SMTP 465** → use `SMTP_PORT=587` + `SMTP_SECURE=false` (memory: `reference_hetzner_smtp_587.md`).
- **`await transporter.sendMail`** in any Express handler is a 504 risk if SMTP transient-slows. Pattern is fire-and-forget with `.catch()` for logging. Now fixed for `request-login`; same risk exists in any other place `await transporter.sendMail` appears in `emailService.js` callers — audit when convenient.
- **Lovable Version History "Publish" picks the displayed entry, not the latest commit.** Austin clicked Publish on `5c8bea5` (latest auto-synced) before our portal PR was merged into ponten-solutions main; the bundle hash didn't change post-Publish. Have to merge the Lovable PR on GitHub FIRST so it gets a sync entry, THEN Publish on that specific entry.
- **PR rebase needed when ANY other PR merges first.** GitHub's `gh pr merge` rejects out-of-date PRs even with no file conflict — `git rebase origin/main && git push --force-with-lease` is the unblock.

### Open queue for next session (no urgency)

1. **SPF / DKIM / DMARC audit** for `pontensolutions.com` outbound from `hello@pontensolutions.com`. Most impactful next-step for email deliverability.
2. **`docs/EMAIL.md`** — no email design doc exists; would help future template work.
3. **Audit other `await transporter.sendMail` callers** — concern, human-mode-reply, agent-invite, license-key, document, password-reset, welcome, verification, trial-limit. Same fire-and-forget pattern applies.
4. **Portal table sweep cron** — `portal_login_tokens` + `portal_sessions` + `portal_rate_limits` rows past expiry. Tables stay tiny without it; cosmetic.
5. **Volume rename** `nomii-ai_pgdata` → `shenmay-ai_pgdata` — internal-only cosmetic; needs dump/restore window.
6. **License key rotation** — Austin still has 1 live `NOMII-` master key in DB. Rotate via platform-admin issue-then-revoke at leisure.
7. **Phase 9 USPTO ITU filing** — $700, Class 9 + 42. Every day = priority-date loss.
8. **Marketing route paths** `pontensolutions.com/products/nomii-ai` → `/products/shenmay-ai` and `/nomii/license` → `/shenmay/license` already done in Lovable; the Shenmay app's outbound `<a href>` strings repointed in v3.1.2 (#75 closed it).

---

## Previous: 2026-04-23 late-evening (Shenmay-only portal overnight build — **3 PRs OPEN awaiting Austin AM review**)

Austin hit the portal at `pontensolutions.com/license` with `ajaces@gmail.com` expecting to see his Shenmay licenses; no email arrived. Investigation uncovered a latent architecture bug: the portal is Kaldryn-Worker-gated at the auth step (the Worker's `email_index` KV is populated ONLY by Kaldryn Stripe webhooks; Shenmay licenses live in Postgres on Hetzner and never touch the Worker). Any Shenmay-only customer would silently fail to get a magic-link email. Zero customer impact (per Phase 8, no real customers exist yet) but unacceptable before onboarding anyone.

Austin's call: the portal is now **Shenmay-only**; Kaldryn moves to its own infra. He went to bed; this session built the fix overnight.

### Overnight work — 3 PRs open

| # | Repo | Branch | Status | What |
|---|---|---|---|---|
| [75](https://github.com/jafools/shenmay-ai/pull/75) | shenmay-ai | `chore/shenmay-license-url-flip` | CI pending | Flip outbound `<a href>` `/nomii/license` → `/shenmay/license` in 4 files (ShenmayPlans x2, ShenmaySetup x1, compose + install.sh comments). Unrelated to the portal-auth work but opened earlier in the session; can merge independently. |
| [76](https://github.com/jafools/shenmay-ai/pull/76) | shenmay-ai | `feat/shenmay-portal-auth` | **LANDED after 1 rate-limit fix** | Shenmay-native magic-link + session auth. Migration 035 (`portal_login_tokens` + `portal_sessions` + `portal_rate_limits`). New endpoints `POST /api/public/portal/{request-login,verify,logout}` + `GET /api/public/portal/licenses` (Bearer). Legacy `POST /licenses` kept alive (Shenmay-session-first, Worker-proxy fallback) for cutover safety. 13 new integration tests. +616 / −62. |
| [7](https://github.com/jafools/ponten-solutions/pull/7) | ponten-solutions | `feat/shenmay-only-portal` | Lovable-synced, pending Austin Publish | Rip Kaldryn out of the customer portal. `portalApi.ts` rewritten to call `nomii.pontensolutions.com/api/public/portal/*` directly. `CustomerPortal.tsx` single Shenmay list, filters to `status==='active'` per "ONLY valid" requirement. `LicenseVerify.tsx` brand-string swap. `docs/portal-api.md` v2.0 contract (Shenmay-only). −183 LOC net. |

### **IN THE MORNING — do these 4 things in order**

**1) Merge Shenmay backend PR #76.**
```bash
gh pr checks 76   # should be all green after the rate-limit fix
gh pr merge 76 --squash
```
Don't auto-merge earlier; CI is flaky when multiple checks queue together. One human review.

**2) Cut a release tag.**
```bash
cd ~/Documents/Work/Nomii\ AI
git fetch origin --tags && git checkout main && git pull origin main
git tag v3.1.0
git push origin v3.1.0
```
v3.1.0 = new feature surface (magic-link portal auth) = minor bump. Wait ~2 min for `Publish Docker Images` to build `:3.1.0` + `:stable` on GHCR (watch `gh run list --workflow docker-publish.yml --limit 1`).

**3) Deploy to Hetzner + ensure `SHENMAY_LICENSE_MASTER=true` is set.**
```bash
# Sanity-check env vars FIRST — if SHENMAY_LICENSE_MASTER isn't set, add it:
ssh nomii@204.168.232.24 "grep SHENMAY_LICENSE_MASTER ~/shenmay-ai/.env || echo NOT SET"
# If NOT SET, add it:
ssh nomii@204.168.232.24 "echo 'SHENMAY_LICENSE_MASTER=true' >> ~/shenmay-ai/.env"

# Deploy:
ssh nomii@204.168.232.24 "cd ~/shenmay-ai && git fetch --tags && git checkout v3.1.0 && IMAGE_TAG=3.1.0 docker compose pull backend frontend && IMAGE_TAG=3.1.0 docker compose up -d backend frontend"

# Verify migration 035 ran + endpoints respond:
ssh nomii@204.168.232.24 "docker exec -i shenmay-db psql -U shenmay -d shenmay_ai -c '\\dt portal_*'"
# expect: portal_login_tokens | portal_rate_limits | portal_sessions

curl -s -X POST https://nomii.pontensolutions.com/api/public/portal/request-login \
  -H 'Content-Type: application/json' -d '{"email":"austin.ponten@gmail.com"}'
# expect: {"ok":true}
```
Note: `austin.ponten@gmail.com` has a starter license in the DB but `is_active=false` — reactivate it via platform-admin OR use platform-admin to issue a fresh test license to any email you own before proceeding to step 4.

**4) Publish the Lovable PR.**
- Open https://lovable.dev in your browser
- Find the ponten-solutions project
- Go to Version History
- The commit `a742423 feat(portal): Shenmay-only customer license portal` should be there already (sync is ~seconds after push)
- Click Publish on that version

Then end-to-end smoke:
- Go to https://pontensolutions.com/license
- Enter the email with a valid Shenmay license
- Magic link should arrive from `hello@pontensolutions.com` within 30s
- Click → redirects to dashboard → shows only Shenmay active licenses

### Safety nets if anything goes wrong

- **If PR #76 CI is still red:** check `gh run view <id> --log-failed | grep -B1 -A3 '✗'`. Only fix we made was raising `portalLookupLimiter` default from 10→30/min. Any new failure is most likely DB-state leakage between tests.
- **If Hetzner deploy fails migration 035:** `SHENMAY_LICENSE_MASTER` gate blocks everything; if tables weren't created, manually: `ssh nomii@204.168.232.24 "docker exec -i shenmay-db psql -U shenmay -d shenmay_ai < ~/shenmay-ai/server/db/migrations/035_portal_auth.sql"`.
- **If curl smoke returns `{"error":"not_available"}`:** `SHENMAY_LICENSE_MASTER=true` wasn't set → add it to `.env` + `docker compose up -d --force-recreate backend`.
- **If Lovable portal loads but says "Something went wrong":** browser devtools → network tab → look for 404/500 against `nomii.pontensolutions.com/api/public/portal/*`. If 404 on all paths, backend isn't on v3.1.0 yet. If CORS error, `pontensolutions.com` should already be in `ALLOWED_ORIGINS` ([security.js:30](server/src/middleware/security.js:30)).
- **Worst case — rollback:** `ssh nomii@204.168.232.24 "cd ~/shenmay-ai && git checkout v3.0.6 && IMAGE_TAG=3.0.6 docker compose up -d backend frontend"`. Migrations are additive (no down-migration needed); v3.0.6 ignores the new tables.

### Deferred follow-ups (not blocking)

- **Remove legacy POST /licenses** — Once Lovable has Published and we've confirmed no calls are hitting the old shape, drop it from `public-portal.js` in a cleanup PR. The Worker fallback inside that handler can go away too.
- **Kaldryn Worker portal cleanup** — With Lovable no longer calling `laterisworker/portal/*`, those handlers become dead code. Kaldryn-repo PR at some point.
- **Portal table sweep cron** — `portal_login_tokens` + `portal_sessions` + `portal_rate_limits` entries past their expiry can be periodically pruned. Low urgency (tables stay tiny).
- **PR #75 (license-URL flip)** — wholly independent of the portal-auth work. Merge + tag separately whenever.

---

## Previous: 2026-04-23 evening (**v3.0.6 LIVE on Hetzner** — rebrand 100% code-complete; repo renamed + Hetzner dir renamed + portal.js split 9%; only external Austin-manual items remain)

Second afternoon continuation picked up at v3.0.1 and shipped v3.0.2 → v3.0.6 (five more patch releases, eight more PRs merged, one force-push recovery during a GitHub Actions outage, zero rollbacks). Closed every remaining code-level Nomii string that could be safely flipped without a cross-repo coordination (only `public-portal.js:108 product:'nomii'` is deferred, blocked on the Lovable marketing portal contract). Renamed the GitHub repo to `jafools/shenmay-ai` (Austin's click) + repointed all hardcoded URLs. Renamed `~/nomii-ai` to `~/shenmay-ai` on Hetzner with a `COMPOSE_PROJECT_NAME` pin to preserve the `nomii-ai_pgdata` volume. Extracted 3 bounded sub-routers out of portal.js (license / team / api-key) as the first ~9% cut of the long-overdue portal.js split. Flipped the Cloudflare tunnel display name to "Shenmay-ai" via the dashboard.

### Ship log (evening, continuing from v3.0.1 handoff)

| PR | Tag | Title |
|---|---|---|
| [#66](https://github.com/jafools/shenmay-ai/pull/66) | (bundled) | License-key prefix `NOMII-` → `SHENMAY-` (3 generators + 2 UI placeholders + test) |
| [#67](https://github.com/jafools/shenmay-ai/pull/67) | (bundled) | Anon-visitor domain unification + migration 033 (53 rows on Hetzner) |
| [#68](https://github.com/jafools/shenmay-ai/pull/68) | **v3.0.2** | File-header JSDoc rebrand (39 files) + dev-secret fallbacks + User-Agent |
| [#69](https://github.com/jafools/shenmay-ai/pull/69) | **v3.0.3** | Repoint hardcoded URLs to `jafools/shenmay-ai` after repo rename |
| [#70](https://github.com/jafools/shenmay-ai/pull/70) | **v3.0.4** | Drop `/shenmay/*` route prefix — canonical URLs are `shenmay.ai/login` etc. |
| [#71](https://github.com/jafools/shenmay-ai/pull/71) | **v3.0.5** | Final shim sunset: WP-plugin URL redirect + `@anonymized.nomii` + migration 034 |
| [#72](https://github.com/jafools/shenmay-ai/pull/72) | (docs-only) | Repoint docs at `~/shenmay-ai` after Hetzner repo-dir rename |
| [#73](https://github.com/jafools/shenmay-ai/pull/73) | **v3.0.6** | `refactor(portal)`: extract 3 bounded sub-routers (license / team / api-key) |

### Major operational changes this session

1. **GitHub repo renamed** `jafools/nomii-ai` → `jafools/shenmay-ai`. GitHub auto-redirects the old URL indefinitely (until someone creates a fresh repo at the old name — don't). Both git remotes (Austin's local Windows + Hetzner) updated to `https://github.com/jafools/shenmay-ai.git`. GHCR image names were already `shenmay-*` since Phase 6 — unaffected.

2. **Cloudflare tunnel display name** flipped "Nomii-ai" → "Shenmay-ai" via dashboard (Austin's click, CLAUDE.md updated). Tunnel ID `fb2cb466-3f4f-46f8-8a0c-2b45c549bbe4` unchanged. Underlying `knomi-ai` connector slug is immutable — dashboard name is the customer-visible bit.

3. **Hetzner repo directory renamed** `~/nomii-ai` → `~/shenmay-ai`. CRITICAL WORKAROUND: added `COMPOSE_PROJECT_NAME=nomii-ai` to `~/shenmay-ai/.env` BEFORE the `mv`. Without it, docker-compose would have derived project name from the new dir, orphaning the existing `nomii-ai_pgdata` postgres volume (compose would have silently created a fresh empty `shenmay-ai_pgdata`). Volume name stays `nomii-ai_pgdata` — internal-only, never customer-facing. Brief (~5s) frontend restart during the rename because the nginx bind-mount absolute path changed; backend + db unaffected.

4. **All DB migrations applied pre-deploy:**
    - Migration 033 on Hetzner: 53 rows on `@visitor.nomii` → `@visitor.shenmay`. Staging was empty (no-op).
    - Migration 034 on Hetzner: 0 rows affected (nobody has ever requested GDPR erasure). Safety-net migration for future consistency.

### Production state at handoff (v3.0.6)

| | |
|---|---|
| Canonical SaaS URL | **https://shenmay.ai** (HTTP 200) |
| Legacy SaaS URL | https://nomii.pontensolutions.com (selective 301 to shenmay.ai) |
| Hetzner image | `ghcr.io/jafools/shenmay-{backend,frontend}:3.0.6` |
| Hetzner repo dir | **`~/shenmay-ai/`** (renamed today; `.env` pins `COMPOSE_PROJECT_NAME=nomii-ai`) |
| Postgres volume | `nomii-ai_pgdata` (kept for continuity — rename needs dump/restore, not worth the cost) |
| Hetzner `.env` | Backup at `~/shenmay-ai/.env.pre-dir-rename-20260423-142051.bak` |
| Git HEAD on Hetzner | `v3.0.6` (`fc06770`) |
| `/api/health` | `{"status":"ok","service":"shenmay-ai"}` |
| Staging URL | **https://nomii-staging.pontensolutions.com** (HTTP 200) |
| Cloudflare tunnel | "Shenmay-ai" (ID unchanged; origin points at `http://shenmay-frontend-staging:80`) |
| Repo | **`github.com/jafools/shenmay-ai`** (renamed from `nomii-ai`; old URL 301s) |

### Deployment-flow changes worth remembering

- **Hetzner SSH pattern is now `cd ~/shenmay-ai && ...`** — all release / migration / log / restart snippets in CLAUDE.md + `docs/RELEASING.md` + `docs/testing.md` updated.
- **Volume name mismatch is intentional.** Do not `docker volume rename nomii-ai_pgdata shenmay-ai_pgdata` — there's no such docker command. A true volume rename requires a dump + restore window, not worth the cost for an internal-only name.
- **GHCR push workflow may need manual dispatch on tag push** during Actions outages. Tag `v3.0.6` did not auto-trigger `Publish Docker Images` even though the config specifies `tags: 'v*'` — fixed by `gh workflow run docker-publish.yml --ref v3.0.6`. The `main`-push workflow fired normally (produced `:edge`). Suspect the tag push got lost mid-outage. Keep an eye on future releases; re-dispatch manually if a tag's GHCR image doesn't appear within a few minutes.

### Cutover gotchas worth remembering

- **GitHub Actions had an ~15-minute outage** (500s on dispatch, 504s on GHCR push, pull_request events got stuck "queued"). PR #73's CI wedged until the queue recovered, then succeeded on the original commit. Two empty-nudge commits I pushed never got CI (never triggered), so the PR-head sha was ahead of the only green check. Resolution: reset HEAD back to the green-CI sha, force-push, close-and-reopen the PR to trigger a fresh `pull_request` event. Don't force-push main; only the PR branch.
- **Force-push on own PR branch is fine** — use `--force-with-lease`. Force-push on `main` or a shared branch is the dangerous case. Austin okayed it once the plan was described.
- **Empty commit doesn't always trigger Actions** if the prior event is still processing. During an outage, manually dispatching the workflow (`gh workflow run ... --ref <branch>`) with a non-`pull_request` event works, but the resulting run won't be associated to the PR's check rollup — closing + reopening the PR does the association.
- **React Router prefix strip needed a catch-all back-compat component.** `/shenmay/*` → `/*` with preserved search/hash. The `ShenmayLegacyRedirect` (5 lines + 1 route in `client/src/App.tsx`) handles in-flight verify-email tokens / Stripe success URLs / bookmarks. Belt-and-suspenders only — no real customers affected (Phase 8 zero-customer audit), but cost is zero.
- **Sed sweep `/shenmay/` → `/`** nearly broke the back-compat route itself. Original App.tsx had `<Route path="/shenmay/*" element={<ShenmayLegacyRedirect />} />` which sed turned into `path="/*"` — which matches EVERY URL. Caught immediately via post-sed grep; restored the prefix on that one line. Lesson: when doing large mechanical replacements, ALWAYS re-read the changed file and grep the tail for one-off regressions before committing.
- **`ANON_EMAIL_DOMAINS` array was only used inside `anonDomains.js` itself.** Verified via grep before dropping. The public API (`ANON_EMAIL_DOMAIN` singular + 4 helper functions) stayed unchanged — only the plural export was removed.

### Still deferred (explicit scope for future sessions)

1. **License key format rotation** — generators now produce `SHENMAY-XXXX`. Austin's 1 live `NOMII-XXXX` master key still validates (exact-string DB lookup, no prefix check) and can be rotated at leisure via platform-admin issue-then-revoke.
2. **`product: 'nomii'` JSON field** in `server/src/routes/public-portal.js:108` — cross-repo contract with the Lovable-managed `ponten-solutions` marketing portal. Coordinated flip needed.
3. **Marketing route paths** `pontensolutions.com/products/nomii-ai` → `/products/shenmay-ai` and `/nomii/license` → `/shenmay/license` in Lovable. Austin's click; once flipped, ~6 client-side URL strings in `client/src/pages/shenmay/` need repointing (currently still linking to the `/nomii/*` paths via outbound `<a href>`).
4. **Phase 9 USPTO ITU filing** — $700, Class 9 + 42. Austin's call; every day = priority-date loss.
5. **Customer-comms email blast** — meaningful only once a real external customer exists.
6. **Volume rename** `nomii-ai_pgdata` → `shenmay-ai_pgdata` — cosmetic-only internal name; requires a maintenance window with pg_dump + volume create + restore. Low priority.
7. **Further portal.js splitting** — still 3490 LOC. The remaining big sections have route-precedence interactions on `/:id` and `/customers/:id/data/*` patterns; each deserves its own PR with full e2e coverage:
    - DASHBOARD + CONVERSATIONS + LABELS + CONCERNS (~800 LOC)
    - CUSTOMERS (~700 LOC)
    - PRODUCTS (~320 LOC)
    - TOOLS + WEBHOOKS + CONNECTORS + NOTIFICATIONS (~1000 LOC)

### v3.0.x verification artifacts (evening)

```
$ curl -s https://shenmay.ai/api/health
{"status":"ok","service":"shenmay-ai"}

$ ssh nomii@204.168.232.24 "docker inspect shenmay-backend --format '{{.Config.Image}}'"
ghcr.io/jafools/shenmay-backend:3.0.6

$ ssh nomii@204.168.232.24 "ls ~ | grep -E 'nomii-ai|shenmay-ai'"
shenmay-ai

$ ssh nomii@204.168.232.24 "docker inspect shenmay-frontend --format '{{range .Mounts}}{{.Source}}{{end}}'" | grep shenmay
/home/nomii/shenmay-ai/config/nginx/prod.conf

$ ssh nomii@204.168.232.24 "docker volume ls" | grep pgdata
nomii-ai_pgdata   ← intentionally preserved via COMPOSE_PROJECT_NAME pin

$ curl -I https://shenmay.ai/login
HTTP/1.1 200 OK          ← new canonical

$ curl -I https://shenmay.ai/shenmay/login
HTTP/1.1 200 OK          ← SPA serves index.html; ShenmayLegacyRedirect strips prefix client-side

$ curl -I https://shenmay.ai/downloads/nomii-wordpress-plugin.zip
HTTP/1.1 404 Not Found   ← legacy WP-plugin URL shim removed

$ curl -I https://shenmay.ai/downloads/shenmay-wordpress-plugin.zip
HTTP/1.1 200 OK          ← canonical WP-plugin URL

$ wc -l server/src/routes/portal.js
3490            ← was 3816

$ gh api repos/jafools/shenmay-ai/commits/v3.0.6/check-runs --jq '.check_runs | map({name, conclusion})'
[{"name":"client-build","conclusion":"success"},{"name":"selfhosted-smoke","conclusion":"success"},{"name":"server-test","conclusion":"success"}]
```

Full vault writeup: [[projects/nomii/rebrand-complete-v306-apr-23-2026]].

---

## Previous: 2026-04-23 afternoon (**v3.0.1 LIVE on Hetzner** — Phase 8 CLOSED 5 months early; only Phase 9 + external blockers remain)

Continuous afternoon session picked up where the late-morning handoff left off (v2.8.1 shipped). Closed the **entire code-level rebrand** including Phase 8's 5 backward-compat shims that were on a 6-month sunset timer. Bumped to `v3.0.0` (major) then `v3.0.1` (patch cleanup). 5 tags this session, 5 PRs merged, 0 rollbacks. **Discovery that unlocked it:** the send-list SQL audit revealed 33 tenants but **zero real external customers** — every row was disposable-email test data. With 0 customers to protect, the 6-month timer was guarding nothing.

### Ship log

| PR | Tag | Title |
|---|---|---|
| [#60](https://github.com/jafools/nomii-ai/pull/60) | **v2.8.2** | chore(brand): compose URL defaults + constants.js header → shenmay |
| [#61](https://github.com/jafools/nomii-ai/pull/61) | v2.8.2 (docs-only) | docs(customer-comms): post-Phase-7 SQL wrapper + test-domain filter |
| [#62](https://github.com/jafools/nomii-ai/pull/62) | **v3.0.0** | chore(brand): close Phase 8 — remove all 5 NOMII_* shims |
| [#63](https://github.com/jafools/nomii-ai/pull/63) | (pre-bundled) | chore(brand): post-Phase-8 cleanup — install.sh + dev secrets + CORS + widget CSS |
| [#64](https://github.com/jafools/nomii-ai/pull/64) | **v3.0.1** | chore(brand): widget postMessage rename + post-rebrand cleanup bundle |

### Major decisions

1. **Closed Phase 8 early.** Sunset timer was 6-12 months to protect customers; zero customers = zero benefit. Phase 9 USPTO still deferred (Austin's call).
2. **Hard-flip (not dual-accept) for widget postMessage API.** Same zero-customer reasoning; adding a fresh shim would contradict the Phase 8 close we just did.
3. **License key `NOMII-XXXX` format left alone.** 1 live key in prod (Austin's master tenant) + 3 generators + 2 UI placeholders — needs a rotation plan, not worth bundling.
4. **anonDomains.js dual-domain kept.** 53 live customer rows in prod use `@visitor.nomii` — needs a data migration, separate concern.

### Production state at session handoff

| | |
|---|---|
| Canonical SaaS URL | **https://shenmay.ai** (HTTP 200) |
| Hetzner image | `ghcr.io/jafools/shenmay-{backend,frontend}:3.0.1` |
| Git HEAD on Hetzner | `v3.0.1` (`257b86a`) |
| Container user | `shenmay` (renamed from `nomii` in v3.0.1 Dockerfile) |
| Hetzner `.env` | `SHENMAY_LICENSE_MASTER=true` (renamed from `NOMII_LICENSE_MASTER` during v3.0.0 deploy; backup at `.env.pre-v3.0.0-*.bak`) |
| `/api/health` | `{"status":"ok","service":"shenmay-ai"}` |
| `/api/license/validate` | HTTP 400 (route active — confirms SHENMAY_LICENSE_MASTER is being read) |
| Staging URL | **https://nomii-staging.pontensolutions.com** (HTTP 200) |
| Staging images | `shenmay-{backend,frontend}:edge` |
| Staging container names | `shenmay-{db,backend,frontend}-staging` (renamed this session) |
| Staging `.env` + compose | Both renamed `NOMII_*` → `SHENMAY_*` |
| Cloudflare tunnel origin | `http://shenmay-frontend-staging:80` (flipped via dashboard this session, MCP Chrome automation) |

### Cutover gotchas worth remembering

- **Phase 8 timer vs. customer count.** The original 6-12 month sunset was designed for customer protection. When customer count was audited (send-list SQL returning 33 rows, all test data), the timer's purpose evaporated. Lesson: schedule-based shim sunsets should be gated on "telemetry shows ≥0 usage", not calendar math. If your user count is zero, fast-forward.
- **Widget postMessage API was never in the Phase 5-8 plan.** Discovered during post-Phase-8 "is everything rebranded?" sweep. The `nomii:setUser` / `:identify` / `:toggle` / `:close` / `:updateLabel` surface was never called out as a rebrand-tracked contract. Always do a final post-closure sweep for things the plan missed.
- **Dockerfile container user rename is safe** because the backend container has no host-bind volumes — pgdata lives in the db container. If the backend had bind mounts, renaming USER would have required a chown operation in the compose lifecycle.
- **scripts/backup.sh retention glob** updated to match both `shenmay_backup_*` AND `nomii_backup_*` so existing customer backup directories don't leak old dumps forever after the filename prefix flip. Not strictly needed today (0 customers), but operational hygiene for the future.
- **Cloudflare tunnel dashboard flip via Chrome MCP worked cleanly.** Tunnel is token-managed (no local `config.yml`), so the dashboard is the only way. 5 MCP tool calls: login → Networks → Connectors → click `Nomii-ai` → edit the public-hostname row → change origin. Saved in `feedback_chrome_mcp_react_events.md` pattern.
- **Network-alias trick worked for zero-downtime container rename on staging.** Kept `nomii-frontend-staging` as a `tunnel_bridge` alias during the cutover so the Cloudflare tunnel kept routing. Then flipped the dashboard. Then removed the alias. Total downtime: 0s.

### v3.0.x verification artifacts

```
$ curl -s https://shenmay.ai/api/health
{"status":"ok","service":"shenmay-ai","timestamp":"2026-04-23T12:39:01.373Z"}

$ ssh nomii@204.168.232.24 "docker inspect shenmay-backend --format '{{.Config.Image}}'"
ghcr.io/jafools/shenmay-backend:3.0.1

$ ssh nomii@204.168.232.24 "docker inspect shenmay-backend --format '{{.Config.User}}'"
shenmay

$ curl -sS https://shenmay.ai/embed.js | grep -E "SHENMAY AI|shenmay:setUser"
 * SHENMAY AI — Embed Script  (embed.js)
 *     window.postMessage({ type: 'shenmay:setUser', email: 'user@example.com', ...}, '*');
```

### Still deferred (explicit scope — pick up next session)

1. **Marketing page publish** — Austin's in Lovable flipping `/products/nomii-ai` → `/products/shenmay-ai` and `/nomii/license` → `/shenmay/license`. Once published, unblocks 6 client-side URL fixes in `client/src/pages/shenmay/`.
2. **License key format rotation** — `NOMII-XXXX-XXXX-XXXX-XXXX` → `SHENMAY-XXXX-...`. 3 generators (`license.js`, `platform/licenses.js`, `stripe-webhook.js`) + 2 UI placeholders (`ShenmayPlans.jsx`, `install.sh`) + rotate Austin's 1 live master key.
3. **anonDomains.js data migration** — migrate 53 rows from `@visitor.nomii` → `@visitor.shenmay` and drop `ANON_EMAIL_DOMAINS` from an array to a single string.
4. **GitHub repo rename** `jafools/nomii-ai` — unblocks install-URL + API-docs-link cleanups in embed examples, `ShenmayLicenseSuccess.jsx`, `ShenmaySettings.jsx`, `install.sh`.
5. **Cloudflare tunnel display-name** "Nomii-ai" → "Shenmay-ai" — 5-sec dashboard action.
6. **Phase 9 USPTO ITU filing** — $700, Class 9 + 42. Austin's call; every day = priority-date loss.
7. **Customer-comms email blast** — only meaningful once a real customer exists.

### Backups created this session

- Hetzner: `~/nomii-ai/.env.pre-v3.0.0-20260423-113342.bak`
- pontenprox: `/root/nomii-staging/.env.pre-v3.0.0-*.bak` + `docker-compose.staging.yml.pre-v3.0.0-*.bak` + `docker-compose.staging.yml.pre-shenmay-container-rename-*.bak` + `docker-compose.staging.yml.pre-alias-cleanup-*.bak`

Full vault writeup: [[projects/nomii/shenmay-phase8-closure-v3-apr-23-2026]].

---

## Previous: 2026-04-23 late morning (**v2.8.1 LIVE on Hetzner** — rebrand bounded-context work DONE; Phases 5/6/7 shipped, only 8/9 remain)

Continuous session that closed out **every code-level bounded-context rename** of the Shenmay migration. 6 PRs merged, 5 production tags (v2.6.0 → v2.8.1), 0 rollbacks, ~2 minutes cumulative downtime across all deploys. Only Phase 8 (sunset of legacy shims, 6-month timer) and Phase 9 (USPTO ITU + ®) remain — both on long timers and unrelated to codebase work.

### Ship log

| PR | Tag | Title |
|---|---|---|
| [#53](https://github.com/jafools/nomii-ai/pull/53) | **v2.6.0** | feat(brand): Phase 5e — WP plugin `[shenmay_widget]` shortcode + v1.1.0 |
| [#54](https://github.com/jafools/nomii-ai/pull/54) | **v2.7.0** | feat(brand): Phase 6 — Docker / GHCR / compose rename to shenmay-* |
| [#55](https://github.com/jafools/nomii-ai/pull/55) | **v2.7.1** | fix(compose): gate cloudflared behind 'tunnel' profile |
| [#56](https://github.com/jafools/nomii-ai/pull/56) | **v2.8.0** | feat(brand): Phase 7 — Postgres DB + user rename to shenmay_ai/shenmay |
| [#57](https://github.com/jafools/nomii-ai/pull/57) | **v2.8.1** | fix(api): flip /api/health service field nomii-ai → shenmay-ai |
| [#58](https://github.com/jafools/nomii-ai/pull/58) | docs-only | chore: note Proxmox staging rebrand catch-up + remaining Cloudflare step |

### Rebrand scoreboard at session end

| Phase | Status | Shipped in |
|---|---|---|
| 5 — in-code identifier rename (7 sub-items) | ✅ ALL DONE | v2.4.0 / v2.5.0 / **v2.6.0** (5e) |
| 6 — Docker / GHCR / compose rename | ✅ DONE | **v2.7.0** + v2.7.1 cleanup |
| 7 — Postgres DB + user rename | ✅ DONE | **v2.8.0** |
| Service-field polish | ✅ DONE | **v2.8.1** |
| Staging unstick (images + DB) | ✅ DONE | live-edit on pontenprox |
| 8 — sunset legacy shims | ⏳ 6-month timer | target 2026-10-20 |
| 9 — USPTO ITU + ® registration | ⏳ Austin's call | strictly last |

### Production state at session handoff

| | |
|---|---|
| Canonical SaaS URL | **https://shenmay.ai** (HTTP 200) |
| Hetzner image | `ghcr.io/jafools/shenmay-{backend,frontend}:2.8.1` |
| Container names | `shenmay-{db,backend,frontend}` |
| DB identity | database `shenmay_ai`, user `shenmay` |
| Git HEAD on Hetzner | `v2.8.1` |
| `/api/health` | `{"status":"ok","service":"shenmay-ai","timestamp":"..."}` |
| Legacy `/nomii/login` | HTTP 200 (backward-compat) |
| Legacy `/downloads/nomii-wordpress-plugin.zip` | 301 → canonical |
| Tenants preserved across all renames | 34 (zero data loss) |
| Staging URL | **https://nomii-staging.pontensolutions.com** (HTTP 200) |
| Staging images | `shenmay-{backend,frontend}:edge` |
| Staging container names | still `nomii-*-staging` (Cloudflare-tunnel-blocked rename) |
| Staging DB | `shenmay_ai_staging`, user `shenmay` |
| Cloudflare tunnel origin | `http://nomii-frontend-staging:80` (unchanged — needs dashboard update before the staging container rename) |

### Deferred / blocked on external action

1. **Staging container rename `nomii-*-staging` → `shenmay-*-staging`** — the Cloudflare tunnel `knomi-ai` (ID `fb2cb466-3f4f-46f8-8a0c-2b45c549bbe4`) is token-managed (no local config file on pontenprox; cloudflared image has no shell). Renaming requires Austin's 5-min Cloudflare dashboard action: Zero Trust → Networks → Tunnels → `knomi-ai` → Public Hostname row for `nomii-staging.pontensolutions.com` → change Service origin from `http://nomii-frontend-staging:80` to `http://shenmay-frontend-staging:80` → save. Pair with a compose sed on pontenprox (`container_name: nomii-*-staging` → `shenmay-*-staging`) + `docker compose down && up -d`. Documented in the Phase 6 section of `docs/SHENMAY_MIGRATION_PLAN.md` and the Staging section of CLAUDE.md. No blocker for anything else.
2. **Customer-comms email send** — final polished text at [docs/CUSTOMER_COMMS_SHENMAY_EMAIL.md](docs/CUSTOMER_COMMS_SHENMAY_EMAIL.md). Austin runs the 33-row send-list SQL, feeds to one-off send script, blasts. Window: Tue–Thu 10am–2pm.
3. **Phase 8 — sunset shims** — 6-month timer. Targets include `[nomii_widget]` WP shortcode (keep forever), `X-Nomii-Signature` header (12 months), `nomii_da_*` API key prefix (90 days after customer notice), `nomii_portal_token` fallback (90 days), `NOMII_*` env vars (6 months + zero deprecation-warning telemetry).
4. **Phase 9 — USPTO ITU + ®** — legal filing, Austin's call, explicitly LAST per `feedback_itu_filing_last.md`.

### Cutover gotchas worth remembering

- **Postgres superuser rename requires a temp second superuser.** The official postgres Docker image only creates ONE superuser — the one named in `POSTGRES_USER`. There is no default `postgres` role. You can't self-rename (`ALTER USER nomii RENAME TO shenmay` while connected AS nomii fails). Pattern: `CREATE USER tmp_rename SUPERUSER PASSWORD '...'` (as nomii) → `ALTER DATABASE nomii_ai RENAME TO shenmay_ai; ALTER USER nomii RENAME TO shenmay` (as tmp_rename) → `DROP USER tmp_rename` (as shenmay).
- **Docker `container_name:` change in compose requires `down` BEFORE `git checkout` of the new tag.** Otherwise `up -d` tries to create new-named containers alongside the old ones → port collision on 80/443/3001. Named volumes persist across the `down` so DB data survives.
- **`docker compose up -d` without service args starts ALL services.** On Hetzner that includes `cloudflared`, which restart-loops with a blank `CLOUDFLARE_TUNNEL_TOKEN`. Fix landed in v2.7.1: `profiles: ["tunnel"]` guard on the cloudflared service in `docker-compose.yml` (parity with the selfhosted compose).
- **Token-managed Cloudflare tunnels store hostname → origin mapping in the dashboard, not on disk.** No `/etc/cloudflared/config.yml` when the tunnel is brought up via `--token`. Renaming an origin container requires dashboard access (or Cloudflare API), not just SSH.
- **Renaming a GHCR registry silently freezes staging's auto-refresh.** Once we flipped publishes to `shenmay-*`, the Proxmox refresh script kept pulling `ghcr.io/jafools/nomii-*:edge`. That tag still exists (immutable) but stopped getting new pushes — so the script reported "no change" every 5 min and staging silently stayed at pre-Phase-6 content for days. Fix: update the script's image refs alongside the registry rename.
- **Selfhosted-smoke CI + first-time tag chicken-and-egg.** The smoke test pulls `ghcr.io/jafools/shenmay-backend:stable`, which doesn't exist until the first tagged release AFTER the rename. Fix: pre-build the image locally under the expected tag in the CI job so compose finds it cached (no `pull_policy: always` on that service → local wins). Added in PR #54.

### v2.8.x verification artifacts

```
$ curl -s https://shenmay.ai/api/health
{"status":"ok","service":"shenmay-ai","timestamp":"2026-04-23T08:31:17.894Z"}

$ ssh nomii@204.168.232.24 "docker inspect shenmay-backend --format '{{.Config.Image}}'"
ghcr.io/jafools/shenmay-backend:2.8.1

$ ssh nomii@204.168.232.24 "docker exec shenmay-db psql -U shenmay -d shenmay_ai -t -c 'SELECT COUNT(*) FROM tenants;'"
    34

$ curl -s https://nomii-staging.pontensolutions.com/api/health
{"status":"ok","service":"shenmay-ai","timestamp":"..."}
```

### Backups created this session (on Hetzner + pontenprox)

- Hetzner: `~/backups/pre-phase7-rename-2026-04-23-082027.sql` (640KB — full prod DB before Phase 7 ALTER)
- pontenprox: `/root/backups/pre-phase7-staging-rename-2026-04-23-102812.sql` (60KB — staging DB before ALTER)
- pontenprox: `/root/nomii-staging/{docker-compose.staging.yml,refresh-staging.sh}.pre-phase7-2026-04-23.bak` (staging compose + refresh script before sed)

Full vault writeup: [[projects/nomii/shenmay-phases-5e-to-7-complete-apr-23-2026]].

---

## Previous: 2026-04-23 mid-morning (**v2.5.0 LIVE on Hetzner** — Phase 5 6/7 done, only 5e remains in sibling repo)

Massive continuous session. Started last night at Phase 5 prep, shipped **two full releases** (v2.4.0 morning + v2.5.0 mid-morning), cleared every housekeeping item, polished the customer-comms email end-to-end. **6 of 7 Phase 5 sub-items now LIVE in production.**

### v2.5.0 — what shipped this release

| PR | Merge commit | Title |
|---|---|---|
| [#50](https://github.com/jafools/nomii-ai/pull/50) | `f5baaa4` | `feat(brand): Phase 5c — localStorage portal token migration` |
| [#51](https://github.com/jafools/nomii-ai/pull/51) | `bc0bcc4` | `feat(brand): Phase 5f — rename WP plugin zip + 301 from legacy URL` |

Tag: `v2.5.0` → GHCR built `:2.5.0` + `:stable` + `:latest` → `ssh nomii@204.168.232.24 "IMAGE_TAG=2.5.0 docker compose pull backend frontend && IMAGE_TAG=2.5.0 docker compose up -d backend frontend"`.

### Customer-visible effect of v2.5.0

Both changes are silent from the customer's perspective:

- **Phase 5c** — the portal JWT now lives under `shenmay_portal_token` in localStorage. Existing sessions (still stored under `nomii_portal_token`) silently migrate on their next portal load via `getToken()`'s read-legacy → write-new → clear-legacy path. No re-login required.
- **Phase 5f** — the WP plugin download canonical URL is `/downloads/shenmay-wordpress-plugin.zip`. Legacy `/downloads/nomii-wordpress-plugin.zip` 301-redirects at the Express layer (intercepted BEFORE `express.static` so the rename never 404s a legacy caller). WP auto-update follows redirects by default, so existing installs pick up the new filename transparently.

### Phase 5 scoreboard

| Sub | Description | Status |
|---|---|---|
| 5a | Webhook `X-Shenmay-Signature` dual-emit | ✅ LIVE (v2.4.0) |
| 5b | Data API `shenmay_da_*` prefix dual-accept | ✅ LIVE (v2.4.0) |
| 5c | localStorage portal token migration | ✅ LIVE (v2.5.0) |
| 5d | `@visitor.shenmay` anon email domain | ✅ LIVE (v2.4.0) |
| 5e | WP plugin shortcode rename | ⏳ sibling plugin repo, separate session |
| 5f | WP plugin zip rename + 301 | ✅ LIVE (v2.5.0) |
| 5g | CSV template filename flip | ✅ LIVE (v2.4.0) |

### Cumulative shipped this session (2026-04-22 evening → 2026-04-23 mid-morning)

**7 PRs merged, 2 production releases, 0 rollbacks.**

| PR | Release | Title |
|---|---|---|
| [#45](https://github.com/jafools/nomii-ai/pull/45) | v2.4.0 | E2E Playwright URL sweep |
| [#46](https://github.com/jafools/nomii-ai/pull/46) | v2.4.0 | Phase 5 prep checklist + TODO markers + Direction B Stripe SVGs |
| [#47](https://github.com/jafools/nomii-ai/pull/47) | v2.4.0 | Phase 5 bundle A — 5a/5b/5d/5g dual-emit real impl |
| [#48](https://github.com/jafools/nomii-ai/pull/48) | docs-only | Session-notes wrap for v2.4.0 |
| [#49](https://github.com/jafools/nomii-ai/pull/49) | docs-only | Customer-comms email polish |
| [#50](https://github.com/jafools/nomii-ai/pull/50) | v2.5.0 | Phase 5c localStorage migration |
| [#51](https://github.com/jafools/nomii-ai/pull/51) | v2.5.0 | Phase 5f WP plugin zip + 301 |

### Production state at session handoff

| | |
|---|---|
| Canonical SaaS URL | **https://shenmay.ai** (200) |
| Hetzner image | `ghcr.io/jafools/nomii-{backend,frontend}:2.5.0` |
| Git HEAD on Hetzner | `v2.5.0` (`bc0bcc4`) |
| `/shenmay/login` | 200 |
| `/nomii/login` | 200 (backward-compat redirect) |
| `/api/health` | 200 |
| `/downloads/nomii-wordpress-plugin.zip` | 301 → `/downloads/shenmay-wordpress-plugin.zip` |
| `/downloads/shenmay-wordpress-plugin.zip` | 200, 4507 bytes, `application/zip` |
| Legacy `nomii.pontensolutions.com` | 200 (selective 301 still routing) |

### What's queued

1. **Customer-comms email send** — the polished text is in [docs/CUSTOMER_COMMS_SHENMAY_EMAIL.md](docs/CUSTOMER_COMMS_SHENMAY_EMAIL.md). Austin runs the send-list SQL (33 rows), hands to a one-off send script, blasts. Earliest acceptable: tomorrow Tue–Thu 10am–2pm.
2. **Phase 5e** — WP plugin shortcode rename (sibling repo, new session).
3. **Phase 6** — Docker/GHCR/compose rename. Coordinated maintenance window with on-prem customers.
4. **Phase 7** — DB rename. Depends on Phase 6.
5. **Phase 8** — sunset shims after 6-month grace window (target 2026-10-20).
6. **Phase 9** — USPTO ITU + TM registration (strictly LAST per Austin).

### Non-obvious learning this session

- **Express-level 301 > nginx-level 301** for single-file moves — one file to edit, testable in `node --check`, no ops coordination window, redirect intercepts BEFORE `express.static` so the physical file rename can't 404 a legacy caller. The Docker image carries both the renamed file AND the redirect handler, so `docker compose pull + up -d` swaps atomically.
- **Silent localStorage migration via read-fallback** — the `getToken()` helper reads `shenmay_portal_token` first; if missing, reads `nomii_portal_token`, writes to the new key, removes the old. The user's next page load does the migration transparently — no re-login, no banner, no visible event. E2E Playwright tests (fresh browser context per test) continue to exercise the migration path on every run via their existing `localStorage.setItem('nomii_portal_token', ...)` fixtures.
- **Sequenced merges behind branch-protection** — after merging PR N, subsequent PRs on a protected-main branch mark MERGEABLE=UNKNOWN / STATUS=BLOCKED until rebased. Recipe: `git rebase origin/main && git push --force-with-lease`. CI re-runs in ~30-60s thanks to cached layers.

### v2.5.0 verification artifacts

```
$ curl -s -I https://shenmay.ai/downloads/nomii-wordpress-plugin.zip
HTTP/1.1 301 Moved Permanently
Content-Length: 73
[Location header in body]

$ curl -s -I https://shenmay.ai/downloads/shenmay-wordpress-plugin.zip
HTTP/1.1 200 OK
Content-Type: application/zip
Content-Length: 4507

$ ssh nomii@204.168.232.24 "docker inspect nomii-backend --format '{{.Config.Image}}'"
ghcr.io/jafools/nomii-backend:2.5.0
```

---

## Previous: 2026-04-23 morning (v2.4.0 release — merged via this same session)

### What shipped in v2.4.0

| PR | Merge commit | Title |
|---|---|---|
| [#45](https://github.com/jafools/nomii-ai/pull/45) | `a978974` | `chore(e2e): flip Playwright + pii-blackbox URLs to shenmay canon` |
| [#47](https://github.com/jafools/nomii-ai/pull/47) | `618a321` | `feat(brand): Phase 5 bundle A — dual-emit webhook header, API prefix, anon domain, CSV name` |
| [#46](https://github.com/jafools/nomii-ai/pull/46) | `a1794be` | `chore(rebrand): Phase 5 prep — backend identifier checklist + TODO markers` (rebased post-#47 to drop 5a/5b/5d/5g TODOs now obsolete; kept 5c/5f TODOs) |

Tag: `v2.4.0` → GHCR built `:2.4.0` + `:stable` + `:latest` → `ssh nomii@204.168.232.24 "IMAGE_TAG=2.4.0 docker compose pull backend frontend && IMAGE_TAG=2.4.0 docker compose up -d backend frontend"`.

### Production state at session handoff

| | |
|---|---|
| Canonical SaaS URL | **https://shenmay.ai** (200) |
| Hetzner image | `ghcr.io/jafools/nomii-{backend,frontend}:2.4.0` |
| Git HEAD on Hetzner | `v2.4.0` (`a1794be`) |
| `/shenmay/login` | 200 |
| `/nomii/login` | 200 — client-side redirect (backward-compat) |
| `/api/health` | 200 |
| Legacy `nomii.pontensolutions.com` | 200 (selective 301) |

### Phase 5 bundle A — what's now live

All four sub-items are additive dual-emit / dual-accept — zero customer action, no breakage.

- **5a** — Outbound webhooks emit BOTH `X-Nomii-Signature` and `X-Shenmay-Signature` with identical HMAC. Portal UI copy at `ShenmaySettings.jsx` (2 spots) presents Shenmay as canonical with legacy-header note.
- **5b** — Data API bearer middleware dual-accepts `nomii_da_*` AND `shenmay_da_*`. Prefix-length dynamic (9→17 vs 11→19 stored prefix). New keys issued as `shenmay_da_*`. `DATA_API_KEY_PREFIXES` array + `matchKeyPrefix()` helper at [server/src/routes/dataApi.js:84](server/src/routes/dataApi.js:84).
- **5d** — New anon widget sessions get `@visitor.shenmay`. [server/src/constants/anonDomains.js](server/src/constants/anonDomains.js) is the single source of truth with 3 SQL-fragment helpers + runtime `isAnonVisitorEmail()`. **20 call sites across 6 files** migrated to the helpers via sequenced `replace_all` ops (aliased-first to prevent over-match). Phase 8 sunset is now a 1-line change in the helper instead of a 20-site re-sweep.
- **5g** — `Step2Products.jsx:152` download filename → `shenmay-products-template.csv`.

### Housekeeping also cleared

- **Stripe product cards** — Direction B replacements committed via #46 (3 SVG source files). Austin already uploaded rendered PNGs to Stripe dashboard.
- **GH PAT leak (Apr 20 session)** — memory claimed "stripped mid-session"; reality was the PAT was still embedded in `~/ponten-solutions/.git/config` on pontenprox. Fixed: stripped + switched remote to SSH (`git@github.com:jafools/ponten-solutions.git`, auth verified). Austin revoked the old PAT at github.com.
- **Ponten-solutions stash** — memory said "stashed during PR #3, still to pop". Actually empty + clean, already resolved in a prior session.
- **ITU filing priority** — Austin corrected: ITU is **dead last** in the rebrand, not parallel. Saved as feedback memory `feedback_itu_filing_last.md`.

### Phase 5 remaining (customer-comms email + 3 sub-items)

Still queued for follow-up sessions:

1. **Customer-comms email** (template at [docs/SHENMAY_MIGRATION_PLAN.md:425](docs/SHENMAY_MIGRATION_PLAN.md:425)) — polish + send. Must ship BEFORE 5c (localStorage) or 5f (WP plugin URL) because those become customer-visible. (v2.4.0 needed NO email — all changes were silent backend additions.)
2. **Phase 5c** — localStorage portal-token migration. Client-side auth-path change (medium-risk, separate isolated PR). TODO anchor at [client/src/lib/shenmayApi.js:41](client/src/lib/shenmayApi.js:41).
3. **Phase 5f** — WP plugin zip rename + nginx 301 + Hetzner artifact upload. TODO anchor at [client/src/components/shenmay/onboarding/Step4InstallWidget.jsx:171](client/src/components/shenmay/onboarding/Step4InstallWidget.jsx:171).
4. **Phase 5e** — WP plugin repo PR adding `[shenmay_widget]` shortcode alongside `[nomii_widget]`. Sibling repo, not this one.

### Non-obvious learning this session

- **Backwards-compat-helper pattern** (captured as wiki concept): any dual-form identifier rollout benefits from a shared helper module with parenthesised SQL-fragment generators + alias-aware column argument. Phase 8 sunset becomes a 1-line change instead of a 20-site sweep. Canonical example: [`server/src/constants/anonDomains.js`](server/src/constants/anonDomains.js). Feedback memory: `feedback_backwards_compat_helper.md`.
- **Sequenced `replace_all` for alias hazards** — `email NOT LIKE` is a substring of `cu.email NOT LIKE`. Do the aliased form FIRST, then the bare form. Order: `cu.email NOT LIKE` → `email NOT LIKE` → `cu.email LIKE` → `email LIKE`.
- **Release-flow branch-up-to-date enforcement** — after merging PR #1 of a batch, subsequent PRs get marked MERGEABLE=UNKNOWN / STATUS=BLOCKED until rebased against new main. Simple fix: `git rebase origin/main && git push --force-with-lease`. Then CI re-runs quickly (cached layers) and branch becomes CLEAN again.

Full vault writeup: [[projects/nomii/shenmay-phase5-bundle-a-apr-22-2026]].

---

## Previous: 2026-04-22 late-evening (3 PRs OPEN state — merged this morning as v2.4.0)

### Phase 5 bundle A (PR #47) — what shipped

All four sub-items are additive dual-emit / dual-accept — zero customer-action, no breakage risk.

- **5a — Webhook `X-Shenmay-Signature`** emitted alongside existing `X-Nomii-Signature` (identical HMAC value). Customer receivers pinning on either header keep verifying. Portal UI copy at `ShenmaySettings.jsx:913, 1131` updated.
- **5b — `shenmay_da_` API key prefix** dual-accept. New keys issued as `shenmay_da_*`; existing `nomii_da_*` keys keep authenticating. Prefix-length handled dynamically (9→17 vs 11→19).
- **5d — `@visitor.shenmay` anon email domain** for new widget sessions. **New `server/src/constants/anonDomains.js`** is the single source of truth with helpers (`anonEmailNotLikeGuard(col)`, `anonEmailLikeMatch(col)`, `anonEmailIlikeMatch(col)`, `isAnonVisitorEmail(email)`). **20 hand-written call sites across 6 files** migrated to the helpers — biggest risk chunk of the PR, mitigated by the helper pattern.
- **5g — `shenmay-products-template.csv`** (one-line filename flip in `Step2Products.jsx:152`).

### Housekeeping cleared this session

- **Stripe product cards** — Direction B replacements for the 3 legacy dark-gradient Nomii cards (paper/ink/teal editorial). Austin uploaded the rendered PNGs to Stripe dashboard; source SVGs committed via PR #46.
- **GH PAT leak (Apr 20 session)** — memory claimed "stripped mid-session"; reality was the PAT was still fully embedded in `~/ponten-solutions/.git/config` on pontenprox. Stripped + switched remote to SSH (`git@github.com:jafools/ponten-solutions.git`, verified auth). Austin revoked the old PAT at github.com.
- **Ponten-solutions stash** — memory said "stashed during PR #3, still to pop". Actually empty + clean, already resolved in a prior session.
- **ITU filing priority** — Austin corrected: ITU is **dead last** in the rebrand sequence, not parallel. Saved as feedback memory `feedback_itu_filing_last.md`.

### What's still on Nomii (Phase 5 remaining + Phases 6-9)

Not in this session's 3 PRs — will be separate sub-PRs:
- **5c** localStorage portal token migration (auth-path-isolated)
- **5e** WP plugin shortcode (sibling plugin repo)
- **5f** WP plugin zip rename + nginx 301 (Hetzner artifact upload needed)
- **Customer-comms email** — template at [docs/SHENMAY_MIGRATION_PLAN.md:425](docs/SHENMAY_MIGRATION_PLAN.md:425); needs polish + send. Must ship before 5c or 5f (but 5a+5b+5d+5g in PR #47 are silent backend additions, no email needed yet)

### Non-obvious learning this session

- **Backwards-compat-helper pattern** (captured as wiki concept in the vault): any dual-form identifier rollout benefits from a shared helper module with parenthesised SQL-fragment generators + alias-aware column argument. Phase 8 sunset becomes a 1-line change instead of a 20-site sweep.
- **Sequenced `replace_all` for alias hazards** — `email NOT LIKE` is a substring of `cu.email NOT LIKE`. Do the aliased form FIRST, then the bare form. Order: `cu.email NOT LIKE` → `email NOT LIKE` → `cu.email LIKE` → `email LIKE`.
- **Memory drift** — the PAT-is-stripped claim was wrong. 5-second verification (`ssh pontenprox "cat ~/ponten-solutions/.git/config"`) surfaced the actual state. Double-check stateful claims before acting on them.

Full vault writeup: [[projects/nomii/shenmay-phase5-bundle-a-apr-22-2026]].

---

## Previous: 2026-04-22 late-evening (**v2.3.0 LIVE** — Phase 4 URL canon + Direction B visual port deployed to Hetzner)

Single huge session that landed both the Phase 4 migration and the full SaaS-app visual rebrand to match the Direction B marketing design. Merged, tagged, and deployed.

### What shipped

| PR | Commit | Title |
|---|---|---|
| [#42](https://github.com/jafools/nomii-ai/pull/42) | `408ef1e` | `feat(shenmay): Phase 4 — /shenmay/* route canon + SHENMAY_* env shim` |
| [#43](https://github.com/jafools/nomii-ai/pull/43) | `a1d400a` | `feat(shenmay): Direction B design system — tokens + Login reference page` (7 squashed commits, ~3.5k LOC changed) |

Tag: `v2.3.0` → GHCR rebuilt `:2.3.0` / `:stable` / `:latest` → Hetzner deployed via `IMAGE_TAG=2.3.0 docker compose pull … up -d`.

### Production state at session end

| | |
|---|---|
| Canonical SaaS URL | **https://shenmay.ai** (200) |
| Hetzner image | `ghcr.io/jafools/nomii-{backend,frontend}:2.3.0` |
| Git HEAD on Hetzner | `v2.3.0` (`a1d400a`) |
| `/shenmay/login` | 200 — new canonical |
| `/nomii/login` | 200 — client-side redirect to `/shenmay/login` (backward-compat) |
| `/api/health` | 200 |

### Phase 4 — what landed

- **Client routing:** canonical `/shenmay/*`, single backward-compat catch-all `<Route path="/nomii/*" element={<NomiiToShenmayRedirect />}/>` that rewrites deep path + query + hash
- **Server env shim:** `server/src/utils/env.js` with `envVar(suffix, fallback)` — `SHENMAY_<SUFFIX>` primary, `NOMII_<SUFFIX>` fallback + one-time deprecation warn. All 10 `process.env.NOMII_*` refs across 5 files migrated
- **Magic-link URLs:** flipped `/nomii/*` → `/shenmay/*` in `emailService` (6 templates), `licenseService`, `notificationService`, `license-checkout`, `portal`, `setup`, `seedSelfHostedTenant`
- **Default fallback URLs:** `nomii.pontensolutions.com` → `shenmay.ai` in 4 files; `middleware/security.js` keeps the legacy origin in `ALLOWED_ORIGINS` intentionally until Phase 8 sunset
- **Docker compose:** both `SHENMAY_*` + `NOMII_*` env vars exposed in `docker-compose.yml` + `docker-compose.selfhosted.yml`; `.env.example` updated with a documented SHENMAY section
- **Preserved on purpose:** `pontensolutions.com/nomii/license` external refs, Stripe product names (Austin UI task), Phase 5–7 identifiers (`X-Nomii-Signature`, `nomii_da_*`, container names, DB, filenames)

### Direction B visual port — what landed

**Tokens + primitives:**
- `client/src/styles/shenmay-tokens.css` — palette (ink `#1A1D1A` / paper `#F5F1E8` / teal `#0F5F5C` / mute / paper-deep / paper-edge), type scale (tight display tracking -0.045em, mono kickers 0.16em), surfaces (6px buttons/inputs, 12px cards, soft paper-edge borders)
- `client/src/components/shenmay/ui/ShenmayUI.jsx` — Kicker, Display, Lede, Field, Input, Select, Textarea, Button (primary/teal/ghost/linky/danger), Card, Notice (teal/success/warning/danger), Divider, PageShell
- `client/src/components/shenmay/ShenmayWordmark.tsx` — split "Shen · may AI" wordmark ported pixel-identical from the marketing handoff
- `client/src/components/shenmay/ShenmaySeal.tsx` — circular editorial stamp ("SHENMAY AI · KÄNN MIG · KNOW ME")
- New favicon at `client/public/favicon.svg` (S·m monogram)

**Auth pages (7 surfaces — full rewrites):**
- Login: two-column with wordmark + seal + italic pull quote "An agent that remembers. / One customer at a time." + Soul/Memory/Control rhythm strip
- Signup: two-column with 2-col form grid, 4-bar mono password-strength meter, consent-checkbox trio; CheckEmail state polished
- VerifyEmail: centered paper with 4 states (loading / no-token / success / error)
- ResetPassword: two-column with Figure 02 "Choose a strong password." panel
- AcceptInvite: single-column featured card
- LicenseSuccess: ink install-command block + copy button + two-case next-steps
- Terms: editorial long-form, mono section numbers, italic "contract between us." heading

**Wizard shells:**
- Onboarding: paper sidebar with progress bar, step rail, user pill, mobile overlay, completion screen
- Setup (self-hosted first-boot): three-step editorial panel + stepped form

**Dashboard layout rewrite:**
- Paper-deep sidebar with ShenmayWordmark header, tenant pill (ink avatar + teal plan chip + usage meters with kicker labels), editorial nav with inset teal accent on active row, mono-uppercase badge chips
- Sticky blurred header, bell panel with kicker notifications, mobile menu
- Ink trial-limit banner

**12 dashboard pages polished:**
- Full rewrites: Overview, Plans, Concerns, Profile, Team, Customers
- Header + chat-bubble + chrome rewrites: Conversations, ConversationDetail, CustomerDetail
- Kicker-header polish: Tools, Settings, AnalyticsCharts

**6 onboarding step components:**
- StepApiKey: full Direction B rewrite
- Step1-4 + StepTools: kicker + italic display heading

**Other:**
- All dashboard page interiors + onboarding step internals tonally palette-flipped via sed pass (hex + rgba + tailwind tokens) before structural polish — no more dark-theme leftovers

### Deploy

```
git tag v2.3.0 → push → GHCR build (~6 min) →
ssh nomii@204.168.232.24 "cd ~/nomii-ai && git fetch --tags && git checkout v2.3.0 &&
  IMAGE_TAG=2.3.0 docker compose pull backend frontend &&
  IMAGE_TAG=2.3.0 docker compose up -d backend frontend"
```

All verified live.

### Austin's next-session priorities (queued)

1. **Stripe product-name rebrand in Stripe dashboard** — still Austin-only UI task
2. **GH PAT revocation** (deferred since Apr 21)
3. **E2E Playwright under shenmay.ai domain** — suite likely still hardcodes `nomii.pontensolutions.com`
4. **Phase 5** — backend identifier rename: `X-Nomii-Signature` dual-emit, `nomii_da_*` API key prefix, `nomii_portal_token` localStorage, `@visitor.nomii` anon domain, `[nomii_widget]` WP shortcode, `nomii-wordpress-plugin.zip` → `shenmay-wordpress-plugin.zip`. Customer comms email required BEFORE merge. Plan: `docs/SHENMAY_MIGRATION_PLAN.md`
5. **Phase 6** — Docker / GHCR / compose rename (coordinated with on-prem customers)
6. **`package-lock.json` sync commit on ponten-solutions** — stashed during PR #3, still to pop

### Still open from earlier sessions (unchanged)

- Live stranger walkthrough — SaaS signup
- Live stranger walkthrough — self-hosted install on a fresh VM
- UptimeRobot signup (closes audit #14)
- Off-host backup destination (Hetzner Storage Box)
- Published docs site at `docs.pontensolutions.com`

Full vault writeup: `[[projects/nomii/shenmay-phase4-and-direction-b-port-apr22-2026]]`.

---

## 2026-04-22 evening (marketing Direction B redesign + Nomii-string cleanup on ponten-solutions — nomii-ai code unchanged)

**Today's session was 100% on the `ponten-solutions` marketing repo** (the Lovable-managed sibling). No changes to the `nomii-ai` repo, no backend changes, no Hetzner touches, no staging refresh required. Production nomii-ai / shenmay.ai SaaS is still on `v2.1.0` (`bad9986`) — unchanged.

### What shipped (ponten-solutions)

| PR | Commit | Title |
|---|---|---|
| [#3](https://github.com/jafools/ponten-solutions/pull/3) | `34552a8` | **Closed unmerged** — hero-only swap, superseded by #4 once we saw the full Direction B design in claude.ai/design |
| [#4](https://github.com/jafools/ponten-solutions/pull/4) | `19fbe4a` | `feat(shenmay): full Direction B editorial redesign of product page` — all 6 chapters, +1188/−485 |
| [#5](https://github.com/jafools/ponten-solutions/pull/5) | `aca4eae` | `fix(shenmay): rename visible Nomii strings on rest-of-site pages` — Products/Index/About/Contact/Footer, +10/−10 |
| [#6](https://github.com/jafools/ponten-solutions/pull/6) | `f07d386` | `fix(shenmay): rebrand remaining visible Nomii text on /buy, portal, widget` — widget persona renamed "Nomii" → "Shenmay", +15/−15 |

3 Lovable Publishes. Final bundle-hash verify on `https://pontensolutions.com/products/nomii-ai` (bundle `/assets/index-DY7BofG8.js`): `NomiiAI: 0`, `Shenmay AI: 6`, `Powered by NomiiAI: 0`.

Full vault writeup: `[[projects/nomii/shenmay-marketing-direction-b-apr22-2026]]`.

### What's on Nomii by design (still preserved, Phase 4 renames)

Unchanged from Apr 21 + today:
- `/nomii/*` URL routes (dashboard + signup + license)
- `/products/nomii-ai` route URL on ponten-solutions (marketing)
- `NomiiAI.tsx`, `NomiiChatWidget.tsx`, `NomiiDashboardLayout.jsx`, `NomiiAuthContext.jsx` etc. filenames + component names
- `X-Nomii-Signature` webhook HMAC header
- `nomii-db` / `nomii-backend` / `nomii-frontend` container names
- `nomii_ai` Postgres DB + `nomii` user
- `NOMII_*` env vars (Phase 4 shim, Phase 8 remove)
- `nomii_da_` API key prefix
- `@visitor.nomii` anon email domain
- `nomii-wordpress-plugin.zip` download URL
- `ghcr.io/jafools/nomii-*` image names
- `nomiiai-icon.svg` + `nomiiai-full-dark.svg` assets on disk (imports now point at `shenmay-*` equivalents, but old files stay for Phase 4 removal)
- Cloudflare tunnel `knomi-ai` (shared with Lateris, untouchable)

### Production state (unchanged today)

| | |
|---|---|
| Canonical SaaS URL | **https://shenmay.ai** (200) |
| Legacy SaaS URL | https://nomii.pontensolutions.com (selective 301) |
| Hetzner image | `ghcr.io/jafools/nomii-{backend,frontend}:2.1.0` (`:stable` alias) |
| Git HEAD on Hetzner | `v2.1.0` (`bad9986`) |
| Marketing site | `pontensolutions.com` — now on bundle `index-DY7BofG8.js` (Direction B + zero NomiiAI) |

### Austin's next-session priorities (continuing)

1. **Phase 4 of Shenmay migration** — URL route renames `/products/nomii-ai` → `/products/shenmay-ai` + `/nomii/*` → `/shenmay/*` (dual-mount), `NomiiAI.tsx` → `ShenmayAI.tsx`, env var shims (`SHENMAY_*` preferred, `NOMII_*` deprecated fallback), Stripe return URL + email template updates. ~3 days per `docs/SHENMAY_MIGRATION_PLAN.md`
2. **GH PAT revocation** (deferred since Apr 21)
3. **E2E test pass under shenmay.ai domain** — Playwright suite likely still hardcodes `nomii.pontensolutions.com`
4. **Stripe product-name rebrand in Stripe dashboard** — flagged Apr 20/21, still TODO
5. **`package-lock.json` sync commit on ponten-solutions** — stashed locally during PR #3 to keep that diff clean; Austin can pop the stash and commit separately (`cd ~/Documents/Work/ponten-solutions && git stash pop && git add package-lock.json && commit -m "chore(deps): sync package-lock with package.json"`)
6. **Corp site redesign via claude.ai/design** — still Austin-driven, out of scope for Claude here

### Still open from earlier sessions (unchanged)

- Live stranger walkthrough — SaaS signup
- Live stranger walkthrough — self-hosted install on a fresh VM
- UptimeRobot signup (closes audit #14)
- Off-host backup destination (Hetzner Storage Box)
- Published docs site at `docs.pontensolutions.com`

---

## 2026-04-21 afternoon (v2.1.0 live — `shenmay.ai` canonical, Full (Strict) SSL, marketing redesign shipped)

Phase 3 of the Shenmay rebrand shipped end-to-end in one sitting. Full writeup at `[[projects/nomii/shenmay-phase3-domain-and-redesign-apr21-2026]]`.

### Production state at session end

| | |
|---|---|
| Canonical SaaS URL | **https://shenmay.ai** |
| Legacy SaaS URL | https://nomii.pontensolutions.com (selective 301, see below) |
| Hetzner image | `ghcr.io/jafools/nomii-{backend,frontend}:2.1.0` (via `:stable` alias) |
| Git HEAD on Hetzner | `v2.1.0` (commit `bad9986`) |
| Cloudflare SSL mode | **Full (Strict)** on `shenmay.ai` zone |
| Origin CA cert | `/etc/ssl/shenmay/origin.{pem,key}` — `*.shenmay.ai` + `shenmay.ai`, 15yr (Apr 2026 → Apr 2041) |
| Marketing site | pontensolutions.com redesigned for Shenmay product pages (bundle `index-DEbNZkQ7.js`) |

### What shipped

**nomii-ai [PR #40](https://github.com/jafools/nomii-ai/pull/40)** → squash `bad9986` → `git tag v2.1.0` → deployed to Hetzner.
- `config/nginx/prod.conf` — 5 server blocks: `:80 default_server _` unchanged; `:443 shenmay.ai` canonical (new cert); `:443 www.shenmay.ai` → 301 to apex; `:443 nomii.pontensolutions.com` SELECTIVE 301 (dashboard paths redirect, `/api/*` + `/embed.js` + `/widget.html` + `/downloads/*` keep serving to protect existing customer widget embeds, Stripe webhooks, WordPress plugin callbacks); `:443 default_server _` safety net.
- `docker-compose.prod.override.yml` — added `/etc/ssl/shenmay:/etc/ssl/shenmay:ro` bind mount on frontend.
- `server/src/middleware/security.js` — `https://shenmay.ai` + `https://www.shenmay.ai` added to `ALLOWED_ORIGINS`.

**Cloudflare (via Chrome MCP):**
- A records for `shenmay.ai` + `www.shenmay.ai` → `204.168.232.24`, proxied (orange cloud)
- "Always Use HTTPS" enabled
- Origin CA cert issued for `*.shenmay.ai` + `shenmay.ai`, RSA 2048, 15-year validity
- SSL/TLS = **Full (Strict)** — **flipped AFTER the deploy** because Strict rejects SAN mismatch, so it had to wait until nginx was serving the right cert for SNI=shenmay.ai.

**Hetzner:**
- `/etc/ssl/shenmay/` created, cert + private key pasted directly by Austin via `sudo tee` heredoc (Claude never saw the key material)
- Cert sanity check via `openssl x509 -noout -subject -ext subjectAltName` confirmed SANs + validity
- `.env` updated: `APP_URL` + `FRONTEND_URL` + `PORTAL_URL` + `STRIPE_PORTAL_RETURN_URL` → `https://shenmay.ai` (STRIPE return URL keeps `/nomii/dashboard/plans` path — Phase 4 renames paths)
- `git checkout v2.1.0 && IMAGE_TAG=2.1.0 docker compose pull backend frontend && docker compose up -d backend frontend` — clean recreate with new volume mount

**ponten-solutions [PR #1](https://github.com/jafools/ponten-solutions/pull/1) (redesign) + [PR #2](https://github.com/jafools/ponten-solutions/pull/2) (wordmark + navbar fix)** → both merged, both Published via Lovable, both verified via bundle-hash grep.
- New `.shenmay-scope` utility class + `--shenmay-*` CSS tokens in `index.css`. Corp LOCKED tokens untouched — follows LaterisAI pattern for product-specific palettes.
- **Aesthetic:** Scandinavian restraint — Inter 500 (not bold), warm paper `#FAFAF6` bg, teal `#0F5F5C` dot as the signature mark (used as literal punctuation: "AI that knows your customers·"), hairline dividers, zero gradients / orbs / drop-shadows, generous whitespace, Swedish "känn mej" story in the copy.
- `NomiiAI.tsx` (10 sections → 7, 1048 LoC → ~500), `BuyNomiiLicense.tsx` (all Stripe checkout + modal logic preserved verbatim), `SelfHostedNomii.tsx` (`INSTALL_CMD` + clipboard handler preserved). FAQ JSON-LD schema refreshed with Shenmay copy.
- `Navbar.tsx` fixed: renamed internal flag `isNomiiPage` → `isShenmayPage`, added `/nomii/license` to the match (was missing), badge now renders `shenmay-icon.svg` + "Shenmay·" text with teal dot.
- `App.tsx` `APP_URL` constant flipped to `https://shenmay.ai` so the `/nomii/*` catch-all redirect forwards to the new apex.

### Verification (all live)

```
https://shenmay.ai                                  200
https://www.shenmay.ai                              301 → https://shenmay.ai/
https://nomii.pontensolutions.com/                  301 → https://shenmay.ai/
https://nomii.pontensolutions.com/nomii/dashboard   301 → https://shenmay.ai/nomii/dashboard (path preserved)
https://nomii.pontensolutions.com/embed.js          200 (preserved for widget embeds)
https://nomii.pontensolutions.com/api/health        200 (preserved for webhooks)
https://shenmay.ai/api/health                       200
```

### Secondary findings

- **GH PAT leaked in `ponten-solutions`'s git remote URL on pontenprox.** Remote URL stripped mid-session (`git remote set-url`) but the token itself is still live at github.com/settings/tokens — Austin deferred revocation.
- **Pre-existing Stripe config bug** — Hetzner `.env` had `STRIPE_PORTAL_RETURN_URL=https://app.pontensolutions.com/...` (a stale subdomain that 301s at Cloudflare but is not a real origin for us). Fixed mid-session to `https://shenmay.ai/nomii/dashboard/plans`.
- **`shenmay-full-dark.svg` vs `shenmay-full-light.svg`** — the suffix refers to the CONTEXT it's designed for, NOT the wordmark colour. `-dark.svg` = white text for dark bg. `-light.svg` = dark text for paper bg. Caught when the hero wordmark rendered invisible on paper; fixed with 3-line import swap.
- **Minor `IMAGE_TAG` drift** — Austin's backend bounce after the env update picked up `:stable` (currently `== :2.1.0`, fine today). The canonical release runbook pins `IMAGE_TAG=X.Y.Z` explicitly; worth enforcing if this drifts again.

### Austin's explicit follow-up priorities for next session

1. **More hunting for Nomii names** across the codebase. Phase 1's 145-file sweep was thorough but keep finding leftovers (marketing STRIPE_PORTAL_RETURN_URL this session, Stripe product display names flagged last session).
2. **Full E2E test pass on both SaaS and on-prem** under the new shenmay.ai domain. Playwright suite at `tests/e2e/` likely still hardcodes `nomii.pontensolutions.com`.
3. **Pontensolutions corp site redesign** via claude.ai/design (Austin driving, out of scope for Claude here).
4. **GH PAT revocation** (deferred from this session).

### Still open from earlier sessions (unchanged)

- Live stranger walkthrough — SaaS signup
- Live stranger walkthrough — self-hosted install on a fresh VM
- UptimeRobot signup (closes audit #14)
- Off-host backup destination (Hetzner Storage Box)
- Published docs site at `docs.pontensolutions.com`
- Stripe product-name rebrand in Stripe dashboard (flagged Apr 21 morning, still TODO)

---

## 2026-04-21 morning (v2.0.0 live — Shenmay AI rebrand shipped to customers; Hetzner on `:2.0.0`)

This entry covers the morning session on 2026-04-21. **v2.0.0 shipped end-to-end.** Nomii AI → Shenmay AI is now live to customers on Hetzner SaaS, and `:stable` + `:latest` both pin to `v2.0.0` so on-prem customers pull the rebranded build on their next `docker compose pull`. Full vault writeup at `[[projects/nomii/shenmay-phase2-v2-release-apr21-2026]]`.

### Production state at session end

| | |
|---|---|
| Hetzner SaaS | https://nomii.pontensolutions.com |
| Image | `ghcr.io/jafools/nomii-backend:2.0.0` + frontend `:2.0.0` |
| Git HEAD | `v2.0.0` (commit `73f5cc1`) |
| Title | `<title>Shenmay AI</title>` + OG meta both Shenmay AI |
| Widget | `<title>Shenmay AI Chat</title>` + `Powered by Shenmay AI` styled footer on both the in-chat + wait-screen |
| Backend startup log | `🧠 Shenmay AI server running on http://localhost:3001` |

### What shipped

**PR #35 — migration plan rewrite**
- [PR #35](https://github.com/jafools/nomii-ai/pull/35) — [docs/SHENMAY_MIGRATION_PLAN.md](docs/SHENMAY_MIGRATION_PLAN.md) rewritten to reflect Phase 1 shipped + Phases 2-9 forward roadmap.

**PR #36 — 3 user-visible Nomii strings missed by Phase 1**
- [PR #36](https://github.com/jafools/nomii-ai/pull/36) — [server/public/widget.html:520](server/public/widget.html:520) "Powered by NomiiAI" on the support-at-capacity wait screen (in-chat footer was already correct, wait-screen wasn't); [server/src/middleware/subscription.js:72](server/src/middleware/subscription.js:72) trial-expired blocker `'Upgrade to keep using NomiiAI.'`; [server/package.json:4](server/package.json:4) description `"Nomii AI — Personalized retirement planning agent backend"` (stale on both brand AND pitch).

**PR #37 — light-theme wordmark SVG**
- [PR #37](https://github.com/jafools/nomii-ai/pull/37) — Phase 1 shipped only `shenmay-full-dark.svg` (white text for dark bg). Two pages on `#FAFAFA` light bg imported it → white-on-white invisible wordmark, user saw `← [nothing] •`. New [client/src/assets/shenmay-full-light.svg](client/src/assets/shenmay-full-light.svg) with dark text `#111118` + Stockholm fjord teal `#0F5F5C`, matching `Company Logos/shenmay_wordmark_light.svg`. [ShenmayTerms.jsx](client/src/pages/shenmay/ShenmayTerms.jsx) + [ShenmayVerifyEmail.jsx](client/src/pages/shenmay/ShenmayVerifyEmail.jsx) switched to the new variant.

**PR #38 — webhook endpoint placeholder**
- [PR #38](https://github.com/jafools/nomii-ai/pull/38) — [ShenmaySettings.jsx:937](client/src/pages/shenmay/dashboard/ShenmaySettings.jsx:937) Settings → Webhooks → Add webhook Endpoint URL placeholder still read `https://your-server.com/hooks/nomii`, spreading the old brand as a suggested hook-path convention to new customers setting up webhook receivers on their own servers. Renamed to `/hooks/shenmay`.

### Full dashboard walkthrough on staging (authenticated)

Signed up a throwaway test tenant (`shenmay-phase2-e2e-20260421@nomii.local`) on staging, pulled the `email_verification_token` from `tenant_admins` via SSH + psql, navigated `/nomii/verify/<token>` to JWT-auth, then walked every dashboard page. All 9 menu pages + onboarding wizard + accept-invite verified clean. Live invite-email send tested (SMTP off on staging by design; URL generation verified in backend log).

Test tenant cleaned up at end of session: `BEGIN; DELETE FROM subscriptions WHERE ...; DELETE FROM tenant_admins WHERE ...; DELETE FROM tenants WHERE ...; COMMIT;` — 1 sub + 2 admins + 1 tenant row removed.

### What's still on Nomii by design (Phase 4-8 back-compat)

Grep-verified to not fix these until their planned phase:
- `/nomii/*` URL routes (Phase 4)
- `X-Nomii-Signature` HMAC header (Phase 5 — customer receivers verify this exact name)
- `nomii-{db,backend,frontend}` Docker container names (Phase 6)
- `nomii_ai` Postgres DB + `nomii` DB user (Phase 7)
- `NOMII_*` env vars (Phase 4 add shim, Phase 8 remove)
- `nomii_da_` API key prefix (Phase 5)
- `@visitor.nomii` anon email domain (Phase 5)
- `nomii_portal_token` localStorage (Phase 5)
- `nomii-wordpress-plugin.zip` URL (Phase 5 redirect)
- `nomii.pontensolutions.com` subdomain (primary until Phase 3 `shenmay.ai` switchover)
- `service: "nomii-ai"` in `/api/health` (customer receivers may parse)
- Cloudflare tunnel `knomi-ai` (shared with Lateris, untouchable)

Webhook outbound is **already Shenmay-branded**: `User-Agent: Shenmay-Webhook/1.0`, `User-Agent: Shenmay-Notifications/1.0`, new `X-Shenmay-Event` header alongside preserved `X-Nomii-Signature`.

### Open for Austin (config, not code)

1. **Stripe product display names** — rename `Nomii AI Starter` → `Shenmay AI Starter` in Stripe **test mode** dashboard (verified stale on staging's Plans & Billing page). Then review Stripe **live mode** for every tier (Starter / Growth / Professional / Enterprise) and rename any that read "Nomii AI". ~10 min in Stripe dashboard.

### Launch blockers (remaining)

1. ~~Stripe test mode on staging~~ **CLOSED Apr 20 afternoon**
2. Live stranger walkthrough — SaaS signup
3. Live stranger walkthrough — self-hosted install on a fresh VM
4. UptimeRobot signup (closes audit #14)
5. Off-host backup destination (Hetzner Storage Box)
6. Published docs site at `docs.pontensolutions.com`
7. Stripe product-name rebrand in Stripe dashboard (new, this session)

### Next session candidate: Phase 3 — canonical domain switchover to `shenmay.ai`

Plan at `docs/SHENMAY_MIGRATION_PLAN.md` Phase 3. ~1 week:
1. Cloudflare DNS: A `shenmay.ai` → `204.168.232.24`, proxied
2. Cloudflare Origin CA cert for `*.shenmay.ai` + `shenmay.ai` on Hetzner `/etc/ssl/shenmay/`
3. nginx `server_name` block for `shenmay.ai` alongside the existing `nomii.pontensolutions.com` block
4. Update `APP_URL=https://shenmay.ai` on Hetzner `.env`, restart backend so email links use the new domain
5. 301 redirect the old subdomain
6. Marketing site (`ponten-solutions` repo, Lovable-managed): rename path `/products/nomii-ai` → `/products/shenmay-ai`, commit + **Austin clicks Publish in Lovable** (manual step, verify via bundle-hash grep per [[wiki/concepts/lovable-deploy-pipeline]])

### Gotchas captured this session

1. **Chrome MCP screenshot fails on chrome-extension:// URLs.** Happens transiently right after a navigation — next action usually succeeds. Don't retry the screenshot in a loop.
2. **Staging DB pluck is the fast signup-walkthrough path.** Staging has SMTP intentionally disabled. Sign up → query `tenant_admins.email_verification_token` → `/nomii/verify/<token>` gets JWT. Clean up tenant rows after via `DELETE FROM subscriptions/tenant_admins/tenants`.
3. **Trial subscription hard-caps `max_agents = 1`.** Invite-Agent button disabled on any fresh trial tenant until `UPDATE subscriptions SET max_agents = 3 WHERE tenant_id = ...`. Worth remembering for future authenticated E2Es.
4. **Phase 1 shipped only the dark-theme logo SVG.** The light-bg page bug (#37) was a Phase 1 gap — a file-contents sweep PR didn't do theme-contrast visual verification. Lesson for future big-sweep PRs: sweep file contents + also click through at least one page on each background theme.

### Memory housekeeping this session

- **Updated:** `project_shenmay_rebrand.md` — moved from "in flight" → "Phase 1+2 LIVE, Phase 3 next". Updated back-compat list + added shipped artifacts.
- **No new memories needed** — the gotchas are session-local and already captured in the vault writeup.

---

## Previous: 2026-04-20 afternoon (v1.1.6 live — Stripe test mode + Managed-AI-Enterprise-only + logo link; Hetzner on `:1.1.6`)

This entry covers the afternoon session on 2026-04-20. **Three patch tags shipped** end-to-end, plus **two marketing-site commits Published via Lovable**, plus one clean Stripe **test-mode E2E** (signup → checkout with card `4242` → webhook → DB flip) — unblocking a launch-blocker that had been sitting open for weeks. Full vault writeup at `[[projects/nomii/stripe-test-mode-plus-managed-ai-rewrite-apr20-2026]]`.

### Production state at session end

| | |
|---|---|
| Hetzner SaaS | https://nomii.pontensolutions.com |
| Image | `ghcr.io/jafools/nomii-backend:1.1.6` + frontend `:1.1.6` |
| Git HEAD | `v1.1.6` (commit `65439a1`) |
| Marketing site | `pontensolutions.com` serving bundle `index-DN5Z4JIF.js` (both Lovable commits Published + verified) |

### What shipped

**v1.1.4 — Stripe env-driven + Plans UX + bug fixes**
- [PR #28](https://github.com/jafools/nomii-ai/pull/28) — `/api/config` emits `stripe.{publishableKey,pricingTableId}` from env vars; [NomiiPlans.jsx](client/src/pages/nomii/dashboard/NomiiPlans.jsx) reads them at runtime with hardcoded live keys as fallback. Staging can now run test mode from the same GHCR image as prod — preserves the byte-identical-build rule.
- [PR #29](https://github.com/jafools/nomii-ai/pull/29) — "Current plan + next upgrade" nudge card above the Stripe pricing table on `/nomii/dashboard/plans`.
- [PR #30](https://github.com/jafools/nomii-ai/pull/30) — Fixed two UI bugs: "Covenant Trust" (a real customer name) leaked into Settings → Email Templates placeholders (swapped to Acme Co); Team page said "0 / 3 agents on trial plan" for starter tenants because of a flat `|| 3` fallback + missing `max_agents` on onboard register INSERT. Server now falls back to `PLAN_LIMITS[plan].max_agents` when the DB column is NULL.

**v1.1.5 — Managed AI is Enterprise-only**
- [PR #31](https://github.com/jafools/nomii-ai/pull/31) — Flipped Growth + Professional `managed_ai: false` in [server/src/config/plans.js](server/src/config/plans.js), [server/src/routes/portal.js](server/src/routes/portal.js) `/api/portal/plans` + admin set-plan defaults, and updated the UpgradeNudge delta copy. Paired with marketing commit [ponten-solutions@82ab2b7](https://github.com/jafools/ponten-solutions/commit/82ab2b7) dropping "Managed AI included/available" from Growth + Professional cards on `/nomii/license` and `/products/nomii-ai`. Existing Growth/Pro tenants with `managed_ai_enabled=true` keep it until their next plan flip — no silent mid-period downgrade.

**v1.1.6 — Logo → marketing-site link**
- [PR #32](https://github.com/jafools/nomii-ai/pull/32) — Wraps the NomiiAI + "by Pontén Solutions" logo stack on the 3 pre-auth pages (signup / login / reset-password) in an anchor to `pontensolutions.com`. Users now have a way back; post-auth dashboards already have their own nav.

**Marketing site (ponten-solutions) — pushed + Lovable-Published**
- Commit `82ab2b7` — Self-Hosted pricing CTAs on `/nomii/license` redirect to `/nomii/self-hosted` (installer page) instead of opening a Stripe checkout modal, so trial-first funnel. Also drops Managed AI from Growth + Pro marketing cards (matches the backend change above).

### Stripe test mode on staging (launch-blocker #1 CLOSED)

All 5 `STRIPE_*` env vars are now live on staging's `/root/nomii-staging/.env` (test mode: `sk_test_…`, `pk_test_…`, `whsec_hOkX…`, `prctbl_1TODCv…`, `price_1TODAr…` Starter). The staging compose file `docker-compose.staging.yml` was updated to forward the 3 new env vars (was previously only forwarding `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`). Prod keeps its live keys via the hardcoded fallback in NomiiPlans.jsx — zero prod env changes needed. End-to-end test with card `4242 4242 4242 4242` verified: signup → JWT → plans page → subscribe → Stripe-hosted checkout → webhook fires → `subscriptions` row flipped to `plan=starter, status=active, max_customers=50, max_messages_month=1000`. Test tenant deleted post-run; Stripe test subscription canceled.

### Gotchas learned this session

1. **Staging `.env` was inheriting prod's LIVE `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`** before this session — replaced with test-mode values and backed up at `.env.backup-20260420-pre-test-mode`. Worth auditing other secret env vars on staging to check for similar drift.
2. **`docker-compose.staging.yml` only forwards env vars explicitly named in the backend service's `environment:` block.** Adding to `.env` alone is silent no-op. Check both when wiring new vars.
3. **MCP Chrome tool `form_input` doesn't trigger React's synthetic `onChange`** — React state stays empty even though the DOM value is set. Use `javascript_tool` to invoke `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)` + dispatch `input` + `change` events to make React notice.
4. **MCP blocks all interactions with `checkout.stripe.com`** (live AND test). User has to fill the card form themselves — unavoidable for SaaS checkout E2E.
5. **Stripe pricing-table web component is a shadow-DOM iframe from `js.stripe.com`** — coordinate clicks work, but `ref`-based clicks through the MCP often don't reach the iframe.

### What's NOT done (deliberately deferred)

| Item | Why deferred |
|---|---|
| Force-migrate existing Growth tenants from `managed_ai_enabled=true` → `false` | Would silently downgrade paying customers mid-period. They keep what they bought; next plan flip resets. |
| Add Growth + Professional test products in Stripe test mode | Austin: "if this works the others should work right?" — same code path, trust the pattern. |
| Split `portal.js` (still 3,750+ LOC) | Same reasoning as prior session — real refactor risk, separate slot. |
| Playwright against staging | Same reasoning. Local Playwright still auth-fails (no TEST_ADMIN seed in dev DB). |
| Rotate the `sk_test_` key pasted in chat | Austin task — takes 10 sec in Stripe dashboard → test/apikeys → Roll key. |

### Launch blockers (remaining)

1. ~~Stripe test mode on staging~~ **CLOSED this session ✓**
2. Live stranger walkthrough — SaaS signup
3. Live stranger walkthrough — self-hosted install on a fresh VM
4. UptimeRobot signup (closes audit #14)
5. Off-host backup destination (Hetzner Storage Box)
6. Published docs site at `docs.pontensolutions.com`

### Memory housekeeping this session

- Nothing added/removed. Existing memories still accurate. One candidate for a new memory: the "form_input doesn't fire React onChange" finding — saving as `feedback_chrome_mcp_react_events.md`.

---

## Previous: 2026-04-20 (v1.1.3 live — PII coverage closed + audit cleanup; Hetzner on `:1.1.3`)

This entry covers the long session that opened 2026-04-19 evening (right after the v1.1.0 black-box E2E) and rolled into 2026-04-20 early morning. Three patch tags shipped end-to-end through the release flow with zero rollbacks. Full vault writeup at `[[projects/nomii/pii-completion-and-audit-cleanup-apr19-20-2026]]`.

### Production state at session end

| | |
|---|---|
| Hetzner SaaS | https://nomii.pontensolutions.com |
| Image | `ghcr.io/jafools/nomii-backend:1.1.3` |
| Git HEAD | `v1.1.3` (commit `9d35046` + the v1.1.3 tag) |
| `:stable` on GHCR | now points at v1.1.3 |
| `pii_tokenization_enabled` | TRUE for all tenants (default from migration 031, owner can toggle in `Settings → Privacy`) |
| Migration row cleanup | verified — `015b_*` row scrubbed from `schema_migrations`, `032_*` recorded |

### What shipped

**v1.1.1 — close CSV-import leak + delete zombie routes**
- [PR #20](https://github.com/jafools/nomii-ai/pull/20) — tokenize CSV-import sample rows + Privacy Policy §6.1 update. Two new regression tests for the JSON.stringify(headers + sample_rows) payload shape.
- [PR #21](https://github.com/jafools/nomii-ai/pull/21) — remove 7 pre-portal route files (chat, conversations, customers, advisors, flags, tenants, customTools) + their mounts. **−1,647 LOC.** Gated on a 7-day Hetzner log grep (zero hits across both backend + frontend nginx logs).

**v1.1.2 — PII closure + owner toggle UI**
- [PR #22](https://github.com/jafools/nomii-ai/pull/22) — prune 4 helpers orphaned by the v1.1.1 delete: `engine/toolConfigurator.js` (whole file), `requireCustomerOwnership`, `sendFlagNotificationEmail`, `listAllTools`. **−321 LOC.**
- [PR #23](https://github.com/jafools/nomii-ai/pull/23) — tokenize the second remaining bare-Anthropic call: `/api/portal/products/ai-suggest` (scrapes website HTML or eats free-text description). Two more regression tests (now 46/46 unit suite).
- [PR #24](https://github.com/jafools/nomii-ai/pull/24) — owner-only PII toggle UI on the existing tenant Settings page. New backend route `PUT /api/portal/settings/privacy` (owner-role-gated, audit-logged on every flip). UI section hidden client-side for non-owners. Default ON (matches migration 031).

**v1.1.3 — audit cleanup**
- [PR #25](https://github.com/jafools/nomii-ai/pull/25) — rename migration `015b_*` → `032_*` to fit `NNN_*.sql` convention. The new file's first statement is `DELETE FROM schema_migrations WHERE filename = '015b_seed_covenant_trust_tools.sql'` so Hetzner's orphan row gets cleaned on first run. Idempotent on fresh DBs. **Verified end-to-end on prod** — `015b_*` row gone, `032_*` recorded.
- [PR #26](https://github.com/jafools/nomii-ai/pull/26) — finish knomi → nomii rename in self-hosted compose + helper scripts (`docker-compose.selfhosted.yml`, `scripts/migrate.sh`, `scripts/backup.sh`). Safe because there are no live on-prem customers running the legacy `knomi` DB right now. Cloudflare tunnel `knomi-ai` and Proxmox docker network `knomi-ai_default` intentionally NOT touched (real infra, also serve Lateris).

### Audit progress

The `docs/AUDIT-2026-04-17.md` open list was 3 actionable items at session start (#5, #7, #15). All three closed. Remaining items are:
- **#14 LOW** — UptimeRobot signup (Austin task, ~5 min in dashboard)
- **#16 LOW/INFO** — `:latest` pinning, "no fix needed"
- **3 INFO items** — positive observations, no action

### What's NOT done (deliberately deferred for next session)

| Item | Why deferred |
|---|---|
| `portal.js` split (3,750+ LOC) | Pure tech debt, real refactor risk. Needs a focused session with an architectural call signed off (split by URL prefix vs feature domain). |
| Playwright wired into CI | Local Playwright suite has 6 auth-related failures because dev DB lacks `TEST_ADMIN_*` seed rows. CI passes the same suite cleanly. Wiring into CI may surface fresh issues — needs its own debug slot. See `[[feedback_playwright_local_env]]` memory. |

### Launch blockers (your court — unchanged)

1. Stripe test mode on staging (~10 min in Stripe dashboard)
2. Live stranger walkthrough — SaaS signup
3. Live stranger walkthrough — self-hosted install on a fresh VM
4. UptimeRobot signup (closes audit #14)
5. Off-host backup destination (Hetzner Storage Box)
6. Published docs site at `docs.pontensolutions.com`

### Carried forward (still true)

- Hetzner backup cron runs 03:00 daily, log at `~/nomii-backup.log`
- Log rotation: 10MB × 5 = 50MB cap per container
- Staging auto-refresh every 5 min via `nomii-staging-refresh.timer` on Proxmox
- SaaS + on-prem byte-identical (both pull GHCR images)
- 48 tokenizer unit tests (was 42 at the start of v1.1.0) — `npm run test:unit`

### Memory housekeeping this session

- **Removed:** `project_pre_portal_routes_zombie.md` — obsolete after PR #21 delete
- **Added:** `feedback_playwright_local_env.md` — don't debug local Playwright auth failures unless explicitly asked
- **Added:** `reference_no_super_admin_ui.md` — there's no platform-admin UI in client; tenant controls go on NomiiSettings.jsx gated by `role='owner'`

---

## Previous: 2026-04-19 evening (PII tokenizer SHIPPED + E2E verified on prod — v1.1.0 live)

### Live E2E verification — PASSED

Black-box E2E run against `https://nomii.pontensolutions.com` using a
disposable test tenant. Full script preserved at [tests/pii_blackbox_e2e.sh](tests/pii_blackbox_e2e.sh)
for future regression checks.

**What the test did:**
1. Created a disposable test tenant + subscription + widget key
2. Started a widget session with a fake customer email
3. Sent one message with a full suite of fake PII (SSN, CC, email, DOB,
   bank account, full name "Diana Thornton")
4. Tailed the backend logs during the turn
5. Verified the response + logs + breach log
6. Cleaned up every row it created

**Results (all three green):**

| Check | Result |
|---|---|
| Detokenization — agent response coherent, no raw tokens visible to user | ✓ (agent replied "Hi Diana!" — 694 chars, no `[SSN_N]` / `[CC_N]` leaked through) |
| Backend logs — no raw PII (SSN, CC, email) in log stream | ✓ |
| `pii_breach_log` delta on clean input | ✓ (0 new rows) |

The agent's response is itself a proof-point: *"I don't actually store or
have access to sensitive personal information like SSNs, credit card numbers,
or bank account details for security reasons"* — which is truthful,
because after tokenization Claude only sees `[SSN_1]`, `[CC_1]`, etc. The
agent accurately reflects what it saw.

### Fixes applied during testing

None — the tokenizer passed E2E on the first real run. The script needed
three cosmetic fixes before it would work:

- Widget API key column is `VARCHAR(64)` — reduced `gen_random_bytes(32)`
  to `(20)` so `'e2e_' + 40 hex chars = 44` fits
- `subscriptions.max_messages_per_month` doesn't exist — correct column
  name is `max_messages_month`
- `psql -t -A` returns `INSERT 0 1` status after `RETURNING` value — split
  into separate INSERT + SELECT to get a clean single-value capture

### Artifacts shipped this session

| | |
|---|---|
| [PR #16](https://github.com/jafools/nomii-ai/pull/16) — merged | Privacy Policy — `docs/PRIVACY.md` |
| [PR #17](https://github.com/jafools/nomii-ai/pull/17) — merged | PII tokenizer feature (v1.1.0) |
| [PR #18](https://github.com/jafools/nomii-ai/pull/18) — merged | SESSION_NOTES wrap of first half |
| PR #19 — this session-wrap | E2E harness + evening notes |
| v1.1.0 tag + Hetzner deploy | GHCR `:1.1.0`, `:stable`, migration 031 applied |

### Still-true things (carried forward)

- v1.1.0 live on Hetzner. `ghcr.io/jafools/nomii-backend:1.1.0`
- All tenants default `pii_tokenization_enabled = true`
- Launch blockers unchanged: Stripe test mode on staging, live stranger
  walkthrough (SaaS + self-hosted), UptimeRobot signup

### New follow-ups noted this session

- Wire tokenizer into `portal.js:639` CSV import (admin path sends up to
  3 customer sample rows to Claude for header mapping — lower risk than
  chat but still a leak vector)
- Admin UI toggle for `pii_tokenization_enabled` (column exists, no UI)
- Presidio NER sidecar for free-text name detection beyond what
  `memory_file` structural hints cover
- Update `docs/PRIVACY.md` §6.1 to mention live tokenization explicitly

---

## Previous: 2026-04-19 midday (PII tokenizer SHIPPED — v1.1.0 live; Privacy Policy drafted)

First minor-version bump. Triggered by Austin asking "what does Anthropic
see with our API calls?" Shipped two PRs end-to-end through the release
flow in one session:

### PRs merged + tag cut

| | |
|---|---|
| [PR #16](https://github.com/jafools/nomii-ai/pull/16) — **MERGED** ([25b3077](https://github.com/jafools/nomii-ai/commit/25b3077)) | `docs/PRIVACY.md` — Shenmay-specific Privacy Policy, BYOK vs Managed AI controller/processor split explicit, "Anthropic does not train on API data" stated directly, EU-first residency posture. Prior `.docx` draft moved to `docs/legal/` out of root. |
| [PR #17](https://github.com/jafools/nomii-ai/pull/17) — **MERGED** ([9d4f5bd](https://github.com/jafools/nomii-ai/commit/9d4f5bd)) | Log-and-block PII tokenizer. Regulated identifiers (SSN, CC+Luhn, IBAN+mod97, phone, email, DOB, postcode, account) tokenized before every Anthropic call; names pseudonymized from structured `memory_file`; breach detector blocks outbound if residual PII remains. |
| **v1.1.0** tag | Pushed to GHCR (`:1.1.0`, `:1.1`, `:stable`, `:latest`), deployed to Hetzner, live |

### Deployment log (Hetzner, 2026-04-19 ~11:21 UTC)

```
=== git fetch + checkout v1.1.0                                    [✓]
=== migration 031 applied (tenants.pii_tokenization_enabled +
    pii_breach_log table)                                          [✓]
=== IMAGE_TAG=1.1.0 docker compose pull (backend + frontend)       [✓]
=== IMAGE_TAG=1.1.0 docker compose up -d (db healthy, backend+
    frontend recreated)                                             [✓]
=== verify
     /api/health (internal):  {"status":"ok"...}                   [✓]
     /api/health (public):    {"status":"ok"...}                   [✓]
     nomii-backend image:     ghcr.io/jafools/nomii-backend:1.1.0  [✓]
     git HEAD:                v1.1.0                                [✓]
     pii_breach_log table:    7 columns present                    [✓]
     pii_tokenization_enabled: TRUE for all 5 tenants              [✓]
```

### The marketing story

`docs/marketing/PII-PROTECTION.md` has:
- One-sentence claim: *"Shenmay never sends your customers' regulated personal identifiers to Anthropic. Names are pseudonymized, SSNs and account numbers are tokenized, and a second-pass breach detector blocks any request that still contains unredacted PII."*
- Three-line pitch for slide decks
- Five-bullet compliance sheet for DPA attachments
- Prospect Q&A, detector list, deliberately-not-tokenized list

### Rollout posture

- Default ON via migration 031 (`DEFAULT TRUE` on `tenants.pii_tokenization_enabled`)
- Per-tenant toggle for BYOK opt-out if ever needed
- Global kill-switch env var: `PII_TOKENIZER_ENABLED=false`
- Fail-open on unknown tokens (Claude hallucinations don't crash)

### Testing

- `tests/tokenizer.test.js` — 42 unit tests, ~80ms, all green. Wired into `npm test` before the integration suite.
- CI server-test applies migration 031 to a fresh test DB — confirms schema change is clean.

### Austin's launch bar (unchanged)

> "I want strangers to be able to do the entire E2E setup and payment
> and dashboard features without any bugs or breaking."

### Remaining launch blockers (all human action, unchanged from Apr 18)

1. Stripe test mode on staging (~10 min in dashboard)
2. Live stranger walkthrough of SaaS signup flow
3. Live stranger walkthrough of self-hosted install on fresh VM
4. UptimeRobot signup (closes audit #14)

### New follow-ups from this session

1. Admin dashboard UI toggle for `pii_tokenization_enabled` (column exists, no UI)
2. Presidio NER sidecar for free-text names (beyond what `memory_file` hints cover)
3. Wire tokenizer into `portal.js:639` CSV import (admin path sends 3 customer sample rows to Claude for header-mapping — lower risk than chat but still a leak vector)
4. Update `docs/PRIVACY.md` §6.1 to mention live tokenization explicitly

### Audit findings scoreboard

**Unchanged at 8 open** — this session was orthogonal to the audit list. The PII story is a net-new win that didn't exist on the audit.

### Still-true things carried forward

- Hetzner backup cron runs 03:00 daily, log at `~/nomii-backup.log`
- Log rotation active (10MB × 5 = 50MB cap per container)
- Staging auto-refresh every 5 min via `nomii-staging-refresh.timer`
- Hetzner `.env` carries `COMPOSE_FILE=docker-compose.yml:docker-compose.prod.override.yml`
- SaaS + on-prem byte-for-byte identical (both pull GHCR `:1.1.0`)

---

## Previous: 2026-04-18 afternoon (SaaS→GHCR cutover SHIPPED — v1.0.3 live on GHCR images)

Cutover done. Both PRs merged, tag cut, Hetzner fully migrated to GHCR-pull
deploy. Binary parity with on-prem customers achieved.

### Cutover log (executed in one SSH invocation, ~45s including pull+recreate)

```
=== Step 1: discard old local overrides (now in git)
     git checkout -- client/nginx.conf docker-compose.yml        [✓]
=== Step 2: add COMPOSE_FILE to .env                             [✓]
=== Step 3: remove duplicate APP_URL (app.pontensolutions.com)   [✓]
=== Step 4: git fetch + checkout v1.0.3                          [✓]
=== Step 5: pull GHCR images (backend + frontend @ 1.0.3)        [✓]
=== Step 6: recreate containers (db healthy, backend+frontend up) [✓]
=== Step 7: verify
     /api/health (internal):  {"status":"ok"...}                 [✓]
     /api/health (public):    {"status":"ok"...}                 [✓]
     nomii-backend image:     ghcr.io/jafools/nomii-backend:1.0.3 [✓]
     nomii-frontend image:    ghcr.io/jafools/nomii-frontend:1.0.3 [✓]
     git HEAD:                v1.0.3                              [✓]
     Bundle hash changed:     D1g5IfPw → DBJt-PRb (new image live) [✓]
```

No customer impact (Austin confirmed he had no customers during the
cutover, and the recreate is ~5s of backend downtime behind Cloudflare
anyway).

### Pre-flight that caught two things before they bit us

1. Ran `docker compose -f docker-compose.yml -f docker-compose.prod.override.yml config`
   on pontenprox against the merged files from main — parse OK, no YAML errors.
2. SSH'd to Hetzner before starting the cutover to capture pre-state.
   Discovered there was **no `git stash` entry** — Austin's overrides lived
   as uncommitted working-tree edits, not a stash. Adjusted the cutover to
   use `git checkout -- <files>` instead of `git stash drop`. Everything
   else went as documented.

### Artifacts shipped this session

| | |
|---|---|
| [PR #12](https://github.com/jafools/nomii-ai/pull/12) — merged earlier (overnight wrap) | Audit follow-ups #14 / #17 / #18 + client ESLint |
| [PR #13](https://github.com/jafools/nomii-ai/pull/13) — **MERGED** ([c633d95](https://github.com/jafools/nomii-ai/commit/c633d95)) | SaaS→GHCR. Findings #10 + #11 resolved. |
| [PR #14](https://github.com/jafools/nomii-ai/pull/14) — **MERGED** ([7afcc50](https://github.com/jafools/nomii-ai/commit/7afcc50)) | Launch-readiness audit: fixed `docs.pontensolutions.com/data-api` dead link, added `docs/DATA-API.md`, added `docs/LAUNCH-READINESS-2026-04-18.md` |
| **v1.0.3** tag | Pushed to GHCR (`:1.0.3`, `:1.0`, `:stable`, `:latest`), deployed to Hetzner, live |

### Austin's launch bar (still the guiding star)

> "I want strangers to be able to do the entire E2E setup and payment
> and dashboard features without any bugs or breaking."

### Remaining launch blockers (unchanged since morning — all human action)

See `docs/LAUNCH-READINESS-2026-04-18.md` for full doc. TL;DR:

1. **Stripe test mode on staging** (~10 min in Stripe dashboard) — #1 unblock
2. **Live stranger walkthrough of SaaS signup flow** — cold, no-coaching
3. **Live stranger walkthrough of self-hosted install** on a fresh VM

### New stuff to know after this cutover

- **`docker-compose.yml` on Hetzner** is now the clean-from-git version (no
  local edits). Future deploys: `git fetch --tags && git checkout vX.Y.Z &&
  IMAGE_TAG=X.Y.Z docker compose pull && docker compose up -d`. No stash.
- **`.env` on Hetzner** now has `COMPOSE_FILE=docker-compose.yml:docker-compose.prod.override.yml`
  which causes docker compose to auto-layer the prod override file. Don't
  remove this line without also moving the overrides back into the base file.
- **`.env` duplicate `APP_URL` line cleaned up** — only `APP_URL=https://nomii.pontensolutions.com`
  remains. The old `app.pontensolutions.com` line was removed.
- **SaaS + on-prem now run byte-for-byte identical images** — both pull
  `ghcr.io/jafools/nomii-backend:1.0.3`. If a bug exists in one, it exists
  in the other; confirmed via `docker inspect` post-cutover.

### Audit findings scoreboard

**After this session:** 8 → still 8 open (cutover just proved the fixes
work, didn't resolve new findings).

- **LOW (4):** #7, #14 (UptimeRobot signup pending), #15, #16
- **INFO (3):** #19, #20, #22
- **MEDIUM (1):** #5 knomi DB branding drift

### Next session priorities

1. **Stripe test mode config** — see `docs/LAUNCH-READINESS-2026-04-18.md` §1
2. **Live stranger walkthrough** — no substitute
3. **UptimeRobot signup** — 5 min, closes #14

### Still-true things carried forward

- Hetzner backup cron runs 03:00 daily, log at `~/nomii-backup.log`
- Log rotation active (10MB × 5 = 50MB cap per container)
- `10.0.100.25` disposable VM has boosted login/widget rate limits — harmless
- pontenprox socat bridge to `10.0.100.25:80` still running; kill with
  `pkill -f "socat TCP-LISTEN:3001"` when no longer needed

---

## Previous: 2026-04-18 morning (SaaS→GHCR cutover PR + launch-readiness audit)

Austin stepped away mid-session. Two PRs left open for his review when he
returns — he has the final call on when to merge + cut the next tag.

### Artifacts shipped this session

| | |
|---|---|
| [PR #12](https://github.com/jafools/nomii-ai/pull/12) — merged overnight | Audit follow-ups #14 (MONITORING.md), #17/#18 (API-CONVENTIONS.md), client ESLint config wired into CI |
| [PR #13](https://github.com/jafools/nomii-ai/pull/13) — **OPEN, all CI green** | SaaS flips from `build: ./server` to `image: ghcr.io/jafools/nomii-{backend,frontend}:${IMAGE_TAG:-stable}`. Resolves Findings #10 + #11. Committed `docker-compose.prod.override.yml` + `config/nginx/prod.conf` so Hetzner's uncommitted overrides finally live in git. Deploy is now `pull + up -d`, not `--build`. |
| [PR #14](https://github.com/jafools/nomii-ai/pull/14) — **OPEN, CI running** | Launch-readiness audit: fixes one real customer-facing dead link (`docs.pontensolutions.com/data-api` — DNS doesn't resolve), adds `docs/DATA-API.md` reference, adds `docs/LAUNCH-READINESS-2026-04-18.md` with the go-to-market blocker list. |

### Austin's launch bar (captured from this session)

> "I want strangers to be able to do the entire E2E setup and payment and
> dashboard features without any bugs or breaking."

Translated: SaaS-signup → verify → onboarding → dashboard → payment flow
must work cold for a human who has never seen the product. Plus the
self-hosted install.sh → setup wizard → onboarding flow.

### Remaining launch blockers (human action only)

See `docs/LAUNCH-READINESS-2026-04-18.md` for the full doc. TL;DR:

1. **Stripe test mode on staging** (~10 min in Stripe dashboard). #1 unblock.
2. **Live stranger walkthrough of SaaS signup flow** — nothing substitutes.
3. **Live stranger walkthrough of self-hosted install** on a fresh VM.

Everything else is polish (UptimeRobot, off-host backups, Playwright in CI,
portal.js split, published docs site).

### Hetzner first-time cutover (one-time, after PR #13 merges + tag cut)

Required the first time PR #13's new compose layout hits Hetzner. Once:

```bash
ssh nomii@204.168.232.24
cd ~/nomii-ai
echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.prod.override.yml' >> .env
git fetch --tags
git checkout vX.Y.Z              # whatever tag has PR #13
git stash drop                   # throw out the old stashed overrides — in git now
IMAGE_TAG=X.Y.Z docker compose pull backend frontend
IMAGE_TAG=X.Y.Z docker compose up -d backend frontend
curl -s http://127.0.0.1:3001/api/health
docker inspect nomii-backend --format '{{.Config.Image}}'
#   → ghcr.io/jafools/nomii-backend:X.Y.Z
```

After this cutover, all future deploys use the simpler `pull + up -d` form
(documented at the new `docs/RELEASING.md`).

### Next session priorities

1. Merge PR #13 + cut v1.0.3 tag + do the Hetzner cutover above. Verify
   `docker inspect nomii-backend` shows the GHCR image ref.
2. Merge PR #14 (docs-only except for one JSX line — low risk).
3. Set up Stripe test keys on staging. See `docs/LAUNCH-READINESS-2026-04-18.md`
   §1 for step-by-step.
4. Schedule the stranger walkthrough.

### Still-true things carried forward

- Hetzner backup cron runs 03:00 daily, log at `~/nomii-backup.log`.
- Log rotation active (10MB × 5 = 50MB cap per container).
- `10.0.100.25` disposable VM has boosted login/widget rate limits — harmless to leave.
- pontenprox socat bridge to `10.0.100.25:80` still running; kill with
  `pkill -f "socat TCP-LISTEN:3001"` when no longer needed.
- Hetzner `.env` currently has TWO `APP_URL` lines (`nomii.pontensolutions.com`
  AND `app.pontensolutions.com`). Last-one-wins = `app.` which is wrong but
  the client never actually hits that URL in production (same-origin fetches).
  **Clean up in the Hetzner cutover** — edit `.env` to have just
  `APP_URL=https://nomii.pontensolutions.com`.

### Open audit findings after this session

Down to **8 remaining** (out of 25 originally):

- **MEDIUM (1):** #5 knomi DB branding drift
- **LOW (4):** #7 migration 015b naming, #14 uptime (external signup pending),
  #15 CI DB name alignment, #16 `:latest` pinning
- **INFO (3):** #19, #20, #22 — positive observations

Once UptimeRobot signup happens, down to 7.

---

## Previous: 2026-04-17 late night (bedtime wrap — audit followups #14 / #17 / #18 + client ESLint)

One last short session before bed. Closed out three audit findings with
docs + a working client-side ESLint config + CI lint step re-enabled.

### Artifacts shipped this session

| | |
|---|---|
| [`docs/MONITORING.md`](MONITORING.md) | Finding #14 — UptimeRobot setup recipe for `https://nomii.pontensolutions.com/api/health` + optional pontenprox fallback template. Actual account creation is an Austin task (external signup). |
| [`docs/API-CONVENTIONS.md`](API-CONVENTIONS.md) | Findings #17 + #18 — snake_case chosen as the go-forward convention, three `/login` endpoints documented with their distinct user populations (customers+advisors / tenant_admins / platform_admins), JWT payload shapes, and why we're keeping them separate. |
| `client/eslint.config.js` + `ci.yml` `Lint client` step | Flat ESLint 9 config tuned for the existing loose TS setup. Currently 0 errors / 10 warnings — warnings are allowed, errors fail CI. |
| `docs/AUDIT-2026-04-17.md` | Summary table updated: #14 → DOCUMENTED, #17 + #18 → RESOLVED. |

### Open findings after this session (9 remaining, down from 12)

- **MEDIUM (3):** #5 knomi DB branding drift, #10 Hetzner uncommitted overrides, #11 SaaS-source vs on-prem-GHCR build strategy
- **LOW (4):** #7 migration 015b naming, #14 uptime (pending external signup), #15 CI DB name alignment, #16 `:latest` pinning
- **INFO (3):** #19, #20, #22 — positive observations, no action

### Next session — priority order

1. **Spend 5 minutes on UptimeRobot signup** — instructions in `docs/MONITORING.md`. Closes #14 for real. External account + 2 monitors.
2. **#11 SaaS/on-prem build strategy** is the highest-value remaining finding — it's the last architectural loose end.
3. **Off-host backup destination for Hetzner** — still deferred. `rsync` to a Hetzner Storage Box (~EUR 4/mo for 1TB).
4. Wire Playwright into CI whenever the manual pontenprox setup becomes annoying.

### Still-true things carried forward from previous session

- Hetzner backup cron runs 03:00 daily, log at `~/nomii-backup.log`.
- Log rotation active on all three compose files (10MB × 5 files = 50MB cap per container).
- `10.0.100.25` disposable VM has boosted login/widget rate limits for E2E batches (harmless to leave).
- pontenprox socat bridge to `10.0.100.25:80` still running; kill with `pkill -f "socat TCP-LISTEN:3001"` when no longer needed.

---

## Previous: 2026-04-17 evening (audit sweep → v1.0.1 patch → full Playwright E2E 35/35)

Full 3-layer audit of both SaaS and on-prem Shenmay, followed by shipping the first
real bug-fix release through the new release flow end-to-end, followed by
5x stress runs of the install/signup flows, a real live Claude chat through
the whole backend chain, and the first full green run of the 35-test Playwright
suite against v1.0.1 code.

### Artifacts shipped this session

| | |
|---|---|
| [`docs/AUDIT-2026-04-17.md`](AUDIT-2026-04-17.md) | 25 findings across 3 layers (static / operational / E2E), 12 resolved this session |
| [`scripts/hetzner-backup.sh`](../scripts/hetzner-backup.sh) + cron | Daily pg_dump on Hetzner prod, 14-day retention, running since 12:32 UTC |
| [PR #7](https://github.com/jafools/nomii-ai/pull/7) — merged → **v1.0.1** | 9 findings fixed: fail-fast secrets in SaaS compose, log rotation, update.sh rewrite, `DEPLOYMENT.md` deleted, migrate.sh DB defaults, testing.md paths, CI `selfhosted-smoke` job, RELEASING.md migration-failure runbook, `tos_accepted` error shape |
| [PR #8](https://github.com/jafools/nomii-ai/pull/8) | Playwright tests now tolerant of rate-limit UX + documents 3 new findings |
| [PR #10](https://github.com/jafools/nomii-ai/pull/10) | Finding #23 resolved — `REGISTER_RATE_LIMIT_MAX` env override in backend + both compose files |
| **v1.0.1** tag | Pushed to GHCR (`:stable`, `:latest`, `:v1.0.1`, `:1.0`) + deployed to Hetzner |
| **v1.0.2** tag | Pushed to GHCR + deployed to Hetzner ~13:55 UTC. Proved the full release flow works twice in one day. |

### Release flow exercised end-to-end for the first time

```
branch → PR #7 → CI green → squash-merge → :edge rebuild → staging auto-refresh
      → git tag v1.0.1 → docker-publish rebuilds :stable/:latest → Hetzner SSH deploy → healthy
```

~4 seconds of perceived downtime on the SaaS backend recreate. Zero customer
impact.

### E2E verification done

| Flow | Result |
|---|---|
| Upgrade test on 10.0.100.25 (pre-release `:latest` → v1.0.0) | ✅ PASS — data preserved, 4s downtime |
| Fresh install x5 | ✅ 5/5 pass, 21s median |
| SaaS staging signup x5 | ✅ 3/5 (iters 4-5 hit register rate limit — correct product behaviour) |
| Real Claude chat with context retention (BYOK key) | ✅ 2-turn convo, DB-persisted |
| Widget iframe embed on simulated customer site | ✅ iframe + React UI render correctly |
| Full Playwright suite (35 tests) | ✅ 35/35 in 40s |

### Things to know for next session

- **10.0.100.25** (disposable test VM) has `LOGIN_RATE_LIMIT_MAX=200` and `WIDGET_SESSION_RATE_LIMIT_MAX=200` in `.env` to allow batched E2E runs. Harmless to leave.
- **pontenprox** (`/root/Knomi/knomi-ai`) has Playwright working. The test-env trick: start a local Vite dev on :5173 with `VITE_API_BASE_URL=http://10.0.100.25`, then run `socat TCP-LISTEN:3001,fork,reuseaddr TCP:10.0.100.25:80` to satisfy the tests' `API_BASE=localhost:3001` assumption. The socat process is still running — kill with `pkill -f "socat TCP-LISTEN:3001"` when no longer needed.
- **server/.env** on pontenprox was updated with `TEST_ADMIN_EMAIL=tier2@example.test` + `TEST_ADMIN_PASSWORD=tier2-password-12345` to match the VM's admin. Not in git — restore to ajaces@gmail.com creds if running tests against a different target.
- **Hetzner `nomii-backup.log`** is the thing to watch if backups ever stop.
- **Open findings (12 remaining)**: #5, #10, #11, #17, #23 MEDIUM; #7, #14, #15, #18 LOW; #16 LOW/INFO; #19, #20, #22 INFO-only. See audit doc summary table. #23 is the highest-value remaining item — adding `REGISTER_RATE_LIMIT_MAX` env override in backend would fix multiple rate-limit-related test fragility.

### Next session

1. If anything is broken, check `docker compose logs backend` on Hetzner — log rotation is now active, so logs are capped at 50MB.
2. Consider adding an **off-host backup destination** for Hetzner (rsync to a second VPS / Hetzner Storage Box) — local backups don't survive VM-destroy.
3. The 11 open audit findings sorted by value: #23 register rate-limit env > #11 SaaS/on-prem build strategy > #17 API naming convention > rest.
4. If you want to run the Playwright suite regularly, **wire it into CI** (deferred finding from audit) instead of relying on the pontenprox-hosted manual setup.

---

## Previous: 2026-04-17 afternoon (session wrap — full release infrastructure shipped)

Single-session build-out of Shenmay's release infrastructure end-to-end. Five PRs merged, v1.0.0 cut, staging environment live with auto-refresh, full flow documented at the top of CLAUDE.md.

### What's live now

| | URL | Image tag | Host |
|---|---|---|---|
| **Staging** | https://nomii-staging.pontensolutions.com | `:edge` (auto-refresh every 5 min) | Proxmox (`ssh pontenprox`) |
| **Prod SaaS** | https://nomii.pontensolutions.com | built from git tag `v1.0.0` | Hetzner (`ssh nomii@204.168.232.24`) |
| **Prod on-prem** | customer hardware | `:stable` from GHCR (currently v1.0.0 content) | customer servers |

### Shipping flow (now enforced)

```
branch → PR → CI green → squash-merge to main
                │
                ▼
      GHCR rebuilds :edge → systemd timer on Proxmox auto-pulls within 5 min
                │
                ▼
    preview at https://nomii-staging.pontensolutions.com
                │
                ▼ happy?
        git tag vX.Y.Z && git push origin vX.Y.Z
                │
                ▼
    GHCR rebuilds :vX.Y.Z + :stable + :latest   (on-prem customers)
                │
                ▼
    ssh nomii@204.168.232.24  + check out tag + rebuild   (SaaS)
```

Full procedure: `docs/RELEASING.md`. TL;DR at the top of `CLAUDE.md`.

### 5 PRs merged this session

1. [#1](https://github.com/jafools/nomii-ai/pull/1) — release flow + branch protection (CI, GHCR retagging, branch protection, repo settings)
2. [#2](https://github.com/jafools/nomii-ai/pull/2) — post-release cleanup (workflow tag-leak fix, docker image tag convention docs)
3. [#3](https://github.com/jafools/nomii-ai/pull/3) — staging environment docs
4. [#4](https://github.com/jafools/nomii-ai/pull/4) — staging timer + SSH alias rename (`nomii-prod` → `pontenprox`)
5. [#5](https://github.com/jafools/nomii-ai/pull/5) — shipping flow TL;DR promoted to top of CLAUDE.md

### Infrastructure state

- **Hetzner**: `v1.0.0` deployed. Health green. Unchanged since this morning's v1.0.0 cutover.
- **Proxmox**: old Shenmay fallback retired (DB backup at `/root/backups/knomi_ai_proxmox_final_20260417_131426.sql`). Fresh staging stack at `/root/nomii-staging/`. Lateris + `nomii-cloudflared` untouched. Systemd timer `nomii-staging-refresh.timer` polling GHCR every 5 min.
- **GHCR**: `ghcr.io/jafools/nomii-{backend,frontend}` with `:edge` (main-push), `:1.0.0`, `:1.0`, `:stable`, `:latest`.
- **Cloudflare tunnel `knomi-ai`**: stale pre-Hetzner routes deleted by Austin. New `nomii-staging.pontensolutions.com` → `http://nomii-frontend-staging:80` added.
- **Branch protection**: main requires PR + green CI (`client-build`, `server-test`). Squash-merge only. Auto-delete branch on merge.

### Open follow-ups (carry forward)

- **Manual QA flows** — the whole reason the release infra was built: SaaS signup → email verify → login → onboarding → dashboard → widget; self-hosted install.sh → setup wizard → widget. **Now safe to test against staging first.** Austin deferred to the next session.
- **`client/eslint.config.js`** missing → CI lint step skipped. Add when ready to enforce.
- **Client vitest tests** don't exist → CI client test step skipped. Add when first frontend test is worth writing.
- **`portal.js` split** (3,683 LOC) — still deferred.
- **Delete 1,646 LOC pre-portal zombie routes** — still deferred (7-day prod log grep needed).
- **Stripe test-mode + test SMTP on staging** — left unset; billing + email features no-op on staging. Add test-mode keys when needed.

### Gotchas worth remembering

- **Git Bash on Windows rewrites `gh api /repos/...`** into a filesystem path. Use `gh api repos/...` (no leading slash).
- **`gh api -f key=false`** sends the string `"false"`. Use `-F` for booleans.
- **`docker/metadata-action` drops the `v` prefix** on SemVer tags. Git tag `v1.2.3` → docker image `1.2.3`.
- **Cloudflare Tunnel "Subdomain" field** rejects dots in the newer Zero Trust UI (single-label subdomains only). That's why staging is `nomii-staging.pontensolutions.com`, not `staging.nomii.pontensolutions.com`.
- **Cloudflare Tunnel "Service URL" field** requires a protocol prefix (`http://` or `https://`).
- **Proxmox LAN IP `10.0.100.2`** is not reachable from GH Actions — so push-based deploy from CI doesn't work. Use pull-based (the systemd timer we set up).
- **Shared docker network on Proxmox is `knomi-ai_default`** (pre-rename). Renaming requires stopping `nomii-cloudflared` which also serves Lateris — left as tech debt.

### Next session

1. Start QA run using staging: sign up fresh, go through onboarding, widget chat, billing flow (once test-mode Stripe added).
2. Mirror the self-hosted flow: `install.sh` on a fresh Ubuntu VM + setup wizard → widget.
3. After QA passes, retire is complete: consider this milestone shipped and close out.

---

## Previous: 2026-04-17 morning (release-flow + branch protection — SHIPPED, v1.0.0 live)

Flipped Shenmay from "push to main = ship to customers" to a tagged-release model.
Main is now a protected branch. CI must pass before merge. Customer-facing
images (`:stable`, `:latest`) only rebuild on `git tag vX.Y.Z`.

### What shipped (branch `chore/release-flow-and-branch-protection`, PR [#1](https://github.com/jafools/nomii-ai/pull/1))

- **New**: `.github/workflows/ci.yml` — client build + server integration tests (Postgres service container). Client lint is currently skipped (no `eslint.config.js` — separate issue).
- **Rewrote**: `.github/workflows/docker-publish.yml` — main push now builds `:edge` only. Tagged release (`v*`) builds `:vX.Y.Z` + `:vX.Y` + `:stable` + `:latest`.
- **Pinned**: `docker-compose.selfhosted.yml` images now use `:stable` (was `:latest`). Customers only receive updates on a deliberate release.
- **Updated**: `scripts/install.sh` — defaults to the latest tagged release via the GitHub API (falls back to `main` if no tags exist).
- **New**: `docs/RELEASING.md` — full release procedure (day-to-day flow, cutting releases, hotfixes, rollback).
- **Updated**: `CLAUDE.md` — flipped the "always work on main" rule; documented the new branching + release model.

### Repo settings applied via `gh api` (not in the PR itself)

- Branch protection on `main`: required status checks (`client-build`, `server-test`), PR required (0 approvals), no force-push, no deletion, linear history, admins NOT enforced (solo-dev escape hatch).
- Merge settings: squash-merge only (`allow_merge_commit=false`, `allow_rebase_merge=false`), `delete_branch_on_merge=true`, `allow_update_branch=true`.

### Current state of prod (v1.0.0 is live on both SaaS and GHCR)

- **Hetzner SaaS**: on `v1.0.0` (commit `53cda5b`). `git describe --tags` returns `v1.0.0`. Public health check 200, internal health check `{"status":"ok"}`, migrations clean, DB connected.
- **GHCR (on-prem distribution)**: `:1.0.0`, `:1.0`, `:stable`, `:latest` all rebuilt for both `nomii-backend` and `nomii-frontend`. Customers pulling `:stable` will now receive v1.0.0's code.
- **Flow dogfooded end-to-end**: PR #1 merged via squash, branch auto-deleted, `:edge` rebuilt on main push, `:stable`/`:latest` rebuilt on tag push, SaaS deployed from the tag.

### Next session

1. **Austin's manual testing** (deferred from last session):
   - SaaS flow: signup → email verify → login → onboarding → dashboard → widget chat
   - Self-hosted flow: install.sh → setup wizard → onboarding → dashboard → widget
2. After testing: retire Proxmox Shenmay containers (`docker compose stop backend frontend db` — leave cloudflared for Lateris).
3. Optional: add `client/eslint.config.js` + re-enable lint step in CI.
4. Optional: add a first vitest smoke test + re-enable the client test step.

### Known follow-ups

- `client/` has ESLint 9 deps but no flat config — lint step skipped in CI with a TODO.
- `docker-compose.selfhosted.yml` still has `knomi_ai`/`knomi` DB user/name (pre-rename) — the live Hetzner compose uses `nomii`. Cosmetic for fresh on-prem installs but worth fixing in a future PR.
- `portal.js` split (3,683 LOC) — still deferred.
- Delete 1,646 LOC pre-portal zombie routes (after 7-day prod log grep).

### How to work from now on

```bash
# New feature
git checkout main && git pull
git checkout -b feat/my-thing
# ... commit ...
git push -u origin feat/my-thing
gh pr create
# wait for CI green, then merge via GitHub UI or `gh pr merge --squash`

# Release
git checkout main && git pull
git tag v1.2.3
git push origin v1.2.3
# wait for docker-publish workflow to go green
# then SSH Hetzner, checkout v1.2.3, rebuild
```

See `docs/RELEASING.md` for the full procedure.

---

## Previous: 2026-04-16 late-evening (pre-test targeted cleanup — deployed to Hetzner)

Targeted cleanup before Austin's manual testing of both SaaS and self-hosted flows.

### What shipped (commit `4820b6c`, deployed)

**Critical: managed_ai_enabled SQL fix (5 queries)**
- Column `managed_ai_enabled` lives on `subscriptions`, NOT `tenants`
- 5 queries were reading `t.managed_ai_enabled` — hard PostgreSQL crash
- Fixed: `widget.js:1284` (greeting), `portal.js:3106` (summarize), `portal.js:3483` (tool test), `memoryUpdater.js:581`, `chat.js:32`
- Each now JOINs `subscriptions s ON s.tenant_id = t.id`

**Onboarding step key standardized**
- `widget.js:1381` was setting `{"widget": true}`, setup.js uses `install_widget`
- Standardized to `install_widget` everywhere

**Stripe checkout URLs dynamic**
- `license-checkout.js` now uses `process.env.APP_URL` instead of hardcoded domain

**Stale URL defaults fixed**
- `emailService.js`, `notificationService.js`, `licenseService.js` — all default to `nomii.pontensolutions.com`
- Removed legacy `app.pontensolutions.com` from CORS allowlist
- `docker-compose.yml` FRONTEND_URL default updated

**CLAUDE.md updated** (commit `cfd10c0`)
- Replaced stale Proxmox VPS section with Hetzner deploy workflow
- Documented `git stash/pull/pop` pattern (Hetzner has local docker-compose overrides)

### Prod state
- Hetzner: `4820b6c` deployed, health check passing
- Proxmox: still running (cloudflared serves Lateris — do NOT stop)

### Next session: Austin's manual testing
1. **SaaS flow**: signup → email verify → login → onboarding (6 steps) → dashboard → widget chat
2. **Self-hosted flow**: install.sh → setup wizard → onboarding (widget step) → dashboard → widget chat
3. After testing: retire Proxmox Shenmay containers (`docker compose stop backend frontend db` — leave cloudflared)

### Still deferred (not blocking)
- `portal.js` split (3,683 LOC)
- Delete 1,646 LOC of pre-portal zombie routes (after 7-day prod log grep)
- Customer-facing self-hosted Getting Started guide
- Update README.md (still references Covenant Trust)

---

## Previous: 2026-04-16 afternoon (Hetzner VPS migration — COMPLETE)

Full production migration from Proxmox VM to Hetzner Cloud Helsinki. Zero downtime. All endpoints verified.

### What shipped

**Hetzner VPS provisioned and running**
- Server: `nomii-prod` — CPX22, Helsinki (hel1), `204.168.232.24`
- Cost: EUR 12.61/mo (server EUR 9.99 + backups EUR 2.00 + IPv4 EUR 0.63)
- OS: Ubuntu 24.04, Docker 29.4.0
- SSH: `ssh nomii@204.168.232.24` (root disabled, password auth disabled, key-only)

**Database migrated with clean naming**
- DB user: `nomii` (finally! no more `knomi`)
- DB name: `nomii_ai`
- Data: 34 tenants, 33 admins, 34 subscriptions, 100 messages, 1 license — all migrated via `pg_dump --no-owner`
- `API_KEY_ENCRYPTION_SECRET` carried over from Proxmox (encrypted API keys in DB still valid)

**DNS cutover — no tunnel, direct A records**
- `nomii.pontensolutions.com` → A `204.168.232.24` (Proxied)
- `api.pontensolutions.com` → A `204.168.232.24` (Proxied)
- `app.pontensolutions.com` → A `204.168.232.24` (Proxied)
- Lateris records (`lateris`, `dev-lateris`) still on Cloudflare tunnel → Proxmox (untouched)

**Full end-to-end SSL**
- Cloudflare Origin CA certificate installed (valid until 2041-04-12)
- SSL mode: **Full (Strict)** — Browser → HTTPS → Cloudflare → HTTPS → Origin
- Certificate covers `*.pontensolutions.com` + `pontensolutions.com`

**Security hardening**
- UFW firewall: SSH (22), HTTP (80), HTTPS (443) only
- fail2ban running
- Backend port 3001 bound to `127.0.0.1` only (not externally accessible)
- Database port 5432 internal to Docker only
- No server fingerprint leaked (shows "cloudflare" only)
- CORS locked to `nomii.pontensolutions.com`

**Repo cleanup (pre-migration)**
- Removed 8 garbage untracked files from repo root
- Fixed `migrate.sh` DB user default from `knomi` → `nomii`
- Added `.claude-flow/swarm/` to `.gitignore`

### Smoke test results (all passing)

| Endpoint | Result |
|---|---|
| `nomii.pontensolutions.com/api/health` | `{"status":"ok"}` |
| `api.pontensolutions.com/api/health` | `{"status":"ok"}` |
| `app.pontensolutions.com` | 301 redirect (expected) |
| `/widget.html` | 200 |
| `/embed.js` | 200 |
| `/api/license/validate` | 403 "License key not found" (correct) |
| `/api/auth/login` (bad creds) | 401 (auth working) |
| `/api/config` | SaaS mode, all features enabled |
| Stripe checkout | Live `checkout.stripe.com` URL returned |
| Response time | 83ms (nomii), 126ms (api) |
| Backend logs | Zero errors |

### What Austin still needs to manually test

1. **Log in** at `nomii.pontensolutions.com/nomii/login`
2. **Dashboard loads** with tenant data
3. **Widget chat** works (tests Anthropic API key decryption)
4. **Plans & Billing** page renders

### What's left (not blocking)

1. **Retire Proxmox Shenmay containers** — keep for 7 days as fallback:
   ```bash
   ssh nomii-prod "cd ~/Knomi/knomi-ai && docker compose stop nomii-backend nomii-frontend"
   # After 7 days: docker compose down (removes DB volume)
   ```
2. **Remove cloudflared from Hetzner docker-compose** — not running, but the service definition is still in the file
3. **Commit the nginx.conf SSL changes** — currently only on Hetzner, not in git
4. **Clean up `/tmp/nomii_dump.sql`** on both Hetzner and local machine
5. **Update `~/.ssh/config`** — add `nomii-hetzner` alias for the new server

### VPS provider research (for reference)

| Provider | DC | Price | Notes |
|---|---|---|---|
| **Hetzner (chosen)** | Helsinki | EUR 12.61/mo | Best value, sub-10ms from Sweden |
| Contabo | Stockholm | EUR 4.50/mo | Cheapest but mixed reputation |
| Vultr | Stockholm | $24/mo | 5x price for same spec |
| DigitalOcean | Amsterdam | $24/mo | No Nordic DC |
| OVHcloud | Stockholm | EUR 10-14/mo | Mixed support |
| UpCloud | Helsinki | EUR 26/mo | Finnish, priciest |

### Infrastructure state

| Component | Location | Status |
|---|---|---|
| Shenmay backend | Hetzner Helsinki | Running ✅ |
| Shenmay frontend | Hetzner Helsinki | Running ✅ |
| Shenmay DB (`nomii`/`nomii_ai`) | Hetzner Helsinki | Healthy ✅ |
| Shenmay (Proxmox) | Proxmox VM | Still running (fallback, retire in 7 days) |
| Lateris | Proxmox VM | Untouched, still on tunnel |
| Cloudflare tunnel | Proxmox | Still active for Lateris only |

### Key files on Hetzner

| Path | Purpose |
|---|---|
| `~/nomii-ai/` | Git clone of repo |
| `~/nomii-ai/.env` | Production env (nomii DB user) |
| `~/nomii-ai/docker-compose.yml` | Modified: backend on 127.0.0.1:3001, frontend on 80+443 |
| `~/nomii-ai/client/nginx.conf` | Modified: added HTTPS server block with Origin CA cert |
| `/etc/ssl/cloudflare/origin.pem` | Cloudflare Origin CA cert (expires 2041) |
| `/etc/ssl/cloudflare/origin.key` | Private key (chmod 600) |

### Migration runbook

Saved to Obsidian vault: `projects/nomii/hetzner-migration-runbook.md`

---

## Previous: 2026-04-16 morning (full launch QA + unified license portal + buy page overhaul)

### What shipped (nomii-ai repo)

**Commit `9685343`** — Portal license lookup endpoint
- New `POST /api/public/portal/licenses` at `server/src/routes/public-portal.js`
- Accepts portal session token, verifies via Cloudflare Worker proxy, returns Shenmay licenses for the authenticated email
- Gated by `NOMII_LICENSE_MASTER=true`, rate-limited 10 req/min
- Deployed to prod via `docker compose up -d --build backend`

### What shipped (ponten-solutions repo — 3 commits)

**Commit `e7d1eb2`** — Badge clipping fix + self-hosted nav
- Removed `overflow-hidden` from Cloud card and Growth pricing card (badges were clipped)
- Added `rounded-t-2xl` to Growth card decorative header to preserve corner clipping
- Wrapped `SelfHostedNomii.tsx` in `<Layout>` for Navbar + Footer
- Added `/nomii/self-hosted` to Navbar product-page check

**Commit `2beb197`** — Unified license portal + Buy page CTA
- Portal fetches Shenmay licenses alongside Lateris, displays grouped by product
- New `NomiiLicenseCard` component (shows plan, status, key, instance_id)
- `portalApi.ts`: `getNomiiLicenses()` function + `NomiiLicenseRecord` type
- Login branding updated to product-neutral (both product icons)
- Buy page CTA updated (was pointing to product explainer)

**Commit `38b129a`** — Combined Cloud + Self-Hosted pricing page
- Cloud/Self-Hosted deploy mode toggle on `/nomii/license`
- Cloud mode: SaaS pricing tiers with "Start Free Trial" → signup
- Self-Hosted mode: existing Stripe checkout pricing (unchanged)
- Bottom CTA dynamically offers the other deploy mode
- Buy overview CTA now links directly to `/nomii/license`

### Launch readiness verified

| Touchpoint | Status |
|---|---|
| Marketing page "Two Ways to Run Shenmay" | Live ✅ |
| Self-hosted landing page + nav | Live ✅ |
| SaaS signup page | ✅ |
| Login page | ✅ |
| License pricing (Cloud + Self-Hosted) | Live ✅ |
| Stripe checkout (live mode) | ✅ |
| License validate (master) | ✅ |
| Widget embed.js + widget.html | ✅ |
| Backend /api/health | ✅ |
| Install script (GitHub raw) | ✅ |
| Client build | Passes ✅ |
| Server syntax | All files clean ✅ |
| Stripe receipts | Already enabled ✅ |
| SMTP_PASS | Not leaked externally ✅ |

### Manual items resolved
- Stripe receipt emails — already toggled on
- SMTP_PASS — only visible in Claude session, not leaked externally
- GitHub PAT — low priority, deferred (scoped to one repo, only root has access)

### Next session: Hetzner VPS port

Austin wants to do the VPS migration in a fresh session. Steps:
1. Provision Hetzner CX22 + SSH keys
2. Harden server (ufw, fail2ban, non-root user)
3. Install Docker + clone repo
4. Copy `.env` + adjust secrets
5. `pg_dump` from Proxmox → `pg_restore` on Hetzner
6. `docker compose up -d`
7. New Cloudflare tunnel token → point to Hetzner
8. Smoke test all endpoints
9. DNS cutover (Cloudflare tunnel swap)
10. Verify + retire Proxmox Shenmay containers

Estimated: 1-2 hours. No code changes needed — same docker-compose.yml works anywhere.

### Still deferred (not blocking launch)
- portal.js split (3,683 LOC) — post-first-customer
- Delete zombie pre-portal routes (1,646 LOC) — needs 7-day prod log grep
- Stale success card at `pontensolutions.com/nomii/license?success=true` — orphaned, nothing links to it

### Prod HEAD state
- `nomii-ai`: `9685343` (deployed to Proxmox)
- `ponten-solutions`: `38b129a` (published via Lovable)

---

## Previous: 2026-04-15 late-evening (marketing-page buyer-journey fork — Cloud vs Self-Hosted)

Shipped Austin's explicit ask from the previous session: a clear two-path fork on the Shenmay product page so visitors immediately see both deployment options. Work was done in the `ponten-solutions` repo (not this one), committed directly on the Proxmox VM at `~/ponten-solutions`, pushed to `origin/main`, Lovable auto-redeploys.

### What shipped (ponten-solutions commit `2086711`)

New **"Two Ways to Run Shenmay"** section inserted between the hero and "The Challenge" section on `/products/nomii-ai`. Two equal-weight cards:

- **Shenmay Cloud** (★ FASTEST TO START badge) → `https://nomii.pontensolutions.com/nomii/signup` — "We run it. You focus on your customers." 5-min signup, fully managed, auto-updates, 14-day trial, from $49/mo.
- **Shenmay Self-Hosted** (accent color `#C9A84C` to match SelfHostedNomii.tsx) → `/nomii/self-hosted` — "You run it. Data stays on your own infrastructure." One-line install, data stays on your network, BYO Anthropic key, free trial, from $49/mo.
- **"Not sure which fits?"** → `/contact` (Book a 20-minute chat).

Design follows existing patterns in the file: `card-glass`, `FadeIn`, `section-padding`/`section-container`, eyebrow label + gradient-text headline. Cloud card gets the same visual priority treatment as the "MOST POPULAR" Growth plan card in the pricing section (primary-color border + glow). Self-Hosted card uses the gold accent from SelfHostedNomii.tsx for cohesion across the on-prem flow.

### Drive-by cleanups in the same commit

- **5x `app.pontensolutions.com/nomii/signup` → `nomii.pontensolutions.com/nomii/signup`** (hero CTA, 3 pricing cards, closing CTA). Skips the `app.` → `nomii.` redirect hop and survives eventual retirement of the `app.` subdomain.
- **Reframed "Need total control?" row** (line ~960 of NomiiAI.tsx) into "Enterprise & regulated industries" — since the new section now owns the self-hosted fork, this row is now pitched for SLA/BAA/volume-pricing conversations on either deployment. CTA text changed from "Buy a License" → "Self-Hosted Plans".
- Added `Cloud, Server` icons to the lucide-react import list.

### What was NOT touched

Hero, Challenge, Architecture (Soul/Memory), Anonymous Widget, Use Cases, Business, Features, Who It's For, 3 SaaS pricing cards (Starter/Growth/Professional), Data Model row, Closing CTA. Non-destructive addition + targeted tweaks only.

### Verification

- Local TSX syntax check via `npx esbuild` on the VM — PARSE OK (no type errors)
- `git diff --stat`: +120/−10 in a single file
- `git push origin main`: `ec6a63f..2086711 main -> main` — confirmed via `git ls-remote` that GitHub main HEAD is `2086711`.

### 🔑 New gotcha discovered: Lovable does NOT auto-publish on GitHub pushes

After the push landed, the deployed bundle (`/assets/index-D8j9QHlx.js`) still served pre-Apr-14 content:

| Commit | String signature | In deployed bundle? |
|---|---|---|
| `2086711` (today, mine) | "Two Ways to Run Shenmay" | ❌ 0 |
| `ec6a63f` (Apr 14) | "Run Shenmay AI on your own" | ❌ 0 |
| `bfbbbf3` (Apr 14) | "Buy a License" | ❌ 0 |
| pre-`bfbbbf3` | "Need total control" | ✅ 1 |

At first I thought the Vercel auto-deploy was broken. It wasn't. Austin showed me a screenshot of his Lovable UI: **my commit WAS synced into Lovable's version history, Lovable just hadn't published it to production.** Lovable's GitHub integration syncs commits to version history automatically, but the live URL stays on whatever the last *published* build was. Austin has to click **Publish** in Lovable manually.

**Consequence for future marketing-page work in `ponten-solutions`:**
- `git push origin main` is step 1 of 2, not the whole shipping process.
- Step 2 is: Austin clicks Publish in Lovable.
- Don't mark a marketing-page task complete until Austin confirms "published" and a curl-grep of the deployed bundle shows the new content.
- The Apr 14 handoff note ("Austin must have applied it between sessions … `/nomii/self-hosted` returning HTTP 200") was also misleading — HTTP 200 just means the SPA shell loaded. The `SelfHostedNomii` component likely wasn't in the live bundle until Austin clicked Publish. Any prior session that claimed "deployed" without a bundle-grep verification is suspect.

**Hosting layer (confirmed):** Lovable → (internal pipeline) → Vercel. Response cookie `__dpl=...` confirms Vercel as the serving platform, Cloudflare is the CDN edge in front. No `vercel.json` or `.github/workflows/` in the repo — deploy config is entirely on Lovable/Vercel's side.

**Saved as memory:** `reference_lovable_manual_publish.md` in the auto-memory system, indexed in `MEMORY.md`.

### Status at session end

- Code on GitHub at `2086711` ✓
- Commit visible in Lovable Version History ✓
- Austin is clicking Publish now — live in a few minutes.

Post-publish verification:
```bash
NEW_BUNDLE=$(curl -s https://pontensolutions.com/products/nomii-ai | grep -oE 'src="/assets/[^"]+\.js"' | head -1 | sed 's/src="//;s/"$//')
curl -s "https://pontensolutions.com${NEW_BUNDLE}" | grep -c "Two Ways to Run Shenmay"
# Expect: 1 once Lovable publishes
```

### Gotcha captured

- **Vite SPA diagnostic gotcha (reinforces an earlier one)**: curl of `/products/nomii-ai` returns the HTML shell — none of the React-rendered content. To verify copy changes on pontensolutions.com, find the `/assets/index-*.js` bundle URL in the HTML and grep the bundle. Hash in the URL changes on each deploy, so a stale hash + old content = deploy not complete yet.

### Git identity warning on the VM

`~/ponten-solutions` on Proxmox has no `user.name`/`user.email` configured, so commits land as `root@pontenprox.local`. Not breaking anything but worth setting once:
```bash
ssh nomii-prod "git config --global user.name 'Austin Ponten' && git config --global user.email '<your email>'"
```

### Security flag

The `origin` remote in `~/ponten-solutions/.git/config` has a GitHub PAT embedded directly in the URL (`https://ghp_...@github.com/...`). Seen in terminal output this session → already in shell history and process tables. Rotate at GitHub → Settings → Developer settings → PATs → revoke + reissue, then `git remote set-url origin https://github.com/jafools/ponten-solutions.git` and use SSH key or credential helper instead. Low blast radius (PAT is scoped to this repo, not org-wide), but don't forget.

### Next session TODO (updated)

1. **Visual QA the new section in a browser** — desktop + mobile. Adjust spacing/copy if anything reads awkward.
2. **Stripe receipts toggle** — Austin to enable "Successful payment receipts" + "Refund receipts" in Stripe Dashboard → Settings → Emails. Manual, 30 seconds.
3. **Stale success card at `pontensolutions.com/nomii/license?success=true`** — orphaned after Apr 15 evening redirect fix. Clean up next ponten-solutions deploy.
4. **SMTP_PASS rotation** — was visible in terminal `env` output during the earlier session. Low risk, worth rotating at convenience.
5. **portal.js split** (3,683 LOC in nomii-ai repo) — deferred post-launch.
6. **Delete 1,646 LOC of pre-portal zombie routes** — after 7-day prod log grep confirms no external traffic.
7. **Hetzner CX22 migration** — still on roadmap, not blocking.
8. **Marketing-page nitpicks** (optional): the `SelfHostedNomii.tsx` "7-day trial" copy in session notes doesn't match the actual behavior (unlimited days, capped at 20 msg/mo + 1 customer). New section copy was rewritten to say "Free trial included" — the SelfHostedNomii.tsx landing page itself is fine, but worth a copy review.

### Prod HEAD state at session end

- `nomii-ai` repo: `83ddc3a` (unchanged from earlier this evening — no nomii-ai code edits this session)
- `ponten-solutions` repo: `2086711` (NEW — this session's marketing-page fork)

---

## Earlier this evening: 2026-04-15 evening (self-hosted purchase funnel validated — live Stripe smoke test passed)

Ran a live $49 Stripe smoke test of the self-hosted Starter license flow. Payment → webhook → DB insert → license-key email → dashboard activation → plan-limits lifted — **all green end-to-end**. Prod HEAD `83ddc3a`. Self-hosted purchase funnel is shippable. Refunded the test purchase after validation.

Fixed three real bugs surfaced by the live test, created a proper post-purchase success page, and identified the marketing-page customer-journey gap as the next priority.

### Bugs fixed this session

1. **Lateris/Shenmay Stripe webhook crossfire** (fix applied in Lateris repo, cross-repo)
   - Both products share one Stripe account → both webhook endpoints receive every `checkout.session.completed` → Lateris issued a spurious Lateris license key for a Shenmay test purchase
   - Fix: negative `metadata.product_type` guard in Lateris `bin/license-worker.js`. Events with `product_type !== "lateris"` are skipped with `{ received: true, skipped: "not a Lateris checkout" }`
   - Shenmay side already stamps `metadata.product_type = 'selfhosted'` on both session AND subscription (see `server/src/routes/license-checkout.js:64-65`), so the guard works with zero Shenmay-side code changes
   - Lateris worker redeployed, stale KV entry (`LIC-2026-AUSTINPONTEN-752`) cleaned up

2. **Stale email activation instructions** (commit `26ad89a`)
   - `sendLicenseKeyEmail()` in `server/src/services/emailService.js` told buyers to SSH in, edit `.env`, set `NOMII_LICENSE_KEY=`, run `docker compose restart` — contradicts the new dashboard-first activation flow
   - Rewrote HTML + plain-text bodies: primary path is now "Log in → Plans & Billing → paste → Activate" (limits lift instantly, no restart). Kept the advanced env-var path in a collapsed `<details>` block for operators who prefer config-over-UI

3. **SMTP_FROM brand drift on prod** (env-only, no commit)
   - Prod `.env` on `nomii-prod` still had `SMTP_FROM="Knomi AI <hello@pontensolutions.com>"` — receipts branded with the retired name
   - Changed to `"Shenmay AI <hello@pontensolutions.com>"`. Required `docker compose up -d --force-recreate backend` to pick up (plain `restart` does NOT reload env files — new gotcha worth remembering)
   - Code default at `emailService.js:44` was already correct; only the prod env override was stale

### Post-purchase success page — created from scratch

Before this session: Stripe's `success_url` pointed to `pontensolutions.com/nomii/license?success=true`, which redirected through the `app.pontensolutions.com → nomii.pontensolutions.com` chain and hit the SPA catch-all → login redirect. No dedicated success page existed anywhere in the Shenmay app. The card showing on the old marketing site was orphaned legacy code with a "Go to Dashboard" button that sent self-hosted buyers to SaaS login.

Created `client/src/pages/nomii/NomiiLicenseSuccess.jsx` — self-contained, no auth, no API calls:
- Dark themed, matches `NomiiLogin` design language
- **Install command embedded inline** with a copy button — buyers who haven't installed yet don't need to leave the page:
  ```
  bash <(curl -fsSL https://raw.githubusercontent.com/jafools/nomii-ai/main/scripts/install.sh)
  ```
- Two labeled sections: "Haven't installed yet?" (Terminal icon, copy-able install cmd) + "Already running Shenmay?" (Server icon, pointing at Plans & Billing)
- Wired route `/nomii/license/success` into `client/src/App.tsx`
- Stripe `success_url` changed to `https://nomii.pontensolutions.com/nomii/license/success` — bypasses the marketing-site redirect chain entirely

Commits `41c0724` (page + route + success_url) and `83ddc3a` (inline install cmd). Deployed and verified: `nomii.pontensolutions.com/nomii/license/success` returns 200, install command present in the deployed JS bundle.

### Gotchas captured

- **`docker compose restart` does NOT reload env files.** Use `docker compose up -d --force-recreate <service>` whenever `.env` changes.
- **`curl -I` on SPA routes is diagnostically useless.** All routes return 200 for the HTML shell regardless of whether a route component exists. Trust code grep, not HTTP headers.
- **Shared Stripe accounts multiply webhook fanout.** Every product under the same Stripe account receives every event. Stamp `metadata.product_type` on session AND subscription (subscription-lifecycle events don't inherit session metadata), and add negative guards in each worker.

### Next session priority (Austin's explicit ask)

> "I want to see the clear path on my marketing page next. I want to hand hold the customers to be able to do On prem or SaaS Shenmay"

Marketing page at `pontensolutions.com/nomii/*` currently has no clear on-prem vs SaaS fork. Needs two explicit buyer journeys:

- **On-prem / Self-hosted (Trial-first)**: "Install Free (2 min)" primary CTA → runs `install.sh` → 7-day trial → upgrade in dashboard (Plans & Billing → paste Stripe key)
- **SaaS / Cloud (Managed)**: "Start Free Trial" → signup at `nomii.pontensolutions.com` → managed single-tenant instance → Stripe subscription from in-app billing

Work belongs in the `ponten-solutions` repo (not this repo). The `SelfHostedNomii.tsx` page drafted in the Apr 14 session is probably a starting point but needs review against the current branding + routing.

### Other outstanding (non-blocking)

- **Stripe customer receipts** — Austin to manually toggle in Stripe Dashboard → Settings → Emails → enable "Successful payment receipts" + "Refund receipts". Email service handles the license-key email but not invoice/receipt.
- **Stale success card** at `pontensolutions.com/nomii/license?success=true` — orphaned (nothing links to it now). Clean up on next ponten-solutions deploy or leave as-is (unreachable).
- **SMTP_PASS rotation** — Was visible in terminal output during an `env | grep` diagnostic this session. Low risk (local terminal only, not logged) but worth rotating at next convenient moment (One.com mail settings).
- **portal.js split** — 3,683 LOC. Flagged by the cleanup sweep. Deferred post-launch.
- **Pre-portal routes** (~1,646 LOC of zombies) — Needs 7-day prod log grep to confirm no external traffic before deletion.
- **Hetzner CX22 migration** — Still on roadmap. Not blocking first customer.

---

## Previous session (2026-04-15 late-evening): 8-agent codebase cleanup sweep — DEPLOYED

37 commits pushed to `origin/main` (cleanup + notes). 96 files changed, net **−5,223 LOC** across 7 merge commits + agent 5's direct commits. **Deployed to Proxmox prod** at HEAD `06f512d`. Backend + frontend containers rebuilt and healthy; external endpoints verified (`/api/health`, `/api/license/validate`, `/api/public/license/checkout`, `/widget.html`, `/embed.js` all 200).

**Still needs Austin's hands for the user-visible verification**: log into `/nomii/dashboard`, open Tools page, click "Test" on a non-connect tool — agent 7's latent bug fix means this should now work (was silently broken since `f6f0edb`). Widget chat round-trip also worth a smoke test.

### What changed (8 parallel subagents, worktree-isolated, background)

| Agent | Branch / merge | Outcome |
|---|---|---|
| 1 DRY | `merge(cleanup-1)` 70a78b8 | Extracted `lib/format.js`, `lib/clipboard.js` (copyToClipboard + plain-HTTP fallback), and `downloadAuthenticatedFile` helper in `nomiiApi.js`. Resisted extracting `ErrorState`/skeletons (drift across 8 sites); left `requireTenantAccess` vs `requireTenantScope` alone (different role checks). |
| 2 Types | `merge(cleanup-2)` bc75394 | Centralized plan/status/notification/deployment enums + JSDoc typedefs (first in repo). `server/src/config/plans.js` sources `UNRESTRICTED_PLANS`/`TRIAL_PLANS`/`VALID_ADMIN_PLANS`/`VALID_LICENSE_PLANS`. New `client/src/lib/constants.js` for `PLAN_LABELS` + enums. `DEPLOYMENT_MODES`/`isSelfHosted()` replaced 10 literal checks. 14 files touched. |
| 3 Unused | `merge(cleanup-3)` ad8fb1e | Deleted **48 client files** (42 shadcn/ui, 3 orphan hooks, `NomiiDashboard.jsx` placeholder, `Step5TestAgent.jsx`). Removed **38 npm deps** (client: `react-hook-form`, `zod`, `framer-motion`, 25 Radix primitives, cmdk, vaul…; server: `uuid`). Client CSS bundle 73.45 kB → 38.55 kB (−48%). |
| 4 Circular | `merge(cleanup-4)` 34e36d2 | **0 cycles** in client (91 files, TS/TSX aware) or server (52 files). Report-only. |
| 5 Weak types | *leaked onto main* (9b65c11 → 4908225) | Added JSDoc to `nomiiApi.js` (80+ consumers had zero docs). Narrowed `licenseService.callValidate` return shape. Added boundary `TypeError`s to `apiKeyService.encrypt/decrypt` and `promptBuilder.buildSystemPrompt`. Added `typeof` guards + length caps on 4 portal mutation routes. **Verified safe against master `/validate` contract** at `server/src/routes/license.js:82-86` — always returns `{ valid, plan, expires_at }`. |
| 6 try/catch | `merge(cleanup-6)` 8964803 | Only 2 simplifications (redundant `console.error` before `next(err)` in `middleware/subscription.js`). Report documents ~349 try/catch sites as consistently purposeful. |
| 7 Deprecated | `merge(cleanup-7)` 9f63590 | **Real latent bug fix**: `portal.js` had TWO `POST /tools/:toolId/test` handlers — older webhook-only one was shadowing the newer agentic sandbox handler (Express first-match). Tools dashboard Test button has been broken for every non-connect tool since `f6f0edb`. Removed shadower (−63 LOC). |
| 8 Comments | `merge(cleanup-8)` 7e2260b | 62 `// =====` banner lines across 10 files. 2 engine-file AI marketing headers replaced with terse module JSDoc. 4 stale narrating comments. 0 debug `console.log`s removed — all 75+ are structured `[Prefix]` grep targets. |

### Big finding from agent 7 (DEFERRED — your call)

Seven **pre-portal route files** (`chat.js`, `conversations.js`, `customers.js`, `advisors.js`, `flags.js`, `tenants.js`, `customTools.js` — ~**1,646 LOC**) have **zero in-repo callers**. All dashboard features moved to `/api/portal/*`; widget chat moved to `/api/widget/chat`. Agent deliberately did not auto-delete due to possible external consumers (WordPress plugin?). Needs a separate decision.

### Agent 5 broke isolation

Despite the worktree sandbox, agent 5 committed 6 commits directly to `main` instead of its branch (`worktree-agent-a93f98e0` is empty). Commits are still local and recoverable. Work itself is good (verified callValidate contract against master). Going forward: explicit "NEVER commit to main" in subagent briefings OR use a pre-commit hook that blocks writes to `main` inside agents' worktrees.

### Open issues the sweep surfaced (not fixed)

- `server/src/routes/portal.js` is **3,683 lines** — violates CLAUDE.md `<500-line` guideline. Should be split into route-group modules.
- `planDefaults` in `portal.js` vs `PLAN_LIMITS` shape mismatch (`null` vs sentinel int for unlimited; `managed_ai_enabled` vs `managed_ai`). Too risky pre-launch but worth aligning after first paying customer.
- Eslint config not present but devDeps installed; vitest scripts exist but no tests. Pick one: restore or remove.

### Post-merge verification (this session)

- `cd client && npm install && npm run build` → PASS (2497 modules, 4.70s)
- `cd server && npm install` → PASS
- `node -c` on 14 key server files (index, portal, widget, license, license-checkout, setup, onboard, auth, chat, promptBuilder, licenseService, apiKeyService, subscription, plans) → all PASS
- 2 merge conflicts resolved by hand: `promptBuilder.js` (agent 5 JSDoc + agent 8 banner removal) and `portal.js` (agent 7 handler removal superseded agent 8's edit inside the deleted block). Both resolutions verified by re-running `node -c`.

### Reports for review

All 8 cleanup reports landed at `docs/cleanup-reports/1-dedup.md` through `8-comments.md`. Each has methodology, concrete file:line findings, HIGH/MEDIUM/LOW recommendations, and a deferred list.

### Next-session TODO (updated)

0. **Review + push the cleanup to prod.** `git push origin main` pushes 36 commits. Then on Proxmox: `cd ~/Knomi/knomi-ai && git pull && docker compose up -d --build backend frontend`. Validate dashboard loads, Test Tool button fires, widget chat works. The sweep is LOCAL until pushed.
1. **Phase 1B-11 (Austin manual, still outstanding)** — $1 live Stripe smoke test through the now-fixed checkout. Cleanup sweep is independent of this.
2. **Phase 3** — SaaS parity audit (as in previous notes).
3. **Phase 4** — Hetzner cutover (as in previous notes).
4. **Decide on 1,646 LOC of pre-portal routes** (agent 7's HIGH deferred finding). Grep production logs for hits to `/api/chat`, `/api/conversations`, `/api/customers`, `/api/advisors`, `/api/flags`, `/api/tenants`, `/api/tools` (not `/api/portal/tools`). If zero hits in 7d, safe to delete.
5. **Split `portal.js`** (3,683 LOC → sensible route-group modules). Separate ticket.
6. **Smaller polish (unchanged)** — paid-tier upgrade banner, refactor `createNotification` to shared service.

---

## Last updated: 2026-04-15 evening (on-prem journey end-to-end shippable)

This was a "is the customer journey actually shippable" validation session that turned into a real-bug discovery + 3 commits to main + 1 prod hotfix + 1 prod deploy. The on-prem self-hosted journey is now genuinely complete end-to-end except a single user-driven smoke test ($1 Stripe).

### What changed (commits, in order)
| Commit | Subject |
|---|---|
| `5647470` | fix(deploy): pass STRIPE_SELFHOSTED_PRICE_* env vars to backend container |
| `233820a` | feat(license): in-dashboard activation for self-hosted licenses |
| `6325c1e` | feat(notifications): in-app trial-limit notification (SMTP-independent) |

### 🚨 Critical bug found and fixed (5647470)
`pontensolutions.com/nomii/license` Stripe checkout was **completely broken** — every plan/interval combo returned 503 "Price not configured". Root cause: the 6 `STRIPE_SELFHOSTED_PRICE_*` env vars were set in `.env` on prod but `docker-compose.yml`'s `environment:` block didn't list them, so they never propagated to the running backend container. `docker compose restart` doesn't pick up new env-var lists; needed `--force-recreate`.

Confirmed via the `licenses` table on prod: **0 licenses ever issued** since the checkout endpoint started returning 503. Today's fix is the first time customers can actually purchase a self-hosted license.

### 🎯 Big build (233820a) — in-dashboard license activation
Before: customer buys a license → receives email → has to SSH in, edit `.env`, run `docker compose restart`. Tech-support nightmare for the SMB target market.

After: customer buys → receives email → opens dashboard → pastes key in `/nomii/dashboard/plans` → trial limits lift instantly. No SSH, no `.env` editing, no restart.

Backend changes:
- Migration 030: `tenants.license_key` + `license_key_validated_at` columns
- `licenseService.activateLicense(key, tenantId)` — validate with master, persist to DB, `applyPlanLimits`, schedule heartbeat
- `licenseService.deactivateLicense(tenantId)` — null the key, revert to trial, clear heartbeat
- `licenseService.getLicenseStatus(tenantId)` — returns masked key + plan + validated_at + signals env_var_in_use
- `checkLicenseOnStartup()` falls back to DB key when env var unset (env var still wins for existing operator-pinned installs)
- DB-sourced key invalid on startup falls to trial rather than crashing (env-var path stays strict)
- **Heartbeat now reverts to trial on definitive failures** (revoked/expired/not-found/instance-bind-mismatch). Closes a revenue leak: previously, if a customer let their license lapse, heartbeat warned but limits stayed paid forever.

Portal endpoints (gated to `NOMII_DEPLOYMENT=selfhosted`):
- `GET    /api/portal/license` — current status
- `POST   /api/portal/license/activate` — validate + persist + lift limits
- `DELETE /api/portal/license` — clear key + revert
- `/api/portal/me` now exposes `deployment_mode` so the dashboard branches its billing UI correctly

`NomiiPlans.jsx` replaces the static "Step 1: edit .env / Step 2: restart" instruction box with an interactive activate form + status panel. Hides the form (with an explanation) when key is pinned via `NOMII_LICENSE_KEY`.

### 🛎️ In-app limit notification (6325c1e)
`sendLimitNotificationIfNeeded` previously only sent an email — useless on default installs since `install.sh` makes SMTP optional. Now also creates a `notifications` row, picked up by the dashboard bell icon. New `limit_reached` notification type with a red Zap icon in the sidebar.

### Phase 2 audit revealed three NOT-A-BUG findings
- **Plans copy "mismatch"** (marketing $349 vs dashboard $399 for Pro): different products. Self-hosted is intentionally cheaper; SaaS includes infrastructure. After the activation build, self-hosted dashboards don't even show SaaS prices anymore.
- **Global upgrade banner**: already exists at `client/src/layouts/NomiiDashboardLayout.jsx:512-552` for trial/free plans. Earlier audit was API-only and missed it. Small follow-up: doesn't fire for paid plans hitting their cap, worth a separate ticket.
- **CSV upload silent fail at customer cap**: my earlier test used multipart; correct format is JSON `{csv:"..."}`. Endpoint actually returns 200 with per-row errors + `limit_reached: true` flag.

### End-to-end verification on test VM (10.0.100.25)
Wiped completely, re-installed via `curl install.sh`, drove the entire customer journey via API:
- ✅ install.sh completes ~60s, 3 containers up, /api/health OK
- ✅ Setup wizard creates tenant + admin + key, JWT issued, idempotent (409 on retry)
- ✅ Onboarding pre-filled correctly (only `install_widget` undone — SH-1 verified)
- ✅ Tool building: created `lookup_investments` lookup tool linked to `investments` data category. AI invoked it via widget chat and returned Alice's exact seeded holdings ("100 AAPL, 50 MSFT, 25 NVDA — total $87,400 as of April 14")
- ✅ Per-minute rate limit fires at burst ~10 messages with "Message rate limit reached. Please slow down."
- ✅ Trial monthly limit (20 msg) fires correctly with `{error: "message_limit_reached"}` HTTP 429
- ✅ Synthetic license activation lifts trial→starter (20→1000 msg, 1→50 customers) instantly via dashboard endpoint, no restart
- ✅ Bad key returns clean error: `{error: "License key not found"}` HTTP 400
- ✅ Deactivate reverts to trial limits instantly
- ✅ In-app notification fires on limit hit, visible at /api/portal/notifications

### Prod state at session end
- Git: at HEAD `6325c1e`, **0 commits behind main** (was 16 behind at session start)
- All 4 containers running: db, backend, frontend, cloudflared
- Stripe checkout: returns live URLs for all 6 plan/interval combos
- License master endpoint: responsive
- New /api/portal/license/* endpoints: mounted (return 404 on SaaS by design)
- Migration 030: applied

### Customer install command (unchanged from previous session)
```bash
# Trial / dev:
NOMII_PUBLIC_URL=https://nomii.yourfirm.com \
  bash <(curl -fsSL https://raw.githubusercontent.com/jafools/nomii-ai/main/scripts/install.sh)

# Headless / CI / Ansible:
NOMII_NONINTERACTIVE=1 \
NOMII_PUBLIC_URL=https://nomii.yourfirm.com \
NOMII_LICENSE_KEY=NOMII-XXXX-XXXX-XXXX-XXXX \
NOMII_CF_TOKEN=eyJ... \
  bash <(curl -fsSL https://raw.githubusercontent.com/jafools/nomii-ai/main/scripts/install.sh)
```
Customers with no license use the dashboard activation flow built today instead of the env var.

### Next-session TODO
1. **Phase 1B-11 (Austin manual, ONLY remaining stitch)** — $1 live Stripe smoke test through the now-fixed checkout to validate the webhook → license-key-email half. Every other segment of the on-prem journey is verified end-to-end. Visit `pontensolutions.com/nomii/license`, pick Starter monthly, real email, complete checkout. Confirm: (a) email arrives with key, (b) `SELECT * FROM licenses;` on prod-DB shows the new row.
2. **Phase 3** — SaaS parity audit: walk the same customer journey on the SaaS path (signup + Stripe subscription instead of install.sh + license activation). Confirm feature parity, fix any deployment-mode drift.
3. **Phase 4** — Hetzner cutover: port docker-compose + .env + DB to Hetzner CX22, DNS swap, retire Proxmox.
4. **Smaller polish (low priority)** — paid-tier upgrade banner (current global banner is trial-only), refactor `createNotification` to a shared service (currently lives in widget.js).

### Phase 1A (landing page) — ALREADY DONE
End-of-session check on prod found `SelfHostedNomii.tsx` already committed (`ec6a63f` on prod ponten-solutions repo), `App.tsx` route mounted at `/nomii/self-hosted` above the wildcard catch-all, and `https://pontensolutions.com/nomii/self-hosted` returning HTTP 200. Austin must have applied it between sessions. The Cloudflare redirect-rule concern from the Apr 14 notes is also resolved.

### Discoveries / new context worth remembering
- Prod SSH: `ssh nomii-prod` (configured in `~/.ssh/config` → `root@10.0.100.2`). Lateris also lives on this Proxmox host — DON'T touch any `lateris-*` containers.
- Prod DB user is `knomi` (not `nomii`) — kept from old brand to preserve volume.
- License master endpoint default in `licenseService.js` is `https://api.pontensolutions.com/api/license/validate` — both `api.` and `nomii.` resolve to the same backend.
- Stripe price IDs (live mode): saved in prod `.env`. Self-hosted plans range $49–$349/mo monthly, slightly different annual.
- The widget-side per-minute rate limit ("slow down") is distinct from the trial monthly cap. Defined in `server/src/index.js:77`.

---

## Earlier today: 2026-04-15 PM (on-prem install iteration — 3 cycles, end-to-end verified)

After the SH-1/SH-2/SH-3 surgical fixes earlier in the day landed, scope expanded to "make the on-prem install actually stress-free for customers". Drove 3 iterative install cycles directly against VM 10.0.100.25 (jafools@, key set up apr-14). VM completely wiped (volumes dropped, ~/nomii rm'd) and `install.sh` re-run from raw GitHub on every cycle. Final state — cycle 3 — passed every verification cleanly.

### Commits shipped in the iteration (all on main)
| Commit | Subject |
|---|---|
| `f5c0dd5` | fix(onboarding): SH-1/SH-2/SH-3 wizard bugs |
| `642fb98` | chore(session): notes |
| `9d673c0` | fix(self-hosted): polish on-prem install — branding, cloudflared, headless mode |
| `0925c0e` | fix(install): skip clear when TERM unset or headless |
| `411ab53` | fix(self-hosted): cloudflared via profiles, fixes distroless /bin/sh |
| `2fc8dc2` | feat(install): add NOMII_GITHUB_REF for version pinning |

### Issues found and fixed
- **HTML branding leak**: `client/index.html` had Pontén marketing title + og:image to `pontensolutions.com/og-image.png`. Self-hosted operators sharing their URL got the wrong link preview. Now generic "Shenmay AI" + relative `/og-image.png`. Improvement for SaaS too.
- **8 pre-auth logo links** to `https://pontensolutions.com` across NomiiLogin (3), NomiiSignup (2), NomiiResetPassword (2), NomiiVerifyEmail (1) — same SH-3 pattern as the post-auth onboarding. Removed the `<a>` wrappers; static logos on login forms is standard UX anyway.
- **Cloudflared restart loop** — root cause: compose `command:` was passed to the cloudflared image's ENTRYPOINT, so the actual exec was `cloudflared sh -c "..."`, sh got treated as a cloudflared subcommand, exit 1, restart-looped forever. **Two failed attempts** before the right fix:
  1. Tried entrypoint override `["/bin/sh","-c"]` + `exec sleep infinity` on no-token. **Failed:** the cloudflared image is distroless, no `/bin/sh` exists.
  2. Switched to **compose `profiles: [tunnel]`**. install.sh detects `CLOUDFLARE_TUNNEL_TOKEN` in `.env` and adds `--profile tunnel` automatically. When no token, no cloudflared container exists at all. Verified scenario A (no token → 3 containers) and scenario B (token set → 4 containers, profile auto-activated).
- **install.sh `clear` crashed in headless mode** — `clear` errors with "TERM environment variable not set" when no tty + `set -e` aborts. Now gated by `[ -n "$TERM" ] && [ "$NONINT" != "1" ]`.
- **install.sh stale CDN cache** — install.sh hardcoded `main` branch URL for compose download; CDN can lag pushes by minutes. Added `NOMII_GITHUB_REF` env var so customers can pin to a release tag (the production-correct way) and so testers can pin to a SHA.
- **install.sh post-docker-install group bug** — install.sh installed Docker, added user to docker group, then immediately tried `docker compose pull` in the same shell — always failed (group not active in current shell). Now uses `DOCKER_CMD="sudo docker"` for the rest of the run when we just installed Docker. User logs out + back in for subsequent runs without sudo.
- **install.sh headless mode** — added `NOMII_NONINTERACTIVE=1` (skips `/dev/tty` redirect, reads answers from `NOMII_PUBLIC_URL`, `NOMII_SMTP_*`, `NOMII_CF_TOKEN`, `NOMII_LICENSE_KEY`). Real customer feature — needed for CI/Ansible/Terraform/Docker-build workflows. Also unblocks automated testing.

### Final verification (cycle 3, scenario A, fresh VM)
- `bash <(curl ...install.sh)` with `NOMII_NONINTERACTIVE=1 NOMII_PUBLIC_URL=http://10.0.100.25 NOMII_GITHUB_REF=<sha>` — completes in ~30s, ends with "Shenmay AI is almost ready!"
- 3 containers up: `nomii-db (healthy)`, `nomii-backend`, `nomii-frontend`. No cloudflared.
- `/api/health` → `{"status":"ok"}` in 1s
- `POST /api/setup/complete` → tenant created with `onboarding_steps` pre-filled `{tools, api_key, products, customers, company_profile: true}` — only `install_widget` undone (SH-1 verified end-to-end)
- HTML head: `<title>Shenmay AI</title>`, og:image=`/og-image.png`, og:site_name=`Shenmay AI`
- 0 `pontensolutions.com` refs on `/`, `/nomii/login`, `/nomii/setup`, `/nomii/onboarding`, `/nomii/signup`
- 20-msg trial limit: with `messages_used_this_month=20`, the 21st widget chat returns `HTTP 429 message_limit_reached`

### Customer install command (post-iteration, recommended)
```bash
# Trial / dev:
NOMII_PUBLIC_URL=https://nomii.yourfirm.com \
  bash <(curl -fsSL https://raw.githubusercontent.com/jafools/nomii-ai/main/scripts/install.sh)

# Headless / CI / Ansible:
NOMII_NONINTERACTIVE=1 \
NOMII_PUBLIC_URL=https://nomii.yourfirm.com \
NOMII_LICENSE_KEY=NOMII-XXXX-XXXX-XXXX-XXXX \
NOMII_CF_TOKEN=eyJ... \
  bash <(curl -fsSL https://raw.githubusercontent.com/jafools/nomii-ai/main/scripts/install.sh)

# Production: pin to a tag (when we cut releases)
NOMII_GITHUB_REF=v1.0.0 \
  bash <(curl -fsSL https://raw.githubusercontent.com/jafools/nomii-ai/v1.0.0/scripts/install.sh)
```

### Still open / future polish (NOT touched in this iteration)
- SH-4 (LOW): `/nomii/*` URL prefix is a SaaS artifact on self-hosted — aesthetic, not functional
- SH-5 (LOW): widget snippet template placeholders shown without inline help
- Pre-existing `widget.js:1284` join bug (selects `t.managed_ai_enabled` from tenants instead of subscriptions)
- Self-hosted onboarding shows SaaS-only steps (Products, Customers) in sidebar even though they're pre-marked done. Customer can click into them — not broken, just redundant. Worth gating those steps on deployment mode.

---

## Earlier today: 2026-04-15 (onboarding wizard bugfixes)

### What was completed (session 2026-04-15)

Three bugs from yesterday's fresh-VM install test (2026-04-14, tracked in `projects/nomii/fresh-vm-install-test-apr14-2026.md` in the Obsidian vault) fixed in one pass.

**SH-3 (CRITICAL) — hardcoded pontensolutions.com redirect mid-onboarding:**
- `client/src/pages/nomii/NomiiOnboarding.jsx:207,288` — both logo wrappers were `<a href="https://pontensolutions.com">`. Clicking the Shenmay logo in the sidebar (desktop) or header (mobile) mid-flow hard-redirected users OUT of their self-hosted instance.
- Fix: swapped to `<Link to="/nomii/dashboard">` (react-router `Link` already imported). Logo now SPA-navigates to dashboard — works for both SaaS and self-hosted.
- Note: NomiiLogin, NomiiSignup, NomiiResetPassword, NomiiVerifyEmail still hardcode the same external link on their logos. Left alone for now — those are pre-auth pages and the scoped task was onboarding.

**SH-1 — first-run wizard skipped widget install step:**
- `server/src/routes/setup.js:89` inserted tenant with `onboarding_steps='{}'`, so `/nomii/onboarding` resume logic treated every step as incomplete.
- `client/src/pages/nomii/NomiiSetup.jsx:62` routed to `/nomii/dashboard` after self-hosted setup, so the operator never passed through the widget-install UI.
- Fix:
  - `setup.js` now pre-fills `onboarding_steps` as `{company_profile, products, customers, api_key, tools: true}` via `$5::jsonb`. Only `install_widget` stays undone.
  - `NomiiSetup.jsx` now `navigate("/nomii/onboarding", ...)` on success; onboarding resume logic lands directly on Step4InstallWidget.

**SH-2 — "Installation guide" link landed on step 1:**
- `client/src/pages/nomii/dashboard/NomiiSettings.jsx:193` `<Link to="/nomii/onboarding">`. On self-hosted, because of SH-1's empty `onboarding_steps`, resume landed on step 1.
- Fix: none required. The SH-1 `onboarding_steps` pre-fill means the Settings → Widget "Installation guide" link now also lands on the widget step. Dropped from scope.

### Verification
- `npm run build` in `client/` passes — 2497 modules, 4.32s, no errors.
- `node -e "require('./server/src/routes/setup.js')"` loads cleanly.
- `onboarding_steps` column confirmed `JSONB NOT NULL DEFAULT '{}'` in migration 005, so `$5::jsonb` cast is schema-correct.

### What still needs to run (on the VM)
1. Commit + push to `main` so CI rebuilds `ghcr.io/jafools/nomii-*:latest` images (or build from source on the VM).
2. Reset the VM tenant (fresh-install scenario) — e.g. `docker exec nomii-db psql -U knomi -d knomi_ai -c "TRUNCATE tenants, tenant_admins, subscriptions CASCADE;"` — so `/api/setup/status` returns `required: true` again.
3. Rerun the first-run wizard in the browser at `http://10.0.100.25/`. Expected: after step 3 (API key), lands on `/nomii/onboarding` widget step (not dashboard).
4. Paste the widget snippet on a test page, verify → wizard flips to "You're all set!" → dashboard.
5. Click the Shenmay logo inside `/nomii/onboarding` mid-flow — must stay in-app (go to `/nomii/dashboard`), not kick out to pontensolutions.com.
6. In Settings → Widget, remove the widget from the test page so "Not yet detected" reappears, click the "Installation guide" pill, verify it lands on the widget step (not step 1).
7. **20-msg rate limit retest** — send 20 messages through the widget in trial mode, confirm 21st is blocked with the trial-exhausted error. `SELECT COUNT(*) FROM messages WHERE tenant_id = <id>` in `nomii-db` to double-check.

---

## Previous sessions

### Last updated: 2026-04-14 (session 4 of the day)

## VPS / Deployment

| Item | Detail |
|------|--------|
| Host | Proxmox VM `pontenprox` |
| Install dir | `~/Knomi/knomi-ai` (NOT `~/nomii`) |
| Compose file | `docker-compose.yml` (SaaS); `docker-compose.selfhosted.yml` (self-hosted builds) |
| Rebuild cmd | `docker compose up -d --build backend frontend` (no sudo — runs as root) |
| Pull image | `docker compose pull frontend && docker compose up -d frontend` |
| DB | `nomii-db` postgres:16, user `knomi`, db `knomi_ai` |
| Backend port | 3001 |
| Frontend port | 80 (nginx) |
| Migrations | `docker exec -i nomii-db psql -U knomi -d knomi_ai < file.sql` |

## Two repos in play

| Repo | Purpose | Where |
|------|---------|--------|
| `jafools/nomii-ai` | Shenmay AI app (backend + frontend) | `~/Knomi/knomi-ai` on Proxmox |
| `jafools/ponten-solutions` | Marketing site (Lovable, auto-deploys to `pontensolutions.com`) | `~/ponten-solutions` on Proxmox |

**Important:** Changes to `ponten-solutions` must be committed and pushed from `~/ponten-solutions` on Proxmox. Claude's sandbox cannot push to that repo directly. Always give the user commands to run on Proxmox for `ponten-solutions` changes.

---

## What was completed (session 2026-04-14)

### Earlier in session
- **nginx iframe fix** — removed `X-Frame-Options: SAMEORIGIN` for `widget.html` (commit `fd5a9d7`)
- **AI re-greeting fix** — `widgetGreeted` flag in `promptBuilder.js` (commit `9f8d299`)
- **Poll spam fix** — `pollInFlight` guard + `+1ms` cursor advance in `widget.html` (commit `f838f42`)
- **Take Over button** — added to `ThreadView` in `NomiiConversations.jsx` (commit `20896ef`)
- **Git history scrub** — secrets removed from all commits, force-pushed to main
- **Stripe key rotation** — user rotated live key, updated on VPS
- **Widget error instrumentation** — diagnostic logging added (commit `3812b0c`)
- **SaaS NOMII_DEPLOYMENT bug fixed** — `NOMII_DEPLOYMENT=selfhosted` incorrectly set in `.env` on SaaS server; removed and rebuilt

### Self-hosted license purchase flow (completed this session)
Full end-to-end flow: **self-hosted customer → pricing page → Stripe → license key by email → activate in dashboard**

**Backend (nomii-ai repo, main branch):**
- `server/src/routes/license-checkout.js` — new public endpoint `POST /api/public/license/checkout`; looks up `STRIPE_SELFHOSTED_PRICE_*` env vars, creates Stripe Checkout Session (subscription), sets `metadata.product_type = 'selfhosted'` so webhook auto-generates + emails license key (commit `016d86d`)
- `server/src/middleware/security.js` — added `https://pontensolutions.com` to `ALLOWED_ORIGINS` for CORS
- `server/src/index.js` — mounted checkout route at `/api/public/license/checkout` (no auth)

**Marketing site (ponten-solutions repo, main branch):**
- `src/pages/nomii/BuyNomiiLicense.tsx` — self-hosted pricing page with monthly/annual toggle, 3 plan cards (Starter $49/mo, Growth $149/mo, Professional $349/mo), email-capture modal, POSTs to `https://nomii.pontensolutions.com/api/public/license/checkout`, success screen on `?success=true` (commits `c7bbd16`, `6d8e816`, `4a93660`)
  - Key bugs fixed during deploy: missing SVG asset import caused module load failure; missing `import BuyNomiiLicense` in `App.tsx` caused ReferenceError
- `src/App.tsx` — added `import BuyNomiiLicense from "./pages/nomii/BuyNomiiLicense"` at line 23; route already existed at line 90 (commit `4a93660`)
- `src/pages/NomiiAI.tsx` — added "Buy a License" primary button (links to `/nomii/license`) in the "Need total control?" enterprise row of the pricing section, alongside existing "Contact Sales" (commit `bfbbbf3`)

**Lesson learned:** When transferring large files to ponten-solutions repo via SSH terminal, use `git show <commit>:path | grep -v <unwanted> > path` to restore/patch from known-good commits. Avoid heredoc and base64 for large files — both are error-prone in terminal paste.

---

## What was completed (session 2026-04-14, session 3)

### First-run browser setup wizard for self-hosted (commits `bbbb356`, `ccdbec9`)
Replaces the terminal/env-var provisioning approach with a polished 3-step web wizard.
Self-hosted users now: `docker compose up -d` → open browser → wizard → dashboard.

**Backend:**
- `server/src/routes/setup.js` (new) — `GET /api/setup/status` returns `{ required: true }` when no tenant exists; `POST /api/setup/complete` creates tenant + admin, stores Anthropic API key encrypted (AES-256 via existing apiKeyService), returns portal JWT for auto-login. Gated by `NOMII_DEPLOYMENT=selfhosted` and idempotent (409 if tenant exists).
- `server/src/index.js` — mounted setup routes at `/api/setup`
- `server/src/jobs/seedSelfHostedTenant.js` — skips silently if `MASTER_EMAIL`/`ADMIN_PASSWORD` not set (wizard handles it)
- `server/src/services/licenseService.js` — `applyPlanLimits` now forces `managed_ai_enabled=false` on self-hosted. Prevented a bug where growth+ license upgrades would break LLM calls (heartbeat was setting `managed_ai_enabled=true` but self-hosted has no platform key).

**Frontend:**
- `client/src/pages/nomii/NomiiSetup.jsx` (new) — 3-step wizard matching dark theme (company name → admin account → Anthropic key)
- `client/src/App.tsx` — added `/nomii/setup` route + `SetupRedirect` component that checks setup status on root visit
- `client/src/lib/nomiiApi.js` — added `getSetupStatus()` and `completeSetup()`

**Deployment:**
- `docker-compose.selfhosted.yml` — removed `TENANT_NAME`, `ADMIN_PASSWORD`; marked `ANTHROPIC_API_KEY` as optional
- `scripts/install.sh` — simplified to 5 steps. Prompts only for install dir, public URL, optional SMTP, optional Cloudflare token, optional license key. Final message directs user to browser wizard.

### Self-hosted landing page for pontensolutions.com
Wrote `src/pages/nomii/SelfHostedNomii.tsx` for the `ponten-solutions` repo — provided full TSX + Proxmox commands to the user. Route: `/nomii/self-hosted`. Uses dark theme, has hero with one-line install command (copy button), benefits, 4-step "how it works", requirements, trial CTA linking to `/nomii/license`.

**User action needed on Proxmox:**
1. Apply the TSX file + App.tsx route in `~/ponten-solutions`
2. Remove/scope the Cloudflare redirect rule catching `pontensolutions.com/nomii/*` → `nomii.pontensolutions.com` so the new route renders

### Verified during review
- nginx.conf correctly proxies `/api/setup/*` to backend
- Widget chat uses `req.subscription.managed_ai_enabled` (not the broken tenant join at widget.js:1284)
- `NomiiProtectedRoute` works with just localStorage token set by the wizard
- Setup endpoint idempotent + gated to self-hosted
- Found + flagged pre-existing bug at `server/src/routes/widget.js:1284` — selects `t.managed_ai_enabled` from tenants but column only exists on subscriptions. Out of scope for this session.

---

## What was completed (session 2026-04-14, session 4)

- **Annual Stripe prices configured** — All 6 price IDs now set in VPS `.env`:
  - `STRIPE_SELFHOSTED_PRICE_STARTER_MONTHLY=price_1TKfAjBlxts7IvMos78onw0X`
  - `STRIPE_SELFHOSTED_PRICE_GROWTH_MONTHLY=price_1TKfAlBlxts7IvMoEzKQSpTe`
  - `STRIPE_SELFHOSTED_PRICE_PROFESSIONAL_MONTHLY=price_1TKfAnBlxts7IvMooJKLldT7`
  - `STRIPE_SELFHOSTED_PRICE_STARTER_ANNUAL=price_1TMCtuBlxts7IvMoLwpXJafP`
  - `STRIPE_SELFHOSTED_PRICE_GROWTH_ANNUAL=price_1TMCuJBlxts7IvMoftLzEgS8`
  - `STRIPE_SELFHOSTED_PRICE_PROFESSIONAL_ANNUAL=price_1TMCukBlxts7IvMoSIeCQtOs`
  - Backend restarted. Annual toggle on `pontensolutions.com/nomii/license` now routes to correct Stripe prices.

---

## Next session TODO (priority order)

1. **Apply self-hosted landing page on pontensolutions.com** — TSX written last session. User needs to apply in `~/ponten-solutions` on Proxmox (nano the file, edit App.tsx, commit, push). Also remove/scope the Cloudflare redirect rule that catches `pontensolutions.com/nomii/*` → `nomii.pontensolutions.com`.

2. **End-to-end test the setup wizard** — create a throwaway deploy in `/tmp/nomii-test` with a port-80→8080 override and minimal `.env` (no MASTER_EMAIL/ADMIN_PASSWORD/ANTHROPIC_API_KEY). Verify wizard appears, 3 steps complete, auto-login works, widget message sends via BYOK key. Teardown with `docker compose down -v`.

3. **Smoke test annual billing** — go to `pontensolutions.com/nomii/license`, toggle to Annual, pick a plan, enter email, confirm Stripe Checkout shows annual price. Do not complete purchase, just verify redirect.

4. **Widget "Sorry, I had trouble responding" error** — instrumentation deployed, waiting for live repro. When it happens:
   ```bash
   cd ~/Knomi/knomi-ai && docker compose logs backend --tail=200 | grep -E '\[Widget\]\[chat\]|\[ERROR\] 5'
   ```

5. **Pre-existing bug at widget.js:1284** — selects `t.managed_ai_enabled` from tenants but the column lives on subscriptions. Returns undefined in that code path. Worth fixing when time permits.

---

## Key file map

| File | Repo | Purpose |
|------|------|---------|
| `server/src/routes/widget.js` | nomii-ai | Widget API — session, message, poll endpoints |
| `server/src/routes/setup.js` | nomii-ai | First-run setup endpoints (`/api/setup/status`, `/api/setup/complete`) |
| `server/src/routes/license-checkout.js` | nomii-ai | Public checkout endpoint — creates Stripe Session for self-hosted license |
| `client/src/pages/nomii/NomiiSetup.jsx` | nomii-ai | 3-step browser setup wizard (self-hosted first-run) |
| `src/pages/nomii/SelfHostedNomii.tsx` | ponten-solutions | Self-hosted landing page at `/nomii/self-hosted` (pending apply) |
| `server/src/middleware/security.js` | nomii-ai | Security headers + CORS allowed origins |
| `server/src/engine/promptBuilder.js` | nomii-ai | Builds AI system prompt; `widgetGreeted` param added |
| `server/public/widget.html` | nomii-ai | Embeddable chat widget (vanilla JS) |
| `client/src/pages/nomii/dashboard/NomiiConversations.jsx` | nomii-ai | Conversations dashboard with split-pane ThreadView |
| `client/src/lib/nomiiApi.js` | nomii-ai | All client API calls |
| `client/nginx.conf` | nomii-ai | nginx config (widget iframe fix lives here) |
| `src/pages/nomii/BuyNomiiLicense.tsx` | ponten-solutions | Self-hosted license purchase page |
| `src/pages/NomiiAI.tsx` | ponten-solutions | Shenmay product page (has Buy a License button) |
| `src/App.tsx` | ponten-solutions | Router — BuyNomiiLicense imported at line 23, route at line 90 |
| `docs/SESSION_NOTES.md` | nomii-ai | This file — session handoff |

---

## Architecture notes

- **DB name**: `knomi_ai`, **DB user**: `knomi` — kept from old Knomi AI brand to avoid breaking production
- **Poll flow**: widget polls `/api/widget/poll?since=<ISO timestamp>` every 1.5s (human) or 3s (AI)
- **JWT expiry**: 2h (`WIDGET_JWT_EXPIRY`)
- **Deployment modes**: `NOMII_DEPLOYMENT=selfhosted` for single-tenant; `NOMII_LICENSE_MASTER=true` for SaaS license server
- **Stripe webhook**: `stripe-webhook.js` handles `checkout.session.completed`; detects `metadata.product_type === 'selfhosted'` → generates license key → inserts into `licenses` table → emails to buyer. No changes needed to this file.
- **Self-hosted license flow**: buyer visits `pontensolutions.com/nomii/license` → selects plan → enters email → POST to `nomii.pontensolutions.com/api/public/license/checkout` → redirected to Stripe → webhook fires → key emailed → buyer activates in Shenmay dashboard under Plans & Billing
