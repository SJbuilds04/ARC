import { AIError, type AIProvider, type ChatMessage, type ChatOptions, type ChatResult, type SpeechToTextProvider } from "./AIProvider";

const BASE = "https://api.groq.com/openai/v1";
const MODEL_COOLDOWN_MS = 60_000;

/** Per-model request tweaks: keep reasoning minimal — JARVIS is optimised for latency. */
function reasoningParams(model: string): Record<string, unknown> {
  if (model.startsWith("qwen/")) return { reasoning_effort: "none" };
  if (model.startsWith("openai/gpt-oss")) return { reasoning_effort: "low", include_reasoning: false };
  return {};
}

export async function groqError(res: Response): Promise<AIError> {
  let message = `Groq HTTP ${res.status}`;
  let code = "";
  try {
    const body = await res.json();
    message = body?.error?.message ?? message;
    code = body?.error?.code ?? "";
  } catch {
    // non-JSON body
  }
  if (res.status === 401 || res.status === 403) return new AIError(message, code === "model_terms_required" ? "TERMS" : "AUTH", code);
  if (code === "model_terms_required") return new AIError(message, "TERMS", code);
  if (res.status === 429) return new AIError(message, "RATE_LIMIT", code);
  if (res.status >= 500) return new AIError(message, "UNAVAILABLE", code);
  return new AIError(message, "BAD_REQUEST", code);
}

export async function groqFetch(apiKey: string, path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as Error).name;
    if (name === "TimeoutError" || name === "AbortError") throw new AIError("Groq request timed out", "TIMEOUT");
    throw new AIError(`Cannot reach Groq: ${(err as Error).message}`, "UNAVAILABLE");
  }
}

export class GroqProvider implements AIProvider, SpeechToTextProvider {
  readonly name = "groq";
  private readonly cooldown = new Map<string, number>();

  constructor(
    private readonly apiKey: string,
    private readonly models: string[],
    private readonly sttModel: string,
  ) {}

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    if (!this.apiKey) throw new AIError("GROQ_API_KEY is not set", "UNCONFIGURED");

    const now = Date.now();
    const candidates = this.models.filter((m) => (this.cooldown.get(m) ?? 0) < now);
    if (!candidates.length) candidates.push(this.models[0]);

    let lastError: AIError | null = null;
    for (const model of candidates) {
      try {
        return await this.complete(model, messages, options);
      } catch (err) {
        lastError = err instanceof AIError ? err : new AIError(String(err), "UNAVAILABLE");
        if (lastError.code === "AUTH" || lastError.code === "UNCONFIGURED") throw lastError;
        // JSON mode occasionally fails to produce valid JSON for long answers: retry the
        // same model in plain mode — the caller's parser tolerates loose output.
        if (options.json && lastError.providerCode === "json_validate_failed") {
          try {
            return await this.complete(model, messages, { ...options, json: false });
          } catch (retryErr) {
            lastError = retryErr instanceof AIError ? retryErr : lastError;
          }
        }
        // Only capacity / rate / timeout problems rest the model; request errors don't.
        if (["RATE_LIMIT", "UNAVAILABLE", "TIMEOUT"].includes(lastError.code)) this.cooldown.set(model, Date.now() + MODEL_COOLDOWN_MS);
        console.warn(`[groq] ${model} failed (${lastError.code}${lastError.providerCode ? `/${lastError.providerCode}` : ""}): ${lastError.message}`);
      }
    }
    throw lastError ?? new AIError("No Groq model available", "UNAVAILABLE");
  }

  private async complete(model: string, messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    const started = performance.now();
    const res = await groqFetch(
      this.apiKey,
      "/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.4,
          max_completion_tokens: options.maxTokens ?? 700,
          ...(options.json ? { response_format: { type: "json_object" } } : {}),
          ...reasoningParams(model),
        }),
      },
      20_000,
    );
    if (!res.ok) throw await groqError(res);
    const data = await res.json();
    const text: string = data?.choices?.[0]?.message?.content ?? "";
    if (!text) throw new AIError("Empty completion", "UNAVAILABLE");
    return { text, model, latencyMs: Math.round(performance.now() - started) };
  }

  async transcribe(audio: Buffer, mime: string, prompt?: string): Promise<string> {
    if (!this.apiKey) throw new AIError("GROQ_API_KEY is not set", "UNCONFIGURED");
    const ext = mime.includes("wav") ? "wav" : mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : "webm";
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `speech.${ext}`);
    form.append("model", this.sttModel);
    form.append("response_format", "json");
    form.append("language", "en");
    form.append("temperature", "0");
    if (prompt) form.append("prompt", prompt);

    const res = await groqFetch(this.apiKey, "/audio/transcriptions", { method: "POST", body: form }, 20_000);
    if (!res.ok) throw await groqError(res);
    const data = await res.json();
    return String(data?.text ?? "").trim();
  }
}
