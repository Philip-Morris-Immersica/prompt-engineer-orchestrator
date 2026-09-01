import fs from 'fs/promises';
import path from 'path';
import { LeadAgent } from './lead-agent';
import { TestRunner } from './test-runner';
import type {
  Analysis,
  OrchestratorConfig,
  Requirements,
  RuleValidationResult,
  RunMetadata,
  Task,
  TestPlan,
  Transcript,
  TranscriptIndex,
  ValidationRules,
  Violation,
} from './types';

export class PlaygroundStoppedError extends Error {
  constructor() {
    super('STOPPED');
    this.name = 'PlaygroundStoppedError';
  }
}

export class PlaygroundEvaluator {
  private apiKey: string;
  private config: OrchestratorConfig;
  private dataDir: string;

  constructor(apiKey: string, config: OrchestratorConfig, dataDir?: string) {
    this.apiKey = apiKey;
    this.config = config;
    this.dataDir = dataDir ?? (process.env.DATA_DIR || './data');
  }

  async evaluate(
    runId: string,
    prompt: string,
    scenarioIds?: string[],
    hooks?: {
      onPhase?: (p: 'testing' | 'analyzing') => void | Promise<void>;
      stopSignalPath?: string;
    },
  ): Promise<{
    transcripts: Transcript[];
    ruleValidation: RuleValidationResult;
    analysis: Analysis;
    cost: number;
  }> {
    const testPlan = await this.readJson<TestPlan>(
      path.join(this.dataDir, 'runs', runId, 'test_plan.json'),
    );
    if (!testPlan || !Array.isArray(testPlan.scenarios)) {
      throw new Error(`Test plan not found for run ${runId}`);
    }

    const task = await this.readJson<Task>(
      path.join(this.dataDir, 'runs', runId, 'task.json'),
    );
    if (!task) {
      throw new Error(`Task not found for run ${runId}`);
    }

    let filteredPlan: TestPlan = testPlan;
    if (Array.isArray(scenarioIds) && scenarioIds.length > 0) {
      const wanted = new Set(scenarioIds);
      filteredPlan = {
        scenarios: testPlan.scenarios.filter((s) => wanted.has(s.id)),
      };
      if (filteredPlan.scenarios.length === 0) {
        throw new Error(
          `No matching scenarios for ids: ${scenarioIds.join(', ')}`,
        );
      }
    }

    const metadata = await this.readJson<RunMetadata>(
      path.join(this.dataDir, 'runs', runId, 'metadata.json'),
    );

    const testRunner = new TestRunner(this.apiKey, this.config);
    const leadAgent = new LeadAgent(this.apiKey, this.config);

    if (hooks?.stopSignalPath) {
      testRunner.setStopSignalPath(hooks.stopSignalPath);
    }

    try {
      await hooks?.onPhase?.('testing');
      const transcripts = await testRunner.runTests(prompt, filteredPlan);

      if (testRunner.wasStoppedByUser()) {
        throw new PlaygroundStoppedError();
      }

      const ruleValidation = this.validateRules(transcripts);
      const index = this.generateTranscriptIndex(transcripts, ruleValidation);

      const taskDescription = [
        task.name,
        task.description,
        task.requirements?.role ? `Role: ${task.requirements.role}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      const championContext =
        metadata && typeof metadata.championIteration === 'number'
          ? { iteration: metadata.championIteration, score: metadata.championScore }
          : undefined;

      await hooks?.onPhase?.('analyzing');
      const analysis = await leadAgent.analyzeTranscripts(
        transcripts,
        index,
        (task.requirements ?? {}) as Requirements,
        this.loadValidationRules(),
        prompt,
        taskDescription,
        championContext,
      );

      const cost = testRunner.getTotalCost() + leadAgent.getTotalCost();

      return { transcripts, ruleValidation, analysis, cost };
    } finally {
      testRunner.clearStopFlag();
    }
  }

  // --- Duplicated from OrchestrationEngine private helpers (do not extract) ---

  private loadValidationRules(): ValidationRules {
    return {
      maxResponseLength: 800,
      forbiddenPhrases: [],
      requiredElements: [],
    };
  }

  private validateRules(transcripts: Transcript[]): RuleValidationResult {
    const rules = this.loadValidationRules();
    const violations: Violation[] = [];

    for (const transcript of transcripts) {
      for (const msg of transcript.messages) {
        if (msg.role !== 'assistant') continue;

        if (
          rules.maxResponseLength &&
          msg.content.length > rules.maxResponseLength
        ) {
          violations.push({
            type: 'response_too_long',
            scenarioId: transcript.scenarioId,
            message: msg.content.substring(0, 100) + '...',
            value: msg.content.length,
          });
        }

        if (rules.forbiddenPhrases) {
          for (const phrase of rules.forbiddenPhrases) {
            if (msg.content.toLowerCase().includes(phrase.toLowerCase())) {
              violations.push({
                type: 'forbidden_phrase',
                scenarioId: transcript.scenarioId,
                message: phrase,
                value: msg.content,
              });
            }
          }
        }
      }
    }

    return {
      passed: violations.length === 0,
      violations,
    };
  }

  private generateTranscriptIndex(
    transcripts: Transcript[],
    ruleValidation: RuleValidationResult,
  ): TranscriptIndex {
    return {
      scenarios: transcripts.map((t) => {
        const violations = ruleValidation.violations.filter(
          (v) => v.scenarioId === t.scenarioId,
        );

        const severityTags = this.calculateSeverityTags(violations);
        const summary = this.summarizeTranscript(t);

        return {
          scenarioId: t.scenarioId,
          scenarioName: t.scenarioName,
          passed: violations.length === 0,
          severityTags,
          summary,
          messageCount: t.messages.length,
          tokenEstimate: this.estimateTokens(t),
          hasHighSeverity: severityTags.includes('high_severity'),
        };
      }),
    };
  }

  private calculateSeverityTags(violations: Violation[]): string[] {
    const tags: string[] = [];

    for (const violation of violations) {
      if (violation.type === 'forbidden_phrase') {
        tags.push('forbidden_content', 'high_severity');
      } else if (violation.type === 'response_too_long') {
        tags.push('too_verbose', 'medium_severity');
      }
    }

    return [...new Set(tags)];
  }

  private summarizeTranscript(transcript: Transcript): string {
    const userMsgs = transcript.messages.filter((m) => m.role === 'user');
    const botMsgs = transcript.messages.filter((m) => m.role === 'assistant');

    const lastBotMsg = botMsgs[botMsgs.length - 1]?.content || '';
    const preview = lastBotMsg.substring(0, 80);

    return `${userMsgs.length} user messages, ${botMsgs.length} bot responses. Last: "${preview}${lastBotMsg.length > 80 ? '...' : ''}"`;
  }

  private estimateTokens(transcript: Transcript): number {
    const totalChars = transcript.messages.reduce(
      (sum, m) => sum + m.content.length,
      0,
    );
    return Math.ceil(totalChars / 4);
  }

  private async readJson<T>(filePath: string): Promise<T | null> {
    try {
      const text = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }
}
