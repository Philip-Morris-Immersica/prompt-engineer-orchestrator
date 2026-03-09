import { LeadAgent } from './lead-agent';
import { TestRunner } from './test-runner';
import { RunStorage } from './storage';
import { ConfigLoader } from './config-loader';
import { FileParser, ParsedFile } from './file-parser';
import { RunLogger } from './run-logger';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
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
  RefinementMode,
  PromptVerdict,
  PromptLedger,
  PromptLedgerEntry,
  ChangeLedger,
  ChangeLedgerEntry,
  ChangePlan,
  ChangeImpact,
  TestAssetMeta,
} from './types';

export class OrchestrationEngine {
  private leadAgent: LeadAgent;
  private testRunner: TestRunner;
  private storage: RunStorage;
  private configLoader: ConfigLoader;
  private config: OrchestratorConfig;
  private dataDir: string;
  private logger: RunLogger | null = null;

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
    this.logger = new RunLogger(this.dataDir, runId);
    const log = this.logger;
    this.testRunner.setLogger(log);
    this.leadAgent.setLogger(log);

    await log.flush();
    log.step(`Starting Refinement Cycle`);
    log.info(`Run ID: ${runId}`);
    log.info(`Orchestrator: ${this.config.name}`);

    try {
      // Phase 1: Load uploaded files (if any)
      let uploadedFilesContext = '';
      let uploadedFilePaths: Array<{ filename: string; path: string }> = [];
      if (task.uploadId) {
        log.step('Loading uploaded reference files...');
        const uploadPath = path.join(this.dataDir, 'uploads', task.uploadId);
        try {
          const files = await fs.readdir(uploadPath);
          const filePaths = files.map((f) => path.join(uploadPath, f));
          const parsedFiles = await FileParser.parseFiles(filePaths);
          uploadedFilesContext = FileParser.formatForContext(parsedFiles);
          uploadedFilePaths = files.map((f) => ({
            filename: f,
            path: path.join(uploadPath, f),
          }));
          log.success(`Loaded ${parsedFiles.length} reference file(s): ${files.map(f => `"${f}"`).join(', ')}`);
          
          // Save uploaded files metadata
          await this.storage.updateMetadata(runId, {
            uploadId: task.uploadId,
            uploadedFiles: files,
          });
        } catch (error) {
          log.warn(`Failed to load uploaded files: ${(error as Error).message}`);
        }
      }

      // Phase 1b: Load orchestrator-specific guidelines (if any)
      let guidelinesContext = '';
      const guidelinesDir = path.join(this.dataDir, 'guidelines', this._orchestratorId);
      try {
        const guideFiles = (await fs.readdir(guidelinesDir).catch(() => []))
          .filter((f) => f.endsWith('.txt') || f.endsWith('.md'))
          .sort();
        if (guideFiles.length > 0) {
          const parts = await Promise.all(
            guideFiles.map((f) => fs.readFile(path.join(guidelinesDir, f), 'utf-8'))
          );
          guidelinesContext = parts.join('\n\n');
          log.success(`Loaded ${guideFiles.length} guideline file(s) for ${this._orchestratorId}: ${guideFiles.join(', ')}`);
        }
      } catch {
        // Guidelines are optional — silently skip if directory doesn't exist
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
        log.info(`Continuing from run ${continuedFromRunId}...`);
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
          log.info('Loaded human feedback from previous run');
        }

        // Generate new test plan (reuse task desc + files) — same scenario set for this run
        log.step('Generating fresh test plan (continuing from existing prompt)...');
        const genResult = await this.leadAgent.generatePrompt(task, promptBank, uploadedFilesContext, guidelinesContext, uploadedFilePaths);
        testPlan = genResult.testPlan;
        // Keep the existing prompt, only use new test plan
        log.success(`Loaded prompt from previous run (${currentPrompt.length} chars)`);
        log.success(`Generated fresh test plan (${testPlan.scenarios.length} scenarios)`);

        await this.storage.updateMetadata(runId, { continuedFromRunId });
      } else {
        // Normal: generate both prompt and test plan
        log.step('Generating initial prompt and fixed test plan (agent may read reference files)...');
        const { prompt, testPlan: tp } = await this.leadAgent.generatePrompt(
          task, promptBank, uploadedFilesContext, guidelinesContext, uploadedFilePaths
        );
        currentPrompt = prompt;
        testPlan = tp;
        log.success(`Generated prompt (${currentPrompt.length} chars)`);
        log.success(`Generated fixed test plan (${testPlan.scenarios.length} scenarios) — same test set will be used across all iterations`);
      }

      if (manualMode) {
        log.info('Manual (step-by-step) mode active');
        await this.storage.updateMetadata(runId, { manualMode: true } as any);
      }

      // Set stop signal path on test runner for fast inter-scenario/inter-turn stop
      const stopSignalPath = path.join(this.dataDir, 'runs', runId, 'stop.signal');
      this.testRunner.clearStopFlag();   // reset any leftover flag from previous run
      this.testRunner.setStopSignalPath(stopSignalPath);

      // Save run-level test assets and init TestAssetMeta
      const testDriverPromptText = this.config.instructions.testDriver || '';
      await this.storage.saveRunLevelTestAssets(runId, testDriverPromptText, testPlan);
      const testAssetMeta: TestAssetMeta = {
        runId,
        generatedAt: Date.now(),
        testDriverPromptVersion: this.hashContent(testDriverPromptText),
        testPlanVersion: this.hashContent(JSON.stringify(testPlan)),
        scenarioBlueprintVersion: this.hashContent(JSON.stringify(testPlan.scenarios.map(s => s.userUtterances))),
        scenarioCount: testPlan.scenarios.length,
        testDriverPromptPath: 'test_driver_prompt.txt',
        testPlanPath: 'test_plan.json',
        qualityObservations: [],
      };
      await this.storage.saveTestAssetMeta(runId, testAssetMeta);

      // Champion / Challenger runtime state
      let championPrompt = currentPrompt;
      let championIteration = 0; // will be set after iteration 1 analysis
      let championMetrics = { score: 0, passRate: 0, highSeverityCount: 999, mediumSeverityCount: 999 };
      const promptLedger: PromptLedger = {
        runId,
        championIteration: 0,
        championScore: 0,
        championPassRate: 0,
        championHighSeverityCount: 999,
        entries: [],
      };
      const changeLedger: ChangeLedger = { runId, entries: [] };

      let iteration = 1;
      let previousIterationCost = 0;
      const history: IterationSummary[] = [];

      // Refinement Loop
      while (iteration <= this.config.maxIterations) {
        log.step(`━━━ Iteration ${iteration} ━━━`);

        // Step 1: Run Tests (same test plan every iteration)
        const transcripts = await this.testRunner.runTests(currentPrompt, testPlan);

        // Step 2: Rule Validation (code-based)
        log.step('Validating rules...');
        const ruleResults = this.validateRules(transcripts);
        if (ruleResults.violations.length > 0) {
          log.warn(`${ruleResults.violations.length} rule violation(s) detected`);
        } else {
          log.success('Rule validation passed — no violations');
        }

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
        log.step(`Analyzing ${selectedTranscripts.length} transcript(s)...`);
        let analysis: Analysis;
        try {
          analysis = await this.leadAgent.analyzeTranscripts(
            selectedTranscripts,
            transcriptIndex,
            task.requirements,
            this.loadValidationRules()
          );
        } catch (analyzeError) {
          log.error(`Analysis failed (iteration ${iteration}): ${(analyzeError as Error).message} — skipping iteration.`);
          iteration++;
          continue;
        }

        // Calculate delta if previous analysis exists
        if (previousAnalysis) {
          analysis.delta = this.calculateDelta(previousAnalysis, analysis);
        }

        const highSeverityCount = analysis.scenarios
          .flatMap((s) => s.issues)
          .filter((i) => i.severity === 'high').length;

        const mediumSeverityCount = analysis.scenarios
          .flatMap((s) => s.issues)
          .filter((i) => i.severity === 'medium').length;

        // Exclude not_evaluable scenarios from passRate — missing/incomplete data must not penalize
        const evaluableAnalyzed = analysis.scenarios.filter(
          (s) => !('verdict' in s) || (s as any).verdict !== 'not_evaluable'
        );
        const analyzedPassedCount = evaluableAnalyzed.filter((s) => s.passed).length;
        const notEvaluableCount = analysis.scenarios.length - evaluableAnalyzed.length;
        // Unanalyzed scenarios (ran but not in analysis) are assumed passed
        const unanalyzedCount = transcripts.length - analysis.scenarios.length;
        const passedCount = analyzedPassedCount + unanalyzedCount;
        const totalCount = transcripts.length - notEvaluableCount; // exclude not_evaluable from denominator
        const passRate = totalCount > 0 ? passedCount / totalCount : 0;

        log.success(`Analysis complete — Pass rate: ${passedCount}/${totalCount} (${(passRate * 100).toFixed(1)}%) | Quality score: ${(analysis.overallScore * 100).toFixed(1)}%`);
        if (notEvaluableCount > 0) log.detail(`  ${notEvaluableCount} scenario(s) marked not_evaluable (excluded from pass rate)`);
        if (highSeverityCount > 0) {
          log.warn(`${highSeverityCount} high-severity issue(s) | ${mediumSeverityCount} medium-severity issue(s)`);
        } else {
          log.success(`No high-severity issues | ${mediumSeverityCount} medium-severity issue(s)`);
        }

        if (analysis.delta) {
          const delta = analysis.delta;
          const parts: string[] = [];
          if (delta.improvements > 0) parts.push(`↑ ${delta.improvements} improved`);
          if (delta.regressions > 0) parts.push(`↓ ${delta.regressions} regressed`);
          if (delta.unchanged > 0) parts.push(`→ ${delta.unchanged} unchanged`);
          if (parts.length > 0) log.info(`Delta vs previous: ${parts.join(' | ')}`);
        }

        // ── Champion / Challenger Gate ────────────────────────────────────
        const candidateMetrics = { score: analysis.overallScore, passRate, highSeverityCount, mediumSeverityCount };
        const becameChampion = this.isBetterThanChampion(candidateMetrics, championMetrics);

        if (becameChampion) {
          championPrompt = currentPrompt;
          championIteration = iteration;
          championMetrics = candidateMetrics;
          log.success(`NEW CHAMPION — Iteration ${iteration} | Score ${(analysis.overallScore * 100).toFixed(1)}% | PassRate ${(passRate * 100).toFixed(1)}%`);
        } else {
          log.info(`Champion remains iteration ${championIteration} | Score ${(championMetrics.score * 100).toFixed(1)}%`);
        }

        const verdict = this.determineVerdict(becameChampion, candidateMetrics, championMetrics, iteration);
        const promptHash = this.hashContent(currentPrompt);

        const ledgerEntry: PromptLedgerEntry = {
          iteration,
          score: candidateMetrics.score,
          passRate: candidateMetrics.passRate,
          highSeverityCount: candidateMetrics.highSeverityCount,
          mediumSeverityCount: candidateMetrics.mediumSeverityCount,
          verdict,
          isChampion: becameChampion,
          mode: iteration === 1 ? 'restructure' : this.determineMode(championMetrics, iteration - 1),
          promptPath: `iterations/${String(iteration).padStart(2, '0')}/prompt.txt`,
          promptHash,
        };
        promptLedger.entries.push(ledgerEntry);

        if (becameChampion) {
          promptLedger.championIteration = iteration;
          promptLedger.championScore = candidateMetrics.score;
          promptLedger.championPassRate = candidateMetrics.passRate;
          promptLedger.championHighSeverityCount = candidateMetrics.highSeverityCount;
        }

        // Parallel: save ledger + update metadata (independent writes)
        await Promise.all([
          this.storage.savePromptLedger(runId, promptLedger),
          this.storage.updateMetadata(runId, {
            championIteration,
            championScore: championMetrics.score,
            championPassRate: championMetrics.passRate,
          }),
        ]);

        // ── Calculate ChangeImpact for this iteration (if we had a plan) ─
        const existingLedgerEntry = changeLedger.entries.find(e => e.iteration === iteration);
        if (existingLedgerEntry?.plan) {
          // Build per-scenario delta evidence so the refiner can attribute
          // which specific scenarios improved or regressed after each change.
          const scenarioDeltaLines: string[] = analysis.scenarios.map((s) => {
            const prev = previousAnalysis?.scenarios.find(p => p.scenarioId === s.scenarioId);
            if (!prev) return `${s.scenarioId}: new (${s.passed ? 'pass' : 'fail'}, issues: ${s.issues.length})`;
            const passChange = s.passed !== prev.passed
              ? (s.passed ? ' PASS←fail' : ' FAIL←pass')
              : ` ${s.passed ? 'pass' : 'fail'}`;
            const issueChange = s.issues.length - prev.issues.length;
            const issueStr = issueChange === 0 ? `issues: ${s.issues.length}` : `issues: ${prev.issues.length}→${s.issues.length} (${issueChange > 0 ? '+' : ''}${issueChange})`;
            const highChange = s.issues.filter(i => i.severity === 'high').length;
            return `${s.scenarioId}:${passChange}, ${issueStr}${highChange > 0 ? `, ${highChange} high` : ''}`;
          });
          const scoreChange = previousAnalysis
            ? ` | score: ${(previousAnalysis.overallScore * 100).toFixed(0)}%→${(analysis.overallScore * 100).toFixed(0)}%`
            : '';
          const scenarioEvidence = scenarioDeltaLines.join('; ') + scoreChange;

          // Determine per-change verdict based on overall outcome
          const overallVerdict: 'improvement' | 'regression' | 'neutral' = becameChampion
            ? 'improvement'
            : (analysis.overallScore < (previousAnalysis?.overallScore ?? championMetrics.score) ? 'regression' : 'neutral');

          const impact: ChangeImpact = {
            iteration,
            newScore: analysis.overallScore,
            newPassRate: passRate,
            newHighSeverityCount: highSeverityCount,
            previousChampionScore: championMetrics.score,
            becameChampion,
            overallVerdict,
            changeImpacts: existingLedgerEntry.plan.plannedChanges.map(c => ({
              changeId: c.id,
              verdict: overallVerdict === 'improvement' ? 'helped' as const
                : overallVerdict === 'regression' ? 'hurt' as const
                : 'neutral' as const,
              evidence: scenarioEvidence,
            })),
          };
          existingLedgerEntry.impact = impact;
          // Parallel: save impact + updated ledger (independent writes)
          await Promise.all([
            this.storage.saveChangeImpact(runId, iteration, impact),
            this.storage.saveChangeLedger(runId, changeLedger),
          ]);
        }

        // Update testQualityObservations if provided by analyzer
        if ((analysis as any).testQualityObservations) {
          const obs = (analysis as any).testQualityObservations;
          await this.storage.updateTestAssetQuality(runId, { iteration, ...obs }).catch(() => {});
        }

        // Create summary — combine LeadAgent + TestRunner costs
        const iterCostBefore = previousIterationCost;
        const iterCostAfter  = this.leadAgent.getTotalCost() + this.testRunner.getTotalCost();
        previousIterationCost = iterCostAfter;

        const summary: IterationSummary = {
          iteration,
          passRate,
          qualityScore: analysis.overallScore,
          passedCount,
          totalCount,
          highSeverityCount,
          mediumSeverityCount,
          mainIssues: analysis.scenarios
            .flatMap((s) => s.issues.filter((i) => i.severity === 'high'))
            .map((i) => `${i.category}: ${i.description}`)
            .slice(0, 3),
          changesApplied: iteration === 1 ? [] : ['Refined based on analysis'],
          cost: iterCostAfter,
          iterationCost: iterCostAfter - iterCostBefore,
          delta: analysis.delta
            ? {
                improvements: analysis.delta.improvements,
                regressions: analysis.delta.regressions,
                unchanged: analysis.delta.unchanged,
              }
            : undefined,
          isChampion: becameChampion,
          verdict,
          mode: ledgerEntry.mode,
        };

        // Save iteration data
        const changePlanForIter = await this.storage.loadChangePlan(runId, iteration);
        const changeImpactForIter = existingLedgerEntry?.impact;
        const iterData: IterationData = {
          prompt: currentPrompt,
          testDriverPrompt: this.config.instructions.testDriver || undefined,
          testPlan: iteration === 1 ? testPlan : undefined,
          transcripts,
          transcriptIndex,
          ruleValidation: ruleResults,
          llmAnalysis: analysis,
          summary,
          changePlan: changePlanForIter ?? undefined,
          changeImpact: changeImpactForIter,
          isChampion: becameChampion,
          verdict,
        };

        await this.storage.saveIteration(runId, iteration, iterData);

        // Step 7a: Check for user stop/pause signals
        const stopSignal  = path.join(this.dataDir, 'runs', runId, 'stop.signal');
        const pauseSignal = path.join(this.dataDir, 'runs', runId, 'pause.signal');

        const userStopped = await fs.access(stopSignal).then(() => true).catch(() => false)
          || this.testRunner.wasStoppedByUser();
        if (userStopped) {
          log.warn('Stop signal received — stopping after current iteration.');
          try { await fs.unlink(stopSignal); } catch {}
          this.testRunner.clearStopFlag();
          await log.flush();
          return this.finalize(runId, currentPrompt, 'stopped', analysis.overallScore, startTime);
        }

        // Manual mode: auto-write pause signal after each iteration
        if (manualMode) {
          log.info('Manual mode — pausing. Click Continue in UI to proceed.');
          await fs.writeFile(pauseSignal, new Date().toISOString());
        }

        // Pause: poll every 5s until pause signal is gone (manual or manual user)
        const paused = await fs.access(pauseSignal).then(() => true).catch(() => false);
        if (paused) {
          if (!manualMode) log.info('Pause signal received — waiting for resume...');
          while (true) {
            await new Promise(r => setTimeout(r, 5000));
            const stillPaused = await fs.access(pauseSignal).then(() => true).catch(() => false);
            if (!stillPaused) break;
            // Check stop signal during pause
            const stoppedDuringPause = await fs.access(stopSignal).then(() => true).catch(() => false);
            if (stoppedDuringPause) {
              try { await fs.unlink(stopSignal); } catch {}
              this.testRunner.clearStopFlag();
              await log.flush();
              return this.finalize(runId, currentPrompt, 'stopped', analysis.overallScore, startTime);
            }
          }
          log.info('Resumed.');
        }

        // Step 7b: Check Stop Conditions (pass corrected totals + iteration number)
        const shouldStop = this.checkStopConditions(analysis, history, passedCount, totalCount, iteration);

        if (shouldStop.stop) {
          log.success(`Stop condition met: ${shouldStop.reason}`);
          await log.flush();
          return this.finalize(
            runId,
            currentPrompt,
            'success',
            analysis.overallScore,
            startTime
          );
        }

        if (highSeverityCount > 0) {
          log.warn('High severity issues remain — continuing refinement...');
        }

        // Step 8: Read fresh human feedback (if user added/updated it mid-run)
        const feedbackPath = path.join(this.dataDir, 'runs', runId, 'human_feedback.txt');
        const latestFeedback = await fs.readFile(feedbackPath, 'utf-8').catch(() => '');
        if (latestFeedback.trim()) {
          log.info('Injecting human feedback into refine context...');
          // Inject into analysis suggestions so refiner sees it prominently
          analysis.generalSuggestions = [
            `HUMAN FEEDBACK (priority): ${latestFeedback.trim()}`,
            ...analysis.generalSuggestions,
          ];
        }

        // Step 9: Refine Prompt
        log.step(`Refining prompt (mode: ${this.determineMode(championMetrics, iteration)})...`);
        const nextIteration = iteration + 1;
        const mode = this.determineMode(championMetrics, iteration);
        const previousChangePlan = changeLedger.entries.length > 0
          ? changeLedger.entries[changeLedger.entries.length - 1]?.plan
          : undefined;

        const context = this.buildContext(
          history,
          transcriptIndex,
          analysis,
          transcripts,
          championPrompt,
          currentPrompt,
          championIteration,
          championMetrics,
          promptLedger,
          changeLedger,
          mode,
          previousChangePlan,
          guidelinesContext,
          uploadedFilePaths,
        );

        let refinedPrompt: string;
        let changes: string[];
        try {
          const refineResult = await this.leadAgent.refinePrompt(
            championPrompt,
            currentPrompt,
            analysis,
            context
          );

          refinedPrompt = refineResult.refinedPrompt;
          changes = refineResult.changes;

          log.success(`Refined prompt ready (${refinedPrompt.length} chars, mode: ${mode})`);
          changes.forEach((change) => log.detail(`  • ${change}`));

          // Save changePlan for the NEXT iteration (before it's tested)
          if (refineResult.changePlan) {
            const nextPlan: ChangePlan = {
              ...refineResult.changePlan,
              iteration: nextIteration,
            };
            const newLedgerEntry: ChangeLedgerEntry = { iteration: nextIteration, plan: nextPlan };
            changeLedger.entries.push(newLedgerEntry);
            // Parallel: save plan + updated ledger (independent writes)
            await Promise.all([
              this.storage.saveChangePlan(runId, nextIteration, nextPlan),
              this.storage.saveChangeLedger(runId, changeLedger),
            ]);
          }
        } catch (refineError) {
          log.error(`Refinement failed (iteration ${iteration}): ${(refineError as Error).message} — keeping current prompt for next iteration.`);
          refinedPrompt = currentPrompt;
          changes = [];
        }

        // Update summary with changes
        summary.changesApplied = changes;
        history.push(summary);

        currentPrompt = refinedPrompt;
        iteration++;
      }

      // Max iterations reached
      log.warn('Max iterations reached');
      await log.flush();
      return this.finalize(
        runId,
        currentPrompt,
        'max_iterations',
        history[history.length - 1]?.passRate || 0,
        startTime
      );
    } catch (error) {
      if (this.logger) {
        this.logger.error(`Run failed: ${(error as Error).message}`);
        await this.logger.flush();
      } else {
        console.error(`Run failed: ${(error as Error).message}`);
      }
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
      this.logger?.detail(`Min iterations gate: ${completedIterations}/${minIterations} done — continuing.`);
      return { stop: false };
    }

    const allIssues = analysis.scenarios.flatMap((s) => s.issues);
    const highCount   = allIssues.filter((i) => i.severity === 'high').length;
    const mediumCount = allIssues.filter((i) => i.severity === 'medium').length;

    // Gate 1: Any high severity issues → keep refining
    if (highCount > 0) {
      this.logger?.detail(`${highCount} high-severity issue(s) remain — continuing.`);
      return { stop: false };
    }

    // Gate 2: Any medium severity issues → keep refining
    if (mediumCount > 0) {
      this.logger?.detail(`${mediumCount} medium-severity issue(s) remain — continuing.`);
      return { stop: false };
    }

    // Gate 3: Quality score must reach the threshold (default 90%)
    if (analysis.overallScore < minQualityScore) {
      this.logger?.detail(`Quality ${(analysis.overallScore * 100).toFixed(1)}% < ${(minQualityScore * 100).toFixed(1)}% threshold — continuing.`);
      return { stop: false };
    }

    // All gates passed — analyzer has only low/no issues AND high quality score
    const score = (analysis.overallScore * 100).toFixed(1);
    this.logger?.success(`Stop conditions met: quality ${score}%, 0 high, 0 medium issues.`);
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
   * Build enriched context for refining
   */
  private buildContext(
    history: IterationSummary[],
    transcriptIndex: TranscriptIndex,
    analysis: Analysis,
    allTranscripts: Transcript[],
    championPrompt: string,
    currentCandidatePrompt: string,
    championIteration: number,
    championMetrics: { score: number; passRate: number; highSeverityCount: number; mediumSeverityCount: number },
    promptLedger: PromptLedger,
    changeLedger: ChangeLedger,
    mode: RefinementMode,
    previousCandidateChangePlan?: ChangePlan,
    guidelinesContext?: string,
    uploadedFilePaths?: Array<{ filename: string; path: string }>,
  ): IterationContext {
    // Get failed transcripts from index
    const failedIds = transcriptIndex.scenarios
      .filter((s) => !s.passed || s.hasHighSeverity)
      .map((s) => s.scenarioId)
      .slice(0, 3);

    const failedTranscripts = allTranscripts.filter((t) =>
      failedIds.includes(t.scenarioId)
    );

    // Get passed sample (up to 2)
    const passedIds = transcriptIndex.scenarios
      .filter((s) => s.passed && !s.hasHighSeverity)
      .map((s) => s.scenarioId)
      .slice(0, 2);

    const passedSample = allTranscripts.filter((t) =>
      passedIds.includes(t.scenarioId)
    );

    return {
      currentAnalysis: analysis,
      transcriptIndex,
      previousSummaries: history, // full history, not just last 2
      failedTranscripts,
      passedSample,
      championPrompt,
      candidatePrompt: currentCandidatePrompt,
      championIteration,
      championScore: championMetrics.score,
      championPassRate: championMetrics.passRate,
      championHighSeverityCount: championMetrics.highSeverityCount,
      promptLedger: promptLedger.entries,
      changeLedger: changeLedger.entries,
      refinementMode: mode,
      previousCandidateChangePlan,
      guidelinesContext,
      uploadedFilePaths,
    };
  }

  /**
   * Champion/Challenger composite comparison
   */
  private isBetterThanChampion(
    candidate: { score: number; passRate: number; highSeverityCount: number; mediumSeverityCount: number },
    champion: { score: number; passRate: number; highSeverityCount: number; mediumSeverityCount: number }
  ): boolean {
    // Level 1: fewer high severity issues always wins
    if (candidate.highSeverityCount < champion.highSeverityCount) return true;
    if (candidate.highSeverityCount > champion.highSeverityCount) return false;

    // Level 2: at equal high severity - higher pass rate (>5% delta is significant)
    const passDelta = candidate.passRate - champion.passRate;
    if (Math.abs(passDelta) > 0.05) return passDelta > 0;

    // Level 3: at close pass rate - higher overall score
    return candidate.score > champion.score;
  }

  /**
   * Determine refinement mode based on champion metrics and iteration
   */
  private determineMode(
    championMetrics: { score: number; highSeverityCount: number },
    iteration: number
  ): RefinementMode {
    const r = (this.config as any).refinement ?? {};
    const earlyIterations = r.earlyIterations ?? 2;
    const restructureBelow = r.restructureBelow ?? 0.65;
    const restructureAboveHighSeverity = r.restructureAboveHighSeverity ?? 3;

    if (
      iteration <= earlyIterations ||
      championMetrics.score < restructureBelow ||
      championMetrics.highSeverityCount >= restructureAboveHighSeverity
    ) {
      return 'restructure';
    }
    return 'surgical';
  }

  /**
   * Determine prompt verdict
   */
  private determineVerdict(
    becameChampion: boolean,
    candidateMetrics: { score: number; passRate: number; highSeverityCount: number },
    championMetrics: { score: number; passRate: number; highSeverityCount: number },
    iteration: number
  ): PromptVerdict {
    if (iteration === 1) return 'baseline';
    if (becameChampion) return 'best_so_far';
    if (candidateMetrics.score < championMetrics.score - 0.05) return 'regression';
    if (candidateMetrics.score > championMetrics.score) return 'improvement';
    return 'rejected';
  }

  /**
   * Hash content (sha1) for quick diff detection
   */
  private hashContent(content: string): string {
    return crypto.createHash('sha1').update(content).digest('hex');
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
    _index: TranscriptIndex
  ): Transcript[] {
    // Always analyze all transcripts so the LLM evaluates every scenario's
    // quality — not just those with rule violations. This prevents unanalyzed
    // scenarios from being incorrectly "assumed passed" and gives the refiner
    // accurate per-scenario feedback to learn from.
    return allTranscripts;
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
    const totalCost = this.leadAgent.getTotalCost() + this.testRunner.getTotalCost();
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

    this.logger?.step(`━━━ Run Complete ━━━`);
    this.logger?.success(status === 'success' ? 'Finished: success' : status === 'stopped' ? 'Finished: stopped by user' : 'Finished: max iterations reached');
    this.logger?.info(`Final score: ${(finalScore * 100).toFixed(1)}%`);
    this.logger?.info(`Total cost: $${totalCost.toFixed(2)}`);
    this.logger?.info(`Duration: ${Math.floor(duration / 1000 / 60)}m ${Math.floor((duration / 1000) % 60)}s`);

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
      this.logger?.warn(`Cost warning: $${currentCost.toFixed(2)} (${percentage}% of budget)`);
    }
  }
}
