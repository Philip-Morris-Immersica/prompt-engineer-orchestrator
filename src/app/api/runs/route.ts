import { NextResponse } from 'next/server';
import { RunStorage } from '@/backend/storage';
import { OrchestrationEngine } from '@/backend/orchestration-engine';
import { TaskSchema } from '@/backend/types';

export async function GET() {
  try {
    const dataDir = process.env.DATA_DIR || './data';
    const storage = new RunStorage(dataDir);
    const runs = await storage.listRuns();

    // Sort by start time (newest first)
    runs.sort((a, b) => b.startedAt - a.startedAt);

    return NextResponse.json(runs);
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to load runs' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { orchestratorId, task, stressMode } = body;

    if (!orchestratorId || !task) {
      return NextResponse.json(
        { error: 'Missing orchestratorId or task' },
        { status: 400 }
      );
    }

    // Validate task
    const validatedTask = TaskSchema.parse(task);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'OPENAI_API_KEY not configured' },
        { status: 500 }
      );
    }

    const dataDir = process.env.DATA_DIR || './data';

    // Create engine
    const engine = new OrchestrationEngine(
      apiKey,
      orchestratorId,
      stressMode || false,
      dataDir
    );

    await engine.init();

    // Start run in background
    const runPromise = engine.runRefinementCycle(validatedTask);

    // Don't await - let it run in background
    runPromise.catch((error) => {
      console.error('Run failed:', error);
    });

    // Get runId by creating temporary storage to read metadata
    const storage = new RunStorage(dataDir);
    const runs = await storage.listRuns();
    const latestRun = runs.sort((a, b) => b.startedAt - a.startedAt)[0];

    return NextResponse.json({
      runId: latestRun.runId,
      status: 'started',
    });
  } catch (error) {
    console.error('Error starting run:', error);
    return NextResponse.json(
      { error: 'Failed to start run: ' + (error as Error).message },
      { status: 500 }
    );
  }
}
