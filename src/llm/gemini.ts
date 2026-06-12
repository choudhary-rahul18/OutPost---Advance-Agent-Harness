import { GoogleGenerativeAI, type Content, type Part } from '@google/generative-ai';
import { LLMAdapter, ActionResult, ToolResultMsg, ToolSchema, KEEP_RECENT, pruneText } from './adapter.js';

// ── Gemini Adapter ────────────────────────────────────────────────────────────
// Owns the Gemini-specific details:
//   • message history in Gemini's Content[] format (role: 'user' | 'model')
//   • tool calls returned as functionCall parts; results sent back as
//     functionResponse parts — matched by NAME, not ID
//   • function response + next observation combined into one user message
//     to preserve the required user/model alternation

// Translate Anthropic tool schemas → Gemini FunctionDeclaration format.
// Gemini accepts standard JSON Schema for parameters, so input_schema passes through.
function toGeminiTools(schemas: ToolSchema[]) {
  return [{
    functionDeclarations: schemas.map(s => ({
      name: s.name,
      description: s.description ?? '',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters: s.input_schema as any,
    })),
  }];
}

export class GeminiAdapter implements LLMAdapter {
  private history: Content[] = [];
  private pendingFunctionName: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private model: any;

  constructor(systemPrompt: string, tools: ToolSchema[]) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
    this.model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL ?? 'gemini-1.5-flash',
      systemInstruction: systemPrompt,
      tools: toGeminiTools(tools),
      // Force Gemini to always respond with a function call. Without this,
      // Gemini may return plain text instead of calling a tool.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolConfig: { functionCallingConfig: { mode: 'ANY' as any } },
    });
  }

  async getNextAction(observation: string, toolResult?: ToolResultMsg): Promise<ActionResult> {
    // If there is a pending function call, close it with a functionResponse
    // first, then append the new observation — all in one user message to keep
    // the required user/model turn alternation intact.
    const parts: Part[] = [];
    if (this.pendingFunctionName) {
      parts.push({
        functionResponse: {
          name: this.pendingFunctionName,
          response: {
            result: toolResult?.content ?? 'Action executed successfully.',
            isError: toolResult?.isError ?? false,
          },
        },
      });
    }
    parts.push({ text: observation });

    const userMessage: Content = { role: 'user', parts };
    this.history.push(userMessage);
    this.pruneHistory();

    const result = await this.model.generateContent({ contents: this.history });
    const modelContent: Content = result.response.candidates?.[0]?.content
      ?? { role: 'model', parts: [{ text: '' }] };

    this.history.push(modelContent);

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

  // Collapse old user observation texts; functionResponse parts stay intact.
  private pruneHistory(): void {
    const userIndexes = this.history
      .map((c, i) => (c.role === 'user' ? i : -1))
      .filter(i => i >= 0);
    const toPrune = userIndexes.slice(0, Math.max(0, userIndexes.length - KEEP_RECENT));
    for (const i of toPrune) {
      for (const part of this.history[i].parts) {
        if ('text' in part && part.text) part.text = pruneText(part.text);
      }
    }
  }
}
