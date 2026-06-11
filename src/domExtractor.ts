import { Page } from 'playwright';

// extractDOM runs a plain JS function INSIDE the browser via page.evaluate().
// Think of page.evaluate() as a remote procedure call:
//   Node.js (harness) → serialise → [browser V8] → execute → serialise → Node.js
// The function has full access to document/window but CANNOT touch Node.js or Playwright.
// The return value must be JSON-serialisable — a plain string here.
export async function extractDOM(page: Page): Promise<string> {
  const tree = await page.evaluate(() => {
    // ── Everything inside this arrow function runs inside the browser ─────────

    const INTERACTIVE_TAGS = 'a, button, input, select, textarea';
    const elements = Array.from(document.querySelectorAll(INTERACTIVE_TAGS));

    let index = 0;
    const lines: string[] = [];

    for (const el of elements) {
      // Visibility check 1: element must have a non-zero bounding box on screen.
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      // Visibility check 2: CSS must not be hiding it.
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

      // Stamp a temporary attribute onto the DOM node so our Tool Registry can
      // target it with: page.locator('[data-index="N"]')
      el.setAttribute('data-index', String(index));

      // Build a human-readable description of this element for the LLM.
      // More detail = better LLM decisions. Keep it on one line per element.
      const tag         = el.tagName.toLowerCase();
      const type        = el.getAttribute('type') ?? '';
      const name        = el.getAttribute('name') ?? '';
      const placeholder = el.getAttribute('placeholder') ?? '';
      const ariaLabel   = el.getAttribute('aria-label') ?? '';
      const innerText   = el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60) ?? '';
      const href        = el.getAttribute('href') ?? '';

      let desc = `[${index}] ${tag.toUpperCase()}`;
      if (type)        desc += ` type="${type}"`;
      if (name)        desc += ` name="${name}"`;
      if (placeholder) desc += ` placeholder="${placeholder}"`;
      if (ariaLabel)   desc += ` aria-label="${ariaLabel}"`;
      if (innerText)   desc += ` text="${innerText}"`;
      if (href && href !== '#') desc += ` href="${href.slice(0, 80)}"`;

      lines.push(desc);
      index++;
    }

    // Return a plain string — safe to cross the page.evaluate() bridge.
    const raw = lines.length > 0
      ? lines.join('\n')
      : '(no interactive elements found on this page)';

    // Sanitise: strip unpaired Unicode surrogates.
    // Sites like LinkedIn emit broken UTF-16 in DOM text. Lone surrogates are
    // invalid in JSON — the Anthropic/Gemini API will reject the entire request
    // with "no low surrogate in string" if these slip through.
    return raw.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
              .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  });

  return tree;
}
