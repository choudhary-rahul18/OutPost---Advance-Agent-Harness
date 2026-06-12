import readline from 'node:readline/promises';
import { IOChannel } from './channel.js';
import { HarnessEvent } from '../core/events.js';

// ── TerminalChannel — the terminal implementation of IOChannel ───────────────
// ask() uses node:readline/promises — the async equivalent of Python's input().
// render() turns harness events into the console output the user reads.
export class TerminalChannel implements IOChannel {
  private rl: readline.Interface | null = null;
  private stdinClosed = false;

  async ask(question: string): Promise<string> {
    // stdin can end (EOF / Ctrl+D / piped input ran out) — fail with a clear
    // message instead of a readline stack trace.
    if (this.stdinClosed) throw new Error('Input stream is closed — cannot ask the user a question.');

    // Lazily create one shared readline interface. stdin keeps the process
    // alive while it is open — close() must be called at the end of the run.
    if (!this.rl) {
      this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      this.rl.on('close', () => { this.stdinClosed = true; this.rl = null; });
    }

    const rl = this.rl;
    let onClose!: () => void;
    const closed = new Promise<never>((_, reject) => {
      onClose = () => reject(new Error('Input stream closed while waiting for an answer.'));
      rl.once('close', onClose);
    });
    try {
      const answer = await Promise.race([rl.question(question), closed]);
      return answer.trim();
    } finally {
      rl.removeListener('close', onClose);
    }
  }

  render(event: HarnessEvent): void {
    switch (event.type) {
      case 'log': {
        const prefix = event.level === 'error' ? 'ERROR — ' : event.level === 'warn' ? 'WARNING — ' : '';
        console.log(`[HARNESS] ${prefix}${event.message}`);
        break;
      }
      case 'campaign_started':
        console.log('\n' + '═'.repeat(55));
        console.log(`[CAMPAIGN] Goal: ${event.goal}`);
        console.log(`[CAMPAIGN] ${event.taskCount} task(s) planned.`);
        console.log('═'.repeat(55));
        break;
      case 'task_started':
        console.log(`\n━━━ TASK ${event.index + 1}/${event.total}: ${event.name} ${'━'.repeat(20)}`);
        console.log(`[TASK] Start URL: ${event.startUrl} | Max steps: ${event.maxSteps}`);
        break;
      case 'step_started':
        console.log(`\n━━━ Step ${event.step} / ${event.maxSteps} ${'━'.repeat(40)}`);
        console.log(`[DOM] URL: ${event.url} | Title: ${event.title}`);
        break;
      case 'guard_fired':
        console.log(`[GUARD:${event.guard}] ${event.verdict.toUpperCase()} — ${event.message}`);
        break;
      case 'llm_action':
        if (event.reasoning) console.log(`[LLM] Reasoning: ${event.reasoning}`);
        console.log(`[LLM] Chose tool: ${event.toolName}(${JSON.stringify(event.toolInput)})`);
        break;
      case 'tool_executed':
        if (event.error) {
          console.log(`  → TOOL ${event.toolName} FAILED: ${event.error}`);
        } else {
          const preview = event.output ? ` → ${event.output.slice(0, 200).replace(/\n/g, ' ')}${event.output.length > 200 ? '…' : ''}` : '';
          console.log(`  → TOOL ${event.toolName} ok${preview}`);
        }
        break;
      case 'verify_result':
        console.log('\n' + '═'.repeat(55));
        console.log('[VERIFY] Final page state:');
        console.log(`         URL:   ${event.url}`);
        console.log(`         Title: ${event.title}`);
        console.log(`[VERIFY] Agent claimed: "${event.agentClaim}"`);
        console.log('─'.repeat(55));
        console.log(`[VERIFY] ${event.message}`);
        console.log('═'.repeat(55));
        break;
      case 'task_finished':
        console.log(`\n[TASK] "${event.name}" ${event.passed ? 'PASSED' : 'FAILED'}.`);
        break;
      case 'campaign_finished':
        console.log('\n' + '═'.repeat(55));
        console.log(`[CAMPAIGN] ${event.passed ? 'COMPLETED' : 'FAILED'} — ${event.summary}`);
        console.log('═'.repeat(55));
        break;
    }
  }

  close(): void {
    this.rl?.close();
    this.rl = null;
  }
}
