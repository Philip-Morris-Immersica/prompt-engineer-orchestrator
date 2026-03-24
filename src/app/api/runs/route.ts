import { NextResponse } from 'next/server';
import { RunStorage } from '@/backend/storage';
import { OrchestrationEngine } from '@/backend/orchestration-engine';
import { TaskSchema } from '@/backend/types';
import { isMarkdownTask, parseMarkdownTask } from '@/backend/task-parser';

export const dynamic = 'force-dynamic';

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
    const { orchestratorId, stressMode, manualMode, continuedFromRunId, scenariosCount } = body;
    let { task, taskMarkdown } = body;

    if (!orchestratorId) {
      return NextResponse.json(
        { error: 'Missing orchestratorId' },
        { status: 400 }
      );
    }

    // Support markdown task input: parse it into a task object
    if (taskMarkdown && typeof taskMarkdown === 'string' && taskMarkdown.trim()) {
      try {
        task = parseMarkdownTask(taskMarkdown);
      } catch (err) {
        return NextResponse.json(
          { error: `Markdown parse error: ${(err as Error).message}` },
          { status: 400 }
        );
      }
    } else if (typeof task === 'string' && isMarkdownTask(task)) {
      try {
        task = parseMarkdownTask(task);
      } catch (err) {
        return NextResponse.json(
          { error: `Markdown parse error: ${(err as Error).message}` },
          { status: 400 }
        );
      }
    }

    if (!task) {
      return NextResponse.json(
        { error: 'Missing task or taskMarkdown' },
        { status: 400 }
      );
    }

    // Apply uploadId, runTitle and scenariosCount from payload
    if (body.uploadId && !task.uploadId) task.uploadId = body.uploadId;
    if (body.runTitle) task.name = body.runTitle;
    if (scenariosCount && !task.scenariosCount) task.scenariosCount = scenariosCount;

    // Forward run-level flags into the task object so the engine can read them
    if (manualMode) (task as any).manualMode = true;
    if (continuedFromRunId) (task as any).continuedFromRunId = continuedFromRunId;

    // Normalize task — fill in missing fields with defaults before validation
    if (!task.id)       task.id       = `task_${Date.now()}`;
    if (!task.name)     task.name     = task.id;
    if (!task.category) task.category = 'assistant';
    if (!task.requirements) task.requirements = {};
    if (!task.requirements.role)        task.requirements.role = '';
    if (!Array.isArray(task.requirements.constraints)) task.requirements.constraints = [];

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
