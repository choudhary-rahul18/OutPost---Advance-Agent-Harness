import { Page } from 'playwright';
import { Task } from '../spec.js';
import { Services } from './services.js';
import { defaultGuards, Guard, GuardState } from './guards.js';
import { extractDOM } from '../browser/domExtractor.js';
import { Toolset } from '../tools/registry.js';
import { browserTools } from '../tools/browserTools.js';
import { harnessTools } from '../tools/harnessTools.js';
import { createAdapter, Provider, ToolResultMsg } from '../llm/adapter.js';

// ── Executor runner — the generic supervisor loop ─────────────────────────────
// Zero platform knowledge, zero provider knowledge, zero UI knowledge:
//   platform  → Task interface          (tasks/)
//   provider  → LLMAdapter              (llm/)
//   guards    → Guard pipeline          (guards.ts)
//   UI/output → events on the bus       (events.ts)
// The runner itself never changes.

export interface TaskResult {
  passed: boolean;
  output: string;   // the agent's done() reason — becomes campaign context
  message: string;  // verifier / failure detail
}

const executorToolset = new Toolset([...browserTools, ...harnessTools]);

export async function runTask(task: Task, page: Page, provider: Provider, sv: Services): Promise<TaskResult> {
  const guards: Guard[] = defaultGuards;
  const adapter = createAdapter(provider, task.systemPrompt, executorToolset.schemas);

  // Follow-up tasks start on the page the previous task ended on — reloading
  // it would destroy live state (a playing video, an open popup). Only
  // navigate when we aren't already there.
  if (page.url() !== task.startUrl) {
    await page.goto(task.startUrl);
    await page.waitForLoadState('load');
    try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch { /* SPA */ }
  }

  const state: GuardState = { loginAttempted: false, history: [], stuckEscalation: 0 };
  // The harness→LLM back-channel: tool output, tool error, guard interception,
  // or a verify failure — delivered as the previous action's tool_result.
  let pendingResult: ToolResultMsg | undefined;
  // Activated after a "prompt too long" API error. Caps DOM to 200 elements
  // and read_page to 40K chars for all remaining steps in this task.
  let compactMode = false;

  for (let step = 0; step < task.maxSteps; step++) {
    const url   = page.url();
    const title = await page.title();
    const tree  = await extractDOM(page, compactMode);

    sv.bus.emit({ type: 'step_started', step: step + 1, maxSteps: task.maxSteps, url, title });
    // Full tree, not a truncated fingerprint — SPA changes can be anywhere.
    state.history.push({ url, dom: tree });

    // ── Guard pipeline — runs before the LLM is consulted ────────────────────
    let intervened = false;
    for (const guard of guards) {
      const verdict = await guard.check(page, task, state, sv);
      if (verdict.action === 'pass') continue;

      sv.bus.emit({
        type: 'guard_fired',
        guard: guard.name,
        verdict: verdict.action,
        message: verdict.action === 'abort' ? verdict.message : verdict.messageToLLM,
      });

      if (verdict.action === 'abort') {
        return { passed: false, output: '', message: verdict.message };
      }
      if (verdict.action === 'inform_llm') {
        // Attach the warning to the previous action's tool_result, keeping any
        // tool output that's already there. The LLM still acts this step.
        const prior = pendingResult ? `${pendingResult.content}\n\n` : '';
        pendingResult = { content: prior + verdict.messageToLLM, isError: true };
        continue;
      }
      // skip_llm: the guard acted on the page itself (e.g. login). Tell the
      // LLM next call that its action was intercepted, and skip this step.
      pendingResult = { content: verdict.messageToLLM, isError: true };
      intervened = true;
      break;
    }
    if (intervened) continue;

    // ── Ask the LLM for the next action ───────────────────────────────────────
    const observation =
      `Current URL: ${url}\n` +
      `Page title: ${title}\n\n` +
      `Interactive elements on the page:\n${tree}`;

    let toolName: string;
    let toolInput: Record<string, unknown>;
    let reasoning: string;
    try {
      ({ toolName, toolInput, reasoning } = await adapter.getNextAction(observation, pendingResult));
    } catch (err) {
      const msg = (err as Error).message.split('\n')[0];
      if (/too long|prompt.*token|context.*length/i.test(msg) && !compactMode) {
        compactMode = true;
        sv.bus.emit({ type: 'log', level: 'warn', message: `Context overflow detected — switching to compact mode (DOM capped at 200 elements, read_page at 40K chars).` });
      } else {
        sv.bus.emit({ type: 'log', level: 'error', message: `LLM API error: ${msg}. Retrying next step...` });
      }
      pendingResult = undefined;
      continue;
    }
    pendingResult = undefined;

    sv.bus.emit({ type: 'llm_action', toolName, toolInput, reasoning });

    if (!toolName) {
      return { passed: false, output: '', message: 'No tool call returned. Agent may be confused.' };
    }

    // ── done() — verify in code, retry on failure ─────────────────────────────
    if (toolName === 'done') {
      const agentClaim = String(toolInput['reason'] ?? '');
      const result = await task.verify(page);

      sv.bus.emit({
        type: 'verify_result',
        passed: result.passed,
        message: result.message,
        agentClaim,
        url: page.url(),
        title: await page.title(),
      });

      if (result.passed) {
        return { passed: true, output: agentClaim, message: result.message };
      }
      // Feed the failure reason back as an error tool_result and let it retry.
      pendingResult = { content: `Verification failed: ${result.message} Please retry the task.`, isError: true };
      continue;
    }

    // ── Execute via the Toolset ───────────────────────────────────────────────
    if (!executorToolset.has(toolName)) {
      return { passed: false, output: '', message: `Unknown tool "${toolName}". Agent hallucinated a tool name.` };
    }

    try {
      const output = await executorToolset.run(toolName, { page, services: sv, compact: compactMode }, toolInput);
      await page.waitForTimeout(1000);
      if (typeof output === 'string') {
        // Tool produced output (read_page text, ask_user answer, ...) —
        // deliver it to the LLM as the tool_result next call.
        pendingResult = { content: output, isError: false };
      }
      sv.bus.emit({ type: 'tool_executed', toolName, output: typeof output === 'string' ? output : undefined });
    } catch (err) {
      // Tool failure (e.g. Playwright timeout) is not fatal — forward the error
      // so the LLM knows the action failed and can decide how to recover.
      const msg = (err as Error).message.split('\n')[0];
      pendingResult = { content: msg, isError: true };
      sv.bus.emit({ type: 'tool_executed', toolName, error: msg });
    }
  }

  return { passed: false, output: '', message: `MAX_STEPS (${task.maxSteps}) reached. Task incomplete.` };
}
