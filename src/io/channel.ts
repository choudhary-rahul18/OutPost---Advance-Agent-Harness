import { HarnessEvent } from '../core/events.js';

// ── IOChannel — the user-facing surface of the harness ───────────────────────
// Everything the harness says to the user goes through render(); everything it
// needs FROM the user goes through ask(). Today the implementation is a
// terminal (readline). A future web UI implements this same interface over a
// websocket — no harness code changes.
export interface IOChannel {
  ask(question: string): Promise<string>;
  render(event: HarnessEvent): void;
  close(): void;
}
