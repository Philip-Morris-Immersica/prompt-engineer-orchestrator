import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

export const dynamic = 'force-dynamic';

const DATA_DIR = process.env.DATA_DIR || './data';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string; iter: string }> }
) {
  try {
    const { runId, iter } = await params;

    const iterNum = parseInt(iter, 10);
    if (isNaN(iterNum) || iterNum < 1) {
      return NextResponse.json({ error: 'Invalid iteration number' }, { status: 400 });
    }

    const iterDir = path.join(
      DATA_DIR,
      'runs',
      runId,
      'iterations',
      iterNum.toString().padStart(2, '0')
    );

    try {
      await fs.access(iterDir);
    } catch {
      return NextResponse.json({ error: 'Iteration not found' }, { status: 404 });
    }

    // Load analysis first (needed to annotate transcripts with passed/failed)
    const analysis = await readJson(path.join(iterDir, 'llm_analysis.json'));

    // Read remaining files in parallel
    const [prompt, testDriverPrompt, summary, ruleValidation, transcripts, changePlan, changeImpact] = await Promise.all([
      readText(path.join(iterDir, 'prompt.txt')),
      readText(path.join(iterDir, 'test_driver_prompt.txt')),
      readJson(path.join(iterDir, 'summary.json')),
      readJson(path.join(iterDir, 'rule_validation.json')),
      readTranscripts(path.join(iterDir, 'tests'), analysis),
      readJson(path.join(iterDir, 'change_plan.json')),
      readJson(path.join(iterDir, 'change_impact.json')),
    ]);

    // Derive verdict and isChampion from summary (if available)
    const verdict = summary?.verdict ?? null;
    const isChampion = summary?.isChampion ?? false;

    return NextResponse.json({
      iteration: iterNum,
      prompt,
      testDriverPrompt,
      analysis,
      summary,
      ruleValidation,
      transcripts,
      changePlan,
      changeImpact,
      verdict,
      isChampion,
    });
  } catch (error) {
    console.error('Error loading iteration:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

async function readJson(filePath: string): Promise<any | null> {
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readTranscripts(testsDir: string, analysis?: any): Promise<any[]> {
  try {
    const files = await fs.readdir(testsDir);
    const transcripts = await Promise.all(
      files
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map(async (f) => {
          try {
            const data = await fs.readFile(path.join(testsDir, f), 'utf-8');
            const t = JSON.parse(data);
            // Annotate passed/verdict from analysis
            if (analysis?.scenarios) {
              const sa = analysis.scenarios.find((s: any) => s.scenarioId === t.scenarioId);
              if (sa) {
                // Use verdict if present; derive passed for backward compat
                t.verdict = sa.verdict ?? (sa.passed ? 'pass' : 'fail');
                t.passed = t.verdict === 'pass';
              } else {
                // Unanalyzed scenario is assumed passed
                t.passed = true;
                t.verdict = 'pass';
              }
            }
            return t;
          } catch {
            return null;
          }
        })
    );
    return transcripts.filter(Boolean);
  } catch {
    return [];
  }
}
