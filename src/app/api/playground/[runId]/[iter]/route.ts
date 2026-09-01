import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { ConfigLoader } from '@/backend/config-loader';
import {
  PlaygroundStore,
  sanitizeIds,
  validateSession,
} from '@/backend/playground-store';

export const dynamic = 'force-dynamic';

const DATA_DIR = process.env.DATA_DIR || './data';
const DEFAULT_SEED = 1337;

async function readText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
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

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string; iter: string }> },
) {
  try {
    const { runId, iter } = await params;
    const ids = sanitizeIds(runId, iter);
    if (!ids) {
      return NextResponse.json({ error: 'Invalid runId or iteration' }, { status: 400 });
    }

    const iterDir = path.join(
      DATA_DIR,
      'runs',
      ids.runId,
      'iterations',
      ids.iter.toString().padStart(2, '0'),
    );

    try {
      await fs.access(iterDir);
    } catch {
      return NextResponse.json({ error: 'Iteration not found' }, { status: 404 });
    }

    const [basePromptRaw, testPlan, metadata] = await Promise.all([
      readText(path.join(iterDir, 'prompt.txt')),
      readJson(path.join(DATA_DIR, 'runs', ids.runId, 'test_plan.json')),
      readJson(path.join(DATA_DIR, 'runs', ids.runId, 'metadata.json')),
    ]);

    const basePrompt = basePromptRaw ?? '';
    const basePromptHash = createHash('sha1').update(basePrompt).digest('hex');

    const planRecord = isRecord(testPlan) ? testPlan : null;
    const rawScenarios = Array.isArray(planRecord?.scenarios) ? planRecord.scenarios : [];
    const scenarios = rawScenarios
      .filter((s): s is Record<string, unknown> => isRecord(s) && typeof s.id === 'string')
      .map((s) => ({
        id: s.id as string,
        name: typeof s.name === 'string' ? s.name : (s.id as string),
      }));

    let model = 'gpt-4o';
    let temperature = 0.7;
    const metaRecord = isRecord(metadata) ? metadata : null;
    if (typeof metaRecord?.orchestratorId === 'string') {
      try {
        const config = await new ConfigLoader(DATA_DIR).loadOrchestrator(metaRecord.orchestratorId);
        model = config.models.test;
        temperature = config.temperatures.test;
      } catch {
        // keep fallbacks
      }
    }

    const store = new PlaygroundStore(DATA_DIR);
    const [session, evaluations] = await Promise.all([
      store.loadSession(ids.runId, ids.iter),
      store.loadEvaluations(ids.runId, ids.iter),
    ]);

    return NextResponse.json({
      session,
      evaluations,
      defaults: {
        basePrompt,
        basePromptHash,
        model,
        temperature,
        seed: DEFAULT_SEED,
        scenarios,
        championIteration: typeof metaRecord?.championIteration === 'number'
          ? metaRecord.championIteration
          : null,
        runStatus: typeof metaRecord?.status === 'string' ? metaRecord.status : 'unknown',
      },
    });
  } catch (error) {
    console.error('Error loading playground session:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string; iter: string }> },
) {
  try {
    const { runId, iter } = await params;
    const ids = sanitizeIds(runId, iter);
    if (!ids) {
      return NextResponse.json({ error: 'Invalid runId or iteration' }, { status: 400 });
    }

    const body = await request.json().catch(() => null);
    if (!body || !('session' in body)) {
      return NextResponse.json({ error: 'Missing session' }, { status: 400 });
    }

    const session = validateSession(body.session);
    if (!session) {
      return NextResponse.json({ error: 'Invalid session' }, { status: 400 });
    }

    session.runId = ids.runId;
    session.baseIteration = ids.iter;

    const store = new PlaygroundStore(DATA_DIR);
    await store.saveSession(ids.runId, ids.iter, session);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error saving playground session:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string; iter: string }> },
) {
  try {
    const { runId, iter } = await params;
    const ids = sanitizeIds(runId, iter);
    if (!ids) {
      return NextResponse.json({ error: 'Invalid runId or iteration' }, { status: 400 });
    }

    const store = new PlaygroundStore(DATA_DIR);
    await store.deleteSession(ids.runId, ids.iter);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error deleting playground session:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
