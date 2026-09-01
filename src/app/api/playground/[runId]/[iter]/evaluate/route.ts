import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { ConfigLoader } from '@/backend/config-loader';
import { PlaygroundEvaluator, PlaygroundStoppedError } from '@/backend/playground-evaluator';
import {
  PlaygroundStore,
  type PlaygroundEvaluation,
  sanitizeIds,
} from '@/backend/playground-store';

export const dynamic = 'force-dynamic';

const DATA_DIR = process.env.DATA_DIR || './data';

const running = new Map<string, true>();

function runningKey(runId: string, iter: number, versionId: string): string {
  return `${runId}:${iter}:${versionId}`;
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

export async function POST(
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
    const versionId = body?.versionId;
    const prompt = body?.prompt;
    const scenarioIds = Array.isArray(body?.scenarioIds)
      ? body.scenarioIds.filter((id: unknown) => typeof id === 'string')
      : [];

    if (typeof versionId !== 'string' || !versionId) {
      return NextResponse.json({ error: 'versionId is required' }, { status: 400 });
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return NextResponse.json({ error: 'prompt must be a non-empty string' }, { status: 400 });
    }

    const key = runningKey(ids.runId, ids.iter, versionId);
    if (running.has(key)) {
      return NextResponse.json({ error: 'Evaluation already running' }, { status: 409 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 });
    }

    running.set(key, true);

    try {
      const store = new PlaygroundStore(DATA_DIR);
      const startedAt = Date.now();
      await store.setEvaluation(ids.runId, ids.iter, versionId, {
        status: 'testing',
        scenarioIds,
        startedAt,
      });

      const job = runEvaluation({
        runId: ids.runId,
        iter: ids.iter,
        versionId,
        prompt,
        scenarioIds,
        startedAt,
        apiKey,
        store,
        key,
      });
      job.catch((error) => {
        console.error('Playground evaluation failed:', error);
      });
    } catch (error) {
      running.delete(key);
      throw error;
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error starting playground evaluation:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string; iter: string }> },
) {
  try {
    const { runId, iter } = await params;
    const ids = sanitizeIds(runId, iter);
    if (!ids) {
      return NextResponse.json({ error: 'Invalid runId or iteration' }, { status: 400 });
    }

    const versionId = request.nextUrl.searchParams.get('versionId');
    if (!versionId) {
      return NextResponse.json({ error: 'versionId is required' }, { status: 400 });
    }

    const store = new PlaygroundStore(DATA_DIR);
    await store.requestStop(ids.runId, ids.iter, versionId);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error stopping playground evaluation:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function runEvaluation(args: {
  runId: string;
  iter: number;
  versionId: string;
  prompt: string;
  scenarioIds: string[];
  startedAt: number;
  apiKey: string;
  store: PlaygroundStore;
  key: string;
}): Promise<void> {
  const { runId, iter, versionId, prompt, scenarioIds, startedAt, apiKey, store, key } = args;

  const write = (evaluation: PlaygroundEvaluation) =>
    store.setEvaluation(runId, iter, versionId, evaluation);

  try {
    await store.clearStop(runId, iter, versionId);

    const metadata = await readJson(path.join(DATA_DIR, 'runs', runId, 'metadata.json'));
    if (!isRecord(metadata) || typeof metadata.orchestratorId !== 'string') {
      throw new Error('Run metadata not found');
    }

    const config = await new ConfigLoader(DATA_DIR).loadOrchestrator(metadata.orchestratorId);
    const evaluator = new PlaygroundEvaluator(apiKey, config, DATA_DIR);

    const result = await evaluator.evaluate(runId, prompt, scenarioIds, {
      stopSignalPath: store.stopSignalPath(runId, iter, versionId),
      onPhase: async (phase) => {
        if (phase === 'analyzing') {
          await write({
            status: 'analyzing',
            scenarioIds,
            startedAt,
          });
        }
      },
    });

    const scenarios = result.analysis.scenarios ?? [];
    const passedCount = scenarios.filter((s) =>
      s.verdict ? s.verdict === 'pass' : s.passed,
    ).length;
    const totalCount = scenarios.length;
    const passRate = totalCount > 0 ? passedCount / totalCount : 0;

    await write({
      status: 'done',
      scenarioIds,
      passedCount,
      totalCount,
      passRate,
      qualityScore: result.analysis.overallScore,
      analysis: result.analysis,
      transcripts: result.transcripts,
      cost: result.cost,
      startedAt,
      finishedAt: Date.now(),
    });
  } catch (error) {
    if (error instanceof PlaygroundStoppedError) {
      await write({
        status: 'stopped',
        scenarioIds,
        startedAt,
        finishedAt: Date.now(),
      });
      return;
    }
    await write({
      status: 'error',
      scenarioIds,
      error: (error as Error).message || 'Evaluation failed',
      startedAt,
      finishedAt: Date.now(),
    });
  } finally {
    running.delete(key);
    await store.clearStop(runId, iter, versionId);
  }
}
