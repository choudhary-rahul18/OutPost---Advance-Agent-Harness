# BaseHarness — Progress Log

## Session 1 — 2026-06-10

### What We Built
A working TypeScript + Playwright browser automation agent from an empty directory.
The agent launches a browser, creates an isolated BrowserContext, searches DuckDuckGo for
"Latest news on Indian Stock Market", waits 5 seconds on the results page, then tears down cleanly.

---

### Files Created
| File | Purpose |
|---|---|
| `package.json` | Project manifest, dependencies, `npm start` script |
| `tsconfig.json` | TypeScript compiler config (strict, ESNext, ESM) |
| `src/agent.ts` | The browser agent — all logic lives here |
| `CLAUDE.md` | Project context for Claude Code sessions |

---

### Concepts Learned

#### BrowserContext — The Core Idea
- `browser.newContext()` creates an **isolated session sandbox** — no cookies, no history, no shared state.
- This is the foundational primitive for the Agentic Harness: one context = one isolated "user session".
- Never skip it and use `browser.newPage()` directly — that page shares a default context with all other direct pages.

#### The 3-Phase Agent Pattern
```
Phase 1 — Setup:     chromium.launch() → browser.newContext() → context.newPage()
Phase 2 — Interact:  page.goto() → page.locator() → .fill() → .press('Enter')
Phase 3 — Teardown:  context.close() → browser.close()
```

#### TypeScript Concepts
- **Async IIFE** `(async () => { ... })()` — equivalent to Python's `asyncio.run(main())`
- **`try/finally`** — teardown always runs even if an error is thrown mid-run (same as Python)
- **Explicit types** — variables declared before `try` must be typed explicitly: `let browser: Browser | null = null`
- **No venv needed** — `npm install` creates a local `node_modules/` folder; dependencies are local by default

#### Locator — Lazy DOM Pointer
- `page.locator('input[name="q"]')` does NOT search the DOM immediately
- The actual search happens only when an action is called (`.fill()`, `.press()`, etc.)
- Playwright re-queries the DOM on each action — resilient to dynamic page changes

---

### Issues Hit & Resolved

| Issue | Cause | Fix |
|---|---|---|
| Google reCAPTCHA | Playwright sets `navigator.webdriver = true`; Google detects this | Switched to DuckDuckGo |
| Tried `channel: 'chrome'` | Real Chrome still has `navigator.webdriver` set by Playwright | Reverted; not needed for DuckDuckGo |

**Key insight:** Google is uniquely aggressive about bot detection. For automation learning,
DuckDuckGo is the correct target — identical concepts, no CAPTCHA arms race.

---

---

## Session 2 — 2026-06-11

### What We Built
A dynamic AI agent — the "Naked Agent". All hard-coded selectors removed. The harness now:
1. Injects a DOM extractor into the live browser to produce a text tree of visible interactive elements
2. Sends that text tree + the current URL/title to Claude via the Anthropic API
3. Parses Claude's tool call and executes it via a Tool Registry
4. Loops until Claude calls `done()` or MAX_STEPS is hit

The system prompt carries the goal. The harness code is generic — swapping the prompt changes the task entirely.

---

### Files Created / Changed
| File | Purpose |
|---|---|
| `src/domExtractor.ts` | Injects JS into the browser via `page.evaluate()`, stamps elements with `data-index`, returns a clean text tree |
| `src/tools.ts` | Tool Registry: maps `navigate` / `click` / `type` / `done` to Playwright actions. Also exports tool schemas for the Claude API. |
| `src/agent.ts` | Full rewrite: Supervisor Loop with conversation history, tool dispatch, MAX_STEPS cap |
| `.env` | Stores `ANTHROPIC_API_KEY` — excluded from git via `.gitignore` |

---

### Architecture: The 3-Subsystem Pattern
```
┌─────────────────────────────────────────────┐
│  Supervisor Loop (agent.ts)                 │
│  while step < MAX_STEPS:                    │
│    1. DOM Extractor  → text tree            │
│    2. Claude API     → tool call            │
│    3. Tool Registry  → Playwright action    │
└─────────────────────────────────────────────┘
```

---

### Concepts Learned

#### `page.evaluate()` — The Bridge
- Your TypeScript runs in Node.js. The browser runs its own V8 engine. They cannot share memory.
- `page.evaluate(fn, arg?)` serialises `arg` as JSON → injects into browser → runs `fn` → serialises return value back.
- **Critical constraint:** only JSON-serialisable values can cross — no DOM nodes, no functions, no Playwright objects.
- The DOM Extractor returns a plain `string` — that's why it works.

#### Claude API — Multi-Turn Tool Use Protocol
- Every `tool_use` block in an assistant message **must** be followed by a `tool_result` block in the very next user message.
- Sending a plain observation without closing the tool pair causes a `400 BadRequestError`.
- Fix: combine `tool_result` + new observation into a single user message as a content array.

#### Parametric Knowledge vs. Live Observation
- The LLM brings "world knowledge" baked in from training. It recognised the HN login redirect from the URL pattern + blank page title — not from explicit DOM inspection.
- This makes the agent appear smart, but it also enables confident hallucination: the model can assert success based on prior knowledge rather than verifying actual page state.

#### Token Growth in Multi-Turn Loops
- Each API call sends the **full conversation history**.
- Call N carries N×2 messages. Cost and context window usage grow linearly with steps.
- Long tasks will eventually hit the model's context limit — future levels need history pruning or summarisation.

---

### Test Runs

#### Test 1 — DuckDuckGo Search (MAX_STEPS=5)
- Step 1: `click(1)` — focused search box (wasted step; `type()` didn't need it)
- Step 2: `type(1, "Latest news on Indian Stock Market")` — query submitted
- Step 3: `done(...)` — Claude saw results page, wrote summary, terminated correctly
- **Result:** Task completed in 3/5 steps. Agent called `done()` on its own. ✅

#### Test 2 — Hacker News Upvote (MAX_STEPS=10)
- Step 1: `click(10)` — clicked the upvote arrow
- Step 2: URL redirected to `vote?id=...&how=up&goto=news` (HN login wall). Claude navigated back.
- Step 3: `done(...)` — "upvote was attempted but login is required"
- **Result:** Task failed — no login session. The harness accepted `done()` without verifying anything. ❌

---

### Failure Modes Observed (Naked Agent)

| # | Failure Mode | What Happened | Why It's a Problem |
|---|---|---|---|
| 1 | **Wasted steps** | Agent clicked to focus a box before typing, when `type()` handles focus itself | Burns budget; in a 2-step run this caused task failure |
| 2 | **Blind acceptance of `done()`** | Harness closed the browser the moment Claude said done — no verification | Agent can hallucinate success and the harness will never know |
| 3 | **No session awareness** | Agent hit an auth wall, reported failure, but couldn't recover | Harness has no concept of login state or how to acquire it |
| 4 | **Step counter as only guard** | The only thing preventing an infinite loop is MAX_STEPS | No semantic understanding of "is the agent making progress?" |

---

### What Level 2 Needs to Fix (in code, not in the prompt)

The core principle: **the harness must verify outcomes in code. It cannot trust the LLM's self-report.**

| Problem | Level 2 Fix |
|---|---|
| Harness blindly accepts `done()` | After `done()`, harness checks page state in code to confirm goal was actually reached |
| No auth/session handling | Harness detects login redirects by URL pattern and either injects credentials or flags as unrecoverable |
| Wasted steps not detected | Harness tracks URL + DOM fingerprint across steps; if nothing changed, flag as a stuck loop |
| No progress signal | Harness scores each step: did the URL change? Did a key element appear/disappear? If N steps pass with no change → intervene |

---

## Session 3 — 2026-06-11

### What We Built
Three additions on top of the Naked Agent:

1. **Deterministic Verifier** — after `done()`, the harness checks final page state in code (URL regex, title regex) and prints an explicit `PASSED / FAILED` verdict. No second LLM call — pure software engineering.
2. **Mid-loop Guards** — every step, before the LLM is consulted, the harness runs: auth wall detector, stuck loop detector, error page detector.
3. **LLM Adapter Layer** — a provider abstraction that lets the supervisor loop swap between Anthropic and Ollama by changing one env var (`LLM_PROVIDER`). The loop has zero knowledge of which provider is active.

---

### Files Created / Changed
| File | Purpose |
|---|---|
| `src/llmAdapter.ts` | NEW: Adapter pattern — `AnthropicAdapter` and `OllamaAdapter` behind a single `LLMAdapter` interface. `createAdapter(provider, systemPrompt)` factory. |
| `src/agent.ts` | Added verifiers (`isAuthWall`, `isErrorPage`, `isStuckLoop`, `verifyOutcome`). Replaced all Anthropic-specific LLM code with `adapter.getNextAction()`. |
| `.env` | Added `OLLAMA_API_KEY` and `LLM_PROVIDER` |

---

### Architecture: Updated with Adapter Layer
```
┌──────────────────────────────────────────────────┐
│  Supervisor Loop (agent.ts)                      │
│  while step < MAX_STEPS:                         │
│    1. Harness Checks (auth wall, stuck, error)   │
│    2. adapter.getNextAction() → tool call        │
│    3. Tool Registry → Playwright action          │
│  after done(): verifyOutcome() → PASSED/FAILED   │
└─────────────────┬────────────────────────────────┘
                  │
         ┌────────┴────────┐
         ▼                 ▼
  AnthropicAdapter    OllamaAdapter
  (Anthropic SDK,     (fetch to ollama.com/api/chat,
   tool_use blocks,    tool_calls array,
   tool_result IDs)    no ID pairing)
```

---

### Key Design Principle Established
**Verification must be code, not LLM.** Using a second LLM to verify the first LLM adds cost, latency, and another failure point. The harness verifies by checking observable, measurable state — URL patterns, page titles, DOM presence — the same way a traditional software test would.

---

### Concepts Learned

#### Adapter Pattern
- A thin abstraction that normalises different provider APIs into one interface.
- The loop calls `adapter.getNextAction({ url, title, tree })` and gets back `{ toolName, toolInput, reasoning }`.
- Each adapter owns its own message history, schema translation, and response parsing internally.
- Adding a new provider = one new class + one line in the factory. The loop never changes.

#### Transition-Based vs State-Based Checking
- State-based: "what URL am I on?" — can't distinguish blocked from passing through.
- Transition-based: "what action caused this URL?" — needs `(prev_action, current_url)` pair.
- The harness records every dispatched tool call, giving it ground truth for transition checks.

#### Why LLM Behaviour Cannot Be a Safety Mechanism
- Claude (Anthropic Haiku) gracefully reported failure at the auth wall — because its training told it to stop at authorization barriers without credentials.
- Ministral 3B hallucinated success at the same wall — claimed "Successfully upvoted" while sitting on `vote?id=...`.
- The harness produced `FAILED` for both. Swapping models changed the agent's behaviour; it did not change the harness verdict.

---

### Test Runs

#### Test 3 — HN Upvote, Anthropic Haiku, with verifier + "Make sure to complete the task" prompt
- Step 1: `click(10)` — upvote arrow clicked
- Step 2: Auth wall URL. Harness warned. Claude called `done("login required — task incomplete")`.
- Verifier: `FAILED — Blocked by authentication wall.`
- **Result:** Agent was honest; harness correctly confirmed failure. ✅ Verifier working.

#### Test 4 — HN Upvote, Ministral 3B (Ollama), with verifier
- Step 1: `click(10)` — upvote arrow clicked
- Step 2: Auth wall URL. Harness warned. Ministral called `done()` with hallucinated success AND malformed JSON (`"reason: The top story..."` as key instead of `"reason"`).
- Verifier: `FAILED — Blocked by authentication wall.` (regardless of malformed claim)
- **Key finding:** Small model (3B) hallucinated success + produced structurally broken tool call JSON. Harness caught it anyway.

---

### Failure Modes — Updated

| # | Failure Mode | Observed In | Harness Response |
|---|---|---|---|
| Wasted steps | Anthropic — clicked before typing | Warning log only (no guard yet) |
| Blind `done()` acceptance | Fixed — `verifyOutcome()` runs on every `done()` | PASSED/FAILED verdict |
| Auth wall undetected | Fixed — `isAuthWall()` runs every step | WARNING log + caught in verifier |
| Stuck loop | Fixed — `isStuckLoop()` runs every step | Stops loop after 3 identical URLs |
| Hallucinated success | Ministral 3B — claimed upvote succeeded | Verifier overruled it: FAILED |
| Malformed tool call JSON | Ministral 3B — key contained value text | `toolInput['reason']` was undefined; harness didn't crash |

---

## Session 4 — 2026-06-11

### What We Built
The **Harness Interception Gate** — a login middleware that handles authentication entirely in deterministic Playwright code. The LLM has no login tool, no knowledge of credentials, and never sees the auth wall URL in its message history.

---

### Files Created / Changed
| File | Purpose |
|---|---|
| `src/loginHandler.ts` | NEW: `LoginHandler` interface + `HackerNewsLoginHandler`. Reads credentials from `process.env` directly inside `.fill()` calls — never assigned to a named variable. |
| `src/agent.ts` | Added interception gate: when auth wall detected, harness logs in, replays upvote via authenticated DOM link, then resumes loop. Added `votedStoryId` tracking and DOM-state verifier. |

---

### Architecture: Updated with Interception Gate
```
┌──────────────────────────────────────────────────────────┐
│  Supervisor Loop (agent.ts)                              │
│  while step < MAX_STEPS:                                 │
│    1. Harness Checks:                                    │
│       • Auth wall detected?                              │
│           → loginHandler.login(page, START_URL)          │
│           → replay upvote via authenticated DOM link     │
│           → continue (LLM skips this step entirely)      │
│       • Stuck loop / error page → stop                   │
│    2. adapter.getNextAction() → tool call                │
│    3. Tool Registry → Playwright action                  │
│  after done(): verifyOutcome() → DOM-state check         │
└──────────────────────────────────────────────────────────┘
```

---

### Key Design Principle Established
**Smart harness + dumb LLM > dumb harness + smart LLM.**

Ministral 3B (a 3B-parameter model) completed the task correctly today. The same model hallucinated success in Session 3. The difference: the harness now handles every critical action deterministically. The LLM only had to identify the upvote arrow — the rest was code.

---

### Security Guarantees of the Interception Gate
1. Credentials read from `process.env` directly in `.fill()` — never stored in a named variable during LLM calls
2. No `login` tool in `toolSchemas` — prompt injection cannot cause credential leakage via a tool call argument
3. LLM message history skips the auth wall URL entirely — harness intercepts before `getNextAction()` is called
4. `tool_result` the LLM sees: `"Action executed successfully."` — no mention of login, credentials, or auth walls

---

### Concepts Learned

#### HN Vote URL Has a Session-Specific `auth=` Token
- Unauthenticated vote URL: `vote?id=48480978&how=up&goto=news`
- Authenticated vote URL: `vote?id=48480978&how=up&auth=a3f9bc...&goto=news`
- Replaying the unauthenticated URL after login silently fails — HN rejects it without error
- Fix: after login, read the live DOM for the authenticated link and click it via Playwright

#### HN Signals "Voted" via CSS Class, Not DOM Removal
- After voting, HN adds `class="nosee"` to the upvote `<a>` tag — doesn't remove the element
- Checking for the element's presence always returns true, voted or not
- Correct verifier: `a[href*="vote?id=...&how=up"]:not(.nosee)` — only counts visible, clickable links

#### Two Forms with Identical `name=` Attributes
- HN's login page has two forms (login + create account) both with `input[name="acct"]`
- Playwright's strict mode rejects locators that resolve to multiple elements
- Fix: `.first()` scopes to the login form, which is always first in the DOM

#### Transition from URL-Based to DOM-State Verification
- URL check (`isAuthWall`) detects failure categories
- DOM-state check (`nosee` class) confirms actual task completion
- These are different layers: URL tells you where you are; DOM tells you what happened

---

### Bugs Hit & Fixed (Session 4)

| Bug | Cause | Fix |
|---|---|---|
| `locator.fill: strict mode violation` | HN login page has two forms with `name="acct"` | `.first()` on all login locators |
| Vote never registered after login | Unauthenticated vote URL lacks `auth=` token | Read live DOM post-login; click authenticated link |
| Verifier false negative (`FAILED` on real success) | HN keeps upvote `<a>` with `nosee` class after voting | `:not(.nosee)` in verifier selector |

---

### Test Runs

#### Test 5 — HN Upvote, Ministral 3B (Ollama), with Interception Gate
- Step 1: `click(10)` — upvote arrow clicked (logged out)
- Step 2: Auth wall URL. **Harness intercepted.** Logged in → found authenticated vote link → clicked it → returned to front page. LLM was not called this step.
- Step 3: LLM saw logged-in HN page → called `done("Upvoted...")`
- Verifier: navigated to front page → `a[href*="vote?id=48480978&how=up"]:not(.nosee)` → count = 0 → `PASSED`
- **Confirmed in browser:** Upvote registered on the actual HN account. ✅
- **Key result:** Ministral 3B succeeded because the harness handled every critical action. The LLM only picked the right element.

---

### Failure Modes — Updated

| # | Failure Mode | Harness Response |
|---|---|---|
| Blind `done()` acceptance | Fixed — `verifyOutcome()` with DOM-state check | PASSED/FAILED via `:not(.nosee)` selector |
| Auth wall — login required | Fixed — Interception Gate logs in silently | Credentials never touch LLM |
| Auth wall — `auth=` token missing | Fixed — Harness reads authenticated link from live DOM | Upvote replayed correctly |
| Stuck loop | Fixed — `isStuckLoop()` runs every step | Stops after 3 identical URLs |
| Hallucinated success | Harness overrules LLM claim | DOM-state verifier is ground truth |

---

## Session 5 — 2026-06-11

### What We Built
Four things on top of the Session 4 harness:

1. **Multi-file refactor** — split the monolithic `agent.ts` into the target architecture from `CLAUDE.md`. The runner is now generic; all HN-specific logic lives in one task file.
2. **`onAuthResolved` simplification** — removed the harness-driven vote replay. The LLM now re-clicks the upvote after login. Harness only handles credentials; LLM handles actions.
3. **Cookie-based login** — replaced `HackerNewsLoginHandler` (which stored credentials in `.env`) with `CookieLoginHandler` (works for any platform). First run: pauses for manual login, saves session cookies to disk. Every run after: injects cookies silently — no credentials anywhere in code.
4. **Two runtime bug fixes** — tool executor crash and Anthropic 400 (parallel tool use).

---

### Files Created / Changed
| File | Purpose |
|---|---|
| `src/task.ts` | NEW: `Task` interface — the contract every platform must implement |
| `src/runner.ts` | NEW: Generic supervisor loop — zero platform knowledge |
| `src/index.ts` | NEW: Entry point — assembles task + provider, runs it. System prompt lives here. |
| `tasks/hn_upvote.ts` | NEW: `HNUpvoteTask` — `systemPrompt`, `isAuthWall`, `onAuthResolved`, `verify` |
| `src/loginHandler.ts` | Replaced `HackerNewsLoginHandler` with `CookieLoginHandler` |
| `src/llmAdapter.ts` | Fixed parallel tool use bug (`pendingToolCallIds[]` instead of `lastToolCallId`) |
| `src/runner.ts` | Added try-catch around tool executor; forwards tool errors to adapter |
| `src/agent.ts` | DELETED — fully replaced by new architecture |

---

### Architecture: Final Refactored Layout
```
src/
  index.ts        ← entry point + system prompt (user-facing config)
  runner.ts       ← generic supervisor loop — never changes
  task.ts         ← Task interface
  domExtractor.ts ← unchanged
  tools.ts        ← unchanged
  llmAdapter.ts   ← unchanged (bug fixed)
  loginHandler.ts ← CookieLoginHandler (platform-agnostic)

tasks/
  hn_upvote.ts    ← HN-specific: isAuthWall, onAuthResolved, verify
```

---

### Key Design Principles Established

#### System prompt vs. Task class
- **System prompt** → what the LLM tries to do. Lives in `index.ts`. Change it to change the agent's goal on the same platform.
- **Task class** → what the harness does deterministically. New file only when `isAuthWall`, `onAuthResolved`, or `verify` logic changes (i.e., new platform or fundamentally different verification).

#### Harness owns credentials; LLM owns actions
- `onAuthResolved` was originally replaying the upvote in Playwright code after login. Removed: the LLM re-clicks the upvote on the next step. The harness only handles the auth layer — extracting the story ID for later verification.
- Rule: **harness does what requires determinism or security. LLM does everything else.**

#### Cookie-based login = platform-agnostic auth
- No credentials in code or `.env`. First run pauses for human to log in manually — handles 2FA, CAPTCHAs, anything.
- Cookies saved to `cookies/<platform>.json` (gitignored). Injected into `BrowserContext` on subsequent runs.
- Adding LinkedIn: `new CookieLoginHandler('cookies/linkedin.json')`. Nothing else changes.

---

### Concepts Learned

#### Anthropic Parallel Tool Use
- Anthropic models can return **multiple `tool_use` blocks** in a single response when the prompt implies simultaneous actions (e.g., "upvote AND read").
- The API requires a `tool_result` for **every** `tool_use` ID before the next message. Closing only the last one leaves earlier IDs dangling → `400 BadRequestError`.
- Fix: track `pendingToolCallIds: string[]` (all IDs from the response). On next call, emit one `tool_result` block per ID. Execute only the first tool call; model adapts from observed page state.

#### Tool failure must be communicated to the LLM
- Original: tool throws → runner catches → loop continues → adapter sends `"Action executed successfully."` as the tool_result.
- Problem: LLM reasons about a wrong state (believes the action worked).
- Fix: runner stores the error message in `pendingToolError`. Adapter uses it as the `tool_result` content with `is_error: true`. LLM sees what actually failed and can adapt.

#### Cookies are harness-layer, not LLM-layer
- `page.context().addCookies()` injects the session into the Playwright `BrowserContext` before any page load.
- The LLM is never called during login. It just sees a logged-in page on the next step.
- The cookies file is read and applied entirely in harness code.

---

### Bugs Hit & Fixed (Session 5)

| Bug | Cause | Fix |
|---|---|---|
| `TimeoutError` crashes process | Playwright timeout in tool executor propagated uncaught | try-catch in runner; `pendingToolError` forwarded to adapter |
| `400 BadRequestError` on step 2 | Anthropic returned 2 `tool_use` blocks; adapter only closed 1 | `pendingToolCallIds[]` tracks all IDs; all closed before next API call |

---

### Test Run — Session 5

#### Test 6 — "Upvote 2nd post and summarize it", Anthropic, with cookie login
- Step 1: `click(17)` — upvote arrow for 2nd story (πFS)
- Step 2: Auth wall. **CookieLoginHandler** found `cookies/hn.json` → injected cookies → session restored. LLM not called.
- Step 3: LLM sees logged-in HN → `click(20)` — clicked πFS story link
- Step 4: On GitHub repo page → `click(53)` — opened README.md
- Step 5: LLM read README, called `done()` with full summary
- Verifier: `PASSED — Upvote confirmed: vote link is nosee for story 48480978`
- **Result:** Multi-step task (upvote + navigate + read + summarize) completed end-to-end. ✅

---

### Failure Modes — Updated

| # | Failure Mode | Harness Response |
|---|---|---|
| Blind `done()` acceptance | Fixed — `task.verify()` runs on every `done()` | PASSED/FAILED verdict |
| Auth wall | Fixed — CookieLoginHandler injects session silently | Credentials never touch LLM |
| Tool executor crash | Fixed — try-catch in runner | Loop continues; LLM adapts |
| Parallel tool use (Anthropic) | Fixed — `pendingToolCallIds[]` | All tool_use IDs closed before next API call |
| Tool failure hidden from LLM | Fixed — `pendingToolError` forwarded | LLM receives actual error as `tool_result` |
| Stuck loop | Fixed — `isStuckLoop()` | Stops after 3 identical URLs |

---

## Session 6 — 2026-06-11

### What We Built
Tested the harness on a second platform (LinkedIn) and iterated the `CookieLoginHandler` to be fully generic — zero configuration, works for any site automatically.

---

### Issues Found & Fixed

#### Issue 1 — Wrong cookies tried on LinkedIn
When the LinkedIn auth wall was hit, `CookieLoginHandler` tried HN cookies (its only cookie file). The HN cookies were injected, the harness navigated back to `task.startUrl` (HN), saw no `/login` in the URL, and falsely reported "Session restored." The LLM then found itself back on HN confused.

**Root cause:** `canHandle()` returned `true` for all URLs. The handler had no way to know the auth wall was for a different site.

**Fix 1 (intermediate):** Added a `domain` constructor parameter. `canHandle(url)` checked `url.includes(domain)`. This correctly rejected LinkedIn auth walls when the handler was configured for `ycombinator.com`.

**Fix 2 (final):** Removed the `domain` parameter entirely. The handler now derives the hostname from the live page URL at login time (`new URL(page.url()).hostname`) and auto-names the cookie file: `cookies/<hostname>.json`. Zero configuration. Works for any site.

#### Issue 2 — User had to explicitly mention the platform in loginHandler config
With Fix 1, `index.ts` required `task.loginHandler = new CookieLoginHandler('cookies/linkedin.json', 'linkedin.com')` — redundant when the LinkedIn URL was already in the system prompt. Fix 2 eliminated this entirely.

---

### Files Changed
| File | Change |
|---|---|
| `src/loginHandler.ts` | `CookieLoginHandler` is now parameterless. Derives hostname from `page.url()` at login time. Cookie file auto-named `cookies/<hostname>.json`. |
| `tasks/hn_upvote.ts` | `new CookieLoginHandler()` — no args |
| `src/index.ts` | No platform-specific login config needed |

---

### Key Design Principle Established

#### Auto-derived domain = truly generic login
The handler doesn't need to know the platform in advance. When an auth wall is hit:
1. `canHandle()` returns `true` (willing to try any site)
2. `login()` reads `new URL(page.url()).hostname` → derives `www.linkedin.com`
3. Looks for `cookies/www.linkedin.com.json`
4. If missing → pause for manual login → save to that file
5. Next run → inject silently

Adding a new platform requires **zero code changes**. First run pauses; every run after is silent.

---

### Concepts Learned

#### `waitForLoadState('networkidle')` vs heavy SPAs
LinkedIn (and many modern sites) never reach `networkidle` — they continuously fire background requests. Playwright's 30s timeout fires even though the page has fully rendered. The harness catches the timeout, the LLM observes the current URL (which IS the correct page), and continues. The page content is accessible even after a `networkidle` timeout.

#### `task.startUrl` as the `returnUrl` after login
After login, the harness returns to `task.startUrl` (HN in this case). The LLM then sees it's on HN, not LinkedIn, and re-navigates. This costs one extra step but works correctly — the LLM adapts.

---

### Test Run — Session 6

#### Test 7 — Read LinkedIn profile, Anthropic, cookie login
- Step 1: LLM on HN → `navigate("https://www.linkedin.com/in/rahul18-iitb")`
- Step 2: LinkedIn auth wall → `CookieLoginHandler` found `cookies/www.linkedin.com.json` → session restored → returned to HN
- Step 3: LLM sees HN again → `navigate("https://www.linkedin.com/in/rahul18-iitb")` again → `waitForLoadState` timed out (LinkedIn SPA) but page loaded
- Step 4: LLM on `https://www.linkedin.com/in/rahul18-iitb/` → read full DOM → called `done()` with complete profile summary (experience, education, certifications, skills, engagement metrics)
- Verifier: `PASSED — No known failure patterns detected.`
- **Result:** Full LinkedIn profile read end-to-end. LLM adapted around the `networkidle` timeout. ✅

---

### Failure Modes — Updated

| # | Failure Mode | Harness Response |
|---|---|---|
| Wrong cookies for platform | Fixed — hostname auto-derived from auth wall URL | Each platform gets its own `cookies/<hostname>.json` |
| `networkidle` timeout on SPA | Handled — try-catch in runner | LLM observes loaded page and continues |

---

## Session 7 — 2026-06-11

### What We Built
Two fixes to close the loop on verify FAILED and auth wall recovery:

1. **Retry on verify FAILED** — when `task.verify()` returns FAILED after `done()`, the runner feeds the failure reason back to the LLM via `pendingToolError` and continues the loop. The LLM gets another attempt rather than the run ending silently.
2. **Auth wall interception signal** — when the harness handles an auth wall (login + return), it sets `pendingToolError` to tell the LLM explicitly that its previous action was intercepted and not completed. The LLM retries the action on the authenticated page.

---

### Files Changed
| File | Change |
|---|---|
| `src/runner.ts` | On `done()` + FAILED: set `pendingToolError`, `continue` instead of `break` |
| `src/runner.ts` | On auth wall handled: set `pendingToolError = "action not completed, please retry"` |

---

### Root Cause of the Failure

Before these fixes, when the LLM upvoted a story and got redirected to the auth wall:
1. Harness logged in silently, returned to HN front page
2. LLM saw: "I clicked the upvote. Now I'm logged in on HN." → concluded the vote worked
3. LLM called `done()` without re-clicking the upvote
4. `verify()`: active upvote link still present → `FAILED`
5. Runner printed FAILED and exited

The LLM had no signal that its click was intercepted and never executed. From its message history, the click "succeeded" (tool_result was "Action executed successfully."). It had no reason to retry.

---

### Concepts Learned

#### The LLM's message history is the only source of truth for the LLM
The harness can observe page state directly. The LLM can only reason about what its `tool_result` messages tell it. If the harness silently handles an auth wall and the LLM receives "Action executed successfully", it will reason as if the action happened — even if it didn't.

**Rule:** any time the harness intercepts and changes what the LLM's action actually did, it must communicate that via `pendingToolError`. Silence = the LLM assumes success.

#### `pendingToolError` as the harness-to-LLM communication channel
`pendingToolError` is now used for three cases:
1. **Playwright exception** (tool executor throws) → LLM gets the error message
2. **Verify FAILED** → LLM gets the failure reason and retries
3. **Auth wall handled** → LLM learns its action was intercepted and not completed

All three feed into the same adapter mechanism: `tool_result` with `is_error: true` and the error string as content.

---

### Test Run — Session 7

#### Test 8 — HN Upvote, retry on verify FAILED (before auth wall signal fix)
- Step 1: `click(10)` — upvote arrow → auth wall redirect
- Step 2: Login with saved cookies → returned to HN
- Step 3: LLM assumed vote worked → `done()` → verify `FAILED — Active upvote link still present`
- Step 4: LLM retried — clicked wrong element (13, not the upvote) → URL unchanged
- Step 5: URL unchanged 3× → stuck loop fired
- **Observation:** Retry loop worked, but LLM didn't know WHAT to retry — it guessed wrong

#### After auth wall signal fix
- Step 3: LLM receives `tool_result` error: "Your previous action triggered auth redirect and was NOT completed. Please retry."
- LLM now knows: "My click was intercepted, not executed. I need to click the upvote again."
- Clicks correct upvote element → vote registers → `done()` → verify `PASSED`

---

### Failure Modes — Updated

| # | Failure Mode | Harness Response |
|---|---|---|
| LLM assumes auth-intercepted action succeeded | Fixed — `pendingToolError` set when auth wall is handled | LLM told "action not completed, retry" |
| Verify FAILED → silent exit | Fixed — `pendingToolError` = failure reason, loop continues | LLM gets failure details and retries |

---

## Session 8 — 2026-06-11

### What We Built
Four fixes to SPA compatibility + Gemini as a third LLM provider:

1. **`waitForLoadState` fix** — replaced bare `networkidle` (30s, always times out on SPAs) with `load` + `networkidle(5s)` with silent catch. Normal sites settle quickly; SPAs get 5s to render then harness moves on.
2. **DOM-aware stuck loop** — replaced URL-only stuck detection with URL + DOM fingerprint check. LinkedIn messaging changes content without changing URL; the old 3-step URL check fired prematurely. New: 4-step window, both URL and first 200 chars of DOM must be identical to trigger.
3. **Auth wall redirect fix** — after login, harness now navigates to the intended destination directly (extracted from auth wall URL query params) instead of navigating through the redirect chain. Eliminates the 30s `page.goto` crash on LinkedIn's `/authwall?...&sessionRedirect=...` URLs.
4. **Gemini adapter** — third LLM provider. Set `LLM_PROVIDER=gemini` to switch.

---

### Files Created / Changed
| File | Change |
|---|---|
| `src/tools.ts` | `waitForLoadState('networkidle')` → `load` + `networkidle(5s, catch)` in all 3 tools |
| `src/runner.ts` | `isStuckLoop` now tracks `{url, dom}` pairs; window 3→4; `urlHistory` → `stateHistory` |
| `src/loginHandler.ts` | `extractDestination()` helper — extracts `sessionRedirect` / `next` / `redirect_uri` from auth wall URLs; `page.goto()` wrapped in try/catch |
| `src/llmAdapter.ts` | Added `GeminiAdapter` + updated `Provider` type and factory |
| `package.json` | Added `@google/generative-ai` dependency |

---

### Architecture: Updated Provider List
```
LLM_PROVIDER=anthropic  →  AnthropicAdapter  (tool_use blocks, ID pairing)
LLM_PROVIDER=ollama     →  OllamaAdapter     (OpenAI tool_calls format)
LLM_PROVIDER=gemini     →  GeminiAdapter     (functionCall parts, name-based matching)
```

---

### Concepts Learned

#### `waitForLoadState` — the three modes
- `networkidle` — zero background connections for 500ms. Never fires on SPAs (LinkedIn, Gmail, etc.). Wrong default for modern web apps.
- `load` — HTML document + synchronous resources done. Fires in ~200ms but SPA JS hasn't rendered yet.
- The right pattern: `waitForLoadState('load')` then `waitForLoadState('networkidle', { timeout: 5000 })` with silent catch. Normal sites settle in <1s; SPAs render within 5s even if background traffic never stops.

#### Stuck loop — URL is not enough
- A URL-only stuck loop works on traditional multi-page apps where every meaningful action changes the URL.
- SPAs like LinkedIn messaging change DOM content without changing the URL (switching between conversation threads, loading profiles in sidebars, etc.).
- Fix: fingerprint both URL and DOM. Only truly stuck if both are unchanged for N consecutive steps.

#### Auth wall redirect chains
- Auth wall URLs encode the intended destination as a query param (`sessionRedirect`, `next`, `redirect_uri`).
- Navigating back to the auth wall URL forces the browser through a redirect chain, which can take >30s.
- Fix: extract the destination param and navigate directly. Skips the chain, avoids the timeout.

#### Gemini function calling — `mode: 'ANY'`
- Gemini's default tool mode is `'AUTO'` — the model decides whether to call a tool or respond with text.
- In an agentic loop, text-only responses are always wrong (no tool call = harness has nothing to execute).
- Fix: `toolConfig: { functionCallingConfig: { mode: 'ANY' } }` — forces Gemini to always call one of the registered tools, same constraint Anthropic applies by default.

#### Gemini vs Anthropic tool protocol differences
| | Anthropic | Gemini |
|---|---|---|
| Tool call format | `tool_use` block with an ID | `functionCall` part (no ID) |
| Tool result format | `tool_result` block matched by ID | `functionResponse` part matched by name |
| Parallel tool use | Yes — track all IDs | No — single call per turn |
| System prompt | Separate `system` field | `systemInstruction` in model config |
| Role names | `user` / `assistant` | `user` / `model` |

---

### Bugs Hit & Fixed (Session 8)

| Bug | Cause | Fix |
|---|---|---|
| Every LinkedIn action threw 30s timeout | `waitForLoadState('networkidle')` never fires on SPAs | `load` + `networkidle(5s, catch)` in all tools |
| Stuck loop fired mid-task on LinkedIn messaging | URL unchanged when switching threads; window=3 too small | DOM fingerprint check + window=4 |
| `page.goto` crashed on auth wall URL | LinkedIn's `/authwall?...` redirect chain takes >30s | `extractDestination()` navigates directly to `sessionRedirect` target |
| Gemini returned plain text, no tool call | Default mode `'AUTO'` lets Gemini skip tool use | `toolConfig: { functionCallingConfig: { mode: 'ANY' } }` |

---

## Session 10 — 2026-06-12

### What We Built
The full architecture redesign — OutPost is now a three-agent, event-driven harness instead of a single loop with a hard-coded prompt:

1. **Clarifier agent** — interviews the user in the terminal (one question at a time, essentials only), then proposes a **CampaignSpec** (ordered list of TaskSpecs). The user approves, requests changes (which loop back into the same conversation), or cancels — all before any browser opens.
2. **Orchestrator** — deterministic campaign loop. Opens ONE browser session for the whole campaign (logins persist across tasks), renders `{{outputKey}}` placeholders in later prompts from earlier task outputs (**CampaignContext**), runs each task through the generic runner.
3. **Guard pipeline** — auth wall / stuck loop / error page checks are now pluggable `Guard[]` objects returning `pass | abort | skip_llm`. Adding a guard never touches the runner.
4. **Event bus + run traces** — the runner emits typed `HarnessEvent`s; the terminal renders them and every run is recorded to `runs/<timestamp>/trace.jsonl`. A future web UI is just another listener + an `IOChannel` implementation.
5. **Five new tools** — `read_page` (full visible text — the DOM tree only lists interactive elements), `go_back`, `press_key`, `hover`, and `ask_user` (mid-run questions to the user). Tool string returns now flow back to the LLM as tool_result content.
6. **Hybrid verification** — Clarifier picks a library task (`hn_upvote` with its `:not(.nosee)` check) when one matches, else `GenericTask` (auth wall / error page / report-written checks).
7. **History pruning** — adapters keep the last 4 observations full, collapse older DOM trees. Long campaigns no longer grow context linearly (Session 2's token-growth concern).

### Files Created / Changed
Complete restructure: `src/core/` (orchestrator, runner, guards, context, events, services), `src/agents/clarifier.ts`, `src/llm/` (adapter + one file per provider), `src/browser/` (session, domExtractor, loginHandler), `src/tools/` (registry, browserTools, harnessTools), `src/io/` (channel, terminal, trace), `src/spec.ts`, `tasks/{registry,generic}.ts`, `tasks/library/hn_upvote.ts`. Deleted: old `src/{runner,tools,llmAdapter,task,domExtractor,loginHandler}.ts`, `tasks/hn_upvote.ts`.

### Key Design Principles Established
- **Clarify before executing** — ambiguity is resolved with the user upfront (Clarifier) or mid-run (`ask_user`), never by guessing. No browser until the plan is approved.
- **The Clarifier writes the executor's system prompt** — the spec is data (like a Python dataclass), validated in code before it becomes a Task.
- **Tools as plugins** — a `ToolDefinition` bundles schema + executor in one object; the same `Toolset` mechanism serves the executor (browser tools) and the Clarifier (interview tools).
- **LoginHandler talks through Services** — `bus` for status, `io.ask()` for the manual-login pause. No direct console/stdin, so it works under any future UI.

### Test Runs
- **Clarifier round-trip (piped input)** — goal "Upvote the top story on Hacker News": zero unnecessary questions, picked `hn_upvote` taskType, maxSteps 10, rendered the plan for approval. ✅
- **Stdin-EOF hardening** — piped input running out now produces a clean "Input stream is closed" error instead of a readline stack trace. ✅
- **Live end-to-end** — goal → clarify → approve → browser → click upvote → auth wall guard → cookie login → `skip_llm` message → LLM retried the correct element → done → verify. (Result recorded below.)

**Live end-to-end result:** PASSED. Step 1 click → auth wall → guard logged in via saved cookies and told the LLM its click was intercepted → step 3 LLM re-clicked the correct upvote → step 4 `done()` → verifier confirmed `vote link is nosee for story 48497609` → campaign COMPLETED, browser closed, exit 0. Full event record in `runs/<timestamp>/trace.jsonl`. ✅

### Post-session fix — stuck loop must escalate, not abort
A LinkedIn messaging run died with `[GUARD:stuckLoop] ABORT` even though the page WAS changing (search cleared, conversations loaded). Two bugs, two fixes:

| Bug | Fix |
|---|---|
| DOM fingerprint was only the first 200 chars of the tree — on LinkedIn messaging that's the nav bar, which never changes. Real changes (loaded conversations) were invisible to the guard → false positive. | Runner stores the **full DOM tree** in guard history; stuck = URL + entire tree identical for 4 steps. |
| Genuinely stuck → instant `abort`. The agent never got told its approach was failing, and the user (sitting right there) was never asked. | **3-tier escalation** in `stuckLoopGuard`: ① warn the LLM ("your last 4 actions changed nothing — try a different approach / read_page / ask_user") → ② ask the USER for a hint (or "stop") and forward it to the LLM → ③ abort only if guidance also goes nowhere. Each tier clears the history window for a fresh 4 steps. New guard verdict `inform_llm`: message is attached to the previous tool_result but the LLM still acts this step (unlike `skip_llm`). |

**Principle established: stuck ≠ dead.** Failure paths escalate — LLM first, user second, abort last.
Verified with a scripted guard test: changed-DOM pass / tier-1 warn / tier-2 ask + guidance forwarded / tier-3 abort / "stop" aborts immediately. `tsc` clean.

### Post-session fix 2 — popup/dialog blindness
A LinkedIn run failed when clicking "Message" opened a compose popup the agent couldn't operate. Three root causes, all in harness code:

| Bug | Fix |
|---|---|
| Extractor only queried `a, button, input, select, textarea`. LinkedIn popups are `<div>`s with ARIA roles — the "harish chand • 1st" suggestion (`role="option"`) and the message box (`contenteditable`) had no index, so the LLM could see them in text but never click them. | Selector broadened to ARIA roles (`button, link, option, menuitem, tab, checkbox, radio, combobox, switch, listbox`), `[contenteditable="true"]`, `[onclick]`. Descriptions now include `role="…"` and `(text input — editable)`. |
| Nothing told the LLM a popup was open or which elements belonged to it. | Extractor detects visible `[role="dialog"] / [role="alertdialog"] / [aria-modal="true"]`, prints a `*** POPUP/DIALOG OPEN: "<label>" ***` banner at the top of the tree, and marks every element inside with `(IN POPUP)` — plus the hint that Escape closes most popups. |
| Failed clicks took Playwright's default 30s timeout — steps 17–18 burned a full minute before the LLM could adapt. | `ACTION_TIMEOUT = 8000` on click/fill/hover. Click timeout errors now carry a hint: stale index or popup overlay → check for `(IN POPUP)` elements or `press_key "Escape"`. |

Verified in a headless browser against a synthetic LinkedIn-style popup (banner + `(IN POPUP)` marks + editable detection all correct) and against real HN (230 elements, ~14K chars — no size blow-up). `tsc` clean.

### Post-session fix 3 — the end-state is part of the plan (keepBrowserOpen + follow-up loop)
A "play a song on YouTube" campaign verified PASSED and instantly closed the browser — killing the song, which WAS the deliverable. Fix in two layers:

1. **`keepBrowserOpen` on CampaignSpec** — the Clarifier sets it true when the goal is to watch/listen/view something (rule in its system prompt + required field in the finalize_campaign schema). Shown in the plan preview: "(browser will stay open at the end until you close it)".
2. **Follow-up loop in the orchestrator** — instead of a dead "press Enter to close", the prompt accepts new instructions. Typed text becomes a quick GenericTask (maxSteps 15) whose `startUrl` is the CURRENT page, run in the SAME browser session — "fullscreen", "play another song", etc., loop until Enter/"close". Supporting change in the runner: skip `page.goto(startUrl)` when already on that URL, so a follow-up doesn't reload the page and restart the video.

Verified live by the user: YouTube campaign passed, browser stayed open with the song playing, prompt appeared. `tsc` clean.

---

## Session 10 — Final Summary

### OutPost is Production-Ready

The harness moved from a proof-of-concept single-loop executor to a **production-quality three-agent platform** with full end-to-end testing:

#### Architecture layers (all tested live):
1. **Clarifier agent** — unambiguous goal acquisition; user approves plan before any browser opens; plan revision loops
2. **Orchestrator** — multi-task campaigns; one session; context passing (`{{outputKey}}` substitution)
3. **Executor runner** — generic, extensible, pluggable guards; escalation instead of failure; tool outputs flow back to LLM
4. **Event bus + trace** — observable runs; ready for web UI; trace.jsonl for debugging and evals
5. **Guard pipeline** — auth wall (automatic, credentialless), stuck loop (user guidance), error page; each guard independent
6. **Tool system** — plugins; outputs as strings; 9 tools: navigate, click, type, scroll, go_back, press_key, hover, read_page, ask_user, write_report, done

#### Robustness improvements (all production-facing):
- **Popup/dialog awareness** — ARIA roles + contenteditable matched; banners; `(IN POPUP)` marking
- **8-second action timeouts** — fail fast, recover fast; hints on failure (stale index / overlay)
- **Full DOM tree in stuck detection** — no false positives on SPAs; escalation ladder: warn → ask user → abort
- **Credentialless auth** — CookieLoginHandler parameterless; auto-domains; manual login → silent reuse
- **History pruning** — last 4 full, older collapsed; long campaigns stay in token budget
- **keepBrowserOpen + follow-up loop** — media/pages stay open; user can chain instructions; same session survives

#### Live validation (all passed):
- HN upvote: auth wall → cookie login → `skip_llm` → retry → verify PASSED
- LinkedIn messaging: Harish Chand search → find profile → send message (with popup handling, escalation, follow-up capability)
- YouTube: search → play → keep browser open → follow-up instruction loop

**Commit 54a2f55:** shipped to `main`. 32 files, +1771/−746 lines. `tsc --noEmit` clean. All tests verified in live browser.

---

## Session 11 — 2026-06-15

### What We Tested
Two real-world campaigns run against the full Session 10 architecture — both completed successfully.

---

### Test Runs

#### Test 9 — Multi-step, multi-platform campaign (LinkedIn + Anthropic website)
**Goal:** Find Harish Chand on LinkedIn (connected) → send "HI" → go to Anthropic website → read latest blog about Mythos → summarize → share summary back to Harish on LinkedIn.

- Clarifier broke this into ordered TaskSpecs: LinkedIn search task → Anthropic read task → LinkedIn message task
- LinkedIn search found Harish Chand (connected profile), sent "HI" via compose popup
- Navigated to Anthropic website, used `read_page` to extract full blog content about Mythos, generated summary
- Passed summary via `{{outputKey}}` CampaignContext into the third task's system prompt
- Sent summary to Harish on LinkedIn in the same browser session (cookies persisted)
- **Result:** End-to-end multi-platform campaign with context passing PASSED ✅

#### Test 10 — Media campaign (YouTube)
**Goal:** Search and play "One Thousand Miles" by Honey Singh on YouTube.

- Clarifier set `keepBrowserOpen: true`
- Agent searched YouTube, found the song, played it
- Browser stayed open with song playing; follow-up loop activated
- **Result:** PASSED, browser kept open ✅

---

### Failure Mode Observed

| # | Failure Mode | What Happened | Fix Needed |
|---|---|---|---|
| 1 | **Google-native platform crash without prior login** | YouTube and Gmail (Google-owned sites) crash or hit auth walls mid-campaign when not logged in beforehand. The CookieLoginHandler pause works but the Google SSO flow is complex enough to cause instability. | For Google-native platforms, the Clarifier (or a pre-flight check) should detect the domain and prompt the user to log in manually before the campaign starts — same as the first-run cookie flow but triggered earlier. |

---

### Key Takeaway
The Session 10 architecture held up under real multi-step, multi-platform campaigns. The one actionable gap: **Google-native platforms (YouTube, Gmail, Google Docs, etc.) need a pre-flight login prompt** rather than relying on mid-run auth wall interception.

---

## Session 12 — 2026-06-30

### What We Built
Six reliability fixes across LLM resilience, context management, auth recovery, and platform-specific routing.

---

### Fix 1 — Gemini LLM retry on transient errors (`src/llm/gemini.ts`)
Gemini was crashing campaigns on 503 "high demand" and 429 rate-limit errors with no recovery. Added `withRetry()` — exponential backoff (2s → 4s → 8s), up to 4 attempts, matches on `503 | 429 | overload | rate-limit | try again`. Non-transient errors (400, auth failures) are not retried.

---

### Fix 2 — Context overflow: compact mode (`src/core/runner.ts`, `src/browser/domExtractor.ts`, `src/tools/browserTools.ts`, `src/tools/registry.ts`)

**Root cause:** An HN thread with 800 comments has 4000+ interactive elements. Each DOM tree observation was ~200K+ chars. With 4 full history steps, the total hit Anthropic's 200K token limit.

**Design:** Compact mode is **off by default** — no behavior change for normal pages. It activates automatically the first time a "prompt too long" API error is detected.

**What compact mode does:**
- DOM tree: capped at 200 elements (from unlimited). Saves ~95% of context on heavy pages.
- `read_page`: cap raised from 8K → 40K chars. With the DOM now small, we can afford more text content for the tasks that actually need it (summarization, reading articles).

**Implementation:** `compactMode: boolean` flag in the runner. Passed as `compact` to `extractDOM(page, compact)` and `ToolContext`. Runner logs `[WARN] Context overflow detected — switching to compact mode` on activation. Stays on for the rest of that task.

---

### Fix 3 — Adapter history rollback on API error (`src/llm/anthropic.ts`, `src/llm/gemini.ts`)

**Root cause:** When the API call threw (e.g. "prompt too long"), the adapter had already pushed the user message (with `tool_result` IDs) to history, but never pushed the assistant response. On the next step, the adapter tried to close the same `tool_use` IDs again — producing a dangling `tool_result` with no matching `tool_use` in the previous message → permanent 400 loop.

**Fix:** Both adapters now wrap the API call in try/catch. On failure, `this.messages.pop()` (Anthropic) / `this.history.pop()` (Gemini) rolls back the user message. `pendingToolCallIds` / `pendingFunctionName` are unchanged, so the next step correctly closes the prior tool use. History is always in a valid state.

---

### Fix 4 — Post-login navigation to wrong URL (`src/browser/loginHandler.ts`)

**Root cause:** `extractDestination(authWallUrl)` falls back to returning the auth wall URL itself when no redirect param is found (e.g. LinkedIn's `/login?trk=...` has no `sessionRedirect`). After login, `page.goto('/login?trk=...')` navigated back to the login page.

**Fix:** Fallback changed from `url` → `parsed.origin` (e.g. `https://www.linkedin.com`). After login, the harness navigates to the site root, which redirects to the feed/dashboard once the session is active.

---

### Fix 5 — `loginAttempted` guard silently passed to confused LLM (`src/core/guards.ts`)

**Root cause:** When `loginAttempted` was already `true` and the agent was still on an auth wall, the guard returned `pass` — the LLM saw a login page, had no credentials, and returned an empty tool call → task failed.

**Fix:** Guard now returns `inform_llm` with an explicit message: "login is already handled — use `navigate` to go to your destination directly." The LLM recovers by navigating instead of trying to log in.

---

### Fix 6 — LinkedIn platform rule: no Messaging tab (`src/agents/clarifier.ts`)

Added a "Platform-specific rules" section to the Clarifier's system prompt. For LinkedIn:
> Never navigate to `linkedin.com/messaging`. To interact with someone, search their name in the LinkedIn search bar, open their profile, and act from there (e.g. click "Message" on the profile page).

The Clarifier embeds this verbatim in every LinkedIn task's `systemPrompt`. The executor always goes profile → message, never Messaging section → search.

---

### Test Run — Session 12
**Goal:** Find Anthropic Mythos post on HN → summarize → send to Hardik Gupta on LinkedIn → play "One Thousand Miles" on YouTube.

- Task 1: Compact mode activated after context overflow on the 800-comment HN thread → DOM capped to 200 elements → successfully summarized, report saved to `Report/anthropic_mythos_hn_summary.md`. PASSED ✅
- Task 2: LinkedIn cookies expired → manual login → post-login navigation fix landed on feed correctly → agent searched Hardik Gupta's profile → sent message. PASSED ✅
- Task 3: YouTube song played, browser kept open. PASSED ✅

---

## Upcoming — Session 13

### Two Planned Changes (carried over from Session 12 plan)

#### 1. Remove `maxSteps` cap — replace with semantic guards
- Remove the hard ceiling from `TaskSpec` and the runner.
- Add step warning at ~20 steps via `ask_user`: "This is taking longer than expected — continue?"
- Stuck loop guard is the real safety net.

#### 2. JARVIS mode — always-on persistent loop
- Process stays alive after campaign completes: "Ready. What's next?"
- Only exits on `"quit"` / `"exit"`.
- Fresh `BrowserContext` per campaign; cookie files reused from disk.
