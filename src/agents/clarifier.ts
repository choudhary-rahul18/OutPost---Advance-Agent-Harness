import { CampaignSpec, TaskSpec } from '../spec.js';
import { Services } from '../core/services.js';
import { createAdapter, Provider, ToolResultMsg, ToolSchema } from '../llm/adapter.js';
import { taskTypes } from '../../tasks/registry.js';

// ── Clarifier agent ───────────────────────────────────────────────────────────
// The planning agent that runs BEFORE any browser opens. It interviews the
// user until the goal is unambiguous, then emits a CampaignSpec. It reuses the
// same LLMAdapter as the executor — just with interview tools instead of
// browser tools. After the plan is drafted, the user approves it or requests
// changes, which loop back into the same conversation.

const MAX_ROUNDS = 20;

const CLARIFIER_SYSTEM_PROMPT = `You are the planning agent of a browser-automation harness.
Your job: turn the user's request into an executable campaign plan. You do NOT browse — a separate executor agent does.

The executor is an LLM that sees the page's interactive elements each step and has these tools:
navigate, click, type, scroll, go_back, press_key, hover, read_page (extracts full page text), write_report (saves a markdown file to Report/), ask_user (asks the user mid-task), done.
Login is handled by the harness automatically with saved cookies — NEVER ask the user for credentials, usernames, or passwords.

Your process:
1. If anything essential is unclear, call ask_user — ONE short question at a time. Essential means: the target website, which specific item/person/post is meant, what counts as success, and whether a saved report is wanted. Do NOT ask about things you can reasonably infer, and do not exceed 3 questions unless the user's answers raise new ambiguity.
2. When the goal is clear, call finalize_campaign with the full plan.

Rules for the plan:
- Split the goal into the MINIMUM number of tasks. One task = one website + one objective. Only use multiple tasks when the goal spans sites or has clearly separate phases (e.g. "read X on HN" then "post about it on LinkedIn").
- Each task's systemPrompt is the executor's complete instruction set: start with "You are a browser automation agent.", then numbered concrete steps, ending with "Call done() with <what the output should contain>."
- If a later task needs an earlier task's result, give the earlier task an outputKey (e.g. "article_summary") and reference it in the later task's systemPrompt as {{article_summary}} — the harness substitutes the actual content before the task runs.
- If the executor must read content, instruct it to use read_page. If the user wants findings saved, instruct write_report and set expectsReport to true.
- taskType: use "hn_upvote" ONLY for upvoting a Hacker News story; otherwise "generic".
- maxSteps: 10 for trivial tasks, 20 for typical tasks, 30 for long multi-page tasks.
- keepBrowserOpen: true when the user's goal is to watch, listen to, or look at something in the browser (play a song or video, open/show a page) — the browser then stays open after completion until the user closes it. false for action or data tasks (upvote, send a message, collect info, save a report).`;

const clarifierTools: ToolSchema[] = [
  {
    name: 'ask_user',
    description: 'Ask the user one short clarifying question and wait for the answer.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One specific question.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'finalize_campaign',
    description: 'Submit the final campaign plan once the goal is fully understood.',
    input_schema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'One-line refined statement of what the user wants.' },
        keepBrowserOpen: { type: 'boolean', description: 'true if the deliverable is on screen (playing media, viewing a page) — browser stays open until the user closes it.' },
        tasks: {
          type: 'array',
          description: 'Ordered list of tasks. Length 1 for simple goals.',
          items: {
            type: 'object',
            properties: {
              name:          { type: 'string', description: 'Short human label, e.g. "Read top HN story".' },
              taskType:      { type: 'string', enum: [...taskTypes], description: 'Which task implementation to use.' },
              systemPrompt:  { type: 'string', description: 'Complete numbered instructions for the executor agent.' },
              startUrl:      { type: 'string', description: 'Full URL the task starts on.' },
              maxSteps:      { type: 'number', description: 'Step budget: 10 / 20 / 30.' },
              expectsReport: { type: 'boolean', description: 'true if the task must save a file via write_report.' },
              outputKey:     { type: 'string', description: 'Optional: key under which this task\'s output is stored for later tasks.' },
            },
            required: ['name', 'taskType', 'systemPrompt', 'startUrl', 'maxSteps', 'expectsReport'],
          },
        },
      },
      required: ['goal', 'tasks', 'keepBrowserOpen'],
    },
  },
];

// Returns the approved CampaignSpec, or null if the user cancelled at the
// approval prompt.
export async function clarify(provider: Provider, sv: Services, initialGoal: string): Promise<CampaignSpec | null> {
  const adapter = createAdapter(provider, CLARIFIER_SYSTEM_PROMPT, clarifierTools);

  let observation = `The user's request: "${initialGoal}"`;
  let toolResult: ToolResultMsg | undefined;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { toolName, toolInput } = await adapter.getNextAction(observation, toolResult);
    toolResult = undefined;

    if (toolName === 'ask_user') {
      const question = String(toolInput['question'] ?? '');
      const answer = await sv.io.ask(`\n[CLARIFIER] ${question}\n> `);
      toolResult = { content: `The user answered: "${answer}"`, isError: false };
      observation = 'Continue: ask another question only if essential, otherwise call finalize_campaign.';
      continue;
    }

    if (toolName === 'finalize_campaign') {
      const spec = parseSpec(toolInput);
      if (typeof spec === 'string') {
        // Validation failed — tell the LLM what was wrong and let it fix the plan.
        toolResult = { content: `Invalid plan: ${spec}`, isError: true };
        observation = 'Fix the plan and call finalize_campaign again.';
        continue;
      }

      // ── Plan approval — the user sees the plan before any browser opens ────
      renderPlan(spec, sv);
      const feedback = await sv.io.ask('\nRun this plan? Press Enter to start, type "cancel" to abort, or describe what to change.\n> ');
      if (feedback === '') return spec;
      if (/^(cancel|quit|exit)$/i.test(feedback)) return null;

      toolResult = { content: `The user requested changes to the plan: "${feedback}"`, isError: false };
      observation = 'Revise the plan based on the user\'s feedback. Ask a question if the feedback is unclear, otherwise call finalize_campaign with the updated plan.';
      continue;
    }

    // No tool call or an unknown tool — steer the model back to its two tools.
    toolResult = { content: 'You must respond with a tool call: ask_user or finalize_campaign.', isError: true };
    observation = 'Please use one of your tools.';
  }

  throw new Error(`Clarifier did not produce an approved campaign within ${MAX_ROUNDS} rounds.`);
}

// Validate the LLM's plan. Returns a CampaignSpec, or an error string
// describing what is wrong (fed back to the LLM to fix).
function parseSpec(input: Record<string, unknown>): CampaignSpec | string {
  const goal = String(input['goal'] ?? '').trim();
  if (!goal) return 'missing "goal"';

  const rawTasks = input['tasks'];
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) return '"tasks" must be a non-empty array';

  const tasks: TaskSpec[] = [];
  for (const [i, t] of rawTasks.entries()) {
    const obj = t as Record<string, unknown>;
    const name         = String(obj['name'] ?? '').trim();
    const taskType     = String(obj['taskType'] ?? 'generic');
    const systemPrompt = String(obj['systemPrompt'] ?? '').trim();
    const startUrl     = String(obj['startUrl'] ?? '').trim();
    if (!name)                          return `task ${i + 1}: missing "name"`;
    if (!systemPrompt)                  return `task ${i + 1}: missing "systemPrompt"`;
    if (!/^https?:\/\//.test(startUrl)) return `task ${i + 1}: "startUrl" must be a full http(s) URL`;

    tasks.push({
      name,
      taskType,
      systemPrompt,
      startUrl,
      maxSteps:      Number(obj['maxSteps']) > 0 ? Number(obj['maxSteps']) : 20,
      expectsReport: Boolean(obj['expectsReport']),
      outputKey:     obj['outputKey'] ? String(obj['outputKey']) : undefined,
    });
  }

  return { goal, tasks, keepBrowserOpen: Boolean(input['keepBrowserOpen']) };
}

function renderPlan(spec: CampaignSpec, sv: Services): void {
  sv.bus.emit({ type: 'log', level: 'info', message: `Proposed campaign — goal: ${spec.goal}` });
  if (spec.keepBrowserOpen) {
    sv.bus.emit({ type: 'log', level: 'info', message: '  (browser will stay open at the end until you close it)' });
  }
  for (const [i, t] of spec.tasks.entries()) {
    const extras = [
      `type=${t.taskType}`,
      `maxSteps=${t.maxSteps}`,
      t.expectsReport ? 'writes report' : '',
      t.outputKey ? `output → {{${t.outputKey}}}` : '',
    ].filter(Boolean).join(', ');
    sv.bus.emit({ type: 'log', level: 'info', message: `  Task ${i + 1}: ${t.name} — ${t.startUrl} (${extras})` });
  }
}
