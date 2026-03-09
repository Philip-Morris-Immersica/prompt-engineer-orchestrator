import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import type { LogEntry } from '@/backend/run-logger';

const DATA_DIR = process.env.DATA_DIR ?? './data';
const DEFAULT_TAIL = 120;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  const logPath = path.join(DATA_DIR, 'runs', runId, 'run_log.jsonl');

  // Optional query params
  const searchParams = req.nextUrl.searchParams;
  const tail = parseInt(searchParams.get('tail') ?? String(DEFAULT_TAIL), 10);
  // "since" = ts of last entry the client already has — only return newer entries
  const since = parseInt(searchParams.get('since') ?? '0', 10);

  try {
    const raw = await fs.readFile(logPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);

    let entries: LogEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as LogEntry);
      } catch {
        // skip malformed lines
      }
    }

    // Filter by since (exclusive) then take last `tail` entries
    if (since > 0) {
      entries = entries.filter((e) => e.ts > since);
    } else {
      entries = entries.slice(-tail);
    }

    return NextResponse.json({ entries });
  } catch {
    // Log file doesn't exist yet — return empty
    return NextResponse.json({ entries: [] });
  }
}
