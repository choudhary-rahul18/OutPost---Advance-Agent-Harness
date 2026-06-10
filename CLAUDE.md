# OutPost — Advanced Agent Harness

**Repo:** https://github.com/choudhary-rahul18/OutPost---Advance-Agent-Harness

A multi-platform agentic harness that runs browser automation campaigns on behalf of the user — Reddit, LinkedIn, Hacker News, and beyond. The LLM decides actions; the harness verifies outcomes in deterministic code.

## Vision

The user describes a campaign in plain language:
> "Upvote the 2nd post on HN → read the 1st post → write a LinkedIn post about it."

OutPost breaks it into `Task` units, runs each one through the generic harness runner, and passes context between steps. Each platform is a self-contained task file. The runner never changes.

---

## Current State: Level 1 — Single-Task Harness (HN Upvote)

The harness is fully working for one task. The refactor to multi-task/multi-platform is in progress.

---

## Target Architecture (in progress)

```
src/
  index.ts        ← Entry point: assembles task(s) and runs them
  runner.ts       ← Generic supervisor loop — zero platform knowledge
  task.ts         ← Task interface: the contract every platform must implement
  domExtractor.ts ← Injects JS into browser, returns text tree of interactive elements
  tools.ts        ← Tool Registry: navigate / click / type / done
  llmAdapter.ts   ← Provider abstraction: AnthropicAdapter + OllamaAdapter
  loginHandler.ts ← LoginHandler interface + per-platform implementations

tasks/
  hn_upvote.ts        ← HN: systemPrompt, isAuthWall, onAuthResolved, verify
  reddit_post.ts      ← (future)
  linkedin_post.ts    ← (future)
```

### The Task Interface — core contract

```typescript
interface Task {
  name: string
  startUrl: string
  systemPrompt: string          // defines what the LLM is trying to do
  maxSteps: number
  loginHandler: LoginHandler | null
  isAuthWall(url: string): boolean
  onAuthResolved(page: Page, interceptedUrl: string): Promise<void>
  verify(page: Page): Promise<{ passed: boolean; message: string }>
}
```

Adding a new platform = one new file in `tasks/` implementing `Task`. The runner never changes.

### Campaign Vision (future)

```typescript
// A campaign is an ordered list of tasks
const campaign: Task[] = [
  new HNReadTopPostTask(),     // reads top story, stores content in context
  new LinkedInPostTask(),      // uses stored content to write a LinkedIn post
];
```

---

## Current File Structure (pre-refactor)

```
src/
  agent.ts        ← Supervisor Loop + all HN-specific logic (being split out)
  domExtractor.ts ← unchanged
  tools.ts        ← unchanged
  llmAdapter.ts   ← unchanged
  loginHandler.ts ← LoginHandler interface + HackerNewsLoginHandler
```

---

## Stack

- **TypeScript 5.x** with strict mode
- **Playwright 1.49+** for browser automation
- **ts-node** (ESM mode) — no build step, `npm start` runs directly
- **@anthropic-ai/sdk** — Anthropic provider
- **dotenv** — env var loading

---

## Run

```bash
npm install
npx playwright install chromium   # first time only
npm start
```

---

## Configuration (.env)

```
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
OLLAMA_API_KEY=...
OLLAMA_MODEL=ministral-3:3b
LLM_PROVIDER=anthropic        # or: ollama
HN_USERNAME=...               # used by loginHandler only — never passed to LLM
HN_PASSWORD=...
```

---

## Key Design Principles

- **Task = unit of work** — one platform, one goal, one system prompt. Swapping the task changes the campaign. The runner never changes.
- **Verification is code, not LLM** — after `done()`, the harness checks observable DOM state (CSS classes, element presence). No second LLM call. Deterministic, free, instantaneous.
- **Harness Interception Gate** — auth walls are handled silently between LLM calls. The harness logs in via Playwright, replays the blocked action using the authenticated DOM link, and resumes. Credentials never appear in the LLM's message history.
- **Adapter pattern for providers** — `LLMAdapter` interface hides all protocol differences. Swap `LLM_PROVIDER` to change models. The runner never changes.
- **Harness guards run before LLM** — auth wall, stuck loop, and error page checks run every step before the LLM is consulted. The harness can stop the loop independently.
- **`page.evaluate()` bridge** — DOM extraction runs inside the browser's V8 engine. Only JSON-serialisable values cross back to Node.js.

---

## User Context

- User is experienced in Python, new to TypeScript — explain TypeScript concepts using Python analogues.
- Improvements to agent reliability go into harness code, not the system prompt.
- Do not add complexity beyond what is asked. Keep it minimal.
