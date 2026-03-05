import { LeadAgent } from './lead-agent';
import { TestRunner } from './test-runner';
import { RunStorage } from './storage';
import { ConfigLoader } from './config-loader';
import { FileParser, ParsedFile } from './file-parser';
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
   * Supports:
   *  - task.manualMode: true → auto-pause after each iteration (step-by-step)
   *  - task.continuedFromRunId: "<id>" → start from that run's final prompt + human feedback
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
      // Phase 1: Load uploaded files (if any)
      let uploadedFilesContext = '';
      if (task.uploadId) {
        console.log('📎 Loading uploaded reference files...');
        const uploadPath = path.join(this.dataDir, 'uploads', task.uploadId);
        try {
          const files = await fs.readdir(uploadPath);
          const filePaths = files.map((f) => path.join(uploadPath, f));
          const parsedFiles = await FileParser.parseFiles(filePaths);
          uploadedFilesContext = FileParser.formatForContext(parsedFiles);
          console.log(`✓ Loaded ${parsedFiles.length} reference file(s)`);
          
          // Save uploaded files metadata
          await this.storage.updateMetadata(runId, {
            uploadId: task.uploadId,
            uploadedFiles: files,
          });
        } catch (error) {
          console.warn('⚠️  Failed to load uploaded files:', (error as Error).message);
        }
      }

      // Phase 2: Generate OR continue from a previous run
      let currentPrompt: string;
      let testPlan: import('./types').TestPlan;
      const promptBank = await this.storage.loadPromptBank(this.config.promptBank);

      // ── Manual mode / continue flags ─────────────────────────────────
      const manualMode = !!(task as any).manualMode;
      const continuedFromRunId: string | undefined = (task as any).continuedFromRunId;

      if (continuedFromRunId) {
        // Load final prompt from previous run
        console.log(`🔗 Continuing from run ${continuedFromRunId}...`);
        const prevRunDir = path.join(this.dataDir, 'runs', continuedFromRunId);
        const prevPromptPath = path.join(prevRunDir, 'final_prompt.txt');
        currentPrompt = await fs.readFile(prevPromptPath, 'utf-8').catch(async () => {
          // Fallback: read from last iteration
          const itersDir = path.join(prevRunDir, 'iterations');
          const iters = (await fs.readdir(itersDir).catch(() => [])).sort();
          const last = iters.at(-1);
          if (!last) throw new Error('No iterations found in previous run');
          return fs.readFile(path.join(itersDir, last, 'prompt.txt'), 'utf-8');
        });

        // Load human feedback if available
        const feedbackPath = path.join(prevRunDir, 'human_feedback.txt');
        const humanFeedback = await fs.readFile(feedbackPath, 'utf-8').catch(() => '');
        if (humanFeedback) {
          uploadedFilesContext += `\n\n── HUMAN FEEDBACK FROM PREVIOUS RUN ──\n${humanFeedback}`;
          console.log('💬 Loaded human feedback from previous run');
        }

        // Generate new test plan (reuse task desc + files) — same scenario set for this run
        console.log('⚙️  Generating fresh test plan (continuing from existing prompt)...');
        const genResult = await this.leadAgent.generatePrompt(task, promptBank, uploadedFilesContext);
        testPlan = genResult.testPlan;
        // Keep the existing prompt, only use new test plan
        console.log(`✓ Loaded prompt from previous run (${currentPrompt.length} chars)`);
        console.log(`✓ Generated fresh test plan (${testPlan.scenarios.length} scenarios)`);

        await this.storage.updateMetadata(runId, { continuedFromRunId });
      } else {
        // Normal: generate both prompt and test plan
        console.log('⚙️  Generating initial prompt and fixed test plan...');
        const { prompt, testPlan: tp } = await this.leadAgent.generatePrompt(
          task, promptBank, uploadedFilesContext
        );
        currentPrompt = prompt;
        testPlan = tp;
        console.log(`✓ Generated prompt (${currentPrompt.length} chars)`);
        console.log(`✓ Generated fixed test plan (${testPlan.scenarios.length} scenarios)`);
        console.log(`  Note: Same test set will be used across all iterations`);
      }

      if (manualMode) {
        console.log('👆 Manual (step-by-step) mode active');
        await this.storage.updateMetadata(runId, { manualMode: true } as any);
      }

      // Set stop signal path on test runner for fast inter-scenario/inter-turn stop
      const stopSignalPath = path.join(this.dataDir, 'runs', runId, 'stop.signal');
      this.testRunner.clearStopFlag();   // reset any leftover flag from previous run
      this.testRunner.setStopSignalPath(stopSignalPath);

      let iteration = 1;
      let previousIterationCost = 0;
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

        // True totals: unanalyzed scenarios were "good" ones (not failed, not high-sev)
        // so we assume they passed
        const analyzedPassedCount = analysis.scenarios.filter((s) => s.passed).length;
        const unanalyzedCount = transcripts.length - analysis.scenarios.length;
        const passedCount = analyzedPassedCount + unanalyzedCount; // unanalyzed = assumed passed
        const totalCount = transcripts.length; // ALL scenarios that ran
        const passRate = totalCount > 0 ? passedCount / totalCount : 0;

        console.log(
          `✓ Pass rate: ${passedCount}/${totalCount} (${(passRate * 100).toFixed(1)}%) | LLM quality: ${(analysis.overallScore * 100).toFixed(1)}%`
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
        const iterCostBefore = previousIterationCost;
        const iterCostAfter  = this.leadAgent.getTotalCost();
        previousIterationCost = iterCostAfter;

        const summary: IterationSummary = {
          iteration,
          passRate,                         // binary: passedCount/totalCount
          qualityScore: analysis.overallScore, // LLM 0-1 quality rating
          passedCount,
          totalCount,
          highSeverityCount,
          mainIssues: analysis.scenarios
            .flatMap((s) => s.issues.filter((i) => i.severity === 'high'))
            .map((i) => `${i.category}: ${i.description}`)
            .slice(0, 3),
          changesApplied: iteration === 1 ? [] : ['Refined based on analysis'],
          cost: iterCostAfter,                      // cumulative at end of analysis step
          iterationCost: iterCostAfter - iterCostBefore, // cost of THIS iteration only
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
          testDriverPrompt: this.config.instructions.testDriver || undefined,
          testPlan: iteration === 1 ? testPlan : undefined,
          transcripts,
          transcriptIndex,
          ruleValidation: ruleResults,
          llmAnalysis: analysis,
          summary,
        };

        await this.storage.saveIteration(runId, iteration, iterData);

        // Step 7a: Check for user stop/pause signals
        const stopSignal  = path.join(this.dataDir, 'runs', runId, 'stop.signal');
        const pauseSignal = path.join(this.dataDir, 'runs', runId, 'pause.signal');

        const userStopped = await fs.access(stopSignal).then(() => true).catch(() => false)
          || this.testRunner.wasStoppedByUser();
        if (userStopped) {
          console.log('\n🛑 Stop signal received — stopping after current iteration.');
          try { await fs.unlink(stopSignal); } catch {}
          this.testRunner.clearStopFlag();
          return this.finalize(runId, currentPrompt, 'stopped', analysis.overallScore, startTime);
        }

        // Manual mode: auto-write pause signal after each iteration
        if (manualMode) {
          console.log('\n👆 Manual mode — pausing. Click Continue in UI to proceed.');
          await fs.writeFile(pauseSignal, new Date().toISOString());
        }

        // Pause: poll every 5s until pause signal is gone (manual or manual user)
        const paused = await fs.access(pauseSignal).then(() => true).catch(() => false);
        if (paused) {
          if (!manualMode) console.log('\n⏸  Pause signal received — waiting for resume...');
          while (true) {
            await new Promise(r => setTimeout(r, 5000));
            const stillPaused = await fs.access(pauseSignal).then(() => true).catch(() => false);
            if (!stillPaused) break;
            // Check stop signal during pause
            const stoppedDuringPause = await fs.access(stopSignal).then(() => true).catch(() => false);
            if (stoppedDuringPause) {
              try { await fs.unlink(stopSignal); } catch {}
              this.testRunner.clearStopFlag();
              return this.finalize(runId, currentPrompt, 'stopped', analysis.overallScore, startTime);
            }
          }
          console.log('▶  Resumed.');
        }

        // Step 7b: Check Stop Conditions (pass corrected totals + iteration number)
        const shouldStop = this.checkStopConditions(analysis, history, passedCount, totalCount, iteration);

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

        // Step 8: Read fresh human feedback (if user added/updated it mid-run)
        const feedbackPath = path.join(this.dataDir, 'runs', runId, 'human_feedback.txt');
        const latestFeedback = await fs.readFile(feedbackPath, 'utf-8').catch(() => '');
        if (latestFeedback.trim()) {
          console.log('💬 Injecting human feedback into refine context...');
          // Inject into analysis suggestions so refiner sees it prominently
          analysis.generalSuggestions = [
            `HUMAN FEEDBACK (priority): ${latestFeedback.trim()}`,
            ...analysis.generalSuggestions,
          ];
        }

        // Step 9: Refine Prompt
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
    history: IterationSummary[],
    correctedPassedCount?: number,
    correctedTotalCount?: number,
    currentIteration?: number
  ): { stop: boolean; reason?: string } {
    const minIterations   = this.config.stopConditions.minIterations   ?? 3;
    const minQualityScore = this.config.stopConditions.minQualityScore ?? 0.90;
    const completedIterations = currentIteration ?? (history.length + 1);

    // Gate 0: Minimum iterations — NEVER stop before minIterations
    if (completedIterations < minIterations) {
      console.log(`  ↻ Minimum iterations gate: ${completedIterations}/${minIterations} done — continuing.`);
      return { stop: false };
    }

    const allIssues = analysis.scenarios.flatMap((s) => s.issues);
    const highCount   = allIssues.filter((i) => i.severity === 'high').length;
    const mediumCount = allIssues.filter((i) => i.severity === 'medium').length;

    // Gate 1: Any high severity issues → keep refining
    if (highCount > 0) {
      console.log(`  ↻ ${highCount} high-severity issue(s) remain — continuing.`);
      return { stop: false };
    }

    // Gate 2: Any medium severity issues → keep refining
    if (mediumCount > 0) {
      console.log(`  ↻ ${mediumCount} medium-severity issue(s) remain — continuing.`);
      return { stop: false };
    }

    // Gate 3: Quality score must reach the threshold (default 90%)
    if (analysis.overallScore < minQualityScore) {
      console.log(`  ↻ Quality ${(analysis.overallScore * 100).toFixed(1)}% < ${(minQualityScore * 100).toFixed(1)}% threshold — continuing.`);
      return { stop: false };
    }

    // All gates passed — analyzer has only low/no issues AND high quality score
    const score = (analysis.overallScore * 100).toFixed(1);
    console.log(`  ✓ Stop conditions met: quality ${score}%, 0 high, 0 medium issues.`);
    return {
      stop: true,
      reason: `Analyzer score ${score}% with no high/medium issues — prompt is ready.`,
    };
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
    status: 'success' | 'max_iterations' | 'stopped',
    finalScore: number,
    startTime: number
  ): Promise<RunResult> {
    const totalCost = this.leadAgent.getTotalCost();
    const duration = Date.now() - startTime;

    // Save final prompt to a dedicated file so "continue" runs can easily load it
    const finalPromptPath = path.join(this.dataDir, 'runs', runId, 'final_prompt.txt');
    await fs.writeFile(finalPromptPath, finalPrompt).catch(() => {});

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

${status === 'success' ? 'The prompt refinement was successful.' : status === 'stopped' ? 'Run was stopped by the user.' : 'Reached maximum iterations without meeting all success criteria.'}

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
