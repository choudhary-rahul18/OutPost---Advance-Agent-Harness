import { Page } from 'playwright';
import { ToolDefinition } from './registry.js';
import { sanitizeText } from '../browser/domExtractor.js';

// ── Browser tool pack ─────────────────────────────────────────────────────────
// Every tool that drives the Playwright page. Assembled into the executor's
// Toolset in core/runner.ts.

// Shared post-action wait: 'load' fires fast; networkidle gets 5s for SPAs
// (LinkedIn never goes idle — the catch is deliberate, content is rendered).
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch { /* SPA */ }
}

// Playwright's default 30s action timeout wastes 1.5 steps' worth of time per
// failed click. 8s is plenty for an actionability check — fail fast so the
// LLM can adapt within its step budget.
const ACTION_TIMEOUT = 8000;

// Click timeouts are almost always "element moved after re-render" or
// "a popup/overlay is intercepting the pointer" — tell the LLM which moves help.
const CLICK_HINT = 'The element may have moved (stale index) or be covered by a popup — check the latest element list for a "(IN POPUP)" section and interact with that, or press_key "Escape" to close the popup.';

export const browserTools: ToolDefinition[] = [
  {
    schema: {
      name: 'navigate',
      description: 'Navigate the browser to a specific URL. Use this to go to a website.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The full URL to navigate to, including https://' },
        },
        required: ['url'],
      },
    },
    async execute({ page }, args) {
      await page.goto(String(args['url']));
      await settle(page);
    },
  },
  {
    schema: {
      name: 'click',
      description: 'Click on an interactive element identified by its index in the DOM tree.',
      input_schema: {
        type: 'object',
        properties: {
          elementIndex: { type: 'number', description: 'The [N] index of the element to click, from the DOM tree.' },
        },
        required: ['elementIndex'],
      },
    },
    async execute({ page }, args) {
      try {
        await page.locator(`[data-index="${Number(args['elementIndex'])}"]`).click({ timeout: ACTION_TIMEOUT });
      } catch (err) {
        throw new Error(`${(err as Error).message.split('\n')[0]} — ${CLICK_HINT}`);
      }
      await settle(page);
    },
  },
  {
    schema: {
      name: 'type',
      description: 'Type text into an input field and press Enter. Use for search boxes and text inputs.',
      input_schema: {
        type: 'object',
        properties: {
          elementIndex: { type: 'number', description: 'The [N] index of the input element to type into.' },
          text:         { type: 'string', description: 'The text to type into the element.' },
        },
        required: ['elementIndex', 'text'],
      },
    },
    async execute({ page }, args) {
      const locator = page.locator(`[data-index="${Number(args['elementIndex'])}"]`);
      await locator.fill(String(args['text']), { timeout: ACTION_TIMEOUT });
      await locator.press('Enter');
      await settle(page);
    },
  },
  {
    schema: {
      name: 'scroll',
      description: 'Scroll the page up or down by one screenful. Use this to reveal content below the fold or to navigate back up.',
      input_schema: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction: "up" or "down".' },
        },
        required: ['direction'],
      },
    },
    async execute({ page }, args) {
      const delta = args['direction'] === 'up' ? -1 : 1;
      await page.evaluate((d) => window.scrollBy(0, d * window.innerHeight), delta);
      await page.waitForTimeout(500);  // let lazy-loaded content render
    },
  },
  {
    schema: {
      name: 'go_back',
      description: 'Go back to the previous page in browser history. Cheaper than re-navigating by URL.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    async execute({ page }) {
      await page.goBack();
      await settle(page);
    },
  },
  {
    schema: {
      name: 'press_key',
      description: 'Press a keyboard key on the page, e.g. "Escape" to close a popup or modal, "Tab", "Enter", "ArrowDown".',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The key to press, e.g. "Escape", "Enter", "Tab", "ArrowDown".' },
        },
        required: ['key'],
      },
    },
    async execute({ page }, args) {
      await page.keyboard.press(String(args['key']));
      await page.waitForTimeout(500);
    },
  },
  {
    schema: {
      name: 'hover',
      description: 'Hover the mouse over an element to reveal dropdown menus or tooltips, without clicking.',
      input_schema: {
        type: 'object',
        properties: {
          elementIndex: { type: 'number', description: 'The [N] index of the element to hover over, from the DOM tree.' },
        },
        required: ['elementIndex'],
      },
    },
    async execute({ page }, args) {
      await page.locator(`[data-index="${Number(args['elementIndex'])}"]`).hover({ timeout: ACTION_TIMEOUT });
      await page.waitForTimeout(500);  // let the hover menu render
    },
  },
  {
    schema: {
      name: 'read_page',
      description: 'Extract the full visible text content of the current page. Use this to actually READ articles, profiles, or posts — the DOM tree only lists interactive elements, not the text between them.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    async execute({ page, compact }) {
      // Default: 8K chars (enough for most pages).
      // Compact mode (activated after a context-overflow error): 40K chars —
      // the DOM tree is already cut to 200 elements, so we can afford more text.
      const MAX_CHARS = compact ? 40_000 : 8_000;
      const raw = await page.evaluate(() => document.body?.innerText ?? '');
      const text = sanitizeText(raw).trim();
      if (text.length === 0) return '(page has no visible text)';
      if (text.length > MAX_CHARS) {
        return text.slice(0, MAX_CHARS) + `\n…[truncated — page has ${text.length} chars total; scroll and read_page again for more]`;
      }
      return text;
    },
  },
];
