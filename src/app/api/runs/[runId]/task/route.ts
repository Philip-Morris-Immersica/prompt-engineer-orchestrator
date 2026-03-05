import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await params;
    const taskPath = path.join(DATA_DIR, 'runs', runId, 'task.json');
    const task = JSON.parse(await fs.readFile(taskPath, 'utf-8'));
    return NextResponse.json(task);
  } catch {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }
}
