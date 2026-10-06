/**
 * Provider-agnostic AI interfaces. JARVIS depends only on these, so another
 * provider (OpenAI, local model, …) can be added without touching JARVIS.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResult {
  text: string;
  model: string;
  latencyMs: number;
}

export interface AIProvider {
  readonly name: string;
  readonly configured: boolean;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>;
}

export interface SpeechToTextProvider {
  readonly configured: boolean;
  transcribe(audio: Buffer, mime: string, prompt?: string): Promise<string>;
}

export type AIErrorCode = "UNCONFIGURED" | "AUTH" | "RATE_LIMIT" | "UNAVAILABLE" | "TERMS" | "BAD_REQUEST" | "TIMEOUT";

export class AIError extends Error {
  constructor(
    message: string,
    readonly code: AIErrorCode,
    /** Provider-specific error code, e.g. Groq's "json_validate_failed". */
    readonly providerCode = "",
  ) {
    super(message);
  }
}
