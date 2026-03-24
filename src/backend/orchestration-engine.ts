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
  BehavioralMetrics,
  CrossRunHistoryEntry,
  OscillationWarning,
  UNIVERSAL_SECTIONS,
  ROLEPLAY_EXTENSION_SECTIONS,
  UNIVERSAL_DIMENSIONS,
  RunStatus,
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
    RunStorage.registerActiveRun(runId, this.dataDir);
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

      // Phase 1c: Load cross-run insights separately (only for Refiner)
      let crossRunInsights = '';
      try {
        const insightsPath = path.join(this.dataDir, 'insights', this._orchestratorId, 'accumulated_insights.md');
        crossRunInsights = await fs.readFile(insightsPath, 'utf-8');
        log.success(`Loaded cross-run insights for ${this._orchestratorId}`);
      } catch {
        // No insights yet — first run
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
      let championDimProfile: Record<string, number> | undefined;
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
          const taskDesc = [task.name, task.description, task.requirements?.role ? `Role: ${task.requirements.role}` : ''].filter(Boolean).join('\n');
          analysis = await this.leadAgent.analyzeTranscripts(
            selectedTranscripts,
            transcriptIndex,
            task.requirements,
            this.loadValidationRules(),
            currentPrompt,
            taskDesc,
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

        // ── Dimension Profile ───────────────────────────────────────────
        const candidateDimProfile = this.computeDimensionProfile(analysis);

        // ── Champion / Challenger Gate ────────────────────────────────────
        const candidateMetrics = { score: analysis.overallScore, passRate, highSeverityCount, mediumSeverityCount };
        const becameChampion = this.isBetterThanChampion(
          candidateMetrics, championMetrics, candidateDimProfile, championDimProfile
        );

        if (becameChampion) {
          championPrompt = currentPrompt;
          championIteration = iteration;
          championMetrics = candidateMetrics;
          championDimProfile = candidateDimProfile;
          log.success(`NEW CHAMPION — Iteration ${iteration} | Score ${(analysis.overallScore * 100).toFixed(1)}% | PassRate ${(passRate * 100).toFixed(1)}%`);
        } else {
          log.info(`Champion remains iteration ${championIteration} | Score ${(championMetrics.score * 100).toFixed(1)}%`);
          if (championMetrics.passRate >= 1.0) {
            currentPrompt = championPrompt;
            log.detail('Champion has 100% passRate — reverting to champion prompt for next refinement.');
          }
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
          mode: iteration === 1 ? 'restructure' : this.determineMode(championMetrics, iteration - 1, promptLedger.entries),
          promptPath: `iterations/${String(iteration).padStart(2, '0')}/prompt.txt`,
          promptHash,
          dimensionProfile: candidateDimProfile,
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

          // Compute dimension deltas per change if profiles available
          const prevProfile = promptLedger.entries.at(-2)?.dimensionProfile;
          const changeCount = existingLedgerEntry.plan.plannedChanges.length;
          const attributionMode = changeCount === 1 ? 'direct' as const
            : changeCount <= 2 ? 'likely' as const
            : changeCount <= 3 ? 'mixed' as const
            : 'unclear' as const;

          const impact: ChangeImpact = {
            iteration,
            newScore: analysis.overallScore,
            newPassRate: passRate,
            newHighSeverityCount: highSeverityCount,
            previousChampionScore: championMetrics.score,
            becameChampion,
            overallVerdict,
            changeImpacts: existingLedgerEntry.plan.plannedChanges.map(c => {
              let dimensionDeltas: Record<string, { before: number; after: number; delta: number }> | undefined;
              if (prevProfile && candidateDimProfile) {
                dimensionDeltas = {};
                const allDims = new Set([...Object.keys(prevProfile), ...Object.keys(candidateDimProfile)]);
                for (const dim of allDims) {
                  const before = prevProfile[dim] ?? 0;
                  const after = candidateDimProfile[dim] ?? 0;
                  if (before !== after) {
                    dimensionDeltas[dim] = { before, after, delta: Math.round((after - before) * 100) / 100 };
                  }
                }
              }
              return {
                changeId: c.id,
                verdict: overallVerdict === 'improvement' ? 'helped' as const
                  : overallVerdict === 'regression' ? 'hurt' as const
                  : 'neutral' as const,
                evidence: scenarioEvidence,
                attributionMode,
                dimensionDeltas,
              };
            }),
            dimensionProfile: candidateDimProfile,
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
          dimensionProfile: candidateDimProfile,
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
          return this.finalize(runId, currentPrompt, 'stopped', analysis.overallScore, startTime, changeLedger, history, championMetrics);
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
              return this.finalize(runId, currentPrompt, 'stopped', analysis.overallScore, startTime, changeLedger, history, championMetrics);
            }
          }
          log.info('Resumed.');
        }

        // Step 7b: Check Stop Conditions (pass corrected totals + iteration number + champion)
        const shouldStop = this.checkStopConditions(analysis, history, passedCount, totalCount, iteration, championIteration);

        if (shouldStop.stop) {
          log.success(`Stop condition met: ${shouldStop.reason}`);
          await log.flush();
          return this.finalize(
            runId,
            currentPrompt,
            'success',
            analysis.overallScore,
            startTime,
            changeLedger,
            history,
            championMetrics,
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
        log.step(`Refining prompt (mode: ${this.determineMode(championMetrics, iteration, promptLedger.entries)})...`);
        const nextIteration = iteration + 1;
        const mode = this.determineMode(championMetrics, iteration, promptLedger.entries);
        const previousChangePlan = changeLedger.entries.length > 0
          ? changeLedger.entries[changeLedger.entries.length - 1]?.plan
          : undefined;

        const context = await this.buildContext(
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
          iteration,
          previousChangePlan,
          guidelinesContext,
          uploadedFilePaths,
          task,
          uploadedFilesContext,
          crossRunInsights,
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
        startTime,
        changeLedger,
        history,
        championMetrics,
      );
    } catch (error) {
      if (this.logger) {
        this.logger.error(`Run failed: ${(error as Error).message}`);
        await this.logger.flush();
      } else {
        console.error(`Run failed: ${(error as Error).message}`);
      }
      await this.storage.updateMetadata(runId, { status: 'error' });
      RunStorage.unregisterActiveRun(runId, this.dataDir);
      throw error;
    }
  }

  /**
   * Resume a completed/stopped run with additional iterations.
   * Loads all state from disk and continues the refinement loop.
   */
  async resumeRun(runId: string, additionalIterations: number): Promise<RunResult> {
    const startTime = Date.now();
    RunStorage.registerActiveRun(runId, this.dataDir);
    this.logger = new RunLogger(this.dataDir, runId);
    const log = this.logger;
    this.testRunner.setLogger(log);
    this.leadAgent.setLogger(log);

    await log.flush();
    log.step(`Resuming run with ${additionalIterations} additional iterations`);

    try {
      const metadata = await this.storage.loadMetadata(runId);
      const runDir = path.join(this.dataDir, 'runs', runId);

      // Load task
      const task: Task = JSON.parse(await fs.readFile(path.join(runDir, 'task.json'), 'utf-8'));

      // Load uploaded files
      let uploadedFilesContext = '';
      let uploadedFilePaths: Array<{ filename: string; path: string }> = [];
      if (metadata.uploadId) {
        const uploadPath = path.join(this.dataDir, 'uploads', metadata.uploadId);
        try {
          const files = await fs.readdir(uploadPath);
          const filePaths = files.map((f) => path.join(uploadPath, f));
          const parsedFiles = await FileParser.parseFiles(filePaths);
          uploadedFilesContext = FileParser.formatForContext(parsedFiles);
          uploadedFilePaths = files.map((f) => ({ filename: f, path: path.join(uploadPath, f) }));
          log.success(`Loaded ${parsedFiles.length} reference file(s)`);
        } catch (error) {
          log.warn(`Failed to load uploaded files: ${(error as Error).message}`);
        }
      }

      // Load guidelines
      let guidelinesContext = '';
      const guidelinesDir = path.join(this.dataDir, 'guidelines', this._orchestratorId);
      try {
        const guideFiles = (await fs.readdir(guidelinesDir).catch(() => []))
          .filter((f) => f.endsWith('.txt') || f.endsWith('.md')).sort();
        if (guideFiles.length > 0) {
          const parts = await Promise.all(guideFiles.map((f) => fs.readFile(path.join(guidelinesDir, f), 'utf-8')));
          guidelinesContext = parts.join('\n\n');
        }
      } catch { /* optional */ }

      // Load cross-run insights
      let crossRunInsights = '';
      try {
        const insightsPath = path.join(this.dataDir, 'insights', this._orchestratorId, 'accumulated_insights.md');
        crossRunInsights = await fs.readFile(insightsPath, 'utf-8');
      } catch { /* none yet */ }

      // Load test plan from disk (reuse same scenarios)
      const testPlan: import('./types').TestPlan = JSON.parse(
        await fs.readFile(path.join(runDir, 'test_plan.json'), 'utf-8')
      );
      log.success(`Loaded existing test plan (${testPlan.scenarios.length} scenarios)`);

      // Load ledgers
      const prevLedger = await this.storage.loadPromptLedger(runId);
      const prevChangeLedger = await this.storage.loadChangeLedger(runId);

      const promptLedger: PromptLedger = prevLedger ?? {
        runId, championIteration: 0, championScore: 0, championPassRate: 0, championHighSeverityCount: 999, entries: [],
      };
      const changeLedger: ChangeLedger = prevChangeLedger ?? { runId, entries: [] };

      // Restore champion state
      let championIteration = promptLedger.championIteration;
      let championMetrics = {
        score: promptLedger.championScore,
        passRate: promptLedger.championPassRate,
        highSeverityCount: promptLedger.championHighSeverityCount,
        mediumSeverityCount: 999,
      };

      // Load champion prompt from its iteration directory
      let championPrompt: string;
      if (championIteration > 0) {
        const champIterDir = path.join(runDir, 'iterations', String(championIteration).padStart(2, '0'));
        championPrompt = await fs.readFile(path.join(champIterDir, 'prompt.txt'), 'utf-8');
      } else {
        championPrompt = await fs.readFile(path.join(runDir, 'final_prompt.txt'), 'utf-8');
      }

      // Load current prompt (from last iteration — may differ from champion)
      const lastIter = metadata.currentIteration;
      const lastIterDir = path.join(runDir, 'iterations', String(lastIter).padStart(2, '0'));
      let currentPrompt: string;
      try {
        currentPrompt = await fs.readFile(path.join(lastIterDir, 'prompt.txt'), 'utf-8');
      } catch {
        currentPrompt = championPrompt;
      }

      // If champion had 100% passRate, start from champion (same logic as main loop)
      if (championMetrics.passRate >= 1.0) {
        currentPrompt = championPrompt;
        log.detail('Champion has 100% passRate — starting from champion prompt.');
      }

      // Load champion dimension profile from ledger
      let championDimProfile: Record<string, number> | undefined;
      const champEntry = promptLedger.entries.find(e => e.iteration === championIteration);
      if (champEntry?.dimensionProfile) {
        championDimProfile = champEntry.dimensionProfile;
      }

      // Rebuild history from iteration summaries on disk
      const history: IterationSummary[] = [];
      const itersDir = path.join(runDir, 'iterations');
      const iterDirs = (await fs.readdir(itersDir).catch(() => [])).sort();
      for (const dir of iterDirs) {
        try {
          const summaryData = await fs.readFile(path.join(itersDir, dir, 'llm_analysis.json'), 'utf-8');
          const analysis = JSON.parse(summaryData);
          const ledgerEntry = promptLedger.entries.find(e => e.iteration === parseInt(dir, 10));
          history.push({
            iteration: parseInt(dir, 10),
            passRate: ledgerEntry?.passRate ?? 0,
            qualityScore: ledgerEntry?.score ?? analysis.overallScore ?? 0,
            passedCount: 0,
            totalCount: testPlan.scenarios.length,
            highSeverityCount: ledgerEntry?.highSeverityCount ?? 0,
            mediumSeverityCount: ledgerEntry?.mediumSeverityCount ?? 0,
            mainIssues: [],
            changesApplied: [],
            cost: 0,
            iterationCost: 0,
            isChampion: ledgerEntry?.isChampion ?? false,
            verdict: ledgerEntry?.verdict ?? 'baseline',
            mode: ledgerEntry?.mode ?? 'surgical',
          });
        } catch { /* skip unreadable */ }
      }

      // Calculate new maxIterations
      const newMaxIteration = lastIter + additionalIterations;
      let iteration = lastIter + 1;
      let previousIterationCost = 0;

      // Update metadata
      await this.storage.updateMetadata(runId, {
        status: 'running' as RunStatus,
        completedAt: undefined,
      } as any);
      // Store new maxIterations in config override for the loop
      const effectiveMaxIterations = newMaxIteration;

      // Setup stop signal
      const stopSignalPath = path.join(runDir, 'stop.signal');
      this.testRunner.clearStopFlag();
      this.testRunner.setStopSignalPath(stopSignalPath);

      // Load human feedback
      const feedbackPath = path.join(runDir, 'human_feedback.txt');
      const humanFeedback = await fs.readFile(feedbackPath, 'utf-8').catch(() => '');
      if (humanFeedback.trim()) {
        log.info('Human feedback available — will inject into refinement context');
      }

      // Load test asset meta
      let testAssetMeta: TestAssetMeta | undefined;
      try {
        const tamRaw = await fs.readFile(path.join(runDir, 'test_asset_meta.json'), 'utf-8');
        testAssetMeta = JSON.parse(tamRaw);
      } catch { /* not critical */ }

      const manualMode = !!(metadata as any).manualMode;

      log.success(`Resuming from iteration ${iteration} (champion: iter ${championIteration}, score ${(championMetrics.score * 100).toFixed(1)}%)`);

      // ═══ Refinement Loop (same as main cycle) ═══
      while (iteration <= effectiveMaxIterations) {
        log.step(`━━━ Iteration ${iteration} ━━━`);

        const transcripts = await this.testRunner.runTests(currentPrompt, testPlan);

        log.step('Validating rules...');
        const ruleResults = this.validateRules(transcripts);
        if (ruleResults.violations.length > 0) {
          log.warn(`${ruleResults.violations.length} rule violation(s) detected`);
        } else {
          log.success('Rule validation passed — no violations');
        }

        const transcriptIndex = this.generateTranscriptIndex(transcripts, ruleResults);
        const selectedTranscripts = this.selectTranscriptsForAnalysis(transcripts, transcriptIndex);

        let previousAnalysis: Analysis | null = null;
        if (iteration > 1) {
          try {
            const prevIterPath = path.join(runDir, 'iterations', (iteration - 1).toString().padStart(2, '0'), 'llm_analysis.json');
            previousAnalysis = JSON.parse(await fs.readFile(prevIterPath, 'utf-8'));
          } catch { /* no previous */ }
        }

        log.step(`Analyzing ${selectedTranscripts.length} transcript(s)...`);
        let analysis: Analysis;
        try {
          const taskDesc = [task.name, task.description, task.requirements?.role ? `Role: ${task.requirements.role}` : ''].filter(Boolean).join('\n');
          analysis = await this.leadAgent.analyzeTranscripts(selectedTranscripts, transcriptIndex, task.requirements, this.loadValidationRules(), currentPrompt, taskDesc);
        } catch (analyzeError) {
          log.error(`Analysis failed (iteration ${iteration}): ${(analyzeError as Error).message} — skipping.`);
          iteration++;
          continue;
        }

        if (previousAnalysis) {
          analysis.delta = this.calculateDelta(previousAnalysis, analysis);
        }

        const highSeverityCount = analysis.scenarios.flatMap((s) => s.issues).filter((i) => i.severity === 'high').length;
        const mediumSeverityCount = analysis.scenarios.flatMap((s) => s.issues).filter((i) => i.severity === 'medium').length;

        const evaluableAnalyzed = analysis.scenarios.filter((s) => !('verdict' in s) || (s as any).verdict !== 'not_evaluable');
        const analyzedPassedCount = evaluableAnalyzed.filter((s) => s.passed).length;
        const notEvaluableCount = analysis.scenarios.length - evaluableAnalyzed.length;
        const unanalyzedCount = transcripts.length - analysis.scenarios.length;
        const passedCount = analyzedPassedCount + unanalyzedCount;
        const totalCount = transcripts.length - notEvaluableCount;
        const passRate = totalCount > 0 ? passedCount / totalCount : 0;

        log.success(`Analysis complete — Pass rate: ${passedCount}/${totalCount} (${(passRate * 100).toFixed(1)}%) | Quality score: ${(analysis.overallScore * 100).toFixed(1)}%`);
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

        const candidateDimProfile = this.computeDimensionProfile(analysis);
        const candidateMetrics = { score: analysis.overallScore, passRate, highSeverityCount, mediumSeverityCount };
        const becameChampion = this.isBetterThanChampion(candidateMetrics, championMetrics, candidateDimProfile, championDimProfile);

        if (becameChampion) {
          championPrompt = currentPrompt;
          championIteration = iteration;
          championMetrics = candidateMetrics;
          championDimProfile = candidateDimProfile;
          log.success(`NEW CHAMPION — Iteration ${iteration} | Score ${(analysis.overallScore * 100).toFixed(1)}% | PassRate ${(passRate * 100).toFixed(1)}%`);
        } else {
          log.info(`Champion remains iteration ${championIteration} | Score ${(championMetrics.score * 100).toFixed(1)}%`);
          if (championMetrics.passRate >= 1.0) {
            currentPrompt = championPrompt;
            log.detail('Champion has 100% passRate — reverting to champion prompt for next refinement.');
          }
        }

        const verdict = this.determineVerdict(becameChampion, candidateMetrics, championMetrics, iteration);
        const promptHash = this.hashContent(currentPrompt);

        const ledgerEntry: PromptLedgerEntry = {
          iteration, score: candidateMetrics.score, passRate: candidateMetrics.passRate,
          highSeverityCount: candidateMetrics.highSeverityCount, mediumSeverityCount: candidateMetrics.mediumSeverityCount,
          verdict, isChampion: becameChampion,
          mode: this.determineMode(championMetrics, iteration - 1, promptLedger.entries),
          promptPath: `iterations/${String(iteration).padStart(2, '0')}/prompt.txt`,
          promptHash, dimensionProfile: candidateDimProfile,
        };
        promptLedger.entries.push(ledgerEntry);

        if (becameChampion) {
          promptLedger.championIteration = iteration;
          promptLedger.championScore = candidateMetrics.score;
          promptLedger.championPassRate = candidateMetrics.passRate;
          promptLedger.championHighSeverityCount = candidateMetrics.highSeverityCount;
        }

        await Promise.all([
          this.storage.savePromptLedger(runId, promptLedger),
          this.storage.updateMetadata(runId, { championIteration, championScore: championMetrics.score, championPassRate: championMetrics.passRate }),
        ]);

        // ChangeImpact
        const existingLedgerEntry = changeLedger.entries.find(e => e.iteration === iteration);
        if (existingLedgerEntry?.plan) {
          const scenarioDeltaLines: string[] = analysis.scenarios.map((s) => {
            const prev = previousAnalysis?.scenarios.find(p => p.scenarioId === s.scenarioId);
            if (!prev) return `${s.scenarioId}: new (${s.passed ? 'pass' : 'fail'}, issues: ${s.issues.length})`;
            const passChange = s.passed !== prev.passed ? (s.passed ? ' PASS←fail' : ' FAIL←pass') : ` ${s.passed ? 'pass' : 'fail'}`;
            const issueChange = s.issues.length - prev.issues.length;
            const issueStr = issueChange === 0 ? `issues: ${s.issues.length}` : `issues: ${prev.issues.length}→${s.issues.length} (${issueChange > 0 ? '+' : ''}${issueChange})`;
            return `${s.scenarioId}:${passChange}, ${issueStr}`;
          });
          const scoreChange = previousAnalysis ? ` | score: ${(previousAnalysis.overallScore * 100).toFixed(0)}%→${(analysis.overallScore * 100).toFixed(0)}%` : '';
          const scenarioEvidence = scenarioDeltaLines.join('; ') + scoreChange;
          const overallVerdict: 'improvement' | 'regression' | 'neutral' = becameChampion ? 'improvement'
            : (analysis.overallScore < (previousAnalysis?.overallScore ?? championMetrics.score) ? 'regression' : 'neutral');
          const prevProfile = promptLedger.entries.at(-2)?.dimensionProfile;
          const changeCount = existingLedgerEntry.plan.plannedChanges.length;
          const attributionMode = changeCount === 1 ? 'direct' as const : changeCount <= 2 ? 'likely' as const : changeCount <= 3 ? 'mixed' as const : 'unclear' as const;
          const impact: ChangeImpact = {
            iteration, newScore: analysis.overallScore, newPassRate: passRate, newHighSeverityCount: highSeverityCount,
            previousChampionScore: championMetrics.score, becameChampion, overallVerdict,
            changeImpacts: existingLedgerEntry.plan.plannedChanges.map(c => {
              let dimensionDeltas: Record<string, { before: number; after: number; delta: number }> | undefined;
              if (prevProfile && candidateDimProfile) {
                dimensionDeltas = {};
                for (const dim of new Set([...Object.keys(prevProfile), ...Object.keys(candidateDimProfile)])) {
                  const before = prevProfile[dim] ?? 0; const after = candidateDimProfile[dim] ?? 0;
                  if (before !== after) dimensionDeltas[dim] = { before, after, delta: Math.round((after - before) * 100) / 100 };
                }
              }
              return { changeId: c.id, verdict: overallVerdict === 'improvement' ? 'helped' as const : overallVerdict === 'regression' ? 'hurt' as const : 'neutral' as const, evidence: scenarioEvidence, attributionMode, dimensionDeltas };
            }),
            dimensionProfile: candidateDimProfile,
          };
          existingLedgerEntry.impact = impact;
          await Promise.all([this.storage.saveChangeImpact(runId, iteration, impact), this.storage.saveChangeLedger(runId, changeLedger)]);
        }

        if ((analysis as any).testQualityObservations) {
          const obs = (analysis as any).testQualityObservations;
          await this.storage.updateTestAssetQuality(runId, { iteration, ...obs }).catch(() => {});
        }

        const iterCostBefore = previousIterationCost;
        const iterCostAfter = this.leadAgent.getTotalCost() + this.testRunner.getTotalCost();
        previousIterationCost = iterCostAfter;

        const summary: IterationSummary = {
          iteration, passRate, qualityScore: analysis.overallScore, passedCount, totalCount,
          highSeverityCount, mediumSeverityCount,
          mainIssues: analysis.scenarios.flatMap((s) => s.issues.filter((i) => i.severity === 'high')).map((i) => `${i.category}: ${i.description}`).slice(0, 3),
          changesApplied: ['Refined based on analysis'], cost: iterCostAfter, iterationCost: iterCostAfter - iterCostBefore,
          delta: analysis.delta ? { improvements: analysis.delta.improvements, regressions: analysis.delta.regressions, unchanged: analysis.delta.unchanged } : undefined,
          isChampion: becameChampion, verdict, mode: ledgerEntry.mode, dimensionProfile: candidateDimProfile,
        };

        const changePlanForIter = await this.storage.loadChangePlan(runId, iteration);
        const changeImpactForIter = existingLedgerEntry?.impact;
        const iterData: IterationData = {
          prompt: currentPrompt, testDriverPrompt: this.config.instructions.testDriver || undefined,
          transcripts, transcriptIndex, ruleValidation: ruleResults, llmAnalysis: analysis, summary,
          changePlan: changePlanForIter ?? undefined, changeImpact: changeImpactForIter,
          isChampion: becameChampion, verdict,
        };
        await this.storage.saveIteration(runId, iteration, iterData);

        // Stop/pause signals
        const stopSignal = path.join(runDir, 'stop.signal');
        const pauseSignal = path.join(runDir, 'pause.signal');
        const userStopped = await fs.access(stopSignal).then(() => true).catch(() => false) || this.testRunner.wasStoppedByUser();
        if (userStopped) {
          log.warn('Stop signal received — stopping.');
          try { await fs.unlink(stopSignal); } catch {}
          this.testRunner.clearStopFlag();
          await log.flush();
          return this.finalize(runId, currentPrompt, 'stopped', analysis.overallScore, startTime, changeLedger, history, championMetrics);
        }

        if (manualMode) {
          await fs.writeFile(pauseSignal, new Date().toISOString());
        }
        const paused = await fs.access(pauseSignal).then(() => true).catch(() => false);
        if (paused) {
          if (!manualMode) log.info('Pause signal received — waiting...');
          while (true) {
            await new Promise(r => setTimeout(r, 5000));
            if (!(await fs.access(pauseSignal).then(() => true).catch(() => false))) break;
            if (await fs.access(stopSignal).then(() => true).catch(() => false)) {
              try { await fs.unlink(stopSignal); } catch {}
              this.testRunner.clearStopFlag();
              await log.flush();
              return this.finalize(runId, currentPrompt, 'stopped', analysis.overallScore, startTime, changeLedger, history, championMetrics);
            }
          }
          log.info('Resumed.');
        }

        const shouldStop = this.checkStopConditions(analysis, history, passedCount, totalCount, iteration, championIteration);
        if (shouldStop.stop) {
          log.success(`Stop condition met: ${shouldStop.reason}`);
          await log.flush();
          return this.finalize(runId, currentPrompt, 'success', analysis.overallScore, startTime, changeLedger, history, championMetrics);
        }

        // Inject latest human feedback
        const latestFeedback = await fs.readFile(feedbackPath, 'utf-8').catch(() => '');
        if (latestFeedback.trim()) {
          log.info('Injecting human feedback into refine context...');
          analysis.generalSuggestions = [`HUMAN FEEDBACK (priority): ${latestFeedback.trim()}`, ...analysis.generalSuggestions];
        }

        // Refine
        log.step(`Refining prompt (mode: ${this.determineMode(championMetrics, iteration, promptLedger.entries)})...`);
        const nextIteration = iteration + 1;
        const mode = this.determineMode(championMetrics, iteration, promptLedger.entries);
        const previousChangePlan = changeLedger.entries.length > 0 ? changeLedger.entries[changeLedger.entries.length - 1]?.plan : undefined;

        const context = await this.buildContext(
          history, transcriptIndex, analysis, transcripts, championPrompt, currentPrompt,
          championIteration, championMetrics, promptLedger, changeLedger, mode, iteration,
          previousChangePlan, guidelinesContext, uploadedFilePaths, task, uploadedFilesContext, crossRunInsights,
        );

        let refinedPrompt: string;
        let changes: string[];
        try {
          const refineResult = await this.leadAgent.refinePrompt(championPrompt, currentPrompt, analysis, context);
          refinedPrompt = refineResult.refinedPrompt;
          changes = refineResult.changes;
          log.success(`Refined prompt ready (${refinedPrompt.length} chars, mode: ${mode})`);
          changes.forEach((change) => log.detail(`  • ${change}`));
          if (refineResult.changePlan) {
            const nextPlan: ChangePlan = { ...refineResult.changePlan, iteration: nextIteration };
            changeLedger.entries.push({ iteration: nextIteration, plan: nextPlan });
            await Promise.all([this.storage.saveChangePlan(runId, nextIteration, nextPlan), this.storage.saveChangeLedger(runId, changeLedger)]);
          }
        } catch (refineError) {
          log.error(`Refinement failed: ${(refineError as Error).message} — keeping current prompt.`);
          refinedPrompt = currentPrompt;
          changes = [];
        }

        summary.changesApplied = changes;
        history.push(summary);
        currentPrompt = refinedPrompt;
        iteration++;
      }

      log.warn('Additional iterations complete');
      await log.flush();
      return this.finalize(runId, currentPrompt, 'max_iterations', history[history.length - 1]?.passRate || 0, startTime, changeLedger, history, championMetrics);
    } catch (error) {
      if (this.logger) {
        this.logger.error(`Resume failed: ${(error as Error).message}`);
        await this.logger.flush();
      }
      await this.storage.updateMetadata(runId, { status: 'error' });
      RunStorage.unregisterActiveRun(runId, this.dataDir);
      throw error;
    }
  }

  /**
   * Check stop conditions with plateau detection
   */
  private checkStopConditions(
    analysis: Analysis,
    history: IterationSummary[],
    correctedPassedCount?: number,
    correctedTotalCount?: number,
    currentIteration?: number,
    championIteration?: number
  ): { stop: boolean; reason?: string } {
    const minIterations       = this.config.stopConditions.minIterations       ?? 3;
    const minQualityScore     = this.config.stopConditions.minQualityScore     ?? 0.90;
    const plateauThreshold    = this.config.stopConditions.plateauThreshold    ?? 3;
    const allowMediumStop     = this.config.stopConditions.allowMediumIssueStop ?? true;
    const completedIterations = currentIteration ?? (history.length + 1);

    // Gate 0: Minimum iterations — NEVER stop before minIterations
    if (completedIterations < minIterations) {
      this.logger?.detail(`Min iterations gate: ${completedIterations}/${minIterations} done — continuing.`);
      return { stop: false };
    }

    // Gate 0b: passRate — NEVER stop unless all evaluable scenarios pass
    const evaluable = analysis.scenarios.filter(s => s.verdict !== 'not_evaluable');
    const passRate = evaluable.length > 0
      ? evaluable.filter(s => s.passed).length / evaluable.length
      : 0;
    if (passRate < 1.0) {
      this.logger?.detail(`Pass rate ${(passRate * 100).toFixed(0)}% < 100% — not all scenarios pass, continuing.`);
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

    // Gate 2: Perfect run — no medium issues + quality above threshold → stop
    if (mediumCount === 0 && analysis.overallScore >= minQualityScore) {
      const score = (analysis.overallScore * 100).toFixed(1);
      this.logger?.success(`Stop: quality ${score}%, 0 high, 0 medium issues — prompt is ready.`);
      return { stop: true, reason: `Quality ${score}% with no high/medium issues.` };
    }

    // Gate 3: Plateau detection — champion hasn't changed for N iterations
    if (championIteration != null) {
      const itersSinceChampion = completedIterations - championIteration;
      const championEntry = history.find(h => h.iteration === championIteration);
      const championScore = championEntry?.qualityScore ?? analysis.overallScore;

      if (itersSinceChampion >= plateauThreshold && championScore >= minQualityScore && (mediumCount === 0 || allowMediumStop)) {
        const score = (championScore * 100).toFixed(1);
        this.logger?.success(
          `Stop: plateau detected — champion (iter ${championIteration}, ${score}%) unchanged for ${itersSinceChampion} iterations. ` +
          `${mediumCount} medium issue(s) remain but no improvement is being made.`
        );
        return {
          stop: true,
          reason: `Plateau: champion score ${score}% stable for ${itersSinceChampion} iterations — further refinement is not producing gains.`,
        };
      }

      if (itersSinceChampion >= plateauThreshold) {
        this.logger?.detail(
          allowMediumStop
            ? `Plateau warning: champion unchanged for ${itersSinceChampion} iterations, but score ${(championScore * 100).toFixed(1)}% < ${(minQualityScore * 100).toFixed(1)}% threshold — continuing.`
            : `Plateau detected (${itersSinceChampion} iters) but allowMediumIssueStop=false and ${mediumCount} medium issue(s) remain — continuing.`
        );
      }
    }

    // Gate 4: Quality score below threshold → keep refining
    if (analysis.overallScore < minQualityScore) {
      this.logger?.detail(`Quality ${(analysis.overallScore * 100).toFixed(1)}% < ${(minQualityScore * 100).toFixed(1)}% threshold — continuing.`);
      return { stop: false };
    }

    // Gate 5: Medium issues remain but not yet plateaued — keep trying
    if (mediumCount > 0) {
      this.logger?.detail(`${mediumCount} medium-severity issue(s) remain — continuing (no plateau yet).`);
      return { stop: false };
    }

    const score = (analysis.overallScore * 100).toFixed(1);
    this.logger?.success(`Stop conditions met: quality ${score}%.`);
    return { stop: true, reason: `Quality ${score}% — prompt is ready.` };
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
  private async buildContext(
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
    currentIteration: number,
    previousCandidateChangePlan?: ChangePlan,
    guidelinesContext?: string,
    uploadedFilePaths?: Array<{ filename: string; path: string }>,
    task?: Task,
    uploadedFilesContext?: string,
    crossRunInsights?: string,
  ): Promise<IterationContext> {
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

    // Phase 1: Load cross-run history
    const crossRunHistory = await this.loadCrossRunHistory(this._orchestratorId);

    // Phase 1: Detect oscillation
    const oscillationWarning = this.detectOscillation(changeLedger.entries, currentIteration);

    // Phase 1: Extract behavioral metrics for all transcripts
    const behavioralMetrics: Record<string, BehavioralMetrics> = {};
    for (const t of allTranscripts) {
      behavioralMetrics[t.scenarioId] = this.extractBehavioralMetrics(t);
    }

    return {
      currentAnalysis: analysis,
      transcriptIndex,
      previousSummaries: history,
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
      taskDescription: task
        ? [task.name, task.description, task.requirements?.role ? `Role: ${task.requirements.role}` : ''].filter(Boolean).join('\n')
        : undefined,
      uploadedContext: uploadedFilesContext || undefined,
      crossRunInsights: crossRunInsights || undefined,
      crossRunHistory: crossRunHistory.length > 0 ? crossRunHistory : undefined,
      oscillationWarning: oscillationWarning.detected ? oscillationWarning : undefined,
      behavioralMetrics,
      sectionTaxonomy: this.getSectionTaxonomy(),
      evaluationDimensions: this.getEvaluationDimensions(),
    };
  }

  /**
   * Champion/Challenger composite comparison.
   * Uses dimensional profiles when available; falls back to legacy metrics.
   */
  private isBetterThanChampion(
    candidate: { score: number; passRate: number; highSeverityCount: number; mediumSeverityCount: number },
    champion: { score: number; passRate: number; highSeverityCount: number; mediumSeverityCount: number },
    candidateDimProfile?: Record<string, number>,
    championDimProfile?: Record<string, number>,
  ): boolean {
    // Level 1: fewer high severity issues always wins
    if (candidate.highSeverityCount < champion.highSeverityCount) return true;
    if (candidate.highSeverityCount > champion.highSeverityCount) return false;

    // Level 2: passRate — significant improvement always wins
    const passDelta = candidate.passRate - champion.passRate;
    if (passDelta > 0.15) return true;
    if (passDelta < -0.15) return false;

    // Level 3: dimensional profile comparison (when passRate is similar)
    if (candidateDimProfile && championDimProfile) {
      const criticalDims = [...UNIVERSAL_DIMENSIONS] as string[];
      let wins = 0, losses = 0, severeRegression = false;

      const allDims = new Set([...Object.keys(candidateDimProfile), ...Object.keys(championDimProfile)]);
      for (const dim of allDims) {
        const cand = candidateDimProfile[dim] ?? 0;
        const champ = championDimProfile[dim] ?? 0;
        const delta = cand - champ;
        if (delta > 0.25) wins++;
        if (delta < -0.25) {
          losses++;
          if (criticalDims.includes(dim) && delta < -1) severeRegression = true;
        }
      }

      if (severeRegression) return false;
      if (wins > losses) return true;
      if (losses > wins) return false;
    }

    // Level 4: smaller passRate differences
    if (Math.abs(passDelta) > 0.05) return passDelta > 0;

    // Level 5: at close pass rate — higher overall score
    return candidate.score > champion.score;
  }

  /**
   * Determine refinement mode based on champion metrics, iteration, and recent history.
   * Falls back to 'restructure' when recent candidates are consistently failing,
   * even if the champion's score is high (stale champion scenario).
   */
  private determineMode(
    championMetrics: { score: number; highSeverityCount: number },
    iteration: number,
    recentEntries?: Array<{ score: number; isChampion: boolean }>,
  ): RefinementMode {
    const r = (this.config as any).refinement ?? {};
    const earlyIterations = r.earlyIterations ?? 2;
    const restructureBelow = r.restructureBelow ?? 0.45;
    const restructureAboveHighSeverity = r.restructureAboveHighSeverity ?? 3;

    if (
      iteration <= earlyIterations ||
      championMetrics.score < restructureBelow ||
      championMetrics.highSeverityCount >= restructureAboveHighSeverity
    ) {
      return 'restructure';
    }

    // Adaptive fallback: if the last 3+ candidates all failed to become champion
    // AND their scores are low, surgical tweaks aren't working — escalate.
    if (recentEntries && recentEntries.length >= 3) {
      const lastN = recentEntries.slice(-3);
      const allBelowChampion = lastN.every(e => !e.isChampion);
      const avgScore = lastN.reduce((s, e) => s + e.score, 0) / lastN.length;
      if (allBelowChampion && avgScore < restructureBelow) {
        return 'restructure';
      }
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

  // ========================================
  // Phase 1: Behavioral Metrics (diagnostic)
  // ========================================

  private extractBehavioralMetrics(transcript: Transcript): BehavioralMetrics {
    const botMessages = transcript.messages.filter(m => m.role === 'assistant');
    const userMessages = transcript.messages.filter(m => m.role === 'user');

    const questionRatio = botMessages.length > 0
      ? botMessages.filter(m => m.content.includes('?')).length / botMessages.length
      : 0;

    const counterQuestionsCount = botMessages.filter(m => m.content.includes('?')).length;

    const earlyBotMessages = botMessages.slice(0, 3);
    const earlyDisclosureCount = earlyBotMessages.filter(m => m.content.length > 200).length;

    const avgResponseLength = botMessages.length > 0
      ? botMessages.reduce((sum, m) => sum + m.content.length, 0) / botMessages.length
      : 0;

    return {
      questionRatio: Math.round(questionRatio * 100) / 100,
      counterQuestionsCount,
      earlyDisclosureCount,
      avgResponseLength: Math.round(avgResponseLength),
      conversationLength: botMessages.length + userMessages.length,
    };
  }

  // ========================================
  // Phase 1: Cross-Run Memory
  // ========================================

  private async loadCrossRunHistory(orchestratorId: string): Promise<CrossRunHistoryEntry[]> {
    const runsDir = path.join(this.dataDir, 'runs');
    try {
      const runDirs = await fs.readdir(runsDir);
      const matchingRuns: Array<{ runId: string; metadata: any; startedAt: number }> = [];

      for (const runId of runDirs) {
        try {
          const metaPath = path.join(runsDir, runId, 'metadata.json');
          const metaRaw = await fs.readFile(metaPath, 'utf-8');
          const meta = JSON.parse(metaRaw);
          if (meta.orchestratorId === orchestratorId && meta.status !== 'running') {
            matchingRuns.push({ runId, metadata: meta, startedAt: meta.startedAt ?? 0 });
          }
        } catch {
          // Skip invalid run dirs
        }
      }

      // Sort by startedAt descending, take last 3
      matchingRuns.sort((a, b) => b.startedAt - a.startedAt);
      const recent = matchingRuns.slice(0, 3);

      const entries: CrossRunHistoryEntry[] = [];
      for (const run of recent) {
        try {
          const ledgerPath = path.join(runsDir, run.runId, 'change_ledger.json');
          const ledgerRaw = await fs.readFile(ledgerPath, 'utf-8');
          const ledger: ChangeLedger = JSON.parse(ledgerRaw);

          const confirmedApproaches: string[] = [];
          const disprovenHypotheses: string[] = [];
          const sectionImpactSummary: string[] = [];
          const dimensionChanges = new Map<string, number>();

          for (const entry of ledger.entries) {
            if (!entry.impact) continue;
            for (const ci of entry.impact.changeImpacts) {
              const change = entry.plan.plannedChanges.find(c => c.id === ci.changeId);
              if (!change) continue;
              const desc = `[${change.targetSection}] ${change.description}`;
              if (ci.verdict === 'helped') {
                confirmedApproaches.push(desc);
              } else if (ci.verdict === 'hurt') {
                disprovenHypotheses.push(desc);
              }
              sectionImpactSummary.push(
                `${change.targetSection}: ${ci.verdict} (${entry.impact.overallVerdict})`
              );
              if (ci.dimensionDeltas) {
                for (const [dim, delta] of Object.entries(ci.dimensionDeltas)) {
                  dimensionChanges.set(dim, (dimensionChanges.get(dim) ?? 0) + delta.delta);
                }
              }
            }
          }

          const persistentWeakDimensions = Array.from(dimensionChanges.entries())
            .filter(([_, total]) => total < 0)
            .map(([dim]) => dim);

          entries.push({
            runId: run.runId,
            startedAt: run.startedAt,
            finalScore: run.metadata.finalScore,
            championScore: run.metadata.championScore,
            totalIterations: run.metadata.currentIteration ?? 0,
            confirmedApproaches: confirmedApproaches.slice(0, 5),
            disprovenHypotheses: disprovenHypotheses.slice(0, 5),
            persistentWeakDimensions,
            sectionImpactSummary: sectionImpactSummary.slice(0, 10),
          });
        } catch {
          // No change ledger for this run
        }
      }

      return entries;
    } catch {
      return [];
    }
  }

  // ========================================
  // Phase 1: Oscillation Detection
  // ========================================

  private detectOscillation(
    changeLedger: ChangeLedgerEntry[],
    currentIteration: number
  ): OscillationWarning {
    const noWarning: OscillationWarning = {
      detected: false, dimensions: [], summary: '', approachesTried: [],
    };

    if (currentIteration < 4 || changeLedger.length < 3) return noWarning;

    // Look at last 3 entries with impacts
    const withImpact = changeLedger.filter(e => e.impact).slice(-3);
    if (withImpact.length < 3) return noWarning;

    // Check for A-B-A pattern in overall verdict
    const verdicts = withImpact.map(e => e.impact!.overallVerdict);
    const isABA = (verdicts[0] === verdicts[2]) && (verdicts[0] !== verdicts[1]);

    // Check dimensional oscillation
    const oscillatingDimensions: string[] = [];
    const profiles = withImpact
      .map(e => e.impact!.dimensionProfile)
      .filter((p): p is Record<string, number> => !!p);

    if (profiles.length === 3) {
      const allDims = new Set(profiles.flatMap(p => Object.keys(p)));
      for (const dim of allDims) {
        const scores = profiles.map(p => p[dim] ?? 0);
        // A-B-A: score goes one direction then back
        if (scores.length === 3) {
          const d1 = scores[1] - scores[0];
          const d2 = scores[2] - scores[1];
          if ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) {
            oscillatingDimensions.push(dim);
          }
        }
      }
    }

    if (!isABA && oscillatingDimensions.length === 0) return noWarning;

    const approachesTried = withImpact.map(e => {
      const changes = e.plan.plannedChanges.map(c => `${c.targetSection}: ${c.description}`).join('; ');
      return `iter ${e.iteration}: ${changes} → ${e.impact!.overallVerdict}`;
    });

    const dims = oscillatingDimensions.length > 0
      ? oscillatingDimensions
      : ['overall_score'];

    return {
      detected: true,
      dimensions: dims,
      summary: `Dimensions [${dims.join(', ')}] have been alternating for ${withImpact.length} iterations. Consider context-conditional logic instead of global changes.`,
      approachesTried,
    };
  }

  // ========================================
  // Phase 1: Dimension Profile Computation
  // ========================================

  private computeDimensionProfile(analysis: Analysis): Record<string, number> | undefined {
    const profile: Record<string, { total: number; count: number }> = {};
    let hasDimensions = false;

    for (const scenario of analysis.scenarios) {
      if (!scenario.dimensionScores) continue;
      hasDimensions = true;
      for (const [dim, ds] of Object.entries(scenario.dimensionScores)) {
        if (!profile[dim]) profile[dim] = { total: 0, count: 0 };
        profile[dim].total += ds.score;
        profile[dim].count += 1;
      }
    }

    if (!hasDimensions) return undefined;

    const result: Record<string, number> = {};
    for (const [dim, { total, count }] of Object.entries(profile)) {
      result[dim] = Math.round((total / count) * 100) / 100;
    }
    return result;
  }

  // ========================================
  // Phase 1: Run Insights Writer
  // ========================================

  private async writeRunInsights(
    runId: string,
    changeLedger: ChangeLedger,
    history: IterationSummary[],
    championMetrics: { score: number; passRate: number; highSeverityCount: number },
  ): Promise<void> {
    const insightsDir = path.join(this.dataDir, 'insights', this._orchestratorId);
    await fs.mkdir(insightsDir, { recursive: true });
    const insightsPath = path.join(insightsDir, 'accumulated_insights.md');

    const confirmed: string[] = [];
    const disproven: string[] = [];
    const sectionChanges: Record<string, { count: number; helped: number; hurt: number }> = {};
    const tradeoffs: string[] = [];

    for (const entry of changeLedger.entries) {
      if (!entry.impact) continue;
      for (const ci of entry.impact.changeImpacts) {
        const change = entry.plan.plannedChanges.find(c => c.id === ci.changeId);
        if (!change) continue;
        const section = change.targetSection;
        if (!sectionChanges[section]) sectionChanges[section] = { count: 0, helped: 0, hurt: 0 };
        sectionChanges[section].count++;
        if (ci.verdict === 'helped') {
          sectionChanges[section].helped++;
          confirmed.push(`[${section}] ${change.description} — ${change.hypothesis}`);
        } else if (ci.verdict === 'hurt') {
          sectionChanges[section].hurt++;
          disproven.push(`[${section}] ${change.description} — ${change.hypothesis}`);
        }
      }
    }

    // Detect trade-offs: sections that both helped and hurt across iterations
    for (const [section, stats] of Object.entries(sectionChanges)) {
      if (stats.helped > 0 && stats.hurt > 0) {
        tradeoffs.push(`${section}: helped ${stats.helped}x, hurt ${stats.hurt}x — likely tension between competing goals`);
      }
    }

    // Persistent weak dimensions
    const lastProfile = history.at(-1)?.dimensionProfile;
    const weakDimensions = lastProfile
      ? Object.entries(lastProfile).filter(([_, v]) => v < 3).map(([d]) => d)
      : [];

    const lines = [
      `# Accumulated Insights — ${this._orchestratorId}`,
      `*Last updated: ${new Date().toISOString()} (run ${runId})*`,
      '',
      `## Confirmed Approaches`,
      confirmed.length > 0 ? confirmed.map(c => `- ${c}`).join('\n') : '- None confirmed yet',
      '',
      `## Disproven Hypotheses`,
      disproven.length > 0 ? disproven.map(d => `- ${d}`).join('\n') : '- None disproven yet',
      '',
      `## Section Impact Summary`,
      Object.entries(sectionChanges).length > 0
        ? Object.entries(sectionChanges)
            .map(([s, stats]) => `- ${s}: changed ${stats.count}x (helped: ${stats.helped}, hurt: ${stats.hurt})`)
            .join('\n')
        : '- No section changes tracked yet',
      '',
      `## Recurring Trade-offs`,
      tradeoffs.length > 0 ? tradeoffs.map(t => `- ${t}`).join('\n') : '- None detected',
      '',
      `## Persistent Weak Dimensions`,
      weakDimensions.length > 0 ? weakDimensions.map(d => `- ${d}`).join('\n') : '- None below threshold',
      '',
      `## Run Summary`,
      `- Final champion score: ${(championMetrics.score * 100).toFixed(1)}%`,
      `- Final champion pass rate: ${(championMetrics.passRate * 100).toFixed(1)}%`,
      `- Total iterations: ${history.length}`,
      '',
    ];

    await fs.writeFile(insightsPath, lines.join('\n'));
    this.logger?.info(`Wrote accumulated insights to ${insightsPath}`);
  }

  /**
   * Get the section taxonomy for this orchestrator
   */
  private getSectionTaxonomy(): string[] {
    const sections: string[] = [...UNIVERSAL_SECTIONS];
    const configTaxonomy = (this.config as any).sectionTaxonomy;
    if (configTaxonomy?.extensions) {
      sections.push(...configTaxonomy.extensions);
    } else {
      sections.push(...ROLEPLAY_EXTENSION_SECTIONS);
    }
    if (configTaxonomy?.specific) {
      sections.push(...configTaxonomy.specific);
    }
    return sections;
  }

  /**
   * Get the evaluation dimensions for this orchestrator
   */
  private getEvaluationDimensions(): string[] {
    const dims: string[] = [...UNIVERSAL_DIMENSIONS];
    const configDims = (this.config as any).evaluationDimensions;
    if (configDims?.specific) {
      dims.push(...configDims.specific);
    }
    return dims;
  }

  /**
   * Finalize run and return result
   */
  private async finalize(
    runId: string,
    finalPrompt: string,
    status: 'success' | 'max_iterations' | 'stopped',
    finalScore: number,
    startTime: number,
    changeLedger?: ChangeLedger,
    history?: IterationSummary[],
    championMetrics?: { score: number; passRate: number; highSeverityCount: number },
  ): Promise<RunResult> {
    const totalCost = this.leadAgent.getTotalCost() + this.testRunner.getTotalCost();
    const duration = Date.now() - startTime;

    // Save final prompt to a dedicated file so "continue" runs can easily load it
    const finalPromptPath = path.join(this.dataDir, 'runs', runId, 'final_prompt.txt');
    await fs.writeFile(finalPromptPath, finalPrompt).catch(() => {});

    // Write accumulated insights for cross-run learning
    if (changeLedger && history && championMetrics) {
      await this.writeRunInsights(runId, changeLedger, history, championMetrics).catch(err => {
        this.logger?.warn(`Failed to write run insights: ${(err as Error).message}`);
      });
    }

    await this.storage.finalizeRun(runId, status, finalScore, totalCost);
    RunStorage.unregisterActiveRun(runId, this.dataDir);

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
