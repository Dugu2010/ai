export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ToolChoice {
  type: "function";
  function: { name: string };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: string | null;
}

export class NIMClient {
  private apiKey: string;
  private baseURL: string;
  private model: string;

  constructor(apiKey: string, baseURL: string, model: string) {
    this.apiKey = apiKey;
    this.baseURL = baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL;
    this.model = model;
  }

  async chat({
    messages,
    tools,
    toolChoice,
    temperature,
    maxTokens,
    timeoutMs,
    maxRetries = 3,
  }: {
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    toolChoice?: ToolChoice | "auto" | "none";
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    maxRetries?: number;
  }): Promise<ChatResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await this.sendRequest(messages, tools, toolChoice, temperature, maxTokens, timeoutMs);
        return this.parseResponse(response);
      } catch (e: any) {
        lastError = e;
        const status = e.status || e.response?.status;
        if (status && (status === 401 || status === 403 || status === 404)) {
          throw e;
        }
        const isRateLimit = status === 429 || (e.response?.data?.error?.code === "rate_limit_exceeded");
        const isOverloaded = status === 503 || (e.response?.data?.error?.code === "overloaded");
        
        if (isRateLimit || isOverloaded) {
          const delay = (attempt + 1) * 2000;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw e;
      }
    }

    throw lastError ?? new Error("Failed after retries");
  }

  private async sendRequest(
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    toolChoice: ToolChoice | "auto" | "none" | undefined,
    temperature: number | undefined,
    maxTokens: number | undefined,
    timeoutMs: number | undefined
  ): Promise<any> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }
    if (toolChoice) {
      body.tool_choice = toolChoice;
    }
    if (temperature !== undefined) {
      body.temperature = temperature;
    }
    if (maxTokens !== undefined) {
      body.max_tokens = maxTokens;
    }

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const error = new Error(`NIM API error: ${response.status} ${response.statusText}`);
      (error as any).status = response.status;
      (error as any).response = { data: errorText };
      throw error;
    }

    return await response.json();
  }

  private parseResponse(data: any): ChatResponse {
    const choices = data.choices;
    const choice = choices?.[0];
    const message = choice?.message;

    let content: string | null = null;
    if (message?.content) {
      content = message.content;
    }

    let toolCalls: ToolCall[] = [];
    if (message?.tool_calls && Array.isArray(message.tool_calls)) {
      toolCalls = message.tool_calls.map((tc: any) => ({
        id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments,
      }));
    }

    let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    if (data.usage) {
      usage = {
        promptTokens: data.usage.prompt_tokens ?? 0,
        completionTokens: data.usage.completion_tokens ?? 0,
        totalTokens: data.usage.total_tokens ?? 0,
      };
    }

    return {
      content,
      toolCalls,
      usage,
      finishReason: choice?.finish_reason ?? null,
    };
  }
}
