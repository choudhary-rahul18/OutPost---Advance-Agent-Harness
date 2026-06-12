import fs from 'fs';
import path from 'path';
import { Page } from 'playwright';
import { Task, TaskSpec } from '../src/spec.js';
import { LoginHandler, CookieLoginHandler } from '../src/browser/loginHandler.js';

// ── GenericTask — runs any Clarifier-written goal ─────────────────────────────
// The fallback when no hand-written task file matches. Verification here is
// universal-only (not on an auth wall, not on an error page, report written if
// one was promised) — platform-specific DOM checks like HN's :not(.nosee)
// need a dedicated task file in the library.
export class GenericTask implements Task {
  name: string;
  startUrl: string;
  systemPrompt: string;
  maxSteps: number;
  loginHandler: LoginHandler = new CookieLoginHandler();

  private expectsReport: boolean;
  private runStartedAt = Date.now();

  constructor(spec: TaskSpec) {
    this.name = spec.name;
    this.startUrl = spec.startUrl;
    this.systemPrompt = spec.systemPrompt;
    this.maxSteps = spec.maxSteps;
    this.expectsReport = spec.expectsReport;
  }

  isAuthWall(url: string): boolean {
    // Generic login-redirect patterns. Word-boundary style matching so that
    // e.g. /author/... does not false-positive on "auth".
    return /\/(login|log-in|signin|sign-in|authwall|checkpoint|auth)([/?#&]|$)/i.test(url);
  }

  async onAuthResolved(_page: Page, _interceptedUrl: string): Promise<void> {
    // Nothing platform-specific to do — the LLM retries its action after login.
  }

  async verify(page: Page): Promise<{ passed: boolean; message: string }> {
    if (this.isAuthWall(page.url())) {
      return { passed: false, message: 'FAILED — Blocked by authentication wall. The claimed action was never completed.' };
    }

    const title = await page.title();
    if (/\b(404|403|error|not found|forbidden|unauthorized)\b/i.test(title)) {
      return { passed: false, message: 'FAILED — Agent ended on an error page.' };
    }

    if (this.expectsReport && !this.reportWrittenSinceStart()) {
      return { passed: false, message: 'FAILED — Task was expected to save a report, but no new file appeared in Report/.' };
    }

    return { passed: true, message: 'PASSED — No known failure patterns detected.' };
  }

  // True if any file in Report/ was modified after this task was constructed.
  private reportWrittenSinceStart(): boolean {
    if (!fs.existsSync('Report')) return false;
    return fs.readdirSync('Report').some(f => {
      const stat = fs.statSync(path.join('Report', f));
      return stat.mtimeMs >= this.runStartedAt;
    });
  }
}
