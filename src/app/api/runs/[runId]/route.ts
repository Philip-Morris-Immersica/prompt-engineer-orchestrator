import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';

async function readJson(filePath: string): Promise<any | null> {
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── POST /api/runs/[runId]  { action: 'stop' | 'pause' | 'resume' } ──
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await params;
    const runDir = path.join(DATA_DIR, 'runs', runId);

    try { await fs.access(runDir); }
    catch { return NextResponse.json({ error: 'Run not found' }, { status: 404 }); }

    const { action } = await request.json();
    const stopSignal  = path.join(runDir, 'stop.signal');
    const pauseSignal = path.join(runDir, 'pause.signal');

    if (action === 'stop') {
      await fs.writeFile(stopSignal, new Date().toISOString());
      return NextResponse.json({ ok: true, action: 'stop' });
    }
    if (action === 'pause') {
      await fs.writeFile(pauseSignal, new Date().toISOString());
      return NextResponse.json({ ok: true, action: 'pause' });
    }
    if (action === 'resume') {
      try { await fs.unlink(pauseSignal); } catch {}
      return NextResponse.json({ ok: true, action: 'resume' });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
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
    const runDir = path.join(DATA_DIR, 'runs', runId);

    // Check if run exists
    try {
      await fs.access(runDir);
    } catch (err) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    // Load metadata
    const metadataPath = path.join(runDir, 'metadata.json');
    const metadataData = await fs.readFile(metadataPath, 'utf-8');
    const metadata = JSON.parse(metadataData);

    // Load iteration summaries
    const iterationsDir = path.join(runDir, 'iterations');
    let iterations: any[] = [];
    
    try {
      const iterFolders = await fs.readdir(iterationsDir);
      
      for (const folder of iterFolders.sort()) {
        const summaryPath = path.join(iterationsDir, folder, 'summary.json');
        try {
          const summaryData = await fs.readFile(summaryPath, 'utf-8');
          const summary = JSON.parse(summaryData);
          iterations.push(summary);
        } catch (err) {
          // Summary not yet created for this iteration
        }
      }
    } catch (err) {
      // Iterations folder doesn't exist yet
    }

    // Check for pause/stop signals so UI can reflect state
    const pauseSignal = path.join(runDir, 'pause.signal');
    const stopSignal  = path.join(runDir, 'stop.signal');
    const isPaused    = await fs.access(pauseSignal).then(() => true).catch(() => false);
    const isStopping  = await fs.access(stopSignal).then(() => true).catch(() => false);

    // Check if final_prompt.txt exists (available for "continue" runs)
    const hasFinalPrompt = await fs.access(path.join(runDir, 'final_prompt.txt')).then(() => true).catch(() => false);
    const hasFeedback    = await fs.access(path.join(runDir, 'human_feedback.txt')).then(() => true).catch(() => false);

    // Load prompt ledger, change ledger, and test asset meta (new)
    const [promptLedger, changeLedger, testAssetMeta] = await Promise.all([
      readJson(path.join(runDir, 'prompt_ledger.json')),
      readJson(path.join(runDir, 'change_ledger.json')),
      readJson(path.join(runDir, 'test_asset_meta.json')),
    ]);

    return NextResponse.json({
      ...metadata,
      iterations,
      isPaused,
      isStopping,
      hasFinalPrompt,
      hasFeedback,
      promptLedger,
      changeLedger,
      testAssetMeta,
    });
  } catch (error) {
    console.error('Error loading run:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
