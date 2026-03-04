import { LeadAgent } from './lead-agent';
import { TestRunner } from './test-runner';
import { RunStorage } from './storage';
import { ConfigLoader } from './config-loader';
import fs from 'fs/promises';
import path from 'path';
import {
  Task,
  OrchestratorConfig,
  Transcript,
  TranscriptIndex,
  TranscriptIndexEntry,
  RuleValidationResult,
  ValidationRules,
  Violation,
  Analysis,
  IterationSummary,
  IterationContext,
  RunResult,
  IterationData,
  ScenarioDelta,
  DeltaChange,
} from './types';

export class OrchestrationEngine {
  private leadAgent: LeadAgent;
  private testRunner: TestRunner;
  private storage: RunStorage;
  private configLoader: ConfigLoader;
  private config: OrchestratorConfig;
  private dataDir: string;

  constructor(
    apiKey: string,
    orchestratorId: string,
    stressMode = false,
    dataDir = './data'
  ) {
    this.storage = new RunStorage(dataDir);
    this.configLoader = new ConfigLoader(dataDir);
    this.dataDir = dataDir;

    // Load config synchronously will be done in async init
    this.config = null as any; // Will be set in init
    this.leadAgent = null as any;
    this.testRunner = null as any;

    // Store for async init
    this._apiKey = apiKey;
    this._orchestratorId = orchestratorId;
    this._stressMode = stressMode;
  }

  private _apiKey: string;
  private _orchestratorId: string;
  private _stressMode: boolean;

  /**
   * Initialize the engine (load config)
   */
  async init(): Promise<void> {
    this.config = await this.configLoader.loadOrchestrator(this._orchestratorId);
    this.leadAgent = new LeadAgent(this._apiKey, this.config);
    this.testRunner = new TestRunner(this._apiKey, this.config, this._stressMode);
  }

  /**
   * Main refinement cycle
   */
  async runRefinementCycle(task: Task): Promise<RunResult> {
    const startTime = Date.now();
    const runId = await this.storage.createRun(this._orchestratorId, task);

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`  Starting Refinement Cycle`);
    console.log(`  Run ID: ${runId}`);
    console.log(`  Orchestrator: ${this.config.name}`);
    console.log(`${'═'.repeat(50)}\n`);

    try {
      // Phase 1: Initial Generation
      console.log('⚙️  Generating initial prompt and fixed test plan...');
      const promptBank = await this.storage.loadPromptBank(
        this.config.promptBank
      );
      const { prompt, testPlan, reasoning } = await this.leadAgent.generatePrompt(
        task,
        promptBank
      );

      console.log(`✓ Generated prompt (${prompt.length} chars)`);
      console.log(`✓ Generated fixed test plan (${testPlan.scenarios.length} scenarios)`);
      console.log(`  Note: Same test set will be used across all iterations`);

      let currentPrompt = prompt;
      let iteration = 1;
      const history: IterationSummary[] = [];

      // Refinement Loop
      while (iteration <= this.config.maxIterations) {
        console.log(`\n${'═'.repeat(50)}`);
        console.log(`  Iteration ${iteration}`);
        console.log(`${'═'.repeat(50)}\n`);

        // Step 1: Run Tests (same test plan every iteration)
        const transcripts = await this.testRunner.runTests(currentPrompt, testPlan);

        // Step 2: Rule Validation (code-based)
        console.log('⚙️  Validating rules...');
        const ruleResults = this.validateRules(transcripts);
        console.log(
          `  ${ruleResults.passed ? '✓' : '✗'} ${ruleResults.violations.length} rule violations`
        );

        // Step 3: Generate Transcript Index
        const transcriptIndex = this.generateTranscriptIndex(
          transcripts,
          ruleResults
        );

        // Step 4: Select transcripts for analysis
        const selectedTranscripts = this.selectTranscriptsForAnalysis(
          transcripts,
          transcriptIndex
        );

        // Step 5: Load previous iteration analysis for delta
        let previousAnalysis: Analysis | null = null;
        if (iteration > 1) {
          try {
            const prevIterPath = path.join(
              this.dataDir,
              'runs',
              runId,
              'iterations',
              (iteration - 1).toString().padStart(2, '0'),
              'llm_analysis.json'
            );
            const prevData = await fs.readFile(prevIterPath, 'utf-8');
            previousAnalysis = JSON.parse(prevData);
          } catch (error) {
            // No previous analysis available
          }
        }

        // Step 6: LLM Analysis with delta calculation
        console.log('⚙️  Analyzing transcripts...');
        const analysis = await this.leadAgent.analyzeTranscripts(
          selectedTranscripts,
          transcriptIndex,
          task.requirements,
          this.loadValidationRules()
        );

        // Calculate delta if previous analysis exists
        if (previousAnalysis) {
          analysis.delta = this.calculateDelta(previousAnalysis, analysis);
        }

        const highSeverityCount = analysis.scenarios
          .flatMap((s) => s.issues)
          .filter((i) => i.severity === 'high').length;

        const passedCount = analysis.scenarios.filter((s) => s.passed).length;
        const totalCount = analysis.scenarios.length;

        console.log(
          `✓ Pass rate: ${passedCount}/${totalCount} (${(analysis.passRate * 100).toFixed(1)}%)`
        );
        console.log(
          `  ${highSeverityCount > 0 ? '✗' : '✓'} High severity issues: ${highSeverityCount}`
        );

        if (analysis.delta) {
          const delta = analysis.delta;
          console.log(`\n  📊 Delta Analysis:`);
          if (delta.improvements > 0) {
            console.log(`    ↑ Improvements: ${delta.improvements} scenario(s)`);
          }
          if (delta.regressions > 0) {
            console.log(`    ↓ Regressions: ${delta.regressions} scenario(s)`);
          }
          if (delta.unchanged > 0) {
            console.log(`    → Unchanged: ${delta.unchanged} scenario(s)`);
          }
        }

        // Create summary
        const summary: IterationSummary = {
          iteration,
          passRate: analysis.passRate,
          passedCount,
          totalCount,
          highSeverityCount,
          mainIssues: analysis.scenarios
            .flatMap((s) => s.issues.filter((i) => i.severity === 'high'))
            .map((i) => `${i.category}: ${i.description}`)
            .slice(0, 3),
          changesApplied: iteration === 1 ? [] : ['Refined based on analysis'],
          cost: this.leadAgent.getTotalCost(),
          delta: analysis.delta
            ? {
                improvements: analysis.delta.improvements,
                regressions: analysis.delta.regressions,
                unchanged: analysis.delta.unchanged,
              }
            : undefined,
        };

        // Save iteration data
        const iterData: IterationData = {
          prompt: currentPrompt,
          testPlan: iteration === 1 ? testPlan : undefined,
          transcripts,
          transcriptIndex,
          ruleValidation: ruleResults,
          llmAnalysis: analysis,
          summary,
        };

        await this.storage.saveIteration(runId, iteration, iterData);

        // Step 7: Check Stop Conditions
        const shouldStop = this.checkStopConditions(analysis, history);

        if (shouldStop.stop) {
          console.log(`\n✓ Stop condition met: ${shouldStop.reason}`);
          return this.finalize(
            runId,
            currentPrompt,
            'success',
            analysis.overallScore,
            startTime
          );
        }

        if (highSeverityCount > 0) {
          console.log(
            '⚠️  High severity issues present - continuing refinement...'
          );
        }

        // Step 8: Refine Prompt
        console.log('⚙️  Refining prompt...');
        const context = this.buildContext(history, transcriptIndex, analysis, transcripts);
        const { refinedPrompt, changes } = await this.leadAgent.refinePrompt(
          currentPrompt,
          analysis,
          context
        );

        console.log(`✓ Refined prompt`);
        changes.forEach((change) => console.log(`  - ${change}`));

        // Update summary with changes
        summary.changesApplied = changes;
        history.push(summary);

        currentPrompt = refinedPrompt;
        iteration++;
      }

      // Max iterations reached
      console.log('\n⚠️  Max iterations reached');
      return this.finalize(
        runId,
        currentPrompt,
        'max_iterations',
        history[history.length - 1]?.passRate || 0,
        startTime
      );
    } catch (error) {
      console.error(`\n✗ Error during refinement: ${(error as Error).message}`);
      await this.storage.updateMetadata(runId, { status: 'error' });
      throw error;
    }
  }

  /**
   * Check stop conditions (updated for small test sets)
   */
  private checkStopConditions(
    analysis: Analysis,
    history: IterationSummary[]
  ): { stop: boolean; reason?: string } {
    const highSeverityCount = analysis.scenarios
      .flatMap((s) => s.issues)
      .filter((i) => i.severity === 'high').length;

    const passedCount = analysis.scenarios.filter((s) => s.passed).length;
    const totalCount = analysis.scenarios.length;
    const allPass = passedCount === totalCount;
    const mostPass = passedCount >= Math.ceil(totalCount * 0.75); // 3/4 или повече

    // Condition 0: High Severity Gate (КРИТИЧНО)
    if (highSeverityCount > this.config.stopConditions.maxHighSeverityIssues) {
      return { stop: false };
    }

    // Condition 1: All scenarios pass + No high severity
    if (allPass && highSeverityCount === 0) {
      return {
        stop: true,
        reason: 'All scenarios pass with no high severity issues',
      };
    }

    // Condition 2: Most scenarios pass (3/4+) + No high severity + 2 consecutive successes
    if (mostPass && highSeverityCount === 0) {
      const recentSuccesses = history
        .slice(-2)
        .filter(
          (h) =>
            h.passedCount >= Math.ceil(h.totalCount * 0.75) &&
            h.highSeverityCount === 0
        ).length;

      if (recentSuccesses >= 1 && history.length >= 1) {
        // Current + 1 previous = 2 consecutive
        return {
          stop: true,
          reason: '2 consecutive successes with most scenarios passing',
        };
      }
    }

    // Condition 3: No changes in delta (stable)
    if (history.length >= 1 && analysis.delta) {
      const lastDelta = analysis.delta;
      if (
        lastDelta.improvements === 0 &&
        lastDelta.regressions === 0 &&
        allPass
      ) {
        return {
          stop: true,
          reason: 'No changes and all scenarios pass - prompt is stable',
        };
      }
    }

    return { stop: false };
  }

  /**
   * Calculate delta between previous and current analysis
   */
  private calculateDelta(
    previousAnalysis: Analysis,
    currentAnalysis: Analysis
  ): {
    improvements: number;
    regressions: number;
    unchanged: number;
    changes: ScenarioDelta[];
  } {
    const changes: ScenarioDelta[] = [];
    let improvements = 0;
    let regressions = 0;
    let unchanged = 0;

    for (const currentScenario of currentAnalysis.scenarios) {
      const previousScenario = previousAnalysis.scenarios.find(
        (s) => s.scenarioId === currentScenario.scenarioId
      );

      if (!previousScenario) {
        // New scenario (shouldn't happen with fixed test set)
        changes.push({
          scenarioId: currentScenario.scenarioId,
          change: 'new',
          currentPassed: currentScenario.passed,
          currentIssueCount: currentScenario.issues.length,
          description: 'New scenario',
        });
        continue;
      }

      const prevPassed = previousScenario.passed;
      const currPassed = currentScenario.passed;
      const prevIssues = previousScenario.issues.length;
      const currIssues = currentScenario.issues.length;

      let change: DeltaChange = 'unchanged';
      let description = '';

      if (!prevPassed && currPassed) {
        change = 'improved';
        description = 'Now passing';
        improvements++;
      } else if (prevPassed && !currPassed) {
        change = 'regressed';
        description = 'Started failing';
        regressions++;
      } else if (prevPassed && currPassed) {
        if (currIssues < prevIssues) {
          change = 'improved';
          description = `Fewer issues (${prevIssues} → ${currIssues})`;
          improvements++;
        } else if (currIssues > prevIssues) {
          change = 'regressed';
          description = `More issues (${prevIssues} → ${currIssues})`;
          regressions++;
        } else {
          change = 'unchanged';
          description = 'Still passing';
          unchanged++;
        }
      } else {
        // Both failing
        if (currIssues < prevIssues) {
          change = 'improved';
          description = `Fewer issues while failing (${prevIssues} → ${currIssues})`;
          improvements++;
        } else if (currIssues > prevIssues) {
          change = 'regressed';
          description = `More issues while failing (${prevIssues} → ${currIssues})`;
          regressions++;
        } else {
          change = 'unchanged';
          description = 'Still failing with same issues';
          unchanged++;
        }
      }

      changes.push({
        scenarioId: currentScenario.scenarioId,
        change,
        previousPassed: prevPassed,
        currentPassed: currPassed,
        previousIssueCount: prevIssues,
        currentIssueCount: currIssues,
        description,
      });
    }

    return {
      improvements,
      regressions,
      unchanged,
      changes,
    };
  }

  /**
   * Build context for refining
   */
  private buildContext(
    history: IterationSummary[],
    transcriptIndex: TranscriptIndex,
    analysis: Analysis,
    allTranscripts: Transcript[]
  ): IterationContext {
    // Get failed transcripts from index
    const failedIds = transcriptIndex.scenarios
      .filter((s) => !s.passed || s.hasHighSeverity)
      .map((s) => s.scenarioId)
      .slice(0, 3);

    const failedTranscripts = allTranscripts.filter((t) =>
      failedIds.includes(t.scenarioId)
    );

    // Get one passed sample
    const passedIds = transcriptIndex.scenarios
      .filter((s) => s.passed && !s.hasHighSeverity)
      .map((s) => s.scenarioId)
      .slice(0, 1);

    const passedSample = allTranscripts.filter((t) =>
      passedIds.includes(t.scenarioId)
    );

    return {
      currentAnalysis: analysis,
      transcriptIndex,
      previousSummaries: history.slice(-2),
      failedTranscripts,
      passedSample,
    };
  }

  /**
   * Generate transcript index
   */
  private generateTranscriptIndex(
    transcripts: Transcript[],
    ruleValidation: RuleValidationResult
  ): TranscriptIndex {
    return {
      scenarios: transcripts.map((t) => {
        const violations = ruleValidation.violations.filter(
          (v) => v.scenarioId === t.scenarioId
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

  /**
   * Select transcripts for analysis (failed + high severity + sample)
   */
  private selectTranscriptsForAnalysis(
    allTranscripts: Transcript[],
    index: TranscriptIndex
  ): Transcript[] {
    const selected: Transcript[] = [];

    // 1. All failed
    const failedIds = index.scenarios
      .filter((s) => !s.passed)
      .map((s) => s.scenarioId);
    selected.push(
      ...allTranscripts.filter((t) => failedIds.includes(t.scenarioId))
    );

    // 2. All high severity (may overlap with failed)
    const highSevIds = index.scenarios
      .filter((s) => s.hasHighSeverity)
      .map((s) => s.scenarioId);
    const highSev = allTranscripts.filter((t) =>
      highSevIds.includes(t.scenarioId)
    );
    selected.push(...highSev.filter((t) => !selected.includes(t)));

    // 3. Sample from passed
    const passedTranscripts = allTranscripts.filter(
      (t) => !selected.some((s) => s.scenarioId === t.scenarioId)
    );
    if (passedTranscripts.length > 0) {
      selected.push(passedTranscripts[0]);
    }

    return selected;
  }

  /**
   * Validate rules (code-based)
   */
  private validateRules(transcripts: Transcript[]): RuleValidationResult {
    const rules = this.loadValidationRules();
    const violations: Violation[] = [];

    for (const transcript of transcripts) {
      for (const msg of transcript.messages) {
        if (msg.role !== 'assistant') continue;

        // Rule 1: Response length
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

        // Rule 2: Forbidden phrases
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

  /**
   * Load validation rules (placeholder for now)
   */
  private loadValidationRules(): ValidationRules {
    // For MVP, use config-based rules or defaults
    return {
      maxResponseLength: 800,
      forbiddenPhrases: [],
      requiredElements: [],
    };
  }

  /**
   * Calculate severity tags from violations
   */
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

  /**
   * Generate summary for a transcript
   */
  private summarizeTranscript(transcript: Transcript): string {
    const userMsgs = transcript.messages.filter((m) => m.role === 'user');
    const botMsgs = transcript.messages.filter((m) => m.role === 'assistant');

    const lastBotMsg = botMsgs[botMsgs.length - 1]?.content || '';
    const preview = lastBotMsg.substring(0, 80);

    return `${userMsgs.length} user messages, ${botMsgs.length} bot responses. Last: "${preview}${lastBotMsg.length > 80 ? '...' : ''}"`;
  }

  /**
   * Estimate tokens for a transcript
   */
  private estimateTokens(transcript: Transcript): number {
    // Rough estimate: ~4 chars per token
    const totalChars = transcript.messages.reduce(
      (sum, m) => sum + m.content.length,
      0
    );
    return Math.ceil(totalChars / 4);
  }

  /**
   * Finalize run and return result
   */
  private async finalize(
    runId: string,
    finalPrompt: string,
    status: 'success' | 'max_iterations',
    finalScore: number,
    startTime: number
  ): Promise<RunResult> {
    const totalCost = this.leadAgent.getTotalCost();
    const duration = Date.now() - startTime;

    await this.storage.finalizeRun(runId, status, finalScore, totalCost);

    // Generate summary
    const summary = this.generateSummary(
      runId,
      status,
      finalScore,
      totalCost,
      duration
    );
    await this.storage.saveSummary(runId, summary);

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`  Result`);
    console.log(`${'═'.repeat(50)}\n`);
    console.log(status === 'success' ? `✓ Success` : `⚠️  Max iterations reached`);
    console.log(`✓ Final score: ${(finalScore * 100).toFixed(1)}%`);
    console.log(`✓ Total cost: $${totalCost.toFixed(2)}`);
    console.log(
      `✓ Duration: ${Math.floor(duration / 1000 / 60)}m ${Math.floor((duration / 1000) % 60)}s`
    );
    console.log(`\n📄 Final prompt saved to:`);
    console.log(`   data/runs/${runId}/iterations/*/prompt.txt\n`);

    const metadata = await this.storage.loadMetadata(runId);

    return {
      runId,
      status,
      finalPrompt,
      finalScore,
      totalIterations: metadata.currentIteration,
      totalCost,
      duration,
    };
  }

  /**
   * Generate markdown summary
   */
  private generateSummary(
    runId: string,
    status: string,
    finalScore: number,
    totalCost: number,
    duration: number
  ): string {
    return `# Refinement Run Summary

**Run ID**: ${runId}
**Status**: ${status}
**Final Score**: ${(finalScore * 100).toFixed(1)}%
**Total Cost**: $${totalCost.toFixed(2)}
**Duration**: ${Math.floor(duration / 1000 / 60)} minutes

## Results

${status === 'success' ? 'The prompt refinement was successful.' : 'Reached maximum iterations without meeting all success criteria.'}

See iterations folder for detailed analysis.
`;
  }

  /**
   * Check budget limits
   */
  private async checkBudget(currentCost: number): Promise<void> {
    if (currentCost >= this.config.costs.budgetPerRun) {
      throw new Error(
        `Budget exceeded: $${currentCost.toFixed(2)} >= $${this.config.costs.budgetPerRun}`
      );
    }

    if (currentCost >= this.config.costs.warnThreshold) {
      const percentage = Math.round(
        (currentCost / this.config.costs.budgetPerRun) * 100
      );
      console.warn(
        `⚠️  Cost warning: $${currentCost.toFixed(2)} (${percentage}% of budget)`
      );
    }
  }
}
