import { Page } from 'playwright';
import { LoginHandler } from './browser/loginHandler.js';

// ── TaskSpec — what the Clarifier produces for ONE task ──────────────────────
// A plain data object (like a Python dataclass). The Clarifier LLM fills this
// in; tasks/registry.ts turns it into a runnable Task.
export interface TaskSpec {
  name: string;           // short human label, e.g. "Read top HN story"
  taskType: string;       // registry key: 'hn_upvote' | 'generic' | ...
  systemPrompt: string;   // numbered instructions for the executor LLM.
                          // May contain {{outputKey}} placeholders filled in
                          // from earlier tasks' results by the orchestrator.
  startUrl: string;
  maxSteps: number;
  expectsReport: boolean; // generic verify checks a Report/ file was written
  outputKey?: string;     // where this task's result lands in CampaignContext
}

// ── CampaignSpec — the Clarifier's full output ────────────────────────────────
// An ordered list of tasks. Length 1 for simple goals; multi-entry for
// campaigns like "read HN story → write a LinkedIn post about it".
export interface CampaignSpec {
  goal: string;           // one-line refined statement of what the user wants
  tasks: TaskSpec[];
  // true when the goal's deliverable IS the open browser (playing a song,
  // showing a page). The orchestrator then waits for the user to press Enter
  // before closing, instead of tearing down the moment verification passes.
  keepBrowserOpen: boolean;
}

// ── Task — the runtime contract every platform implements ────────────────────
// Unchanged from the original architecture: the runner only knows this shape.
export interface Task {
  name: string;
  startUrl: string;
  systemPrompt: string;
  maxSteps: number;
  loginHandler: LoginHandler | null;
  isAuthWall(url: string): boolean;
  onAuthResolved(page: Page, interceptedUrl: string): Promise<void>;
  verify(page: Page): Promise<{ passed: boolean; message: string }>;
}
