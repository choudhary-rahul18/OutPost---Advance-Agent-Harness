import fs from 'fs';
import path from 'path';
import { Page } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';

// ── Tool input shapes ─────────────────────────────────────────────────────────
// These are TypeScript interfaces — like Python dataclasses, but compile-time only.
// They describe exactly what arguments each tool expects.
interface NavigateInput { url: string; }
interface ClickInput    { elementIndex: number; }
interface TypeInput     { elementIndex: number; text: string; }
interface DoneInput        { reason: string; }
interface ScrollInput      { direction: 'up' | 'down'; }
interface WriteReportInput { filename: string; content: string; }

// A union type: ToolInput is exactly one of these shapes.
// The `|` is TypeScript's "or" for types — same idea as Python's Union[A, B, C].
export type ToolInput = NavigateInput | ClickInput | TypeInput | DoneInput | ScrollInput | WriteReportInput;

// ── Tool Registry ─────────────────────────────────────────────────────────────
// Maps tool name (string) → async function that takes (page, args) and runs it.
// Record<string, ...> is TypeScript's way of saying "an object used as a map".
export const toolRegistry: Record<string, (page: Page, args: ToolInput) => Promise<void>> = {

  navigate: async (page, args) => {
    const { url } = args as NavigateInput;
    console.log(`  → TOOL: navigate("${url}")`);
    await page.goto(url);
    await page.waitForLoadState('load');
    try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch { /* SPA — content rendered despite background requests */ }
  },

  click: async (page, args) => {
    const { elementIndex } = args as ClickInput;
    console.log(`  → TOOL: click(element ${elementIndex})`);
    // This is why we stamped data-index in the DOM Extractor:
    // [data-index="N"] is a CSS attribute selector — find the element we labelled.
    await page.locator(`[data-index="${elementIndex}"]`).click();
    await page.waitForLoadState('load');
    try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch { /* SPA */ }
  },

  type: async (page, args) => {
    const { elementIndex, text } = args as TypeInput;
    console.log(`  → TOOL: type(element ${elementIndex}, "${text}")`);
    const locator = page.locator(`[data-index="${elementIndex}"]`);
    await locator.fill(text);
    await locator.press('Enter');
    await page.waitForLoadState('load');
    try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch { /* SPA */ }
  },

  scroll: async (page, args) => {
    const { direction } = args as ScrollInput;
    // Scroll by one viewport height in the given direction
    const delta = direction === 'up' ? -1 : 1;
    await page.evaluate((d) => window.scrollBy(0, d * window.innerHeight), delta);
    await page.waitForTimeout(500);  // let lazy-loaded content render
    console.log(`  → TOOL: scroll("${direction}")`);
  },

  write_report: async (_page, args) => {
    const { filename, content } = args as WriteReportInput;
    // path.basename strips any directory traversal (e.g. "../../.env" → ".env")
    // replace() removes chars that aren't alphanumeric, underscore, hyphen, dot, or space
    const safe = path.basename(filename).replace(/[^a-zA-Z0-9_\-. ]/g, '_');
    const mdFile = safe.endsWith('.md') ? safe : `${safe}.md`;
    fs.mkdirSync('Report', { recursive: true });
    fs.writeFileSync(path.join('Report', mdFile), content, 'utf-8');
    console.log(`  → TOOL: write_report → Report/${mdFile}`);
  },

};

// ── Tool schemas for the Claude API ──────────────────────────────────────────
// This is what we send to Claude so it knows which tools exist and how to call them.
// Claude returns a "tool_use" block with the tool name + a JSON-matching the input_schema.
// Anthropic.Tool is the SDK's type for this structure.
export const toolSchemas: Anthropic.Tool[] = [
  {
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
  {
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
  {
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
  {
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
  {
    name: 'done',
    description: 'Signal that the goal has been achieved or cannot be achieved. Always call this to end the session.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Explain what was accomplished or why the goal cannot be completed.' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'write_report',
    description: 'Save research, summaries, or notes as a markdown file in the local Report/ folder. Use this whenever the task asks you to note down, save, or record findings.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Filename for the report, e.g. "hn_summary". The .md extension is added automatically if omitted.' },
        content:  { type: 'string', description: 'Full markdown content to write to the file.' },
      },
      required: ['filename', 'content'],
    },
  },
];
