# OutPost — Advanced Agent Harness

**Repo:** https://github.com/choudhary-rahul18/OutPost---Advance-Agent-Harness

A multi-platform agentic harness that runs browser automation campaigns on behalf of the user — Reddit, LinkedIn, Hacker News, and beyond. The LLM decides actions; the harness verifies outcomes in deterministic code.

## How a run works

The user types a goal in the terminal:
> "Upvote the 2nd post on HN → read the 1st post → write a LinkedIn post about it."

1. **Clarifier agent** (no browser) interviews the user — one question at a time, only essentials — then proposes a **CampaignSpec**: an ordered list of TaskSpecs. The user approves, requests changes, or cancels before any browser opens.
2. **Orchestrator** (deterministic code) opens ONE browser session, runs each task through the generic runner, and passes outputs between tasks via the **CampaignContext** (`{{outputKey}}` placeholders in later prompts).
3. **Executor runner** drives each task: guard pipeline → LLM action → tool execution → `verify()` in code on `done()`, with retry on failure. It can `ask_user` mid-run when genuinely blocked.

---

## File Structure

```
src/
  index.ts              ← wiring only: terminal + trace → bus; goal → clarifier → orchestrator
  spec.ts               ← TaskSpec, CampaignSpec, Task (the three core contracts)
  core/
    orchestrator.ts     ← campaign loop + context passing between tasks
    runner.ts           ← generic executor loop — zero platform/provider/UI knowledge
    guards.ts           ← Guard pipeline: authWall, stuckLoop, errorPage (pluggable)
    context.ts          ← CampaignContext: {{key}} store passed between tasks
    events.ts           ← typed HarnessEvent + EventBus (observer pattern)
    services.ts         ← Services = { bus, io }, threaded through everything
  agents/
    clarifier.ts        ← interview loop → approved CampaignSpec (tools: ask_user, finalize_campaign)
  llm/
    adapter.ts          ← LLMAdapter interface + factory + history pruning helpers
    anthropic.ts / gemini.ts / ollama.ts   ← one adapter per provider
  browser/
    session.ts          ← one browser/context/page per campaign (cookies persist across tasks)
    domExtractor.ts     ← text tree of interactive elements via page.evaluate()
    loginHandler.ts     ← CookieLoginHandler: generic session-cookie auth, any site
  tools/
    registry.ts         ← ToolDefinition (schema + executor in one object) + Toolset
    browserTools.ts     ← navigate, click, type, scroll, go_back, press_key, hover, read_page
    harnessTools.ts     ← ask_user, write_report, done
  io/
    channel.ts          ← IOChannel interface: ask() + render() — terminal today, web UI later
    terminal.ts         ← TerminalChannel (readline + console rendering of events)
    trace.ts            ← writes every event to runs/<timestamp>/trace.jsonl

tasks/
  registry.ts           ← taskTypes enum + buildTask(spec): library task or GenericTask
  generic.ts            ← GenericTask: universal verification for any Clarifier-written goal
  library/hn_upvote.ts  ← HN: platform-specific verify (:not(.nosee) DOM check)
```

---

## The three core contracts (src/spec.ts)

```typescript
interface TaskSpec {       // what the Clarifier produces per task (plain data)
  name; taskType; systemPrompt; startUrl; maxSteps; expectsReport; outputKey?
}
interface CampaignSpec {   // the Clarifier's full output
  goal: string; tasks: TaskSpec[]
}
interface Task {           // the runtime contract the runner executes
  name; startUrl; systemPrompt; maxSteps; loginHandler
  isAuthWall(url); onAuthResolved(page, url); verify(page)
}
```

Adding a platform with custom verification: new file in `tasks/library/`, add its key to `taskTypes` and a case in `buildTask`. Everything else (including the Clarifier's enum) picks it up automatically.

---

## Stack

- **TypeScript 5.x** with strict mode
- **Playwright 1.49+** for browser automation
- **ts-node** (ESM mode) — no build step, `npm start` runs directly
- **@anthropic-ai/sdk** — Anthropic provider
- **@google/generative-ai** — Gemini provider
- **dotenv** — env var loading

---

## Run

```bash
npm install
npx playwright install chromium   # first time only
npm start                         # type your goal at the prompt
```

---

## Configuration (.env)

```
LLM_PROVIDER=gemini               # anthropic | ollama | gemini

ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001

GEMINI_API_KEY=...
GEMINI_MODEL=gemini-1.5-flash

OLLAMA_API_KEY=...
OLLAMA_MODEL=ministral-3:3b
```

No credentials for HN or LinkedIn — the harness uses `cookies/<hostname>.json` saved from manual login.

---

## Key Design Principles

- **Clarify before executing** — ambiguity is resolved with the user upfront (Clarifier) or mid-run (`ask_user` tool), never by guessing. No browser opens until the user approves the plan.
- **Hybrid verification** — the Clarifier picks a library task (platform-specific DOM checks) when one matches; otherwise `GenericTask` runs universal checks (auth wall, error page, report-written). Verification is code, not LLM.
- **Campaign context bus** — each task's `done()` output is stored under its `outputKey`; later tasks reference it as `{{key}}` in their prompts. The orchestrator substitutes before the task runs.
- **Events, not console.log** — the runner emits typed events to the EventBus; the terminal renders them and `runs/<ts>/trace.jsonl` records them. A future web UI is just another listener + an IOChannel implementation.
- **Guards are pluggable** — auth wall, stuck loop, and error page checks run every step before the LLM, as a `Guard[]` pipeline. Verdicts: `abort`, `skip_llm` (guard acted, e.g. login — LLM told its action was intercepted), `inform_llm` (warning attached to the tool_result, LLM still acts). Adding a guard never touches the runner.
- **Stuck ≠ dead** — the stuck guard escalates instead of aborting: warn the LLM to change approach → ask the user for a hint (or "stop") → abort only if guidance also goes nowhere. Each tier gets a fresh 4-step window.
- **The end-state is part of the plan** — the Clarifier sets `keepBrowserOpen` when the deliverable is on screen (playing media, an open page). The orchestrator then enters a follow-up loop: Enter closes the browser; any typed instruction ("fullscreen", "play another song") runs as a new GenericTask starting on the CURRENT page in the same session (the runner skips `goto` when already on `startUrl`, so live state survives).
- **Tool outputs flow back to the LLM** — a tool returning a string (read_page text, ask_user answer) becomes the tool_result content. Silence = "Action executed successfully."
- **Harness owns credentials; LLM owns actions** — CookieLoginHandler is parameterless, derives `cookies/<hostname>.json` from the live URL, and the LLM never sees auth walls or credentials.
- **One browser per campaign** — logins persist across tasks in the same BrowserContext.
- **SPA-safe everything** — `load` + `networkidle(5s, catch)` waits; stuck detection compares URL **and the full DOM tree** (truncated fingerprints false-positive on SPAs where changes are deep in the page).
- **Popup-aware, ARIA-aware extraction** — the DOM extractor matches ARIA roles (`button`, `option`, `menuitem`, …), `contenteditable`, and `[onclick]`, not just native tags — SPAs build popups out of `<div>`s. Open dialogs get a `*** POPUP/DIALOG OPEN ***` banner and their elements are marked `(IN POPUP)`.
- **Fail fast on actions** — click/fill/hover use an 8s timeout (not Playwright's 30s default); click timeout errors carry a recovery hint (stale index / popup overlay → press Escape).
- **History pruning** — adapters keep the last 4 observations full and collapse older DOM trees, so long campaigns don't blow up the context window.
- **Adapter pattern for providers** — tools are a constructor parameter; the same adapters serve the Clarifier (interview tools) and the executor (browser tools). Swap `LLM_PROVIDER` to change models.

---

## User Context

- User is experienced in Python, new to TypeScript — explain TypeScript concepts using Python analogues.
- Improvements to agent reliability go into harness code, not the system prompt.
- Do not add complexity beyond what is asked. Keep it minimal.
