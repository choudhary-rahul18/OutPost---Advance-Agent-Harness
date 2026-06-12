import { Task, TaskSpec } from '../src/spec.js';
import { GenericTask } from './generic.js';
import { HNUpvoteTask } from './library/hn_upvote.js';

// ── Task registry — the hybrid verification switch ────────────────────────────
// The Clarifier picks a taskType from this list (it is the enum in the
// finalize_campaign schema). Library tasks bring platform-specific verify();
// everything else falls back to GenericTask's universal checks.
//
// Adding a platform: write tasks/library/<platform>.ts, add its key here and
// a case in buildTask. Nothing else in the harness changes.
export const taskTypes = ['generic', 'hn_upvote'] as const;

export function buildTask(spec: TaskSpec): Task {
  switch (spec.taskType) {
    case 'hn_upvote': return new HNUpvoteTask(spec);
    default:          return new GenericTask(spec);
  }
}
