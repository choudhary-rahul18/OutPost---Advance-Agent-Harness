// ── HarnessEvent — every observable thing the harness does ───────────────────
// The runner/orchestrator never print directly. They emit typed events to the
// EventBus; listeners decide what to do with them (terminal rendering, trace
// file, a future web UI over websocket). This is the observer pattern — like a
// list of Python callbacks, each invoked with the event dict.
export type HarnessEvent =
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'campaign_started'; goal: string; taskCount: number }
  | { type: 'task_started'; index: number; total: number; name: string; startUrl: string; maxSteps: number }
  | { type: 'step_started'; step: number; maxSteps: number; url: string; title: string }
  | { type: 'guard_fired'; guard: string; verdict: string; message: string }
  | { type: 'llm_action'; toolName: string; toolInput: Record<string, unknown>; reasoning: string }
  | { type: 'tool_executed'; toolName: string; output?: string; error?: string }
  | { type: 'verify_result'; passed: boolean; message: string; agentClaim: string; url: string; title: string }
  | { type: 'task_finished'; name: string; passed: boolean; output: string }
  | { type: 'campaign_finished'; passed: boolean; summary: string };

export type EventListener = (event: HarnessEvent) => void;

export class EventBus {
  private listeners: EventListener[] = [];

  on(listener: EventListener): void {
    this.listeners.push(listener);
  }

  emit(event: HarnessEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
