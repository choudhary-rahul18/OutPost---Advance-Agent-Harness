import { chromium, Browser, BrowserContext } from 'playwright';
import { extractDOM } from './domExtractor.js';
import { toolRegistry } from './tools.js';
import { createAdapter, Provider } from './llmAdapter.js';
import { Task } from './task.js';

// Generic harness guards — no platform knowledge.
function isErrorPage(title: string): boolean {
  return /\b(404|403|error|not found|forbidden|unauthorized)\b/i.test(title);
}

// Tracks both URL and a DOM fingerprint (first 200 chars of the tree).
// On SPAs like LinkedIn messaging, URL can stay the same while meaningful
// content changes — checking DOM prevents premature stuck detection.
function isStuckLoop(history: Array<{ url: string; dom: string }>, window = 4): boolean {
  if (history.length < window) return false;
  const tail = history.slice(-window);
  return tail.every(s => s.url === tail[0].url && s.dom === tail[0].dom);
}

export async function runTask(task: Task, provider: Provider): Promise<void> {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext();
    const page = await context.newPage();
    console.log('[HARNESS] Browser ready.');

    const adapter = createAdapter(provider, task.systemPrompt);
    console.log(`[HARNESS] Provider: ${provider}`);
    console.log(`[HARNESS] Task: ${task.name}\n`);

    await page.goto(task.startUrl);
    await page.waitForLoadState('networkidle');

    const stateHistory: Array<{ url: string; dom: string }> = [];
    let loginAttempted = false;
    let pendingToolError: string | undefined;

    for (let step = 0; step < task.maxSteps; step++) {
      console.log(`\n━━━ Step ${step + 1} / ${task.maxSteps} ${'━'.repeat(40)}`);

      const url   = page.url();
      const title = await page.title();
      const tree  = await extractDOM(page);

      console.log(`[DOM] URL: ${url} | Title: ${title}`);
      stateHistory.push({ url, dom: tree.slice(0, 200) });

      // ── Harness checks — run before LLM is consulted ──────────────────────
      if (task.isAuthWall(url)) {
        if (!loginAttempted && task.loginHandler?.canHandle(url)) {
          loginAttempted = true;
          console.log('[HARNESS] Auth wall detected — attempting harness-driven login...');
          const success = await task.loginHandler.login(page, url);
          if (!success) {
            console.log('[HARNESS] Login failed. Cannot recover. Stopping.');
            break;
          }
          await task.onAuthResolved(page, url);
          // Tell the LLM that the auth redirect was handled and it is now on the
          // intended page. It should continue from its current position.
          pendingToolError = 'Authentication was handled automatically. You are now on the page you were trying to access. Please continue your task from here.';
          console.log('[HARNESS] Resuming task.');
          continue;
        }
        console.log('[HARNESS] WARNING — Auth wall detected. No handler available or login already attempted.');
      }
      if (isStuckLoop(stateHistory)) {
        console.log('[HARNESS] STUCK — URL and DOM unchanged for 4 consecutive steps. Stopping.');
        break;
      }
      if (isErrorPage(title)) {
        console.log(`[HARNESS] ERROR PAGE — "${title}". Stopping.`);
        break;
      }

      // ── Ask the LLM for the next action ───────────────────────────────────
      console.log(`[LLM] Asking ${provider} for next action...`);
      const { toolName, toolInput, reasoning } = await adapter.getNextAction({ url, title, tree }, pendingToolError);
      pendingToolError = undefined;

      if (reasoning) console.log(`[LLM] Reasoning: ${reasoning}`);

      if (!toolName) {
        console.log('[HARNESS] FAILED — No tool call returned. Agent may be confused.');
        break;
      }

      console.log(`[LLM] Chose tool: ${toolName}(${JSON.stringify(toolInput)})`);

      if (toolName === 'done') {
        const agentReason = String(toolInput['reason'] ?? '');
        const result = await task.verify(page);

        console.log('\n' + '═'.repeat(55));
        console.log('[VERIFY] Final page state:');
        console.log(`         URL:   ${page.url()}`);
        console.log(`         Title: ${await page.title()}`);
        console.log(`[VERIFY] Agent claimed: "${agentReason}"`);
        console.log('─'.repeat(55));
        console.log(`[VERIFY] ${result.message}`);
        console.log('═'.repeat(55));

        if (result.passed) break;

        // Verification failed — feed the reason back to the LLM as a tool_result
        // error and let it retry. The adapter will close the done tool_use pair
        // with this error on the next getNextAction call.
        pendingToolError = `Verification failed: ${result.message} Please retry the task.`;
        continue;
      }

      // ── Execute via Tool Registry ──────────────────────────────────────────
      const executor = toolRegistry[toolName];
      if (!executor) {
        console.log(`[HARNESS] FAILED — Unknown tool "${toolName}". Agent hallucinated a tool name.`);
        break;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      try {
        await executor(page, toolInput as any);
        await page.waitForTimeout(1000);
      } catch (err) {
        // Tool failure (e.g. Playwright timeout) is not fatal — treat it as a bad
        // action and let the loop continue. The error is forwarded to the adapter
        // so it closes the tool_use/tool_result pair correctly AND the LLM knows
        // the action failed and can decide how to recover.
        pendingToolError = (err as Error).message.split('\n')[0];
        console.log(`[HARNESS] Tool "${toolName}" failed: ${pendingToolError}`);
        console.log('[HARNESS] Continuing — LLM will observe current page state and adapt.');
      }
    }

    if (stateHistory.length === task.maxSteps) {
      console.log(`\n[HARNESS] FAILED — MAX_STEPS (${task.maxSteps}) reached. Task incomplete.`);
    }

  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    console.log('\n[HARNESS] Browser closed.');
  }
}
