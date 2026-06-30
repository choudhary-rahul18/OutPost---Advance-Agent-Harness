import Anthropic from '@anthropic-ai/sdk';
import { LLMAdapter, ActionResult, ToolResultMsg, ToolSchema, KEEP_RECENT, pruneText } from './adapter.js';

// ── Anthropic Adapter ─────────────────────────────────────────────────────────
// Owns the Anthropic-specific details:
//   • message history in Anthropic format
//   • tool_use / tool_result ID pairing (every tool_use must be closed)
//   • response parsing (content blocks)
export class AnthropicAdapter implements LLMAdapter {
  private client = new Anthropic();
  private messages: Anthropic.MessageParam[] = [];
  // Anthropic can return multiple tool_use blocks in one response (parallel
  // tool use). Every one must be closed with a tool_result before the next call.
  private pendingToolCallIds: string[] = [];

  constructor(private systemPrompt: string, private tools: ToolSchema[]) {}

  async getNextAction(observation: string, toolResult?: ToolResultMsg): Promise<ActionResult> {
    // Close every pending tool_use with a tool_result, then append the observation.
    if (this.pendingToolCallIds.length > 0) {
      const content = toolResult?.content ?? 'Action executed successfully.';
      const toolResults = this.pendingToolCallIds.map(id => ({
        type: 'tool_result' as const,
        tool_use_id: id,
        content,
        is_error: toolResult?.isError ?? false,
      }));
      this.messages.push({
        role: 'user',
        content: [...toolResults, { type: 'text', text: observation }],
      });
    } else {
      this.messages.push({ role: 'user', content: observation });
    }

    this.pruneHistory();

    let response: Awaited<ReturnType<typeof this.client.messages.create>>;
    try {
      response = await this.client.messages.create({
        model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: this.systemPrompt,
        messages: this.messages,
        tools: this.tools,
      });
    } catch (err) {
      // Roll back the user message we just pushed so history stays consistent
      // for the next call. pendingToolCallIds is unchanged — the previous
      // assistant tool_use still needs to be closed on the next attempt.
      this.messages.pop();
      throw err;
    }

    this.messages.push({ role: 'assistant', content: response.content });

    let reasoning = '';
    const toolBlocks: Anthropic.ToolUseBlock[] = [];

    for (const block of response.content) {
      if (block.type === 'text')     reasoning = block.text;
      if (block.type === 'tool_use') toolBlocks.push(block);
    }

    // Track ALL returned tool_use IDs — every one must be closed next call.
    // If the model returned multiple (parallel tool use), we execute only the
    // first; the model sees the resulting page state next step and adjusts.
    this.pendingToolCallIds = toolBlocks.map(b => b.id);

    const first = toolBlocks[0] ?? null;
    return {
      toolName:  first?.name  ?? '',
      toolInput: (first?.input ?? {}) as Record<string, unknown>,
      reasoning,
    };
  }

  // Collapse old observation texts. tool_use/tool_result pairing is untouched —
  // only the large text blocks inside older user messages are shrunk.
  private pruneHistory(): void {
    const userIndexes = this.messages
      .map((m, i) => (m.role === 'user' ? i : -1))
      .filter(i => i >= 0);
    const toPrune = userIndexes.slice(0, Math.max(0, userIndexes.length - KEEP_RECENT));

    for (const i of toPrune) {
      const msg = this.messages[i];
      if (typeof msg.content === 'string') {
        msg.content = pruneText(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') block.text = pruneText(block.text);
        }
      }
    }
  }
}
