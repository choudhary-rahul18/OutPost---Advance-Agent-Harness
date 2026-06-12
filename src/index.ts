import 'dotenv/config';
import { EventBus } from './core/events.js';
import { Services } from './core/services.js';
import { TerminalChannel } from './io/terminal.js';
import { createTraceWriter } from './io/trace.js';
import { clarify } from './agents/clarifier.js';
import { runCampaign } from './core/orchestrator.js';
import { Provider } from './llm/adapter.js';

// ── OutPost entry point ───────────────────────────────────────────────────────
// Wiring only — no logic lives here:
//   terminal channel + trace file subscribe to the event bus
//   user's goal (terminal) → Clarifier (interview → approved CampaignSpec)
//   CampaignSpec → Orchestrator (browser, tasks, context passing)
const provider = (process.env.LLM_PROVIDER ?? 'anthropic') as Provider;

const io = new TerminalChannel();
const bus = new EventBus();
bus.on(event => io.render(event));   // user-facing output
bus.on(createTraceWriter());         // runs/<timestamp>/trace.jsonl

const sv: Services = { bus, io };

try {
  const goal = await io.ask('\nOutPost — what should the agent do?\n> ');
  if (!goal) {
    bus.emit({ type: 'log', level: 'error', message: 'No goal given. Exiting.' });
  } else {
    bus.emit({ type: 'log', level: 'info', message: `Provider: ${provider}. Clarifying the goal...` });
    const spec = await clarify(provider, sv, goal);
    if (spec) {
      await runCampaign(spec, provider, sv);
    } else {
      bus.emit({ type: 'log', level: 'info', message: 'Cancelled by user. No browser was opened.' });
    }
  }
} catch (err) {
  bus.emit({ type: 'log', level: 'error', message: (err as Error).message });
} finally {
  // readline holds stdin open — without this the process never exits.
  io.close();
}
