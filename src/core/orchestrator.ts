import { CampaignSpec, TaskSpec } from '../spec.js';
import { Services } from './services.js';
import { CampaignContext } from './context.js';
import { runTask } from './runner.js';
import { openSession, closeSession, BrowserSession } from '../browser/session.js';
import { buildTask } from '../../tasks/registry.js';
import { Provider } from '../llm/adapter.js';

// ── Orchestrator — runs a campaign of tasks in order ──────────────────────────
// Deterministic code, no LLM calls of its own:
//   1. Opens ONE browser session for the whole campaign (logins persist)
//   2. Renders {{placeholders}} in each task's prompt from earlier outputs
//   3. Runs each task through the generic runner
//   4. Stores each task's output under its outputKey for later tasks
// A failed task stops the campaign — later tasks likely depend on its output.
export async function runCampaign(spec: CampaignSpec, provider: Provider, sv: Services): Promise<boolean> {
  sv.bus.emit({ type: 'campaign_started', goal: spec.goal, taskCount: spec.tasks.length });

  const context = new CampaignContext();
  let session: BrowserSession | null = null;

  try {
    session = await openSession();
    sv.bus.emit({ type: 'log', level: 'info', message: 'Browser ready.' });

    for (let i = 0; i < spec.tasks.length; i++) {
      const raw = spec.tasks[i];
      // Fill {{outputKey}} placeholders with results from earlier tasks.
      const rendered: TaskSpec = { ...raw, systemPrompt: context.render(raw.systemPrompt) };
      const task = buildTask(rendered);

      sv.bus.emit({
        type: 'task_started',
        index: i, total: spec.tasks.length,
        name: task.name, startUrl: task.startUrl, maxSteps: task.maxSteps,
      });

      const result = await runTask(task, session.page, provider, sv);

      if (raw.outputKey) context.set(raw.outputKey, result.output);
      sv.bus.emit({ type: 'task_finished', name: task.name, passed: result.passed, output: result.output });

      if (!result.passed) {
        sv.bus.emit({ type: 'campaign_finished', passed: false, summary: `Task "${task.name}" failed: ${result.message}` });
        return false;
      }
    }

    sv.bus.emit({ type: 'campaign_finished', passed: true, summary: `All ${spec.tasks.length} task(s) completed and verified.` });

    // If the deliverable is what's on screen (playing media, an open page),
    // hand control to the user instead of closing instantly — and accept
    // follow-up instructions in the same browser session.
    if (spec.keepBrowserOpen) {
      await followUpLoop(session, provider, sv);
    }
    return true;

  } finally {
    await closeSession(session);
    sv.bus.emit({ type: 'log', level: 'info', message: 'Browser closed.' });
  }
}

// ── Follow-up loop ────────────────────────────────────────────────────────────
// The browser is open with the campaign's result on screen. Instead of a dead
// "press Enter to close", the prompt accepts new instructions ("fullscreen",
// "play another song") — each becomes a quick GenericTask that starts on the
// CURRENT page in the SAME session. Enter or "close" ends the session.
async function followUpLoop(session: BrowserSession, provider: Provider, sv: Services): Promise<void> {
  for (;;) {
    const instruction = await sv.io.ask(
      '\n[HARNESS] Browser stays open. Press Enter to close it, or type a follow-up instruction (e.g. "fullscreen", "play another song").\n> ',
    );
    if (instruction === '' || /^(close|exit|quit|stop|done)$/i.test(instruction)) return;

    const spec: TaskSpec = {
      name: `Follow-up: ${instruction.slice(0, 50)}`,
      taskType: 'generic',
      systemPrompt:
        'You are a browser automation agent continuing an ongoing session — the page you see is exactly where the previous task ended (do not navigate away unless the instruction requires it).\n' +
        `The user's follow-up instruction: "${instruction}"\n` +
        'Carry it out starting from the current page. If the instruction is ambiguous, use ask_user. When finished, call done() describing what you did.',
      startUrl: session.page.url(),
      maxSteps: 15,
      expectsReport: false,
    };
    const task = buildTask(spec);

    sv.bus.emit({ type: 'task_started', index: 0, total: 1, name: task.name, startUrl: task.startUrl, maxSteps: task.maxSteps });
    const result = await runTask(task, session.page, provider, sv);
    sv.bus.emit({ type: 'task_finished', name: task.name, passed: result.passed, output: result.output });
  }
}
