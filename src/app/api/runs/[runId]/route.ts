import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';

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

    return NextResponse.json({
      ...metadata,
      iterations,
    });
  } catch (error) {
    console.error('Error loading run:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
