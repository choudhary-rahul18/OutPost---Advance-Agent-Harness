# OutPost — Advanced Agent Harness

**Repo:** https://github.com/choudhary-rahul18/OutPost---Advance-Agent-Harness

A multi-platform agentic harness that runs browser automation campaigns on behalf of the user — Reddit, LinkedIn, Hacker News, and beyond. The LLM decides actions; the harness verifies outcomes in deterministic code.

## Vision

The user describes a campaign in plain language:
> "Upvote the 2nd post on HN → read the 1st post → write a LinkedIn post about it."

OutPost breaks it into `Task` units, runs each one through the generic harness runner, and passes context between steps. Each platform is a self-contained task file. The runner never changes.

---

## Current State

The refactor to multi-file architecture is complete and working. The harness has been tested on Hacker News (upvote) and LinkedIn (profile read, messaging). Three LLM providers are supported.

---

## File Structure

```
src/
  index.ts        ← Entry point: assembles task + provider, runs it. System prompt lives here.
  runner.ts       ← Generic supervisor loop — zero platform knowledge. Never changes.
  task.ts         ← Task interface: the contract every platform must implement
  domExtractor.ts ← Injects JS into browser, returns text tree of interactive elements
  tools.ts        ← Tool Registry: navigate / click / type / done
  llmAdapter.ts   ← Provider abstraction: AnthropicAdapter + GeminiAdapter + OllamaAdapter
  loginHandler.ts ← CookieLoginHandler: generic session-cookie auth, works for any site

tasks/
  hn_upvote.ts        ← HN: isAuthWall, onAuthResolved, verify
  reddit_post.ts      ← (future)
  linkedin_post.ts    ← (future)
```

---

## The Task Interface — core contract

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

---

## Campaign Vision (future)

```typescript
// A campaign is an ordered list of tasks
const campaign: Task[] = [
  new HNReadTopPostTask(),     // reads top story, stores content in context
  new LinkedInPostTask(),      // uses stored content to write a LinkedIn post
];
```

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
npm start
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

- **Task = unit of work** — one platform, one goal, one system prompt. Swapping the task changes the campaign. The runner never changes.
- **Verification is code, not LLM** — after `done()`, the harness checks observable DOM state (CSS classes, element presence). No second LLM call. Deterministic, free, instantaneous.
- **Cookie-based auth** — `CookieLoginHandler` is parameterless and platform-agnostic. Derives the hostname from the live page URL, saves/loads `cookies/<hostname>.json`. First run = manual login; every run after = silent injection.
- **Auth wall redirect extraction** — harness extracts the intended destination from the auth wall URL (`sessionRedirect`, `next`, `redirect_uri`) and navigates directly there, skipping the redirect chain.
- **SPA-safe load strategy** — `waitForLoadState('load')` then `networkidle(5s, catch)`. Works for both traditional sites and heavy SPAs like LinkedIn.
- **DOM-aware stuck loop** — checks URL + DOM fingerprint. Fires only when both are unchanged for 4 consecutive steps. URL-only checks fire too early on SPAs.
- **Adapter pattern for providers** — `LLMAdapter` interface hides all protocol differences. Swap `LLM_PROVIDER` to change models. The runner never changes.
- **Harness guards run before LLM** — auth wall, stuck loop, and error page checks run every step before the LLM is consulted. The harness can stop the loop independently.
- **`page.evaluate()` bridge** — DOM extraction runs inside the browser's V8 engine. Only JSON-serialisable values cross back to Node.js.

---

## User Context

- User is experienced in Python, new to TypeScript — explain TypeScript concepts using Python analogues.
- Improvements to agent reliability go into harness code, not the system prompt.
- Do not add complexity beyond what is asked. Keep it minimal.
