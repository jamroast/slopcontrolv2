# SlopControl v2

Planning-driven agent orchestration built on Mastra. TypeScript monorepo.

## Lifecycle

1. **Open project** — reverse-engineer or validate a living `BLUEPRINT.md` (+ `ROADMAP.md`). Stale blueprints are archived under `.slopcontrol/archive/`.
   - **Empty folder (greenfield):** requires `intent` (“what are we building?”). Returns `needs_intent` if omitted. Creates blueprint/roadmap from the idea and `git init` if needed.
   - **Nested under another git repo:** SlopControl requires a **dedicated** `.git` in the project folder (toplevel must equal the project root). If the folder only sits inside a parent repo, open/develop initializes a nested repo there — it will not attach worktrees or merges to the parent.
2. **Start change** — creates the next ordered phase folder (`01-slug`, `02-slug`, …) with research → `PHASE.md` review. Optional `dependsOn: ["01-…"]` blocks **development** until those phases are `complete`.
3. **Develop** — coding tools run in a **checked-out git worktree** under `~/.slopcontrol/worktrees/<projectId>/<phaseId>` on branch `slop/<phaseId>`. **One active develop job per project** (`start_development` / `retry_development` / `retry_verify`); a second call returns `409 development_in_progress` while the job is live. Failed / blocked / interrupted / complete runs do **not** hold the lock — another phase can start develop immediately after.
4. **Runs are project-scoped** — list via `GET /projects/:id/runs` (never a global dump).

## Packages

- `@slopcontrol/types` — shared Zod schemas and domain types
- `@slopcontrol/artifacts` — BLUEPRINT / ROADMAP / ordered phases / archive
- `@slopcontrol/llm` — generic LLM endpoint registry
- `@slopcontrol/coding-tools` — OpenCode adapter + git worktrees
- `@slopcontrol/mastra` — Mastra agents and orchestrator
- `@slopcontrol/obsidian` — optional Obsidian vault sync

## Apps

- `@slopcontrol/server` — Express REST/SSE + MCP
- `@slopcontrol/web` — Next.js test UI
- `@slopcontrol/cli` — `slopcontrol` stack CLI (`up` / `down` / `logs` / `status` / `init`)

## Quick start

```bash
pnpm install
pnpm build
pnpm slopcontrol -- up -d       # start detached (server :3020); logs → ~/.slopcontrol/cli/logs/
pnpm slopcontrol -- logs -f     # tail stack logs (or: logs -f --up to start if needed)
# stop: pnpm slopcontrol -- down
pnpm slopcontrol -- status
```

Foreground (stream to terminal + log files; Ctrl+C stops managed processes):

```bash
pnpm slopcontrol -- up
```

Stack config: [`slopcontrol.yaml`](slopcontrol.yaml) at the repo root (or walk-up / `~/.slopcontrol/slopcontrol.yaml`). Run `pnpm slopcontrol -- init` to write a default file. Coding engine is `coding.engine` (default `opencode`). Optional web UI: set `web.enabled: true` in the YAML, or `pnpm dev:web`.

Low-level aliases (still work):

```bash
pnpm dev              # Express server on :3020 only
pnpm dev:web          # Next.js UI on :3021
pnpm dev:opencode     # headless OpenCode on :4096 only
```

```bash
mkdir -p ~/.slopcontrol
cp endpoints.example.json ~/.slopcontrol/endpoints.json
# Stack secrets (portable): ~/.slopcontrol/.env  — loaded by `slopcontrol up` for server + OpenCode
# Local monorepo alternate: put OLLAMA_API_KEY in the repo root .env (also loaded when present)
# Optional: EXA_API_KEY for research web_search + OpenCode websearch (see Internet research)
# Optional: SLOPCONTROL_LOG_LEVEL=debug|info|warn|error (default info; logs go to stderr)
```

### Internet research

Research, blueprint, and planner Mastra agents can use:

- `web_search` — Ollama Cloud when `OLLAMA_API_KEY` is set (default), else Exa (`EXA_API_KEY` / `SLOPCONTROL_EXA_API_KEY`). Order in `~/.slopcontrol/web-search.json`; diagnose with MCP `web_search_status`.
- `fetch_url` — HTTPS GET of a public doc URL (no API key; blocks localhost/private IPs)

Develop (OpenCode) uses OpenCode’s `websearch` / `webfetch` when Exa is enabled:

- Set `EXA_API_KEY` (same key)
- `ensureOpenCodeRunning` sets `OPENCODE_ENABLE_EXA=1` when spawning OpenCode
- `pnpm slopcontrol -- up` / `pnpm dev:opencode` also default `OPENCODE_ENABLE_EXA=1` (still needs the key)

Restart the stack (`pnpm slopcontrol -- up`) after setting the key. Agents should prefer repo tools first, cite URLs, and never curl product APIs with secrets.

### MCP tools

Primary endpoint (Streamable HTTP, same process as REST):

```bash
pnpm --filter @slopcontrol/server dev
# → http://localhost:3020/mcp
```

Optional auth: set `SLOPCONTROL_MCP_TOKEN` and send `Authorization: Bearer <token>`. If unset, `/mcp` is open (intended for local `127.0.0.1`).

Optional stdio adapter (same tools, for clients that only speak stdio):

```bash
pnpm mcp:stdio
```

- `open_project` — bootstrap/validate blueprint (`rootPath`, optional `forceRefresh`)
- `reinit_project` — archive planning, reverse-engineer BLUEPRINT from source, reset to phase zero (`projectId` or `rootPath`)
- `ask` — project-scoped AI conversation (`projectId`, `message`; optional `askId` to continue, `title`). Exploratory, **read-only** (no shell) — does not create a phase.
- `ask_sub_research` — up to **4** ephemeral parallel investigations inside an open ask (`projectId`, `askId`, `topics[]`). Findings append to the ask transcript; no phases / no `RESEARCH.md`.
- `list_asks` / `get_ask` — list or fetch ask sessions for a project
- `promote_ask` — turn an ask into a phase and start research (`projectId`, `askId`; optional `description`, `dependsOn`). Then use review / `start_design` / `start_development` as usual.
- `agent` — project-scoped inspect/verify chat with **`run_command` in the project root** (`projectId`, `message`; optional `agentId` / `title`). Not development — no worktrees, design, or merge. For implementation use `ask` → `promote_ask` or `start_change`.
- `list_agents` / `get_agent` — list or fetch agent chat sessions for a project
- `start_change` — new ordered phase directly (`projectId`, `description`) without an ask conversation
- `plan_loop_start` / `plan_loop_continue` / `plan_loop_accept` / `plan_loop_promote` — chat-driven **plan** sessions (structured `PLAN.md` under `.slopcontrol/plan-loops/`). Iterate like design loops; tick `ACCEPTANCE` (goal/scope/approach/areas/success/risks); accept compiles `PLAN_PACK.json`; promote binds to a phase and starts research with the plan as an authoritative contract (does **not** skip RESEARCH.md). Prefer this over thin `ask` → `promote_ask` Task briefs for multi-turn planning. Also: `plan_loop_get`, `plan_loop_acceptance`, `plan_loop_retry`, `plan_loop_versions`, `plan_loop_discard`, `list_plan_loops`.
- `design_loop_start` / `design_loop_continue` / `design_loop_accept` / `implement_design` — chat-driven look-and-feel mocks (HTML under `.slopcontrol/design-loops/`). **Accept freezes a feature checklist** (`ACCEPTANCE.json`: palette, logo, type, applied_shell, theme_modes, …) that research/draft must plan; unticked items are out of scope. After implement, `design_loop_continue` reopens the same loop for v2+; accept again, then `implement_design` (omit `phaseId` — a prior implement on the loop always opens a **new** phase + research even if the old phase is still incomplete; only pass `phaseId` to force rebind without a new phase). **Extension delta:** after a prior implement, logo/icon/`assets_only` continues clear out-of-focus ticks and research/develop use only the newly accepted features (vs `lastImplementedFeatureIds`); re-tick prior screens/theme only when you want a broader redo. New phases take the current `REQUEST.md` + delta labels, not the original loop brief.
- `relaunch_design_research` — recovery when a loop is already **accepted/implemented** but research never ran (or only rebound `design_complete`). Creates a **new** phase, rebinds the current mock + pack + UI-SPEC, and always starts research. Pass `loopId` and/or stuck `phaseId`. Then review → `start_development`.
- **Conceptual model** — durable scope + theme contract on the loop (`META.scope` + `DESIGN_PACK.json`): `kind` (`product`|`shell`|`screen`|`component`|`flow`), `focus` (e.g. `chat.composer`, `theme`), `preserve[]`, and structured `theme` (`data-theme` mechanism, dark/light CSS, requirements). Chat can narrow (“only the chat form”) or widen (“whole site”); start accepts optional `scope` override. Returned as `conceptualModel` on start/continue/get/accept/implement. Acceptance seeds and mock prompts follow the scope (component loops do not auto-require full shell).
- **`applied_shell` chrome layout:** when the accepted mock shows a content-aligned menubar (e.g. `.menubar__inner` at `max-width: var(--content-max)`), that layout is part of `DESIGN_PACK.shell` and UI-SPEC Layout — develop must implement and prove it (claim-vs-proof greps for `--content-max` / inner wrapper + Menubar mount). This is **not** LIVE SITE `navAlign` (syncing nav labels/hrefs with code). Continues like “centre the menubar over page content / same width as the contents” target `shell`/`layout`, not `navAlign`.
- Theme contract: mocks with dark/light toggle compile `theme.lightTokensCss` into the pack and phase `tokens.css`; research/develop must wire `html[data-theme]` (not an unused `.light` class). `implement_design` may return `themeContractWarning` when product CSS lacks light remaps (warn posture).
- `design_loop_acceptance` — save checklist ticks without freezing the loop
- `design_loop_pin` / `design_loop_unpin` / `design_loop_concepts` — pin authoritative concept/asset per slot (logo/palette/…); list candidates + selections. Continues prefer pinned / true RGBA over inventing a new mark.
- `design_loop_versions` / `design_loop_discard` — version tree (`parentVersion`, active|invalid); soft-discard bad tips (rewinds tip to parent). `design_loop_continue` accepts optional `baseVersion` to fork from an active ancestor.
- **Chat intent is LLM-first:** design-loop **start and continue**, plan-loop continue, dependency intent, and Change Intent are classified by the `classification` role into structured JSON. Phrasing need not match fixed templates — “using jamroast-components”, “pull theme from X”, “unhappy with the logos”, etc. all go through the LLM. On success, regex does **not** merge or override fields. Regex (`fallbackContinueIntentFromText` / `detectDependencyIntentFromText` / `extractChangeIntent`) is **failure/offline only** (`catch` or `heuristicOnly`). Absolute paths, `@scope/pkg`, and on-disk asset filenames remain pure extractors after intent is known.
- Design-loop intent fields: `scope`, `targets`, `inventLogo`, `inventLogoCount`, `adoptTheme`, `adoptChrome`, `shareFrom`, `reuseProjectDesign`, `navAlign`, `preserveChrome`, optional `designScope`. Sibling share auto-import runs when `adoptTheme` / `adoptChrome` / `shareFrom` (or an absolute path) is set — not from bare “palette” mentions. “Look and feel” from a sibling sets `adoptChrome` (shell/layout + theme-toggle when resolvable), not palette-only. Dissatisfaction (“unhappy with the logos”) should set `inventLogo` via the classifier — the prior logo pin is unpinned, `generate_image` may run with `inventNew=true`, and the final mock is **not** force-patched back to the old pin. When the operator asks for **N** logo ideas (`inventLogoCount`), the agent generates N variants into a concept grid and does **not** auto-pin; pin/use a chosen mark on a follow-up.
- **Sibling theme share:** chat/`import-design` pulls palette + dual-theme tokens **and** `DESIGN_PACK.shell` chrome notes from a **named** sibling (registered project name, folder basename, or absolute path via `shareFrom` / `fromName`). There are no built-in brand→folder aliases. Chat auto-detect uses **longest identifier match** with hyphen-safe boundaries (`jamroast` does not match inside `jamroast-components`). Accidental self-`SHARED_FROM` is ignored. When SHARED DESIGN is active it outranks LIVE SITE for palette/tokens/logos/shell; LIVE SITE keeps nav/routes/screen copy. Token excerpts include `.dark`/`.light` ladders, not only `:root`. Mock drift uses static HTML fingerprints with **hard vs soft** severity: hard contracts (pinned logo swap, competing theme-toggle, structure diffs on `assets_only` / `nav_align` / `preserveChrome`) discard the agent mock; soft structural diffs on surgical continues warn in NOTES and **keep** the agent mock. Nav compares label **sets** (order-insensitive).
- **Prior project design (fresh loop):** if a loop got dirty, start a **new** `design_loop_start` and ask to pull the **current/existing theming** / design pack / design concepts. SlopControl seeds `PRIOR_DESIGN.json` from the latest accepted/implemented loop in the same project (else phase `design/tokens.css` + mock), copies logos, and grounds v1 on that prior mock — it does **not** invent a new palette. Prefer `design_loop_continue` on the same loop when you are still iterating that thread; use a fresh loop + prior seed when you want a clean transcript grounded on the existing theming document.
- **Example recovery (JamPress loop `1511ce7f-…`):** rebuild/restart the SlopControl server, then `design_loop_continue` asking to invent new logos **and** adopt theme from a registered sibling (or MCP `import-design` with `fromName` / `fromRootPath`). Prior self-`SHARED_FROM` is ignored automatically; re-import overwrites with a real sibling.
- **Shared design elements (A+B+C):** versioned controls under `.slopcontrol/elements/<id>/vN/` (project library) and optionally `~/.slopcontrol/shared-elements/` (global registry). Each element has `ELEMENT.json`, `SPEC.md`, `mock.html`, optional `tokens.css` + `src/` TS/JS, plus a scaffolded `@jam/<id>` `npm-package/` (code entry when project source is found; otherwise mock/tokens exports). Author in a central brand project → `list_extractable_design_elements` (lists candidates + `sourcePaths` / `npmPackage`) → `design_element_extract` with that `elementId` (tag-balanced mock region + mapped `src/` when present) / `design_element_publish` (set `publishToRegistry` for B). Push to Verdaccio with `design_element_publish_npm`. Consume via chat (“import the elements from &lt;project&gt;” bulk-imports + deterministically applies menubar/shell to the mock) or `design_element_import`, then `pnpm add @jam/…`. Accept freezes `DESIGN_PACK.elements[]`; implement binds `design/elements/` and research must mount by id (prefer `src/` when `hasCode`). Competing day/night toggles while `theme-toggle` is pinned are rejected as drift. Also: `list_design_elements`, `design_element_get`.
- **Private npm registry (Verdaccio):** SlopControl auto-starts a full private registry at `http://127.0.0.1:4873` under `~/.slopcontrol/npm-registry/` (disable with `SLOPCONTROL_NPM_REGISTRY=0`; port via `SLOPCONTROL_NPM_REGISTRY_PORT`). Scopes `@jam/*` and `@slopcontrol/*` are private (no uplink); other packages proxy to npmjs. MCP/HTTP: `npm_registry_status` / `start` / `stop` / `ensure_rc` / `list` / `publish`. After `design_element_publish_npm`, consumers run `npm_registry_ensure_rc` then `pnpm add @jam/<element>`. Orthogonal to monorepos — separate project folders still work. Prefer not committing generated `.npmrc` auth tokens. **Never use `npm link` / `pnpm link`** between sibling projects — the private registry is the supported install path.
- **Cross-chat dependency awareness:** ask, agent, plan_loop, and research/draft/develop inject a CROSS-PROJECT DEPS catalog (elements + private npm packages + registered projects) plus DEPENDENCY INTENT when the operator says things like “use theme-toggle from &lt;registered-project&gt;” or “add @scope/…”. MCP/HTTP: `list_cross_project_deps` (`GET /projects/:id/cross-deps`) and `resolve_dependency` (`POST /projects/:id/resolve-dependency`) → then `npm_registry_ensure_rc` → `pnpm add` and/or `design_element_import`. PLAN_PACK may include `dependencies[]` parsed from Likely areas / Handoff notes.
- `design_loop_get` — meta + **transcript** + mock HTML/notes + **acceptance** checklist + **conceptualModel** + `concepts`/`selections` + `assets[]` + `siteInventory` summary + `usedScaffold` (pass `includeHtml=false` for chat-only). Mock HTML asset `src`s are rewritten to path-only HTTP URLs at serve time; on-disk `mock.html` keeps project-relative paths.
- `design_loop_site_inventory` — live project nav/routes/tokens/logos **plus per-route screen copy** (headings, table columns, form fields, buttons) and domain entity field names (TS/zod/prisma). Read-only from source; rebuilds `SITE_INVENTORY.json`. Continues use this for menu align and for real UI copy in mocks (do not invent placeholder text for extracted screens). Authority: SHARED DESIGN (imported palette/logos) > LIVE SITE (nav + screen copy + tokens); nav always LIVE SITE.
- `rename_project` — update a project's display name only (`projectId` or `rootPath`, `name`). `rootPath`, `id`, and all nested design-loop/phase URLs are unchanged.
- `design_loop_retry` — regenerate a failed/scaffold version **in place** (timeout recovery; does not bump version)
- `generate_design_image` — raster via `roles.designImage` (local Flux / `openai-images`); hard-fails if unbound
- `search_design_images` / `import_design_image` — Openverse (open-licensed Wikimedia / Flickr CC / museums); import writes loop `assets/` + attribution sidecar
- `review_design_loop` — screenshot mock → `roles.designVision` critique (`vN/REVIEW.md`). Needs Playwright Chromium: `pnpm --filter @slopcontrol/coding-tools exec playwright install chromium`

**Ask vs plan vs agent vs develop:** `ask` is light Q&A / sticky explore (Task brief → `promote_ask`); `plan_loop_*` builds a versioned full PLAN.md then `plan_loop_promote` → research; `agent` runs shell inspect/verify without phases; `design_loop_*` is look-and-feel; `start_development` owns product code in a worktree.
- `list_runs` / `list_phases` — **require** `projectId`
- `list_worktrees` — phase worktrees under `~/.slopcontrol/worktrees` (`projectId`)
- `get_git_status` — which branch is checked out in the project folder (`projectId`)
- `checkout_branch` — switch the project folder branch (`projectId`, `branch`; optional `create`, `stashDirty`)
- `remove_worktree` — delete an old phase worktree (`projectId`, `phaseId`; optional `deleteBranch`)
- `merge_phase` — commit dirty worktree (if needed) and merge `slop/<phaseId>` into the project root (`projectId`, `phaseId`; auto-stashes dirty root files; removes worktree by default; auto-resolves merge/stash conflicts preferring phase content)
- `list_conflicts` — unmerged paths in the project root (`projectId`)
- `resolve_conflicts` — resolve conflicts (`projectId`, optional `strategy`=`auto|phase|ours|theirs`, optional `phaseId` / `paths`)
- `get_health`
- `get_run_steps` — structured develop verify steps (`id` / name / command / exit / excerpt) + `firstFailure` for a run (also on `get_run` as `verify_steps` / `verify_first_failure`). Prefer this over scraping logs when diagnose-then-act after a blocked develop verify.
- `retry_verify` — re-run the **full** Automated Checks / success-check suite in the phase worktree (**no** coding agent, **no** merge). Allowed when stage is `blocked` / `failed` / `interrupted`. Returns `{ ok, firstFailure, stepsSummary, steps }`. Use after diagnosing a step; use `retry_development` when coding or merge is still needed.
- `preview_change_intent` — dry-run Change Intent (`uiMount`, `changeKind`, engagement, interaction contract); optional PHASE alignment; set `heuristicOnly: true` to skip the planning LLM
- `reconcile_blueprint` — rebuild Live decisions (verified vs claimed via repo probes); **defaults to `dryRun: true`**
- `audit_ui_gates` — Intent preview + PHASE align + dry-run reconcile pass/fail (read-only); optional `heuristicOnly`

```bash
# after server restart (default :3020)
curl -s localhost:3020/runs -H 'content-type: application/json' -d '{
  "action":"audit_ui_gates","projectId":"<fixture-or-real>",
  "description":"Unable to submit form — superseded by a newer form"
}'
```

Real projects may be audited read-only; writing `BLUEPRINT.md` only via `reconcile_blueprint` with `dryRun: false` after operator approval. Fixture smoke: `packages/artifacts/fixtures/ui-gate-project/`.

**Engagement / form Intent hardening (runs 54–56 lessons):**
- Change Intent is **LLM-classified** via the `classification` role (`changeKind`, `brandTheming`, `themeWiringOnly`, `requestsMissingThemeControl`, `needsInteraction`), then finalized from those fields only (no description-regex veto on success). Regex heuristics are the sync fallback when the LLM fails or `heuristicOnly` is set. PHASE↔Intent **alignment** is now **pure-LLM** (`judgeIntentAlignmentViaLlm` / `phaseDocAlignsWithChangeIntentAsync`): a single judge call reads the full PHASE doc + intent and returns a holistic `{ aligned, gaps, suggestedLines }` verdict — there is no regex pre-filter. A missing judge or judge error fails closed (reject with "could not verify"). Structural checks (section presence, format) remain deterministic in `validatePhaseDocForDev`.
- Draft LLM timeout with an engagement Change Intent **fails closed** (retry draft) — does not write a generic scaffold that fails Intent align.
- RESEARCH that overclaims “~90% already works” without residual risks is retried once when `interaction` is set (skipped for `chrome-hide` / `backend`). This overclaim check is now **pure-LLM** too (`judgeResearchEngagementViaLlm` / `researchEngagementQualityAsync`): a single judge call returns a holistic `{ overclaims, gaps, suggestedLines }` verdict — no regex pre-filter. A missing judge or judge error fails closed (reject).
- Weak on-disk `INTENT.json` (`uiMount: n/a` / missing interaction / missing `changeKind`) is refreshed on research, draft, and approve.
- Engagement PHASE Automated Checks must prove live AI SDK `type: tool-<name>` name resolution (not only `tool-invocation` fixtures).
- Design vision skips SVG-only assets (providers return 400 for `image/svg+xml`).
- Design pass is **skipped** for `changeKind: chrome-hide` / `backend` unless PHASE forces visuals (`Requires design pass: yes`, or `## Brand` / `## Assets`). Leftover UI-SPEC alone does not block develop. Behaviour gates stay Intent/PHASE-driven; call `start_design` manually when you want pixels.
- **Brand / theming / logo** asks classify as `changeKind: other` (never `backend`) and **always need a design pass**. Research prefers sibling **consumed** logos (`public/images/logo.svg` from Header), not `*-reuse.svg` fallbacks. Logo asset generation **fails closed** without a bound `designImage` role — bind local Flux (`x/flux2-klein`) via `openai-images` (see `endpoints.example.json`); do not accept tile+circle `svg_fallback` as a logo.
- Chrome-only UX asks (hide empty form / tab strip when nothing to gather) lock `uiMount: composer` but **do not** invent a fill/submit `interaction` contract; status questions like “What phases are complete?” are stripped from the Intent title.

**Brand theming re-run (after Intent/designImage fixes):**

1. Rebuild/restart SlopControl (`pnpm build` then `pnpm slopcontrol -- up`).
2. Ensure `~/.slopcontrol/endpoints.json` has `designImage` → local `openai-images` model (`ollama pull x/flux2-klein`). Chat roles (`research` / `planning` / `supervisor` / `coding` / `design`) currently prefer `deepseek-v4-pro:cloud`; bind `classification` → `ollama-cloud-glm` (`glm-5.2:cloud`) for continue-/change-intent JSON; keep `designVision` on a vision model (`kimi-k2.7-code`).
3. Delete weak `INTENT.json` on the brand phase (or rely on weak refresh when `changeKind` was `backend` but the ask is theming).
4. Re-run research → draft → design → develop. Confirm RESEARCH cites sibling `images/logo.svg` when the operator named a sibling (not `*-reuse.svg`). Design must not complete on logo `svg_fallback`.
5. If full look-and-feel is required, approve a PHASE that includes shell/theme machinery — not palette-only hex remaps.

**Re-run research after Intent/heuristic fixes** (e.g. JamPress phase 56 form engagement):

1. Rebuild and restart the stack so the server loads the new `@slopcontrol/artifacts` / `@slopcontrol/mastra` code (`pnpm build` then `pnpm slopcontrol -- up`, or your usual restart).
2. Optionally delete `.slopcontrol/phases/<phaseId>/INTENT.json` — or rely on `ensureChangeIntent`, which refreshes weak `n/a` / missing-interaction Intents when the description needs fill/submit.
3. Re-run research: MCP/REST `start_research` with that `projectId` + `phaseId` (or promote again only if you need a new phase).
4. Confirm Intent: `uiMount: composer` (for form populate/submit asks), non-empty `interaction` / `mustNot`, title not starting with “I want a task to promote…”. RESEARCH should use today’s date and must not claim fill+submit is proven solely because prior form phases are `complete`.

### REST highlights

- `POST /projects/open` — open/bootstrap
- `GET /projects/:id/runs` — runs for one project
- `GET /projects/:id/asks` — list ask conversations
- `POST /projects/:id/asks` — start/continue ask (`message`, optional `askId` / `title`)
- `GET /projects/:id/asks/:askId` — full ask transcript
- `POST /projects/:id/asks/:askId/sub-research` — run up to 4 ephemeral sub-researches (`topics[]`); sync response with findings in transcript
- `POST /projects/:id/asks/:askId/promote` — promote ask → phase + start research
- `POST /projects/:id/design-loops` — start design loop (brief → mock HTML)
- `POST /projects/:id/design-loops/:loopId/continue` — revise mock
- `POST /projects/:id/design-loops/:loopId/retry` — regenerate a version in place after scaffold/timeout
- `PATCH /projects/:id` — rename display name (`{ name }`); id/rootPath unchanged
- `GET /projects/:id/design-loops/:loopId` — meta + transcript + html + `assets[]` + `siteInventory` summary (`?includeHtml=false` to skip html)
- `GET /projects/:id/design-loops/:loopId/site-inventory` — full live-site inventory (`?refresh=true` to rebuild)
- `GET /projects/:id/design-loops/:loopId/assets/:name` — serve a loop asset file (PNG/etc.) for remote preview
- `POST /projects/:id/design-loops/:loopId/accept` / `implement` / `relaunch-research` / `review`
- `POST /projects/:id/relaunch-design-research` — same recovery as `relaunch-research`; body `{ loopId? , phaseId? , dependsOn? }`
- `POST /projects/:id/design-images` — generate raster (`designImage`)
- `POST /projects/:id/design-images/search` — Openverse search
- `POST /projects/:id/design-images/import` — import Openverse id into loop assets

Design-loop rasters live under `.slopcontrol/design-loops/<loopId>/assets/` (project-relative paths in stored mocks). SlopControl rewrites those refs to `/projects/.../assets/...` in API responses; dashboards should proxy that route (e.g. Hermes `/api/slop/...`) so `srcDoc` iframes stay same-origin.
- `GET /projects/:id/agents` — list agent chat sessions
- `POST /projects/:id/agents` — start/continue agent chat (`message`, optional `agentId` / `title`)
- `GET /projects/:id/agents/:agentId` — full agent transcript
- `GET /projects/:id/git` — project-folder branch status
- `POST /projects/:id/git/checkout` — checkout a branch in the project folder
- `GET /projects/:id/worktrees` — phase worktree status
- `DELETE /projects/:id/worktrees/:phaseId` — remove a phase worktree (`?deleteBranch=true` optional)
- `POST /projects/:id/phases/:phaseId/merge` — merge worktree branch into project root (removes worktree by default)
- `GET /projects/:id/conflicts` — list conflicted files
- `POST /projects/:id/conflicts/resolve` — resolve conflicts
- `GET /runs?projectId=` — same, query required
- `POST /runs` — actions including `open_project`, `start_research`, review, develop, `list_worktrees`, `get_git_status`, `checkout_branch`, `remove_worktree`, `merge_phase`, `list_conflicts`, `resolve_conflicts`

## Artifacts layout

```
<project>/.slopcontrol/
  BLUEPRINT.md          # living design
  ROADMAP.md            # ordered phase table
  LEARNINGS.md          # durable lessons (human-readable)
  learnings/index.json  # tagged learning index
  archive/BLUEPRINT-…   # superseded blueprints
  asks/<askId>/         # exploratory conversations (TRANSCRIPT.md, meta.json)
  agents/<agentId>/     # inspect/verify chats with run_command (TRANSCRIPT.md, meta.json)
  design-loops/<id>/    # look-and-feel mocks (META+selections, TRANSCRIPT, vN/mock.html, assets/, CONCEPTS.json, DESIGN_PACK.json on accept)
  generated-images/     # rasters generated without a loopId
  phases/01-slug/       # RESEARCH.md, PHASE.md, APPENDIX.md, status.json
  runs/<uuid>/log.txt
  runs/<uuid>/checks/   # full verify dumps + plan-progress
```

Optional project config (`.slopcontrol/config.json`):

- `buildCommand` / `testCommand` / `verifyCommand` — success gates (tests run by default)
- `verifyPreflightCommand` — optional command run **before** `testCommand` on root verify (e.g. compose health / service ping). Exit non-zero is treated as **infra**, not an app bug. Unset = skipped; classifier still catches connection-refused style failures from tests.
- `runTestsOnComplete` (default `true`) — run `testCommand` before complete
- `autoMergeOnComplete` (default `true`) — merge worktree into project root, then run tests on the **project root** (where gitignored `.env*` files live). Worktree gate is build-only.
- `mergeTargetBranch` — optional branch to merge into / leave checked out (defaults to current branch)
- `removeWorktreeOnComplete` (default `true`) — delete the phase worktree after a successful auto-merge
- `worktreeSyncPaths` — copy local env/secrets from project root into the phase worktree (defaults: `.env`, `.env.local`, `.env.docker`, `.env.test`, …). Re-synced each development iteration, but **worktree files that already differ from root are preserved** (agent edits are not wiped). After a successful merge, differing worktree env files are **pushed back to the project root** before root verify (gitignored files are not in the merge), except **paid→free `OLLAMA_TIER` regressions are blocked**. Also writes `.env.slopcontrol` with the full resolved map for CI/root parity.
- **Env layers:** `.env.slopcontrol` = SlopControl **test/develop overlay** (local Ollama / fixture via `llmTestProfile`). `.env.docker` / `.env.local` = **runtime/Docker**. Coding agents must not “fix tests” by forcing free-tier models into `.env.docker` or setting `OLLAMA_TIER=free`. PHASE.md Automated Checks that require `OLLAMA_TIER=free` or `:cloud` model IDs are rejected.
- **Project env (technology-agnostic):** `resolveProjectEnv` merges example → `.env*` files, then **process.env wins** for those keys. Optional `envPassthroughKeys` / `envPassthroughPrefixes` pull CI-only vars. Generic `envMap` remaps any values; `llmModelMap` remains a convenience for model IDs.
- `llmTestProfile` (`local` | `fixture` | `live`, default `local`) — LLM harness consumer of project env. Never falls back to free-tier Ollama Cloud. Local down → fixture profile.
- `llmTestEnvFile` (default `.env.test`) — optional gitignored overrides; commit `.env.test.example` only.
- `llmSmokeMode` (`off` | `local` | `live`, default `off`) — optional chat smoke. Develop gates skip live cloud smoke by default.
- `llmModelMap` / `envMap` — rewrite values during verify (e.g. cloud model → local name, prod Redis → local).
- DB phases also require `CREATE TABLE` in `docker/init-db.sql` or `drizzle/*.sql`
- On `open_project`, scaffolds `.env.test.example`, `tests/helpers/llm-test-client.ts`, and a sample fixture if missing.
- Automated Checks that print `FAIL:` but exit 0 (e.g. `|| echo FAIL`) are treated as failures — use `|| exit 1`.
- Full success-check dumps are written to `.slopcontrol/runs/<runId>/checks/` (`latest-*.txt` + timestamped copies) for analysis.
- Coding turns abort only on **real bash** `curl … api.ollama.cloud` / Bearer curls to **non-local** hosts (assistant prose or PHASE.md mentioning curl/Bearer is not enough; local `127.0.0.1` / `localhost` / `ollama:` / `host.docker.internal` Bearer diagnosis is allowed). Wall-clock soft budget: `SLOPCONTROL_CODING_TURN_MS` or project `codingTurnTimeoutMs` (default **600000** / 10m) — with worktree changes this is a **sticky yield** (`turn_budget_yield`), not a session recreate. Idle (no OpenCode events): `SLOPCONTROL_CODING_IDLE_MS` (default 90000). `provider_rate_limit` only on **provider error shapes** (e.g. `"error":…`, `statusCode:429`, `Too Many Requests`) — not instructional learnings/prompts that merely mention “rate limit”. **`turn_budget_yield` / productive `turn_timeout` keep the same OpenCode session**. **3 consecutive** idle / empty-timeout / rate-limit aborts → operator `DEV_BLOCKED` with persisted `diagnosis.json`. Diagnosis cards **redact** `*_API_KEY` / Bearer tokens from evidence.
- **Coding engine mode:** `slopcontrol.yaml` `coding.mode` (`per_project` default | `shared`). Per-project lazily starts OpenCode on ports **4100+** via the SDK's `createOpencodeServer` (stable hash of `projectId`); shared uses one daemon on **4096**. Server inherits `SLOPCONTROL_CODING_MODE` from `slopcontrol up`. Coding turns are non-blocking: `session.promptAsync` dispatches and completion arrives over the SSE event stream (`session.idle`), so no long-lived HTTP requests and no global fetch-timeout hacks; context injection uses `session.prompt({ noReply: true })` (no model turn).
- Supervisor turns time out via `SLOPCONTROL_SUPERVISOR_MS` (default 180000)

### Operator suggestions (MCP)

When develop fails on **env/infra** (missing keys, services down, LLM quota), diagnosis is persisted to `.slopcontrol/runs/<runId>/diagnosis.json` with `audience: "operator"` and concrete `operatorActions`. MCP tools:

- `get_run` / `get_run_steps` / `get_phase_status` / `get_operator_suggestions` — surface actions and per-step verify failures to the human (e.g. set a valid LLM key)
- `start_development` / `retry_verify` / `retry_development` — control plane next to suggestions (`retry_verify` = checks only; `retry_development` = coding + verify + merge)

Coding agents must **not** invent worktree-only product fixes for these failures.

**Retest after a stall-block fix (e.g. design→develop phase 32):** rebuild/restart the server (`pnpm slopcontrol -- up`); call `retry_development` on the blocked run. Expect sticky soft-budget continues (`turn_budget_yield` / `coding turn budget exceeded — continue`) when the wall clock hits but files changed **without** `Recreating OpenCode session`; only idle / empty-timeout / rate-limit streaks should `DEV_BLOCKED`, and then `get_phase_status` should show a persisted diagnosis.

### Learning / eval loop

Verify failures are classified (`infra` | `product` | `process` | `model` | `env`) from the **first failing step** (not truncated whole-run noise) and promoted into `.slopcontrol/learnings/`. Relevant learnings are injected into research, phase drafting, coding, and supervisor prompts.

**Diagnose-then-act:** each failed verify writes a Failure diagnosis card to APPENDIX (class, audience, operator actions, root cause, evidence). High-confidence diagnoses skip supervisor enrichment. The same diagnosis fingerprint repeating **3×** blocks the run (`DEV_BLOCKED`) instead of mindlessly looping. Supervisor timeouts keep the deterministic diagnosis — they do not invent a conflicting “just retry” narrative.

**Automated Checks:** bash fences join `\` line continuations and coalesce `if/fi` (and similar) compounds into one command. Incomplete compounds (`if …; then` without `fi`) fail PHASE validation. Prefer one complete command per line.

**Infra/env is generic:** connection refused / missing secrets / failed `verifyPreflightCommand` mean the operator must restore reality (same as CI/runtime). After ~2 operator/infra strikes the phase blocks; use `get_operator_suggestions`.

Plan progress compares PHASE.md `## File Changes` to OpenCode session changes **plus** `git` worktree diffs. `stop_run` marks the phase/run `interrupted` so `retry_development` can resume safely.
PHASE.md must include `## Automated Checks` with runnable `bash` commands (no curl+API-key probes); development will not complete on manual-only criteria.

If the planner narrates or writes `PHASE.md` at the project root via tools, SlopControl **harvests** the valid document into `.slopcontrol/phases/<id>/PHASE.md`. Thin research / invalid drafts are retried once (fresh memory thread), then scaffolded so the run can still reach review. Research/planning prompts **clip** large BLUEPRINT/ROADMAP dumps and use separate Mastra thread ids per stage so observational memory is not exhausted mid-tool-loop.

## Memory stores

- **Mastra agent threads:** LibSQL at `~/.slopcontrol/mastra.db` (observational memory uses the supervisor endpoint). Message window **100k** tokens / observation window **200k** tokens (Mastra defaults are 30k / 40k). `/health` reports `mastraStorage`.
- **Run iteration notes:** `.slopcontrol/runs/<runId>/memory.json`
- **Human artifacts:** `.slopcontrol/` (and optional Obsidian sync) — not agent thread storage

## OpenCode

Chat roles currently map to `deepseek-v4-pro:cloud` while Kimi K3 is unstable on Ollama Cloud (`designVision` stays on a vision model). Sessions use the **worktree path**, not the main checkout. Local env files are re-synced and `.env.slopcontrol` is written each iteration; with `autoMergeOnComplete`, tests run on the project root after merge under the resolved project env + `llmTestProfile`.