import { LLMAdapter, ActionResult, ToolResultMsg, ToolSchema, KEEP_RECENT, pruneText } from './adapter.js';

// ── Ollama Adapter ────────────────────────────────────────────────────────────
// Owns the Ollama-specific details:
//   • message history in Ollama/OpenAI format (system message in array, tool role)
//   • tool schema translation (Anthropic → OpenAI format)
//   • response parsing (message.tool_calls array, not content blocks)
//   • no ID pairing needed — Ollama tool results don't require matching IDs

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

// Translate Anthropic tool schema format → Ollama/OpenAI tool format.
// Anthropic: { name, description, input_schema: { type, properties, required } }
// Ollama:    { type: 'function', function: { name, description, parameters: {...} } }
function toOllamaTools(schemas: ToolSchema[]) {
  return schemas.map(s => ({
    type: 'function' as const,
    function: {
      name: s.name,
      description: s.description ?? '',
      parameters: s.input_schema,
    },
  }));
}

export class OllamaAdapter implements LLMAdapter {
  private messages: OllamaMessage[] = [];
  private tools: ReturnType<typeof toOllamaTools>;
  private hadPreviousToolCall = false;

  constructor(systemPrompt: string, tools: ToolSchema[]) {
    // Ollama takes the system prompt as a message in the array, not a separate field.
    this.messages.push({ role: 'system', content: systemPrompt });
    this.tools = toOllamaTools(tools);
  }

  async getNextAction(observation: string, toolResult?: ToolResultMsg): Promise<ActionResult> {
    // Ollama tool result: a separate 'tool' role message (no ID required).
    if (this.hadPreviousToolCall) {
      this.messages.push({ role: 'tool', content: toolResult?.content ?? 'Action executed successfully.' });
    }
    this.messages.push({ role: 'user', content: observation });

    this.pruneHistory();

    const response = await fetch('https://ollama.com/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OLLAMA_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL ?? 'ministral-3:3b',
        messages: this.messages,
        tools: this.tools,
        stream: false,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama API error ${response.status}: ${body}`);
    }

    const data = await response.json() as {
      message: {
        role: string;
        content: string;
        tool_calls?: Array<{
          function: { name: string; arguments: Record<string, unknown> };
        }>;
      };
    };

    const msg = data.message;
    this.messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });

    const toolCall = msg.tool_calls?.[0];
    this.hadPreviousToolCall = !!toolCall;

    return {
      toolName:  toolCall?.function.name      ?? '',
      toolInput: toolCall?.function.arguments ?? {},
      reasoning: msg.content ?? '',
    };
  }

  // Collapse old user observations; system / assistant / tool messages stay.
  private pruneHistory(): void {
    const userIndexes = this.messages
      .map((m, i) => (m.role === 'user' ? i : -1))
      .filter(i => i >= 0);
    const toPrune = userIndexes.slice(0, Math.max(0, userIndexes.length - KEEP_RECENT));
    for (const i of toPrune) {
      this.messages[i].content = pruneText(this.messages[i].content);
    }
  }
}
