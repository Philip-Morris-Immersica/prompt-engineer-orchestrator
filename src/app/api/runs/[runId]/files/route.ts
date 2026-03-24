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

    const uploadId: string | undefined = task.uploadId;
    if (!uploadId) {
      return NextResponse.json({ files: [] });
    }

    const uploadDir = path.join(DATA_DIR, 'uploads', uploadId);
    try {
      const entries = await fs.readdir(uploadDir);
      const files = entries.filter(f => !f.startsWith('.'));
      return NextResponse.json({ files, uploadId });
    } catch {
      return NextResponse.json({ files: [], uploadId });
    }
  } catch {
    return NextResponse.json({ files: [] });
  }
}
