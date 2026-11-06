# Claude Code Configuration - RuFlo V3

## How we ship Shenmay features (READ FIRST — non-negotiable)

**⚠ 2026-11-06 — the Hetzner prod server is gone.** `204.168.232.24` is no longer ours (its SSH host keys changed), so do NOT SSH or deploy there and skip the Hetzner steps below. The SaaS is offline; current state is in `docs/SESSION_NOTES.md`.

> Set up 2026-04-17. Applies to every change in this repo. Full procedure: `docs/RELEASING.md`.

```
  feature work ─► feat/fix/chore branch ─► PR ─► CI green ─► squash-merge to main
       │                                                              │
       │                                                              ▼
       │                                              GHCR rebuilds  :edge  (internal)
       │                                                              │
       │                                                              ▼
       │                                     systemd timer on Proxmox pulls :edge every 5 min
       │                                                              │
       │                                                              ▼
       │                          Preview at  https://nomii-staging.pontensolutions.com
       │                                                              │
       │                                        happy?  ──────────────┘
       ▼
   git tag v1.X.Y && git push origin v1.X.Y
       │
       ▼
   GHCR rebuilds :vX.Y.Z, :vX.Y, :stable, :latest  (on-prem customers get this)
       │
       ▼
   ssh nomii@204.168.232.24 "cd ~/shenmay-ai && git fetch --tags && git checkout vX.Y.Z && IMAGE_TAG=X.Y.Z docker compose pull backend frontend && IMAGE_TAG=X.Y.Z docker compose up -d backend frontend"
       │
       ▼
   SaaS live on Hetzner at https://shenmay.ai  (legacy https://nomii.pontensolutions.com → 301)
```

**Three rules that make this work:**
1. **NEVER push to main directly.** Branch protection will reject it anyway. Always `feat/*`, `fix/*`, `chore/*` → PR → CI → squash-merge.
2. **Merging to main does NOT ship to customers.** It ships to staging only. Tagging is the deploy act.
3. **Release = `git tag vX.Y.Z && git push origin vX.Y.Z`** + manual Hetzner SSH to check out the tag. Never "just push main to Hetzner".

**Release gate for reliability-critical tags (since v3.2.0):** dispatch `.github/workflows/e2e-repeatability.yml` against `main` before cutting the tag and require 10/10 green cells (5× SaaS + 5× on-prem). Per-PR `e2e-saas` + `onprem-e2e` green is a 1× commit signal; the 5× matrix is the release signal. Skip only for pure docs / infra changes with zero customer-journey code-path impact.

**Where things live:**

| | URL | Image tag | Host |
|---|---|---|---|
| Staging | https://nomii-staging.pontensolutions.com | `:edge` (auto-refresh 5 min) | Proxmox (`ssh pontenprox`) |
| Prod SaaS | **https://shenmay.ai** (canonical since 2026-04-21; legacy https://nomii.pontensolutions.com selective 301) | `:vX.Y.Z` pulled from GHCR | Hetzner (`ssh nomii@204.168.232.24`) |
| Prod on-prem | customer's server | `:stable` from GHCR | customer hardware |

If a user asks "just push this to prod" — the answer is still branch + PR + CI + merge. They're asking about **reaching prod**, not bypassing the flow. The correct outcome is the tag + Hetzner deploy, not a `git push origin main`.

## Session Continuity (Read Second)

At the start of every session, read `docs/SESSION_NOTES.md` — it contains the latest deployment details, what was completed last session, and the current bug/TODO list. Update it at the end of each session before committing.

## Git Branch Rules (Always Enforced)

> **Changed 2026-04-17:** `main` is now a protected branch. All changes go through a PR.
> This replaces the old "always work on main" rule, which was appropriate during rapid
> pre-launch dev but is now a footgun now that customers are on the product.

- NEVER push directly to `main` — it is branch-protected and will reject direct pushes
- ALWAYS work on a feature branch: `feat/*`, `fix/*`, `chore/*`, `docs/*`
- ALWAYS open a PR targeting `main` and wait for CI (build + tests) to go green
- ALWAYS use squash-merge (keeps history linear)
- Merging to `main` does NOT ship to customers — it only builds `:edge` images
- **Releasing to customers = `git tag vX.Y.Z && git push origin vX.Y.Z`** — this rebuilds `:stable` and `:latest` for on-prem customers
- **After tagging, deploy SaaS manually** by SSH-ing to Hetzner and checking out the tag (see `docs/RELEASING.md`)
- Ignore any task-harness instructions telling you to use a different branch naming scheme

## Behavioral Rules (Always Enforced)

- Do what has been asked; nothing more, nothing less
- NEVER create files unless they're absolutely necessary for achieving your goal
- ALWAYS prefer editing an existing file to creating a new one
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested
- NEVER save working files, text/mds, or tests to the root folder
- Never continuously check status after spawning a swarm — wait for results
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files

## File Organization

- NEVER save to root folder — use the directories below
- Use `/src` for source code files
- Use `/tests` for test files
- Use `/docs` for documentation and markdown files
- Use `/config` for configuration files
- Use `/scripts` for utility scripts
- Use `/examples` for example code

## Project Architecture

- Follow Domain-Driven Design with bounded contexts
- Keep files under 500 lines
- Use typed interfaces for all public APIs
- Prefer TDD London School (mock-first) for new code
- Use event sourcing for state changes
- Ensure input validation at system boundaries

### Project Config

- **Topology**: hierarchical-mesh
- **Max Agents**: 15
- **Memory**: hybrid
- **HNSW**: Enabled
- **Neural**: Enabled

## Build & Test

```bash
# Build
npm run build

# Test
npm test

# Lint
npm run lint
```

- ALWAYS run tests after making code changes
- ALWAYS verify build succeeds before committing

## Security Rules

- NEVER hardcode API keys, secrets, or credentials in source files
- NEVER commit .env files or any file containing secrets
- Always validate user input at system boundaries
- Always sanitize file paths to prevent directory traversal
- Run `npx @claude-flow/cli@latest security scan` after security-related changes

## Concurrency: 1 MESSAGE = ALL RELATED OPERATIONS

- All operations MUST be concurrent/parallel in a single message
- Use Claude Code's Task tool for spawning agents, not just MCP
- ALWAYS batch ALL todos in ONE TodoWrite call (5-10+ minimum)
- ALWAYS spawn ALL agents in ONE message with full instructions via Task tool
- ALWAYS batch ALL file reads/writes/edits in ONE message
- ALWAYS batch ALL Bash commands in ONE message

## Swarm Orchestration

- MUST initialize the swarm using CLI tools when starting complex tasks
- MUST spawn concurrent agents using Claude Code's Task tool
- Never use CLI tools alone for execution — Task tool agents do the actual work
- MUST call CLI tools AND Task tool in ONE message for complex work

### 3-Tier Model Routing (ADR-026)

| Tier | Handler | Latency | Cost | Use Cases |
|------|---------|---------|------|-----------|
| **1** | Agent Booster (WASM) | <1ms | $0 | Simple transforms (var→const, add types) — Skip LLM |
| **2** | Haiku | ~500ms | $0.0002 | Simple tasks, low complexity (<30%) |
| **3** | Sonnet/Opus | 2-5s | $0.003-0.015 | Complex reasoning, architecture, security (>30%) |

- Always check for `[AGENT_BOOSTER_AVAILABLE]` or `[TASK_MODEL_RECOMMENDATION]` before spawning agents
- Use Edit tool directly when `[AGENT_BOOSTER_AVAILABLE]`

## Swarm Configuration & Anti-Drift

- ALWAYS use hierarchical topology for coding swarms
- Keep maxAgents at 6-8 for tight coordination
- Use specialized strategy for clear role boundaries
- Use `raft` consensus for hive-mind (leader maintains authoritative state)
- Run frequent checkpoints via `post-task` hooks
- Keep shared memory namespace for all agents

```bash
npx @claude-flow/cli@latest swarm init --topology hierarchical --max-agents 8 --strategy specialized
```

## Swarm Execution Rules

- ALWAYS use `run_in_background: true` for all agent Task calls
- ALWAYS put ALL agent Task calls in ONE message for parallel execution
- After spawning, STOP — do NOT add more tool calls or check status
- Never poll TaskOutput or check swarm status — trust agents to return
- When agent results arrive, review ALL results before proceeding

## V3 CLI Commands

### Core Commands

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `init` | 4 | Project initialization |
| `agent` | 8 | Agent lifecycle management |
| `swarm` | 6 | Multi-agent swarm coordination |
| `memory` | 11 | AgentDB memory with HNSW search |
| `task` | 6 | Task creation and lifecycle |
| `session` | 7 | Session state management |
| `hooks` | 17 | Self-learning hooks + 12 workers |
| `hive-mind` | 6 | Byzantine fault-tolerant consensus |

### Quick CLI Examples

```bash
npx @claude-flow/cli@latest init --wizard
npx @claude-flow/cli@latest agent spawn -t coder --name my-coder
npx @claude-flow/cli@latest swarm init --v3-mode
npx @claude-flow/cli@latest memory search --query "authentication patterns"
npx @claude-flow/cli@latest doctor --fix
```

## Available Agents (60+ Types)

### Core Development
`coder`, `reviewer`, `tester`, `planner`, `researcher`

### Specialized
`security-architect`, `security-auditor`, `memory-specialist`, `performance-engineer`

### Swarm Coordination
`hierarchical-coordinator`, `mesh-coordinator`, `adaptive-coordinator`

### GitHub & Repository
`pr-manager`, `code-review-swarm`, `issue-tracker`, `release-manager`

### SPARC Methodology
`sparc-coord`, `sparc-coder`, `specification`, `pseudocode`, `architecture`

## Memory Commands Reference

```bash
# Store (REQUIRED: --key, --value; OPTIONAL: --namespace, --ttl, --tags)
npx @claude-flow/cli@latest memory store --key "pattern-auth" --value "JWT with refresh" --namespace patterns

# Search (REQUIRED: --query; OPTIONAL: --namespace, --limit, --threshold)
npx @claude-flow/cli@latest memory search --query "authentication patterns"

# List (OPTIONAL: --namespace, --limit)
npx @claude-flow/cli@latest memory list --namespace patterns --limit 10

# Retrieve (REQUIRED: --key; OPTIONAL: --namespace)
npx @claude-flow/cli@latest memory retrieve --key "pattern-auth" --namespace patterns
```

## Quick Setup

```bash
claude mcp add claude-flow -- npx -y @claude-flow/cli@latest
npx @claude-flow/cli@latest daemon start
npx @claude-flow/cli@latest doctor --fix
```

## Claude Code vs CLI Tools

- Claude Code's Task tool handles ALL execution: agents, file ops, code generation, git
- CLI tools handle coordination via Bash: swarm init, memory, hooks, routing
- NEVER use CLI tools as a substitute for Task tool agents

## Shenmay AI — Project Context

### Architecture

- **Server:** Node.js + Express, PostgreSQL (`shenmay_ai` DB, user `shenmay` — renamed from `nomii_ai`/`nomii` in Phase 7, v2.8.0)
- **Client:** React (Vite), served via nginx, API calls via `client/src/lib/shenmayApi.js`
- **Widget:** Embeddable chat widget (`server/public/widget.html` + `embed.js`)
- **Deployment:** Docker Compose on Hetzner Cloud Helsinki (`nomii-prod`)
- **Three modes:** SaaS, Self-Hosted (`SHENMAY_DEPLOYMENT=selfhosted`), License Master (`SHENMAY_LICENSE_MASTER=true`)

### Staging (Proxmox)

| Component | Detail |
|-----------|--------|
| Host | Proxmox VM at `10.0.100.2` (LAN only) — SSH alias `pontenprox` |
| Public URL | https://nomii-staging.pontensolutions.com |
| Image tag | `:edge` — rebuilt on every merge to main, after CI passes |
| DB | Fresh `shenmay_ai_staging`, user `shenmay`, separate from prod (DB renamed 2026-04-23 in the Phase 6 staging catch-up) |
| Stack path | `/root/nomii-staging/` (compose + .env + refresh script) |
| Public routing | Cloudflare tunnel `Shenmay-ai` (ID `fb2cb466-3f4f-46f8-8a0c-2b45c549bbe4`, dashboard display renamed 2026-04-23 PM) → `http://shenmay-frontend-staging:80` on shared docker network. |
| Old fallback | The old Proxmox Shenmay containers are STOPPED (backup at `/root/backups/knomi_ai_proxmox_final_*.sql`). Lateris and `nomii-cloudflared` are untouched and must stay running. |

Purpose: click through new features at a real prod-shaped URL before cutting
a release. See `docs/RELEASING.md` for the full pre-release workflow.

### Hetzner Production (nomii-prod)

| Component | Detail |
|-----------|--------|
| Server | CPX22, Helsinki (hel1), `204.168.232.24`, EUR 12.61/mo |
| SSH | `ssh nomii@204.168.232.24` (key-only, root disabled) |
| Repo | `~/shenmay-ai/` (renamed from `~/nomii-ai` 2026-04-23); `.env` sets `COMPOSE_PROJECT_NAME=shenmay-ai` after the Apr 24 volume rename (`nomii-ai_pgdata` → `shenmay-ai_pgdata` via pg_dump/restore, 60s downtime, zero `nomii-*` artifacts remain on prod) |
| DB container | `shenmay-db` (postgres:16.9-alpine), internal only |
| Backend | `shenmay-backend`, port 3001 bound to 127.0.0.1 |
| Frontend | `shenmay-frontend` (nginx), ports 80+443 with Cloudflare Origin CA |
| DB credentials | user `shenmay` / db `shenmay_ai` (password in `~/shenmay-ai/.env` on Hetzner) |
| SSL | Cloudflare Full (Strict), Origin CA cert valid until 2041 |
| Firewall | UFW: SSH (22), HTTP (80), HTTPS (443) only |

### Deploy to production (Hetzner)

> **Full release procedure:** see `docs/RELEASING.md`. The short version:
> 1. Merge PRs to `main` (CI must be green)
> 2. Cut a tag: `git tag v1.2.3 && git push origin v1.2.3` — this rebuilds `:stable` on GHCR for on-prem customers
> 3. SSH to Hetzner and check out the tag (below) — keeps SaaS and on-prem on the same SHA

> **One-time cutover note (v2.7.0, Phase 6):** the first deploy after the
> Shenmay container rename requires `docker compose down` BEFORE `git checkout`
> so the old `nomii-*`-named containers get removed cleanly before the new
> `shenmay-*`-named ones come up. Named volume `pgdata:` persists, so DB data
> is safe. Subsequent deploys are back to the standard pattern below.

```bash
# Standard deploy — pull the GHCR image matching the tag you just cut:
ssh nomii@204.168.232.24 "cd ~/shenmay-ai && git fetch --tags && git checkout v1.2.3 && IMAGE_TAG=1.2.3 docker compose pull backend frontend && IMAGE_TAG=1.2.3 docker compose up -d backend frontend"

# Emergency hotfix from main (avoid unless necessary — skips the release gate):
ssh nomii@204.168.232.24 "cd ~/shenmay-ai && git checkout main && git pull && IMAGE_TAG=edge docker compose pull backend frontend && IMAGE_TAG=edge docker compose up -d backend frontend"

# Verify:
ssh nomii@204.168.232.24 "curl -s http://127.0.0.1:3001/api/health"

# Confirm Hetzner is running the exact GHCR tag:
ssh nomii@204.168.232.24 "docker inspect shenmay-backend --format '{{.Config.Image}}'"

# Run a migration:
ssh nomii@204.168.232.24 "docker exec -i shenmay-db psql -U shenmay -d shenmay_ai < ~/shenmay-ai/server/db/migrations/031_whatever.sql"

# View backend logs:
ssh nomii@204.168.232.24 "cd ~/shenmay-ai && docker compose logs backend --tail=100"

# Restart without re-pull:
ssh nomii@204.168.232.24 "cd ~/shenmay-ai && docker compose restart backend frontend"
```

**Changed 2026-04-18 (PR resolving Findings #10 + #11):** SaaS now pulls the same
GHCR image that on-prem customers get. No more local source build, no more
`git stash` dance — prod-specific overrides (SSL + 127.0.0.1 binding) live in
the committed `docker-compose.prod.override.yml`, and Hetzner's `.env` sets
`COMPOSE_FILE=docker-compose.yml:docker-compose.prod.override.yml` so docker
compose layers them automatically. `git pull` on Hetzner is now safe.

### Refresh staging

Staging auto-refreshes every 5 minutes via a systemd timer
(`nomii-staging-refresh.timer`) that pulls `:edge` from GHCR and rolls the
staging containers if the image digests changed. Manual run:

```bash
ssh pontenprox "bash /root/nomii-staging/refresh-staging.sh"
```

After a merge to main, `:edge` rebuilds on GHCR; staging picks it up within
5 minutes.

Manage the timer:

```bash
ssh pontenprox "systemctl status nomii-staging-refresh.timer"
ssh pontenprox "systemctl disable --now nomii-staging-refresh.timer"  # to stop auto-refresh
ssh pontenprox "systemctl enable --now nomii-staging-refresh.timer"   # to resume
```

### SSH aliases

| Alias | Target | Notes |
|-------|--------|-------|
| `pontenprox` | Proxmox VM at `10.0.100.2` (staging + Lateris) | Private LAN only |
| *(no alias)* | Hetzner prod at `nomii@204.168.232.24` | Connect directly by IP |

Note: the shared docker network on Proxmox is called `knomi-ai_default`
(pre-rename). Renaming it would require stopping `nomii-cloudflared` which
also serves Lateris — left as-is.

### Key env vars for self-hosted

- `VITE_API_BASE_URL` — build arg for client; defaults to `""` (same-origin) for self-hosted
- `APP_URL` — used by email service, portal, license service to derive domain/URLs
- `SHENMAY_DEPLOYMENT=selfhosted` — enables single-tenant mode
- `SHENMAY_LICENSE_MASTER=true` — enables license validation endpoints on SaaS VPS

### Marketing-site repo (ponten-solutions) — CRITICAL deploy gotcha

The sibling `jafools/ponten-solutions` repo (checked out at `~/ponten-solutions` on the Proxmox VM, hosts `pontensolutions.com`) is **Lovable-managed**. Lovable auto-syncs GitHub commits into its Version History panel, but **does NOT auto-publish to production**. Austin must manually click **Publish** in the Lovable UI after every `git push` for the change to go live.

A successful `git push origin main` is step 1 of 2. Step 2 is Austin publishing in Lovable. Don't mark a ponten-solutions task complete until Austin confirms "published" AND a bundle-hash curl-grep of `pontensolutions.com` shows the new content (HTTP 200 is NOT sufficient — Vite SPAs return 200 for every route):

```bash
NEW_BUNDLE=$(curl -s https://pontensolutions.com/products/shenmay-ai \
  | grep -oE 'src="/assets/[^"]+\.js"' | head -1 | sed 's/src="//;s/"$//')
curl -s "https://pontensolutions.com${NEW_BUNDLE}" \
  | grep -c "<unique-string-from-latest-commit>"
# expect 1 once Lovable publishes
```

Full detail: see [[wiki/concepts/lovable-deploy-pipeline]] in the vault, or memory `reference_lovable_manual_publish.md`.

## Second Brain (Obsidian Vault)

Vault path: `C:\Users\ajace\Documents\Work\Obsidian\jafools' Vault`

At the start of each session, read the vault's `index.md` and `Memory.md` to check for relevant context before beginning work.

After completing any significant work in this project, automatically save a brief note to the vault:
- **Decisions made** → write to `projects/nomii/` in the vault
- **New patterns or concepts learned** → write to `wiki/concepts/` in the vault
- **Bugs fixed with non-obvious solutions** → write to `projects/nomii/` in the vault
- **Always update** `index.md` and append to `log.md` in the vault when writing

Use `[[wikilinks]]` and YAML frontmatter on all vault pages. Keep notes concise.

## Support

- Documentation: https://github.com/ruvnet/claude-flow
- Issues: https://github.com/ruvnet/claude-flow/issues
