# BaseHarness / OutPost

A progressively hardened agentic browser automation harness. Each session adds a new layer of reliability — not by improving the prompt, but through deterministic software engineering in the harness itself.

The core principle: **the LLM decides actions; the harness verifies outcomes in code.**

---

## What It Does

The harness launches a browser, gives an LLM a live view of the DOM at each step, executes whatever tool the LLM calls, and independently verifies the result. The LLM can hallucinate — the harness cannot be fooled by a hallucination.

Swap the system prompt in `src/index.ts` to change the task. The runner never changes.

---

## Stack

- **TypeScript 5.x** — strict mode
- **Playwright 1.49+** — browser automation
- **ts-node** (ESM) — runs TypeScript directly, no build step
- **@anthropic-ai/sdk** — Anthropic provider
- **@google/generative-ai** — Gemini provider
- **dotenv** — env var loading

---

## Setup

```bash
npm install
npx playwright install chromium   # first time only
```

Create a `.env` file:

```
LLM_PROVIDER=gemini               # anthropic | ollama | gemini

ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001

GEMINI_API_KEY=...
GEMINI_MODEL=gemini-1.5-flash

OLLAMA_API_KEY=...
OLLAMA_MODEL=ministral-3:3b
```

```bash
npm start
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Supervisor Loop (runner.ts)                            │
│  while step < MAX_STEPS:                                │
│    1. Harness Checks (runs before LLM):                 │
│       • Auth wall? → CookieLoginHandler (silent login)  │
│       • Stuck loop? → stop (URL + DOM fingerprint)      │
│       • Error page? → stop                              │
│    2. adapter.getNextAction() → tool call               │
│    3. Tool Registry → Playwright action                 │
│  after done(): task.verify() → DOM-state check          │
└──────────────────────┬──────────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
  AnthropicAdapter  GeminiAdapter  OllamaAdapter
```

---

## Project Structure

```
src/
  index.ts        — Entry point: assembles task and provider, runs it
  runner.ts       — Generic supervisor loop — zero platform knowledge
  task.ts         — Task interface: contract every platform must implement
  domExtractor.ts — Injects JS into browser, returns text tree of interactive elements
  tools.ts        — Tool Registry: navigate / click / type / done
  llmAdapter.ts   — Provider abstraction: Anthropic + Gemini + Ollama
  loginHandler.ts — CookieLoginHandler: generic session-cookie auth for any site

tasks/
  hn_upvote.ts    — HN-specific: isAuthWall, onAuthResolved, verify
```

---

## Key Design Decisions

**Verification is code, not LLM.** After `done()`, the harness checks observable DOM state (CSS classes, element presence) with Playwright. No second LLM call. Deterministic, free, instantaneous.

**Cookie-based login — platform agnostic.** No credentials in code or `.env`. First run pauses for manual login; cookies are saved to `cookies/<hostname>.json`. Every subsequent run injects them silently. Works for 2FA, CAPTCHAs, anything.

**Auth wall redirect extraction.** When an auth wall is hit, the harness extracts the intended destination from the auth wall URL's query params (`sessionRedirect`, `next`, `redirect_uri`) and navigates directly there — skipping the redirect chain that would otherwise time out.

**DOM-aware stuck loop.** The stuck loop checks both URL and a DOM fingerprint. On SPAs like LinkedIn, meaningful actions change page content without changing the URL. A URL-only check would fire too early.

**SPA-safe load strategy.** All tools use `waitForLoadState('load')` then attempt `networkidle` with a 5-second cap. Normal sites settle in <1s; SPAs get 5s to render before the harness moves on. No more 30-second timeouts.

**Adapter pattern for providers.** `LLMAdapter` interface hides all protocol differences. Set `LLM_PROVIDER` in `.env` to switch. The runner never changes.

**Harness guards run before LLM.** Every step, the harness checks page state before consulting the LLM. The harness can stop or redirect the loop independently of the LLM's reasoning.

**DOM tree as the LLM's eyes.** `domExtractor.ts` injects JS via `page.evaluate()`, stamps each interactive element with `data-index`, and returns a plain text tree. The LLM references elements by index; the Tool Registry finds them by `[data-index="N"]`.

---

## Security Properties

- No credentials anywhere in code — `CookieLoginHandler` uses saved browser cookies only
- No login tool in `toolSchemas` — prompt injection cannot extract credentials via a tool call
- Auth wall URL is never sent to the LLM as an observation — harness intercepts between steps
