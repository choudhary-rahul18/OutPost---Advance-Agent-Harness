import { Page } from 'playwright';
import { ToolSchema } from '../llm/adapter.js';
import { Services } from '../core/services.js';

// ── Tool plugin system ────────────────────────────────────────────────────────
// A ToolDefinition bundles the LLM-facing schema with the executor function —
// one object, one source of truth. A returned string becomes the tool_result
// the LLM sees next step (read_page text, the user's ask_user answer, ...).
// Returning void means the generic "Action executed successfully."

export interface ToolContext {
  page: Page;
  services: Services;
  compact: boolean;  // true when context overflow was detected — tools use tighter limits
}

export interface ToolDefinition {
  schema: ToolSchema;
  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string | void>;
}

// A Toolset is an assembled collection handed to the runner + adapter.
// Like a Python dict {name: fn} plus the schema list for the API call.
export class Toolset {
  private byName = new Map<string, ToolDefinition>();

  constructor(definitions: ToolDefinition[]) {
    for (const def of definitions) this.byName.set(def.schema.name, def);
  }

  get schemas(): ToolSchema[] {
    return [...this.byName.values()].map(d => d.schema);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  async run(name: string, ctx: ToolContext, args: Record<string, unknown>): Promise<string | void> {
    const def = this.byName.get(name);
    if (!def) throw new Error(`Unknown tool "${name}"`);
    return def.execute(ctx, args);
  }
}
