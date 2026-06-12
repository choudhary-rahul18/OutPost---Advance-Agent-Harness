import { chromium, Browser, BrowserContext, Page } from 'playwright';

// ── BrowserSession — one browser for the whole campaign ──────────────────────
// The orchestrator opens ONE session and passes the same page to every task.
// This matters: cookies injected during task 1's login stay in the
// BrowserContext, so task 2 on the same site is already authenticated.
export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export async function openSession(): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  return { browser, context, page };
}

export async function closeSession(session: BrowserSession | null): Promise<void> {
  if (!session) return;
  await session.context.close();
  await session.browser.close();
}
