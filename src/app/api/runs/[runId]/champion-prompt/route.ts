import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await params;
    const runDir = path.join(DATA_DIR, 'runs', runId);

    try {
      await fs.access(runDir);
    } catch {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    // Load prompt ledger to find champion iteration
    const ledgerPath = path.join(runDir, 'prompt_ledger.json');
    let ledger: any = null;
    try {
      const raw = await fs.readFile(ledgerPath, 'utf-8');
      ledger = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'Prompt ledger not found' }, { status: 404 });
    }

    if (!ledger || ledger.championIteration === 0) {
      return NextResponse.json({ error: 'No champion established yet' }, { status: 404 });
    }

    // Find the champion entry
    const championEntry = ledger.entries?.find((e: any) => e.iteration === ledger.championIteration);
    if (!championEntry) {
      return NextResponse.json({ error: 'Champion entry not found in ledger' }, { status: 404 });
    }

    // Load the champion prompt text
    const promptPath = path.join(runDir, championEntry.promptPath);
    let promptText: string;
    try {
      promptText = await fs.readFile(promptPath, 'utf-8');
    } catch {
      return NextResponse.json({ error: 'Champion prompt file not found' }, { status: 404 });
    }

    return NextResponse.json({
      championIteration: ledger.championIteration,
      championScore: ledger.championScore,
      championPassRate: ledger.championPassRate,
      promptText,
      promptHash: championEntry.promptHash,
    });
  } catch (error) {
    console.error('Error loading champion prompt:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
