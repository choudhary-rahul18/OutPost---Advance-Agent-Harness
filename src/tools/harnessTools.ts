import fs from 'fs';
import path from 'path';
import { ToolDefinition } from './registry.js';

// ── Harness tool pack ─────────────────────────────────────────────────────────
// Tools that don't touch the browser page: talking to the user, writing files,
// and the done() terminator.

export const harnessTools: ToolDefinition[] = [
  {
    schema: {
      name: 'ask_user',
      description: 'Ask the user a clarifying question and wait for their answer. Use this ONLY when you are genuinely blocked by ambiguity (e.g. two search results match equally well and the task does not say which to pick). Do not ask about things you can resolve by observing the page.',
      input_schema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'One specific question for the user.' },
        },
        required: ['question'],
      },
    },
    async execute({ services }, args) {
      const question = String(args['question'] ?? '');
      const answer = await services.io.ask(`\n[AGENT ASKS] ${question}\n> `);
      return `The user answered: "${answer}"`;
    },
  },
  {
    schema: {
      name: 'write_report',
      description: 'Save research, summaries, or notes as a markdown file in the local Report/ folder. Use this whenever the task asks you to note down, save, or record findings.',
      input_schema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Filename for the report, e.g. "hn_summary". The .md extension is added automatically if omitted.' },
          content:  { type: 'string', description: 'Full markdown content to write to the file.' },
        },
        required: ['filename', 'content'],
      },
    },
    async execute(_ctx, args) {
      // path.basename strips any directory traversal (e.g. "../../.env" → ".env")
      // replace() removes chars that aren't alphanumeric, underscore, hyphen, dot, or space
      const safe = path.basename(String(args['filename'])).replace(/[^a-zA-Z0-9_\-. ]/g, '_');
      const mdFile = safe.endsWith('.md') ? safe : `${safe}.md`;
      fs.mkdirSync('Report', { recursive: true });
      fs.writeFileSync(path.join('Report', mdFile), String(args['content']), 'utf-8');
      return `Report saved to Report/${mdFile}`;
    },
  },
  {
    schema: {
      name: 'done',
      description: 'Signal that the goal has been achieved or cannot be achieved. The reason you give is also the task\'s OUTPUT — if the task asked you to read or collect something, put the full result here, because later tasks in the campaign may depend on it.',
      input_schema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'What was accomplished (including any collected content), or why the goal cannot be completed.' },
        },
        required: ['reason'],
      },
    },
    // Never executed — the runner intercepts done() and runs task.verify()
    // instead. The definition exists so the schema reaches the LLM.
    async execute() { /* intercepted by runner */ },
  },
];
