// Minimal OpenAI-compatible client for Nemotron 3 Nano Omni on build.nvidia.com.
// Reasoning ("thinking") is OFF for fast calls (Judge, Profile, Alert) and ON for the debrief.
import { config } from './config.js';

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type ToolSpec = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ChatResult = { content: string; toolCalls: ToolCall[]; raw: unknown; ms: number };

export function stripThinking(text: string): string {
  let t = text ?? '';
  // Reasoning may arrive inline in content when the server doesn't split it out.
  t = t.replace(/<think>[\s\S]*?<\/think>/g, '');
  if (t.includes('</think>')) t = t.slice(t.lastIndexOf('</think>') + 8);
  return t.trim();
}

export async function chat(
  messages: ChatMessage[],
  opts: { tools?: ToolSpec[]; thinking?: boolean; maxTokens?: number; temperature?: number; timeoutMs?: number } = {}
): Promise<ChatResult> {
  if (!config.llmApiKey) throw new Error('LLM_API_KEY missing in .env');
  const thinking = opts.thinking ?? false;
  const body: Record<string, unknown> = {
    model: config.llmModel,
    messages,
    temperature: opts.temperature ?? (thinking ? 0.6 : 0.2),
    top_p: thinking ? 0.95 : 1,
    max_tokens: opts.maxTokens ?? (thinking ? 6000 : 700),
    chat_template_kwargs: { enable_thinking: thinking },
    stream: false,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? (thinking ? 90_000 : 25_000));
  try {
    const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.llmApiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 400)}`);
    const json = JSON.parse(text);
    const msg = json?.choices?.[0]?.message ?? {};
    return {
      content: stripThinking(msg.content ?? ''),
      toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
      raw: json,
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Pull the first JSON object out of a model reply (handles ```json fences and prose around it).
export function extractJson<T = any>(text: string): T | undefined {
  const cleaned = stripThinking(text).replace(/```(?:json)?/g, '');
  const start = cleaned.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(cleaned.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export const hasImages = (messages: ChatMessage[]) =>
  messages.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));

// Same conversation with every image replaced by a note (fallback if the endpoint rejects images).
export function withoutImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    m.role === 'user' && Array.isArray(m.content)
      ? { role: 'user', content: m.content.map((p) => (p.type === 'text' ? p.text : '[screenshot omitted]')).join('\n') }
      : m
  );
}
