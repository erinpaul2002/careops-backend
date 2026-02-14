type GroqRole = "system" | "user" | "assistant";

export interface GroqMessage {
  role: GroqRole;
  content: string;
}

const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";

function getGroqApiKey(): string | null {
  const key = process.env.GROQ_API_KEY?.trim();
  return key || null;
}

export function isGroqConfigured(): boolean {
  return Boolean(getGroqApiKey());
}

function getGroqModel(): string {
  const configured = process.env.GROQ_MODEL?.trim();
  return configured || "llama-3.3-70b-versatile";
}

export async function generateGroqText(input: {
  messages: GroqMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<string | null> {
  const apiKey = getGroqApiKey();
  if (!apiKey) {
    return null;
  }

  const timeoutMs = Math.max(500, input.timeoutMs ?? 4_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: getGroqModel(),
        temperature: input.temperature ?? 0.4,
        max_tokens: input.maxTokens ?? 220,
        messages: input.messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return null;
    }
    const normalized = content.trim();
    return normalized.length ? normalized : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
