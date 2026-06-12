import fs from 'fs';
import path from 'path';
import { EventListener } from '../core/events.js';

// ── Run trace — every event appended as one JSON line ────────────────────────
// runs/<timestamp>/trace.jsonl is the full record of a run: every step, every
// LLM decision, every guard, the final verdict. Used for debugging and future
// evals. JSONL = one JSON object per line, streamable and grep-friendly.
export function createTraceWriter(): EventListener {
  const runDir = path.join('runs', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(runDir, { recursive: true });
  const traceFile = path.join(runDir, 'trace.jsonl');

  return (event) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    fs.appendFileSync(traceFile, line + '\n', 'utf-8');
  };
}
