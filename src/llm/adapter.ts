import Anthropic from '@anthropic-ai/sdk';
import { AnthropicAdapter } from './anthropic.js';
import { OllamaAdapter } from './ollama.js';
import { GeminiAdapter } from './gemini.js';

// ── Shared types ──────────────────────────────────────────────────────────────
// The Anthropic tool schema is the canonical format across the harness.
// Each adapter translates it to its provider's wire format internally.
export type ToolSchema = Anthropic.Tool;

// Result of the previous tool execution, fed back to the LLM.
// content: tool output (e.g. read_page text, the user's ask_user answer) or
//          an error message. isError tells the LLM the action did NOT happen.
export interface ToolResultMsg {
  content: string;
  isError: boolean;
}

export interface ActionResult {
  toolName: string;                    // empty string if the LLM returned no tool call
  toolInput: Record<string, unknown>;
  reasoning: string;                   // any text the LLM produced alongside the tool call
}

// ── Adapter interface ─────────────────────────────────────────────────────────
// The only contract callers know about. The observation is plain text composed
// by the caller — the runner sends a page snapshot, the Clarifier sends the
// conversation with the user. The adapter is agnostic to both.
export interface LLMAdapter {
  getNextAction(observation: string, toolResult?: ToolResultMsg): Promise<ActionResult>;
}

// ── History pruning ───────────────────────────────────────────────────────────
// Each API call sends the full conversation. Old DOM trees are huge and stale —
// the page has changed since. Keep the last KEEP_RECENT observations full and
// collapse older long texts to a stub. Shared by all three adapters.
export const KEEP_RECENT = 4;
const PRUNE_THRESHOLD = 600;

export function pruneText(text: string): string {
  if (text.length <= PRUNE_THRESHOLD) return text;
  return text.slice(0, 200) + '\n…[older observation trimmed to save context]';
}

// ── Factory ───────────────────────────────────────────────────────────────────
// Tools are now a parameter: the executor passes browser tools, the Clarifier
// passes its interview tools. Same adapters serve both agents.
export type Provider = 'anthropic' | 'ollama' | 'gemini';

export function createAdapter(provider: Provider, systemPrompt: string, tools: ToolSchema[]): LLMAdapter {
  if (provider === 'anthropic') return new AnthropicAdapter(systemPrompt, tools);
  if (provider === 'ollama')    return new OllamaAdapter(systemPrompt, tools);
  if (provider === 'gemini')    return new GeminiAdapter(systemPrompt, tools);
  throw new Error(`Unknown LLM provider: "${provider}"`);
}
