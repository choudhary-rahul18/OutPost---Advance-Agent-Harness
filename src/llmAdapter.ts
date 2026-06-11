import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI, type Content, type Part } from '@google/generative-ai';
import { toolSchemas } from './tools.js';

// ── Shared types ──────────────────────────────────────────────────────────────
// PageObservation: what the harness sees at each step — fed into every adapter.
// ActionResult: what the adapter returns — the same shape regardless of provider.
// The supervisor loop only ever works with these two types.

export interface PageObservation {
  url: string;
  title: string;
  tree: string;
}

export interface ActionResult {
  toolName: string;                    // empty string if the LLM returned no tool call
  toolInput: Record<string, unknown>;
  reasoning: string;                   // any text the LLM produced alongside the tool call
}

// ── Adapter interface ─────────────────────────────────────────────────────────
// This is the only contract the supervisor loop knows about.
// Each adapter implements it using its own protocol internally.
export interface LLMAdapter {
  // toolError: if the previous tool threw, pass the error message here so the
  // adapter closes the tool_use/tool_result pair correctly and the LLM knows
  // the action failed.
  getNextAction(obs: PageObservation, toolError?: string): Promise<ActionResult>;
}

// ── Anthropic Adapter ─────────────────────────────────────────────────────────
// Owns the Anthropic-specific details:
//   • message history in Anthropic format
//   • tool_use / tool_result ID pairing
//   • response parsing (content blocks)
class AnthropicAdapter implements LLMAdapter {
  private client = new Anthropic();
  private messages: Anthropic.MessageParam[] = [];
  // Anthropic can return multiple tool_use blocks in one response (parallel tool use).
  // We must close every one of them with a tool_result before the next API call.
  private pendingToolCallIds: string[] = [];

  constructor(private systemPrompt: string) {}

  async getNextAction(obs: PageObservation, toolError?: string): Promise<ActionResult> {
    const observationText =
      `Current URL: ${obs.url}\n` +
      `Page title: ${obs.title}\n\n` +
      `Interactive elements on the page:\n${obs.tree}`;

    // Close every pending tool_use with a tool_result, then append the observation.
    if (this.pendingToolCallIds.length > 0) {
      const resultContent = toolError ?? 'Action executed successfully.';
      const toolResults = this.pendingToolCallIds.map(id => ({
        type: 'tool_result' as const,
        tool_use_id: id,
        content: resultContent,
        is_error: !!toolError,
      }));
      this.messages.push({
        role: 'user',
        content: [...toolResults, { type: 'text', text: observationText }],
      });
    } else {
      this.messages.push({ role: 'user', content: observationText });
    }

    const response = await this.client.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: this.systemPrompt,
      messages: this.messages,
      tools: toolSchemas,
    });

    this.messages.push({ role: 'assistant', content: response.content });

    let reasoning = '';
    const toolBlocks: Anthropic.ToolUseBlock[] = [];

    for (const block of response.content) {
      if (block.type === 'text')     reasoning = block.text;
      if (block.type === 'tool_use') toolBlocks.push(block);
    }

    // Track ALL returned tool_use IDs — every one must be closed next call.
    // If the model returned multiple (parallel tool use), we execute only the
    // first and close the rest with the same result. The model will see the
    // current page state next step and can adjust.
    this.pendingToolCallIds = toolBlocks.map(b => b.id);

    const first = toolBlocks[0] ?? null;
    return {
      toolName:  first?.name  ?? '',
      toolInput: (first?.input ?? {}) as Record<string, unknown>,
      reasoning,
    };
  }
}

// ── Ollama Adapter ────────────────────────────────────────────────────────────
// Owns the Ollama-specific details:
//   • message history in Ollama/OpenAI format (system message in array, tool role)
//   • tool schema translation (Anthropic → OpenAI format)
//   • response parsing (message.tool_calls array, not content blocks)
//   • no ID pairing needed — Ollama tool results don't require matching IDs

// Ollama message shape — different from Anthropic's MessageParam.
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
function toOllamaTools(schemas: Anthropic.Tool[]) {
  return schemas.map(s => ({
    type: 'function' as const,
    function: {
      name: s.name,
      description: s.description ?? '',
      parameters: s.input_schema,
    },
  }));
}

class OllamaAdapter implements LLMAdapter {
  private messages: OllamaMessage[] = [];
  private tools = toOllamaTools(toolSchemas);
  private hadPreviousToolCall = false;

  constructor(systemPrompt: string) {
    // Ollama takes the system prompt as a message in the array, not a separate field.
    this.messages.push({ role: 'system', content: systemPrompt });
  }

  async getNextAction(obs: PageObservation, toolError?: string): Promise<ActionResult> {
    const observationText =
      `Current URL: ${obs.url}\n` +
      `Page title: ${obs.title}\n\n` +
      `Interactive elements on the page:\n${obs.tree}`;

    // Ollama tool result: a separate 'tool' role message (no ID required).
    if (this.hadPreviousToolCall) {
      this.messages.push({ role: 'tool', content: toolError ?? 'Action executed successfully.' });
    }
    this.messages.push({ role: 'user', content: observationText });

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

    // Ollama response shape: { message: { role, content, tool_calls? } }
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
}

// ── Gemini Adapter ────────────────────────────────────────────────────────────
// Owns the Gemini-specific details:
//   • message history in Gemini's Content[] format (role: 'user' | 'model')
//   • tool calls returned as functionCall parts; results sent back as functionResponse parts
//   • no IDs — Gemini matches function responses by name, not ID
//   • function response + next observation are combined into one user message
//     to preserve the required user/model alternation

// Translate Anthropic tool schemas → Gemini FunctionDeclaration format.
// Gemini accepts standard JSON Schema for parameters, so input_schema passes through directly.
function toGeminiTools(schemas: Anthropic.Tool[]) {
  return [{
    functionDeclarations: schemas.map(s => ({
      name: s.name,
      description: s.description ?? '',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters: s.input_schema as any,
    })),
  }];
}

class GeminiAdapter implements LLMAdapter {
  private history: Content[] = [];
  private pendingFunctionName: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private model: any;

  constructor(systemPrompt: string) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
    this.model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL ?? 'gemini-1.5-flash',
      systemInstruction: systemPrompt,
      tools: toGeminiTools(toolSchemas),
      // Force Gemini to always respond with a function call.
      // Without this, Gemini may return plain text instead of calling a tool.
      toolConfig: { functionCallingConfig: { mode: 'ANY' as any } },
    });
  }

  async getNextAction(obs: PageObservation, toolError?: string): Promise<ActionResult> {
    const observationText =
      `Current URL: ${obs.url}\n` +
      `Page title: ${obs.title}\n\n` +
      `Interactive elements on the page:\n${obs.tree}`;

    // Build user message parts.
    // If there is a pending function call, close it with a functionResponse first,
    // then append the new observation — all in one user message to keep the
    // required user/model turn alternation intact.
    const parts: Part[] = [];
    if (this.pendingFunctionName) {
      parts.push({
        functionResponse: {
          name: this.pendingFunctionName,
          response: { result: toolError ?? 'Action executed successfully.' },
        },
      });
    }
    parts.push({ text: observationText });

    const userMessage: Content = { role: 'user', parts };
    const contents = [...this.history, userMessage];

    const result = await this.model.generateContent({ contents });
    const modelContent: Content = result.response.candidates?.[0]?.content
      ?? { role: 'model', parts: [{ text: '' }] };

    this.history.push(userMessage, modelContent);

    let reasoning = '';
    let fnCall: { name: string; args: Record<string, unknown> } | null = null;

    for (const part of modelContent.parts) {
      if ('text' in part && part.text)                reasoning = part.text;
      if ('functionCall' in part && part.functionCall) {
        fnCall = {
          name: part.functionCall.name,
          args: (part.functionCall.args ?? {}) as Record<string, unknown>,
        };
      }
    }

    this.pendingFunctionName = fnCall?.name ?? null;

    return {
      toolName:  fnCall?.name  ?? '',
      toolInput: fnCall?.args  ?? {},
      reasoning,
    };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────
// The only thing the supervisor loop imports. Pass a provider string, get back
// an adapter. Adding a new provider = adding one new class + one line here.
export type Provider = 'anthropic' | 'ollama' | 'gemini';

export function createAdapter(provider: Provider, systemPrompt: string): LLMAdapter {
  if (provider === 'anthropic') return new AnthropicAdapter(systemPrompt);
  if (provider === 'ollama')    return new OllamaAdapter(systemPrompt);
  if (provider === 'gemini')    return new GeminiAdapter(systemPrompt);
  throw new Error(`Unknown LLM provider: "${provider}"`);
}
