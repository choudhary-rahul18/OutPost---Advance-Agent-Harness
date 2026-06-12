import { Page } from 'playwright';
import { Task } from '../spec.js';
import { Services } from './services.js';

// ── Guard pipeline ────────────────────────────────────────────────────────────
// Guards run every step BEFORE the LLM is consulted. Each guard inspects the
// live page + the run state and returns a verdict:
//   pass       → next guard / continue to LLM
//   abort      → stop the task with a failure message (last resort only)
//   skip_llm   → the guard intervened (e.g. handled a login); skip the LLM this
//                step and deliver messageToLLM as an error tool_result next
//                call, so the LLM knows its previous action was intercepted.
//   inform_llm → the LLM still acts THIS step, but messageToLLM is attached to
//                its previous tool_result — a warning, not an interception.
// Adding a guard = one new object in this file (or a task-specific list).
// The runner never changes.

export interface GuardState {
  loginAttempted: boolean;
  history: Array<{ url: string; dom: string }>;
  // Stuck-loop escalation ladder: 0 = none, 1 = LLM warned, 2 = user consulted.
  stuckEscalation: number;
}

export type GuardVerdict =
  | { action: 'pass' }
  | { action: 'abort'; message: string }
  | { action: 'skip_llm'; messageToLLM: string }
  | { action: 'inform_llm'; messageToLLM: string };

export interface Guard {
  name: string;
  check(page: Page, task: Task, state: GuardState, sv: Services): Promise<GuardVerdict>;
}

// ── Auth wall guard ───────────────────────────────────────────────────────────
// Detects login redirects and resolves them in deterministic code. The LLM
// never sees the auth wall URL or anything about credentials — it only learns
// "your previous action was intercepted, retry it" via the skip_llm message.
export const authWallGuard: Guard = {
  name: 'authWall',
  async check(page, task, state, sv) {
    const url = page.url();
    if (!task.isAuthWall(url)) return { action: 'pass' };

    if (state.loginAttempted || !task.loginHandler?.canHandle(url)) {
      sv.bus.emit({ type: 'log', level: 'warn', message: 'Auth wall detected — no handler available or login already attempted.' });
      return { action: 'pass' };
    }

    state.loginAttempted = true;
    sv.bus.emit({ type: 'log', level: 'info', message: 'Auth wall detected — attempting harness-driven login...' });

    const success = await task.loginHandler.login(page, url, sv);
    if (!success) return { action: 'abort', message: 'Login failed. Cannot recover.' };

    await task.onAuthResolved(page, url);
    return {
      action: 'skip_llm',
      messageToLLM: 'Your previous action triggered an authentication redirect and was NOT completed. ' +
                    'Authentication has been handled automatically — you are now on the intended page. ' +
                    'Please retry your action from here.',
    };
  },
};

// ── Stuck loop guard ──────────────────────────────────────────────────────────
// Compares URL + the FULL DOM tree across steps. On SPAs like LinkedIn
// messaging, the URL stays the same while content changes — and the change may
// be far down the tree (loaded conversations, opened panels), which is why a
// truncated fingerprint produces false positives. Full-string comparison only
// fires when literally nothing observable changed.
//
// Being stuck is not fatal. The guard escalates:
//   tier 1 → warn the LLM: "your approach is not working, try something else"
//   tier 2 → ask the USER for guidance (or permission to stop)
//   tier 3 → abort — only after the user's guidance also went nowhere
// Each tier clears the history window, giving the agent a fresh STUCK_WINDOW
// steps to show progress before the next escalation.
const STUCK_WINDOW = 4;

export const stuckLoopGuard: Guard = {
  name: 'stuckLoop',
  async check(page, _task, state, sv) {
    if (state.history.length < STUCK_WINDOW) return { action: 'pass' };
    const tail = state.history.slice(-STUCK_WINDOW);
    const stuck = tail.every(s => s.url === tail[0].url && s.dom === tail[0].dom);
    if (!stuck) return { action: 'pass' };

    state.history.length = 0; // fresh window before the next escalation check

    if (state.stuckEscalation === 0) {
      state.stuckEscalation = 1;
      return {
        action: 'inform_llm',
        messageToLLM:
          `WARNING: your last ${STUCK_WINDOW} actions produced NO observable change on the page. ` +
          'Your current approach is not working. Try a fundamentally different approach: ' +
          'a different element, a different navigation path (navigate/go_back), read_page to reorient yourself, ' +
          'or ask_user if you are blocked by something only the user can resolve.',
      };
    }

    if (state.stuckEscalation === 1) {
      state.stuckEscalation = 2;
      sv.bus.emit({ type: 'log', level: 'warn', message: 'Agent still stuck after a warning — asking the user for guidance.' });
      const answer = await sv.io.ask(
        `\n[STUCK] The agent has made no progress on ${page.url()}.\n` +
        `Give it a hint (e.g. where to click, a different approach), or type "stop" to abort.\n> `,
      );
      if (/^(stop|abort|quit|cancel)$/i.test(answer)) {
        return { action: 'abort', message: 'Stuck — user chose to stop.' };
      }
      return {
        action: 'inform_llm',
        messageToLLM:
          'You were stuck, so the harness asked the user for help. ' +
          `The user's guidance: "${answer}". Follow this guidance now.`,
      };
    }

    return { action: 'abort', message: 'No progress even after warning the agent and applying user guidance. Stopping.' };
  },
};

// ── Error page guard ──────────────────────────────────────────────────────────
export const errorPageGuard: Guard = {
  name: 'errorPage',
  async check(page) {
    const title = await page.title();
    if (/\b(404|403|error|not found|forbidden|unauthorized)\b/i.test(title)) {
      return { action: 'abort', message: `Landed on an error page: "${title}".` };
    }
    return { action: 'pass' };
  },
};

export const defaultGuards: Guard[] = [authWallGuard, stuckLoopGuard, errorPageGuard];
