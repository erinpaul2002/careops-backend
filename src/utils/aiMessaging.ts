import { Message } from "./types";
import { generateGroqText } from "./groq";

function clipText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function cleanAiOutput(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  const singleLine = raw.replace(/\r\n/g, "\n").trim();
  const cleaned = singleLine
    .replace(/^["'`]+/, "")
    .replace(/["'`]+$/, "")
    .trim();
  return cleaned || null;
}

export async function generateContactAcknowledgementDraft(input: {
  workspaceName: string;
  contactFirstName: string;
  submittedMessage?: string;
  channel: "email" | "sms";
  customFields: Record<string, unknown>;
}): Promise<string | null> {
  const compactFields = Object.entries(input.customFields)
    .map(([key, value]) => `${key}: ${String(value ?? "")}`)
    .join(" | ");

  const response = await generateGroqText({
    temperature: 0.45,
    maxTokens: input.channel === "sms" ? 120 : 220,
    timeoutMs: 3_500,
    messages: [
      {
        role: "system",
        content:
          "You write professional acknowledgement replies for inbound leads. " +
          "Be concise, warm, and avoid salesy language. Do not add markdown.",
      },
      {
        role: "user",
        content:
          `Workspace: ${input.workspaceName}\n` +
          `Channel: ${input.channel}\n` +
          `Contact first name: ${input.contactFirstName}\n` +
          `Submitted message: ${input.submittedMessage ?? "none"}\n` +
          `Submitted fields: ${clipText(compactFields, 900)}\n\n` +
          `Write a ${input.channel === "sms" ? "single short sentence" : "short paragraph"} ` +
          "acknowledging receipt and saying someone will follow up shortly.",
      },
    ],
  });

  return cleanAiOutput(response);
}

export async function generateConversationReplyDraft(input: {
  workspaceName: string;
  contactFullName: string;
  channel: "email" | "sms";
  messages: Message[];
  instruction?: string;
}): Promise<string | null> {
  const transcript = input.messages
    .slice(-12)
    .map((message) => {
      const role = message.direction === "outbound" ? "Staff" : "Contact";
      return `${role}: ${clipText(message.body, 600)}`;
    })
    .join("\n");

  const instruction = input.instruction?.trim();
  const response = await generateGroqText({
    temperature: 0.5,
    maxTokens: input.channel === "sms" ? 160 : 280,
    timeoutMs: 4_000,
    messages: [
      {
        role: "system",
        content:
          "You draft responses for a customer support inbox. " +
          "Keep replies clear, practical, and empathetic. " +
          "Do not invent unavailable policies. Do not add markdown.",
      },
      {
        role: "user",
        content:
          `Workspace: ${input.workspaceName}\n` +
          `Contact: ${input.contactFullName}\n` +
          `Channel: ${input.channel}\n` +
          `Recent conversation:\n${transcript || "No prior messages."}\n\n` +
          `Instruction from agent: ${instruction || "Create a helpful default reply."}\n\n` +
          `Draft only the outbound message body.`,
      },
    ],
  });

  return cleanAiOutput(response);
}
