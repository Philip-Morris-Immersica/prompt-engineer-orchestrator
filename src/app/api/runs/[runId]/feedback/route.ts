import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await params;
    const runDir = path.join(DATA_DIR, 'runs', runId);

    try { await fs.access(runDir); }
    catch { return NextResponse.json({ error: 'Run not found' }, { status: 404 }); }

    const { feedback } = await request.json();
    if (typeof feedback !== 'string') {
      return NextResponse.json({ error: 'feedback must be a string' }, { status: 400 });
    }

    const feedbackPath = path.join(runDir, 'human_feedback.txt');
    await fs.writeFile(feedbackPath, feedback.trim());

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await params;
    const feedbackPath = path.join(DATA_DIR, 'runs', runId, 'human_feedback.txt');
    const feedback = await fs.readFile(feedbackPath, 'utf-8').catch(() => '');
    return NextResponse.json({ feedback });
  } catch {
    return NextResponse.json({ feedback: '' });
  }
}
