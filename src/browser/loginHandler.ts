import { Page } from 'playwright';
import * as fs from 'fs';
import { Services } from '../core/services.js';

// ── LoginHandler interface ────────────────────────────────────────────────────
// Services gives the handler the event bus (for status messages) and the IO
// channel (for the "press Enter when logged in" pause) — no direct console or
// stdin access, so the same handler works under a future web UI.
export interface LoginHandler {
  canHandle(url: string): boolean;
  login(page: Page, returnUrl: string, services: Services): Promise<boolean>;
}

// ── CookieLoginHandler ────────────────────────────────────────────────────────
// Fully generic — no configuration needed. Derives the domain from the auth wall
// URL at runtime and auto-names the cookie file (e.g. cookies/www.linkedin.com.json).
//
// On first encounter with a site:
//   1. Pauses and waits for the user to log in manually in the open browser
//   2. Saves the session cookies to cookies/<hostname>.json
// On subsequent runs:
//   1. Injects the saved cookies — skips the login page entirely
//   2. Falls back to manual login if the cookies have expired
//
// Works with 2FA, CAPTCHAs, and any login mechanism — because a human does it.
// No credentials are ever stored in code or passed to the LLM.
export class CookieLoginHandler implements LoginHandler {
  canHandle(_url: string): boolean {
    return true; // handles any auth wall — domain derived at login time
  }

  async login(page: Page, returnUrl: string, sv: Services): Promise<boolean> {
    const hostname   = new URL(page.url()).hostname;
    const cookiePath = `cookies/${hostname}.json`;

    // Auth wall URLs often encode the real destination as a query param.
    // Navigate directly there to skip the redirect chain entirely.
    const targetUrl = extractDestination(returnUrl);

    // ── Try saved cookies first ───────────────────────────────────────────
    if (fs.existsSync(cookiePath)) {
      sv.bus.emit({ type: 'log', level: 'info', message: `[LOGIN] Found saved cookies for ${hostname}. Trying...` });
      const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
      await page.context().addCookies(cookies);
      try {
        await page.goto(targetUrl);
      } catch {
        // goto timed out — check where we landed anyway
      }
      try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch { /* SPA */ }
      if (!/\/login|\/signin|\/auth/.test(page.url())) {
        sv.bus.emit({ type: 'log', level: 'info', message: '[LOGIN] Session restored from saved cookies.' });
        return true;
      }
      sv.bus.emit({ type: 'log', level: 'warn', message: '[LOGIN] Saved cookies expired or invalid. Falling back to manual login.' });
    }

    // ── Manual login fallback ─────────────────────────────────────────────
    sv.bus.emit({ type: 'log', level: 'info', message: `[LOGIN] Manual login required for ${hostname}. The browser is open — please log in.` });
    await sv.io.ask('[LOGIN] Press Enter here when you are done... ');

    // Save cookies so the next run skips this step
    const cookies = await page.context().cookies();
    fs.mkdirSync('cookies', { recursive: true });
    fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
    sv.bus.emit({ type: 'log', level: 'info', message: `[LOGIN] Cookies saved to ${cookiePath}. Future runs will skip login.` });

    try {
      await page.goto(targetUrl);
    } catch {
      // goto timed out — SPA may have loaded anyway
    }
    try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch { /* SPA */ }
    return true;
  }
}

// Many auth wall URLs encode the intended destination as a query param.
// Extract it directly so we skip the redirect chain (avoids 30s goto timeouts).
//   LinkedIn:  ?sessionRedirect=https://linkedin.com/in/...
//   OAuth:     ?redirect_uri=...
//   Django:    ?next=...
// If no known param is found, use the URL as-is.
function extractDestination(url: string): string {
  try {
    const parsed = new URL(url);
    return (
      parsed.searchParams.get('sessionRedirect') ??
      parsed.searchParams.get('redirect_uri')    ??
      parsed.searchParams.get('next')            ??
      parsed.searchParams.get('return_to')       ??
      parsed.origin  // no redirect param — go to site home; the site will redirect to feed/dashboard
    );
  } catch {
    return url;
  }
}
