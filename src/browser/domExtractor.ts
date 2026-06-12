import { Page } from 'playwright';

// extractDOM runs a plain JS function INSIDE the browser via page.evaluate().
// Think of page.evaluate() as a remote procedure call:
//   Node.js (harness) → serialise → [browser V8] → execute → serialise → Node.js
// The function has full access to document/window but CANNOT touch Node.js or Playwright.
// The return value must be JSON-serialisable — a plain string here.
export async function extractDOM(page: Page): Promise<string> {
  const tree = await page.evaluate(() => {
    // ── Everything inside this arrow function runs inside the browser ─────────

    // Native interactive tags are not enough for modern SPAs: LinkedIn (and
    // most React apps) build buttons, dropdown options, and even text inputs
    // out of <div>s with ARIA roles or contenteditable. Without these, popup
    // contents are invisible to the LLM.
    const INTERACTIVE_SELECTOR = [
      'a', 'button', 'input', 'select', 'textarea',
      '[role="button"]', '[role="link"]', '[role="option"]', '[role="menuitem"]',
      '[role="menuitemradio"]', '[role="tab"]', '[role="checkbox"]', '[role="radio"]',
      '[role="combobox"]', '[role="switch"]', '[role="listbox"]',
      '[contenteditable="true"]', '[onclick]',
    ].join(', ');
    const elements = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));

    // Popup/dialog detection: if a modal or dialog is open, the elements
    // inside it are usually the ONLY ones that matter (and the ones behind it
    // often can't be clicked — the overlay intercepts the pointer).
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]'))
      .filter(d => {
        const r = d.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    const dialogLabel = (d: Element): string =>
      d.getAttribute('aria-label')
      ?? d.querySelector('h1, h2, h3, [role="heading"]')?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60)
      ?? '(untitled)';

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
      const role        = el.getAttribute('role') ?? '';
      const type        = el.getAttribute('type') ?? '';
      const name        = el.getAttribute('name') ?? '';
      const placeholder = el.getAttribute('placeholder') ?? '';
      const ariaLabel   = el.getAttribute('aria-label') ?? '';
      const editable    = el.getAttribute('contenteditable') === 'true';
      const innerText   = el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60) ?? '';
      const href        = el.getAttribute('href') ?? '';
      const inDialog    = dialogs.some(d => d.contains(el));

      let desc = `[${index}] ${tag.toUpperCase()}`;
      if (role)        desc += ` role="${role}"`;
      if (type)        desc += ` type="${type}"`;
      if (name)        desc += ` name="${name}"`;
      if (placeholder) desc += ` placeholder="${placeholder}"`;
      if (ariaLabel)   desc += ` aria-label="${ariaLabel}"`;
      if (editable)    desc += ` (text input — editable)`;
      if (innerText)   desc += ` text="${innerText}"`;
      if (href && href !== '#') desc += ` href="${href.slice(0, 80)}"`;
      if (inDialog)    desc += ` (IN POPUP)`;

      lines.push(desc);
      index++;
    }

    // If a popup is open, say so loudly at the top of the tree — and warn that
    // the page behind it is usually not clickable until the popup is handled.
    if (dialogs.length > 0) {
      const labels = dialogs.map(d => `"${dialogLabel(d)}"`).join(', ');
      lines.unshift(
        `*** POPUP/DIALOG OPEN: ${labels} ***`,
        `Elements marked (IN POPUP) belong to it. Interact with those to use the popup;`,
        `elements behind a popup often cannot be clicked. press_key "Escape" closes most popups.`,
        '',
      );
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

// Same surrogate sanitisation for text extracted in Node (e.g. read_page output).
export function sanitizeText(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
             .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}
