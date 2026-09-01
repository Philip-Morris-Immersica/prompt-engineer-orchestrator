import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { ConfigLoader } from '@/backend/config-loader';
import { sanitizeIds } from '@/backend/playground-store';

export const dynamic = 'force-dynamic';

const DATA_DIR = process.env.DATA_DIR || './data';
const MAX_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_PROMPT_CHARS = 50_000;
const MAX_TOTAL_CHARS = 100_000;

// Duplicated from test-runner.ts — do not import or extract.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-5.4':       { input: 2.50,  output: 15.00 },
  'gpt-5.3':       { input: 1.75,  output: 14.00 },
  'gpt-4o':        { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':   { input: 0.15,  output: 0.60 },
  'o3':            { input: 10.00, output: 40.00 },
  'o3-mini':       { input: 1.10,  output: 4.40 },
};

function calcCost(usage: { prompt_tokens?: number; completion_tokens?: number } | undefined, model: string): number {
  if (!usage) return 0;
  const p = MODEL_PRICING[model] ?? MODEL_PRICING['gpt-4o'];
  return (usage.prompt_tokens ?? 0) / 1_000_000 * p.input
       + (usage.completion_tokens ?? 0) / 1_000_000 * p.output;
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { runId, prompt, messages, model: bodyModel, temperature: bodyTemperature, seed: bodySeed } = body ?? {};

    if (typeof runId !== 'string' || !sanitizeIds(runId, '1')) {
      return NextResponse.json({ error: 'Invalid runId' }, { status: 400 });
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return NextResponse.json({ error: 'prompt must be a non-empty string' }, { status: 400 });
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return NextResponse.json({ error: 'prompt is too long' }, { status: 400 });
    }
    if (!Array.isArray(messages)) {
      return NextResponse.json({ error: 'messages must be an array' }, { status: 400 });
    }
    if (messages.length > MAX_MESSAGES) {
      return NextResponse.json({ error: `messages must have at most ${MAX_MESSAGES} entries` }, { status: 400 });
    }

    let totalChars = prompt.length;
    const cleaned: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const msg of messages) {
      if (!msg || (msg.role !== 'user' && msg.role !== 'assistant') || typeof msg.content !== 'string') {
        return NextResponse.json({ error: 'each message must have role user|assistant and string content' }, { status: 400 });
      }
      if (msg.content.length > MAX_MESSAGE_CHARS) {
        return NextResponse.json({ error: `each message must be under ${MAX_MESSAGE_CHARS} characters` }, { status: 400 });
      }
      totalChars += msg.content.length;
      cleaned.push({ role: msg.role, content: msg.content });
    }
    if (totalChars > MAX_TOTAL_CHARS) {
      return NextResponse.json({ error: 'total input is too large' }, { status: 400 });
    }

    const metadata = await readJson(path.join(DATA_DIR, 'runs', runId, 'metadata.json'));
    if (!isRecord(metadata) || typeof metadata.orchestratorId !== 'string') {
      return NextResponse.json({ error: 'Run metadata not found' }, { status: 404 });
    }

    const config = await new ConfigLoader(DATA_DIR).loadOrchestrator(metadata.orchestratorId);
    const model = typeof bodyModel === 'string' && bodyModel.trim()
      ? bodyModel.trim()
      : config.models.test;
    const temperature = typeof bodyTemperature === 'number' && Number.isFinite(bodyTemperature)
      ? Math.min(2, Math.max(0, bodyTemperature))
      : config.temperatures.test;
    const seed = typeof bodySeed === 'number' && Number.isFinite(bodySeed)
      ? bodySeed
      : 1337;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 });
    }

    const openai = new OpenAI({ apiKey, timeout: 90_000, maxRetries: 2 });

    let response;
    try {
      response = await openai.chat.completions.create({
        model,
        temperature,
        seed,
        max_tokens: 1000,
        messages: [
          { role: 'system', content: prompt },
          ...cleaned,
        ],
      });
    } catch (err) {
      return NextResponse.json(
        { error: (err as Error).message || 'OpenAI request failed' },
        { status: 502 },
      );
    }

    const reply = response.choices[0]?.message?.content ?? '';
    const cost = calcCost(response.usage, model);

    return NextResponse.json({ reply, cost, model });
  } catch (error) {
    console.error('Playground chat error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
