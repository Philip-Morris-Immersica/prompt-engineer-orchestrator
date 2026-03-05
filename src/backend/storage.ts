import fs from 'fs/promises';
import path from 'path';
import {
  Task,
  RunMetadata,
  IterationData,
  Transcript,
  TranscriptIndex,
  RuleValidationResult,
  Analysis,
  IterationSummary,
  TestPlan,
  RunStatus,
} from './types';

export class RunStorage {
  private dataDir: string;

  constructor(dataDir: string = './data') {
    this.dataDir = dataDir;
  }

  /**
   * Create a new run and return its ID
   */
  async createRun(orchestratorId: string, task: Task): Promise<string> {
    const runId = `run_${Date.now()}`;
    const runDir = path.join(this.dataDir, 'runs', runId);

    await fs.mkdir(runDir, { recursive: true });

    const metadata: RunMetadata = {
      runId,
      orchestratorId,
      taskId: task.id,
      taskName: task.name !== task.id ? task.name : undefined,
      status: 'running',
      startedAt: Date.now(),
      currentIteration: 0,
    };

    await fs.writeFile(
      path.join(runDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    );

    // Save task info
    await fs.writeFile(
      path.join(runDir, 'task.json'),
      JSON.stringify(task, null, 2)
    );

    return runId;
  }

  /**
   * Update run metadata
   */
  async updateMetadata(
    runId: string,
    updates: Partial<RunMetadata>
  ): Promise<void> {
    const metadataPath = path.join(this.dataDir, 'runs', runId, 'metadata.json');
    const currentData = await fs.readFile(metadataPath, 'utf-8');
    const metadata = JSON.parse(currentData);

    const updated = { ...metadata, ...updates };

    await fs.writeFile(metadataPath, JSON.stringify(updated, null, 2));
  }

  /**
   * Save a complete iteration
   */
  async saveIteration(
    runId: string,
    iteration: number,
    data: IterationData
  ): Promise<void> {
    const iterDir = this.getIterationDir(runId, iteration);
    await fs.mkdir(iterDir, { recursive: true });

    // Save prompt
    await fs.writeFile(path.join(iterDir, 'prompt.txt'), data.prompt);

    // Save test driver prompt snapshot (if present)
    if (data.testDriverPrompt) {
      await fs.writeFile(path.join(iterDir, 'test_driver_prompt.txt'), data.testDriverPrompt);
    }

    // Save test plan (if provided, only in first iteration)
    if (data.testPlan) {
      await fs.writeFile(
        path.join(iterDir, 'test_plan.json'),
        JSON.stringify(data.testPlan, null, 2)
      );
    }

    // Save transcript index
    await fs.writeFile(
      path.join(iterDir, 'transcript_index.json'),
      JSON.stringify(data.transcriptIndex, null, 2)
    );

    // Save rule validation results
    await fs.writeFile(
      path.join(iterDir, 'rule_validation.json'),
      JSON.stringify(data.ruleValidation, null, 2)
    );

    // Save LLM analysis
    await fs.writeFile(
      path.join(iterDir, 'llm_analysis.json'),
      JSON.stringify(data.llmAnalysis, null, 2)
    );

    // Save summary
    await fs.writeFile(
      path.join(iterDir, 'summary.json'),
      JSON.stringify(data.summary, null, 2)
    );

    // Save transcripts
    await this.saveTranscripts(iterDir, data.transcripts);

    // Update metadata
    await this.updateMetadata(runId, { currentIteration: iteration });
  }

  /**
   * Save transcripts for an iteration
   */
  private async saveTranscripts(
    iterDir: string,
    transcripts: Transcript[]
  ): Promise<void> {
    const testsDir = path.join(iterDir, 'tests');
    await fs.mkdir(testsDir, { recursive: true });

    await Promise.all(
      transcripts.map((transcript) =>
        fs.writeFile(
          path.join(testsDir, `${transcript.scenarioId}.json`),
          JSON.stringify(transcript, null, 2)
        )
      )
    );
  }

  /**
   * Save transcript index separately
   */
  async saveTranscriptIndex(
    runId: string,
    iteration: number,
    index: TranscriptIndex
  ): Promise<void> {
    const iterDir = this.getIterationDir(runId, iteration);
    await fs.mkdir(iterDir, { recursive: true });

    await fs.writeFile(
      path.join(iterDir, 'transcript_index.json'),
      JSON.stringify(index, null, 2)
    );
  }

  /**
   * Save prompt for an iteration
   */
  async savePrompt(
    runId: string,
    iteration: number,
    prompt: string
  ): Promise<void> {
    const iterDir = this.getIterationDir(runId, iteration);
    await fs.mkdir(iterDir, { recursive: true });

    await fs.writeFile(path.join(iterDir, 'prompt.txt'), prompt);
  }

  /**
   * Load run metadata
   */
  async loadMetadata(runId: string): Promise<RunMetadata> {
    const metadataPath = path.join(this.dataDir, 'runs', runId, 'metadata.json');
    const data = await fs.readFile(metadataPath, 'utf-8');
    return JSON.parse(data);
  }

  /**
   * Load transcripts for an iteration
   */
  async loadTranscripts(runId: string, iteration: number): Promise<Transcript[]> {
    const testsDir = path.join(this.getIterationDir(runId, iteration), 'tests');

    try {
      const files = await fs.readdir(testsDir);
      const transcripts = await Promise.all(
        files
          .filter((f) => f.endsWith('.json'))
          .map(async (f) => {
            const data = await fs.readFile(path.join(testsDir, f), 'utf-8');
            return JSON.parse(data);
          })
      );
      return transcripts;
    } catch (error) {
      return [];
    }
  }

  /**
   * Load transcript index
   */
  async loadTranscriptIndex(
    runId: string,
    iteration: number
  ): Promise<TranscriptIndex | null> {
    const indexPath = path.join(
      this.getIterationDir(runId, iteration),
      'transcript_index.json'
    );

    try {
      const data = await fs.readFile(indexPath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      return null;
    }
  }

  /**
   * List all runs
   */
  async listRuns(): Promise<RunMetadata[]> {
    const runsDir = path.join(this.dataDir, 'runs');

    try {
      await fs.mkdir(runsDir, { recursive: true });
      const dirs = await fs.readdir(runsDir);

      const runs = await Promise.all(
        dirs.map(async (dir) => {
          try {
            return await this.loadMetadata(dir);
          } catch (error) {
            return null;
          }
        })
      );

      return runs.filter((r) => r !== null) as RunMetadata[];
    } catch (error) {
      return [];
    }
  }

  /**
   * Finalize a run
   */
  async finalizeRun(
    runId: string,
    status: RunStatus,
    finalScore?: number,
    totalCost?: number
  ): Promise<void> {
    await this.updateMetadata(runId, {
      status,
      completedAt: Date.now(),
      finalScore,
      totalCost,
    });
  }

  /**
   * Generate and save summary
   */
  async saveSummary(runId: string, summary: string): Promise<void> {
    const summaryPath = path.join(this.dataDir, 'runs', runId, 'final_summary.md');
    await fs.writeFile(summaryPath, summary);
  }

  /**
   * Helper: Get iteration directory
   */
  private getIterationDir(runId: string, iteration: number): string {
    return path.join(
      this.dataDir,
      'runs',
      runId,
      'iterations',
      iteration.toString().padStart(2, '0')
    );
  }

  /**
   * Helper: Get run directory
   */
  private getRunDir(runId: string): string {
    return path.join(this.dataDir, 'runs', runId);
  }

  /**
   * Load prompt bank examples
   */
  async loadPromptBank(bankPath: string): Promise<any[]> {
    const fullPath = path.join(this.dataDir, bankPath);

    try {
      await fs.mkdir(fullPath, { recursive: true });
      const files = await fs.readdir(fullPath);

      const examples = await Promise.all(
        files
          .filter((f) => f.endsWith('.json'))
          .map(async (f) => {
            const data = await fs.readFile(path.join(fullPath, f), 'utf-8');
            return JSON.parse(data);
          })
      );

      return examples;
    } catch (error) {
      console.warn(`Warning: Could not load prompt bank from ${bankPath}`);
      return [];
    }
  }
}
