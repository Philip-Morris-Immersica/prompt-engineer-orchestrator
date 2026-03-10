import OpenAI from 'openai';
import fs from 'fs/promises';
import { FileParser } from './file-parser';
import type { RunLogger } from './run-logger';
import {
  Task,
  PromptExample,
  GenerateResult,
  Requirements,
  Transcript,
  TranscriptIndex,
  ValidationRules,
  Analysis,
  IterationContext,
  RefineResult,
  OrchestratorConfig,
  TestPlan,
  ChangePlan,
  PlannedChange,
  ScenarioAnalysis,
  UNIVERSAL_DIMENSIONS,
  DEFAULT_DIMENSION_RUBRICS,
} from './types';

// ========================================
// Rate Limiter
// ========================================

class RateLimiter {
  private queue: Array<{
    fn: () => Promise<any>;
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
  }> = [];
  private activeRequests = 0;
  private lastRequestTime = 0;

  constructor(
    private maxConcurrent: number,
    private minIntervalMs: number
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.queue.length === 0 || this.activeRequests >= this.maxConcurrent) {
      return;
    }

    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minIntervalMs) {
      setTimeout(
        () => this.processQueue(),
        this.minIntervalMs - timeSinceLastRequest
      );
      return;
    }

    const item = this.queue.shift();
    if (!item) return;

    const { fn, resolve, reject } = item;
    this.activeRequests++;
    this.lastRequestTime = Date.now();

    try {
      const result = await fn();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.activeRequests--;
      this.processQueue();
    }
  }
}

// ========================================
// Lead Agent
// ========================================

export class LeadAgent {
  private openai: OpenAI;
  private rateLimiter: RateLimiter;
  private config: OrchestratorConfig;
  private totalCost = 0;
  private logger: RunLogger | null = null;

  setLogger(logger: RunLogger) { this.logger = logger; }

  constructor(apiKey: string, config: OrchestratorConfig) {
    this.openai = new OpenAI({ apiKey, timeout: 180_000, maxRetries: 2 }); // 3 min timeout, 2 auto-retries
    this.config = config;

    // Rate limiter: 3 concurrent requests, 300ms interval
    const maxConcurrent = parseInt(
      process.env.MAX_CONCURRENT_REQUESTS || '3',
      10
    );
    const intervalMs = parseInt(process.env.RATE_LIMIT_INTERVAL_MS || '300', 10);
    this.rateLimiter = new RateLimiter(maxConcurrent, intervalMs);
  }

  /**
   * Role 1: Generate Prompt + Test Plan
   */
  async generatePrompt(
    task: Task,
    promptBank: PromptExample[],
    uploadedContext: string = '',
    guidelinesContext: string = '',
    uploadedFilePaths: Array<{ filename: string; path: string }> = []
  ): Promise<GenerateResult> {
    return this.rateLimiter.execute(async () => {
      const systemPrompt = this.buildGenerateSystemPrompt();
      const userMessage = this.formatGenerateRequest(task, promptBank, uploadedContext, guidelinesContext);

      const { content, totalUsage } = await this.callWithFileAccess(
        this.config.models.generate,
        this.config.temperatures.generate,
        systemPrompt,
        userMessage,
        uploadedFilePaths,
      );

      const cost = this.calculateCost(totalUsage, this.config.models.generate);
      this.totalCost += cost;

      const result = JSON.parse(content || '{}');

      return {
        prompt: result.prompt || '',
        testPlan: result.testPlan || { scenarios: [] },
        reasoning: result.reasoning || '',
        cost,
      };
    });
  }

  /**
   * Role 2: Analyze Transcripts
   */
  async analyzeTranscripts(
    selectedTranscripts: Transcript[],
    transcriptIndex: TranscriptIndex,
    requirements: Requirements,
    rules: ValidationRules,
    botPrompt?: string,
    taskDescription?: string,
  ): Promise<Analysis> {
    return this.rateLimiter.execute(async () => {
      const systemPrompt = this.buildAnalyzeSystemPrompt();
      const userMessage = this.formatAnalyzeRequest(
        selectedTranscripts,
        transcriptIndex,
        requirements,
        rules,
        botPrompt,
        taskDescription,
      );

      const response = await this.openai.chat.completions.create({
        model: this.config.models.analyze,
        temperature: this.config.temperatures.analyze,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        response_format: { type: 'json_object' },
      });

      const cost = this.calculateCost(response.usage, this.config.models.analyze);
      this.totalCost += cost;

      const result = JSON.parse(response.choices[0].message.content || '{}');

      // Normalize scenario entries: derive `passed` from `verdict` for backward compat,
      // and ensure `verdict` is always present (default based on old `passed` field).
      // not_evaluable scenarios are excluded from passRate recalculation below.
      const rawScenarios: ScenarioAnalysis[] = (result.scenarios || []).map((s: any) => {
        const verdict = s.verdict ?? (s.passed ? 'pass' : 'fail');
        return {
          ...s,
          verdict,
          passed: verdict === 'pass',
          strengths: s.strengths ?? [],
          issues: (s.issues || []).map((i: any) => ({
            ...i,
            improvementDirection: i.improvementDirection ?? i.suggestion ?? '',
            rootCauseArea: i.rootCauseArea ?? 'other',
          })),
        };
      });

      // Recalculate passRate excluding not_evaluable scenarios
      const evaluable = rawScenarios.filter((s) => s.verdict !== 'not_evaluable');
      // Strict passRate: only "pass" counts (used for stop conditions)
      const passRate = evaluable.length > 0
        ? evaluable.filter((s) => s.passed).length / evaluable.length
        : (result.passRate || 0);

      // Weighted passRate for quality score: pass=1.0, mixed=0.5, fail=0.0
      const weightedPassRate = evaluable.length > 0
        ? evaluable.reduce((sum, s) => {
            if (s.passed) return sum + 1.0;
            if (s.verdict === 'mixed') return sum + 0.5;
            return sum;
          }, 0) / evaluable.length
        : 0;

      // Compute overallScore deterministically from dimensional scores
      const allDimScores: number[] = [];
      for (const s of evaluable) {
        if (s.dimensionScores) {
          for (const ds of Object.values(s.dimensionScores as Record<string, { score: number }>)) {
            if (typeof ds.score === 'number') allDimScores.push(ds.score);
          }
        }
      }
      const rawDimScore = allDimScores.length > 0
        ? allDimScores.reduce((a, b) => a + b, 0) / allDimScores.length / 5
        : (result.overallScore || 0);

      // Quality = dimAvg × weightedPassRate (mixed gets partial credit)
      const computedScore = rawDimScore * weightedPassRate;

      const llmScore = result.overallScore || 0;
      if (allDimScores.length > 0 && Math.abs(rawDimScore - llmScore) > 0.10) {
        console.warn(
          `[Analyzer] overallScore mismatch: LLM reported ${llmScore.toFixed(2)}, ` +
          `computed from dimensions: ${rawDimScore.toFixed(2)}, adjusted (×passRate): ${computedScore.toFixed(2)}. Using adjusted.`
        );
      }

      return {
        overallScore: allDimScores.length > 0 ? computedScore : (llmScore * weightedPassRate),
        passRate,
        scenarios: rawScenarios,
        generalSuggestions: result.generalSuggestions || [],
        needsAdditionalTranscripts: result.needsAdditionalTranscripts,
        testQualityObservations: result.testQualityObservations,
      };
    });
  }

  /**
   * Role 3: Refine Prompt (enriched - champion + candidate context)
   */
  async refinePrompt(
    championPrompt: string,
    candidatePrompt: string,
    analysis: Analysis,
    context: IterationContext
  ): Promise<RefineResult> {
    return this.rateLimiter.execute(async () => {
      const systemPrompt = this.buildRefineSystemPrompt(context.refinementMode);
      const userMessage = this.formatRefineRequest(
        championPrompt,
        candidatePrompt,
        analysis,
        context
      );

      const { content, totalUsage } = await this.callWithFileAccess(
        this.config.models.refine,
        this.config.temperatures.refine,
        systemPrompt,
        userMessage,
        context.uploadedFilePaths ?? [],
      );

      const cost = this.calculateCost(totalUsage, this.config.models.refine);
      this.totalCost += cost;

      const result = JSON.parse(content || '{}');

      // Parse changePlan from result if available
      let changePlan: ChangePlan | undefined;
      if (result.changePlan) {
        changePlan = result.changePlan as ChangePlan;
      } else if (result.plannedChanges) {
        // Fallback: build a minimal changePlan from plannedChanges array
        changePlan = {
          iteration: 0, // will be set by engine
          basedOnChampionIteration: context.championIteration ?? 1,
          basedOnCandidateIteration: context.previousSummaries.at(-1)?.iteration,
          mode: context.refinementMode ?? 'surgical',
          diagnosis: result.diagnosis ?? analysis.generalSuggestions.join('; '),
          decisionRationale: result.decisionRationale ?? result.reasoning ?? '',
          plannedChanges: (result.plannedChanges as PlannedChange[]) ?? [],
        };
      }

      return {
        refinedPrompt: result.prompt || candidatePrompt,
        changes: result.changes || [],
        reasoning: result.reasoning || '',
        cost,
        changePlan,
      };
    });
  }

  /**
   * Shared agentic loop that allows any agent call to read uploaded reference
   * files on-demand via function calling.
   *
   * The model receives a compact file index upfront (filenames + descriptions).
   * When it needs a file's content it calls read_reference_file(filename).
   * The loop resolves the tool call, appends the file content, and continues.
   *
   * Returns the final JSON string and accumulated token usage.
   */
  private async callWithFileAccess(
    model: string,
    temperature: number,
    systemPrompt: string,
    userMessage: string,
    uploadedFilePaths: Array<{ filename: string; path: string }>,
  ): Promise<{ content: string; totalUsage: any }> {

    const hasFiles = uploadedFilePaths.length > 0;

    // Build file index block injected into the user message so the model
    // knows which files exist and what it can request.
    let messageWithIndex = userMessage;
    if (hasFiles) {
      const index = uploadedFilePaths
        .map((f) => `  • ${f.filename}`)
        .join('\n');
      messageWithIndex = `${userMessage}\n\n${'─'.repeat(50)}\n📂 REFERENCE FILES AVAILABLE ON-DEMAND\nUse the read_reference_file tool to load any of these when you need to verify details:\n${index}\n${'─'.repeat(50)}`;
    }

    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = hasFiles
      ? [
          {
            type: 'function',
            function: {
              name: 'read_reference_file',
              description:
                'Read the full content of an uploaded reference file when you need to verify character details, behavioral rules, process steps, or prompt structure. Call this only when you genuinely need to consult the source material.',
              parameters: {
                type: 'object',
                properties: {
                  filename: {
                    type: 'string',
                    description: 'Exact filename to read (as listed in the file index above)',
                  },
                  reason: {
                    type: 'string',
                    description: 'Brief reason why you need this file right now',
                  },
                },
                required: ['filename'],
              },
            },
          },
        ]
      : [];

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: messageWithIndex },
    ];

    let totalUsage: any = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const MAX_TOOL_ROUNDS = 5;

    // Track whether we have processed any tool calls yet
    let toolCallsMade = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // After at least one tool call round, the next call that returns no tool calls
      // must produce JSON — we enforce this by not passing tools anymore once the
      // model has had a chance to read files (round > 0 with tool history).
      const isFinalizingRound = !hasFiles || round === MAX_TOOL_ROUNDS - 1 || toolCallsMade;

      const requestParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = isFinalizingRound
        ? {
            model,
            temperature,
            messages,
            tools: hasFiles ? tools : undefined,
            tool_choice: hasFiles ? 'none' : undefined,
            response_format: { type: 'json_object' },
          }
        : {
            model,
            temperature,
            messages,
            tools,
            tool_choice: 'auto',
          };

      const response = await this.openai.chat.completions.create(requestParams);

      // Accumulate token usage
      if (response.usage) {
        totalUsage.prompt_tokens += response.usage.prompt_tokens ?? 0;
        totalUsage.completion_tokens += response.usage.completion_tokens ?? 0;
        totalUsage.total_tokens += response.usage.total_tokens ?? 0;
      }

      const choice = response.choices[0];

      // No tool calls — this is the final JSON response
      if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
        return { content: choice.message.content || '{}', totalUsage };
      }

      // Process tool calls (file reads)
      toolCallsMade = true;
      messages.push(choice.message as OpenAI.Chat.Completions.ChatCompletionMessageParam);

      for (const toolCall of choice.message.tool_calls) {
        if (toolCall.function.name === 'read_reference_file') {
          let fileContent: string;
          try {
            const args = JSON.parse(toolCall.function.arguments || '{}');
            const requested = (args.filename as string) ?? '';
            const reason = (args.reason as string) ?? '';

            // Find matching file (case-insensitive, partial match allowed)
            const match = uploadedFilePaths.find(
              (f) =>
                f.filename.toLowerCase() === requested.toLowerCase() ||
                f.filename.toLowerCase().includes(requested.toLowerCase())
            );

            if (match) {
              const parsed = await FileParser.parseFile(match.path);
              fileContent = `FILE: ${match.filename}\n${'─'.repeat(40)}\n${parsed.content}`;
              this.logger?.info(`Agent read file: "${match.filename}"${reason ? ` — ${reason}` : ''}`);
            } else {
              fileContent = `[File not found: "${requested}". Available files: ${uploadedFilePaths.map((f) => f.filename).join(', ')}]`;
              this.logger?.warn(`Agent requested unknown file: "${requested}"`);
            }
          } catch (err) {
            fileContent = `[Error reading file: ${(err as Error).message}]`;
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: fileContent,
          });
        }
      }

      // Inject a reminder after tool results so the model knows to finalize
      messages.push({
        role: 'user',
        content: 'Files loaded. Now produce your final JSON output.',
      });
    }

    // Should not reach here, but return empty as safety
    return { content: '{}', totalUsage };
  }

  /**
   * Get total cost accumulated
   */
  getTotalCost(): number {
    return this.totalCost;
  }

  /**
   * Per-model pricing table (USD per 1M tokens, March 2026).
   * Fallback to gpt-4o pricing when model is unknown.
   */
  private static readonly MODEL_PRICING: Record<string, { input: number; output: number }> = {
    // GPT-5.x
    'gpt-5.4':             { input: 2.50,  output: 15.00 },
    'gpt-5.3':             { input: 1.75,  output: 14.00 },
    // GPT-4o family
    'gpt-4o':              { input: 2.50,  output: 10.00 },
    'gpt-4o-mini':         { input: 0.15,  output: 0.60 },
    'gpt-4o-2024-11-20':   { input: 2.50,  output: 10.00 },
    'gpt-4o-2024-08-06':   { input: 2.50,  output: 10.00 },
    // o-series
    'o3':                  { input: 10.00, output: 40.00 },
    'o3-mini':             { input: 1.10,  output: 4.40 },
    'o1':                  { input: 15.00, output: 60.00 },
    'o1-mini':             { input: 1.10,  output: 4.40 },
    // Older
    'gpt-4-turbo':         { input: 10.00, output: 30.00 },
    'gpt-4':               { input: 30.00, output: 60.00 },
    'gpt-3.5-turbo':       { input: 0.50,  output: 1.50 },
  };

  /**
   * Calculate cost based on token usage and actual model used.
   */
  private calculateCost(usage: any, model?: string): number {
    if (!usage) return 0;

    const pricing = (model ? LeadAgent.MODEL_PRICING[model] : undefined)
      ?? LeadAgent.MODEL_PRICING['gpt-4o']
      ?? { input: 2.50, output: 10.00 };

    const inputCost  = (usage.prompt_tokens     / 1_000_000) * pricing.input;
    const outputCost = (usage.completion_tokens  / 1_000_000) * pricing.output;

    return inputCost + outputCost;
  }

  // ========================================
  // Prompt Templates — read from config.instructions
  // ========================================

  private buildGenerateSystemPrompt(): string {
    const scenariosCount = this.config.testing.scenariosCount || 3;
    const turnsMin = this.config.testing.turnsPerScenario?.min || 3;
    const turnsMax = this.config.testing.turnsPerScenario?.max || 5;
    const maxTurnsDriverMode = this.config.testing.maxTurnsDriverMode || 20;

    return this.config.instructions.generate
      .replace(/\{\{scenariosCount\}\}/g, String(scenariosCount))
      .replace(/\{\{turnsMin\}\}/g, String(turnsMin))
      .replace(/\{\{turnsMax\}\}/g, String(turnsMax))
      .replace(/\{\{maxTurns\}\}/g, String(maxTurnsDriverMode));
  }

  private buildAnalyzeSystemPrompt(): string {
    const testQualityInstruction = `

Also evaluate the quality of the TEST SCENARIOS themselves (not the bot). Add a "testQualityObservations" field:
{
  "overallQuality": "good" | "medium" | "weak",
  "isChallengingEnough": true | false,
  "isRealistic": true | false,
  "notes": ["observation 1", "observation 2"],
  "suggestedImprovementsForNextRun": ["improvement 1"]
}

RULES for testQualityObservations:
- "notes" must include at least ONE specific weakness or gap in the test scenarios. Generic praise like "Scenarios are well-structured" is NOT acceptable.
- Think critically: does the test package cover enough edge cases? Are the driver approaches distinct enough? Is there a scenario type that is missing?
- "suggestedImprovementsForNextRun" must be concrete and actionable, e.g.: "Add a scenario where the employee starts well but makes a critical mistake mid-conversation."
- If you genuinely cannot find any weakness, explain WHY the scenarios are sufficient and what makes them complete.`;

    const dimensionInstruction = `

CRITICAL — DIMENSIONAL SCORING:
For each evaluable scenario, you MUST include a "dimensionScores" field with integer 1-5 scores per dimension.
Each score MUST include evidence from the transcript and a pairwise comparison vs champion (vsChampion).
The overallScore should be the weighted average of all dimension scores across evaluable scenarios, normalized to 0-1 (divide by 5).
See the user message for the full dimension list and rubric anchors.`;

    return this.config.instructions.analyze + testQualityInstruction + dimensionInstruction;
  }

  private buildRefineSystemPrompt(mode?: string): string {
    const base = this.config.instructions.refine;
    const changeBudget = `

CHANGE BUDGET — control the scope of changes:
- small: wording tweak or minor clarification in 1 section (low risk)
- medium: new logic or reworked behavior in 1-2 sections (medium risk)
- large: structural change across 3+ sections (high risk)
Budget per iteration: up to 3 small OR 1 medium + 1 small OR 1 large.
Each change must reference a section from the taxonomy and specify its scope.`;

    const modeGuidance = mode === 'surgical'
      ? `\n\nREFINEMENT MODE: surgical\nMake tightly targeted changes within the CHANGE BUDGET. Each change must have a clear PlannedChange entry with targetSection, scope, description, and hypothesis. Preserve everything that is working.`
      : `\n\nREFINEMENT MODE: restructure\nYou may restructure significantly if needed. Focus on fixing fundamental issues in role, tone, boundaries, and flow. Still respect the CHANGE BUDGET for trackability.`;

    const thinkingPressure = `

DEPTH OF ANALYSIS — THIS IS THE MOST IMPORTANT PART OF THE PROCESS:
You are the core intelligence of a self-improving prompt refinement system. The quality of the entire pipeline depends on the depth of YOUR analysis.

Before writing your output:
1. Re-read the failed transcripts carefully. Identify specific turns where behavior deviates from ideal.
2. Cross-reference with the reference materials — does the prompt faithfully represent the character?
3. Check the change ledger — what was tried before and what was its effect?
4. Formulate a clear diagnosis BEFORE proposing changes.
5. For each planned change, write a specific hypothesis about which dimension it will improve and why.

Your diagnosis and reasoning fields should be DETAILED (at least 3-5 sentences each).
Do NOT produce shallow output like "Запазвам кандидата в текущия му вид" — if the score is below 90%, there is ALWAYS something to improve.
A prompt that passes all tests with inflated scores still needs work on realism, naturalness, and depth.`;

    return base + changeBudget + modeGuidance + thinkingPressure;
  }

  private formatGenerateRequest(
    task: Task,
    promptBank: PromptExample[],
    uploadedContext: string = '',
    guidelinesContext: string = ''
  ): string {
    const examples = promptBank
      .slice(0, 3)
      .map(
        (ex, i) =>
          `Пример ${i + 1}: ${ex.name}\n${ex.prompt}\n(Rating: ${ex.rating || 'N/A'})`
      )
      .join('\n\n');

    let message = `ЗАДАЧА:
${task.description}

ИЗИСКВАНИЯ:
Роля: ${task.requirements.role}
Ограничения:
${task.requirements.constraints.map((c) => `- ${c}`).join('\n')}
${task.requirements.tone ? `Тон: ${task.requirements.tone}` : ''}
${task.requirements.maxResponseLength ? `Макс дължина отговор: ${task.requirements.maxResponseLength} chars` : ''}`;

    if (guidelinesContext) {
      message += `\n\n${'━'.repeat(50)}\n📚 PROMPT ENGINEERING GUIDELINES\n${'━'.repeat(50)}\n${guidelinesContext}\n${'━'.repeat(50)}\nApply these guidelines actively when building the system prompt and test package.`;
    }

    if (uploadedContext) {
      message += `\n\n📎 REFERENCE MATERIALS:\n${uploadedContext}\n\nВАЖНО: Използвай uploaded reference materials като контекст при създаването на prompt-а.`;
    }

    // Test quality suggestions are embedded in guidelinesContext (accumulated_insights.md)
    // which is already injected above. No additional injection needed.

    message += `\n\n${promptBank.length > 0 ? `ПРИМЕРИ ОТ PROMPT BANK:\n${examples}` : ''}

ВАЖНО: Структура на output-а:
{
  "prompt": "system prompt за Bot Under Test (assistant side)",
  "testPlan": {
    "scenarios": [
      {
        "id": "scenario_01",
        "name": "Descriptive name",
        "driverRole": "USER-side role (e.g. sales rep) — НЕ ролята на бота",
        "situation": "Brief context (1-2 изречения)",
        "userGoal": "Какво иска AI Test Driver (user side) да постигне",
        "maxTurns": ${this.config.testing.maxTurnsDriverMode || 20},
        "stopRules": ["Stop if goal achieved", "Stop if conversation ends naturally"],
        "expectedBehavior": "Какво трябва да прави Bot Under Test (assistant)",
        "userUtterances": [
          { "id": "utt_01", "text": "реплика от USER перспектива", "group": "opening", "useWhen": "conversation start", "maxUses": 1, "canRephrase": true },
          ... (общо 15 реплики: ~2 opening, ~4 discovery, ~5 objections, ~4 close)
        ]
      }
    ]
  },
  "reasoning": "Кратко обяснение"
}

Bot Under Test = АСИСТЕНТ (зарежда system prompt, отговаря в ролята).
AI Test Driver = USER страна (симулира driverRole, НЕ ролята на бота).
driverRole е отсрещната страна: ако ботът е дерматолог, driverRole = "търговски представител".

Създай ТОЧНО ${this.config.testing.scenariosCount || 3} scenarios, всеки с ТОЧНО 15 userUtterances с реалистично съдържание.`;

    return message;
  }

  private formatAnalyzeRequest(
    selectedTranscripts: Transcript[],
    transcriptIndex: TranscriptIndex,
    requirements: Requirements,
    rules: ValidationRules,
    botPrompt?: string,
    taskDescription?: string,
  ): string {
    const indexSummary = transcriptIndex.scenarios
      .map(
        (s) =>
          `${s.scenarioId}: ${s.scenarioName} (${s.passed ? '✓' : '✗'}) - ${s.summary}`
      )
      .join('\n');

    const fullTranscripts = selectedTranscripts
      .map((t) => {
        const messages = t.messages
          .map((m) => `${m.role === 'user' ? '👤' : '🤖'} ${m.role}: ${m.content}`)
          .join('\n');
        return `--- ${t.scenarioId}: ${t.scenarioName} ---\nОчаквано: ${t.expectedBehavior}\n${messages}`;
      })
      .join('\n\n');

    // Build dimension + rubric block
    const dimensions = this.getEvaluationDimensions();
    const rubrics = this.getDimensionRubrics();
    const dimensionBlock = dimensions.map(dim => {
      const rubric = rubrics[dim];
      if (rubric) {
        return `- ${dim}:\n    1: ${rubric['1']}\n    3: ${rubric['3']}\n    5: ${rubric['5']}`;
      }
      return `- ${dim}: (use standard 1-5 rubric)`;
    }).join('\n');

    const taskBlock = taskDescription
      ? `${'━'.repeat(50)}\n🎯 TASK / GOAL\n${'━'.repeat(50)}\n${taskDescription}\n${'━'.repeat(50)}\n\n`
      : '';

    const promptBlock = botPrompt
      ? `${'═'.repeat(50)}\nBOT SYSTEM PROMPT (this is the prompt the bot was loaded with — evaluate whether the bot FOLLOWS these instructions)\n${'═'.repeat(50)}\n${botPrompt}\n${'═'.repeat(50)}\n\n`
      : '';

    return `${taskBlock}${promptBlock}ИЗИСКВАНИЯ:
Роля: ${requirements.role}
Ограничения:
${requirements.constraints.map((c) => `- ${c}`).join('\n')}

VALIDATION RULES:
${rules.maxResponseLength ? `- Макс дължина: ${rules.maxResponseLength} chars` : ''}
${rules.forbiddenPhrases ? `- Забранени фрази: ${rules.forbiddenPhrases.join(', ')}` : ''}

TRANSCRIPT INDEX (всички scenarios):
${indexSummary}

FULL TRANSCRIPTS:
${fullTranscripts}

────────────────────────────────────────
DIMENSIONAL SCORING — REQUIRED PER SCENARIO
────────────────────────────────────────
For EACH scenario, score these dimensions on integer 1-5 scale.
Use the rubric anchors below. You MUST cite evidence from the transcript for each score.
Compare each dimension to the champion (if provided) using vsChampion: "better" | "same" | "worse" | "n/a".

DIMENSIONS AND RUBRIC ANCHORS:
${dimensionBlock}

Per-scenario dimensionScores format:
"dimensionScores": {
  "dimension_name": { "score": 3, "vsChampion": "worse", "evidence": "Turn 2: premature validation — bot said '...'" }
}
────────────────────────────────────────

overallScore = weighted average of all dimension scores across all evaluable scenarios, normalized to 0-1 scale (divide avg by 5).

Анализирай дали ботът следва изискванията и върни детайлна оценка.`;
  }

  /**
   * Get evaluation dimensions (universal + orchestrator-specific)
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
   * Get dimension rubrics (defaults + orchestrator overrides)
   */
  private getDimensionRubrics(): Record<string, Record<string, string>> {
    const rubrics = { ...DEFAULT_DIMENSION_RUBRICS };
    const configRubrics = (this.config as any).dimensionRubrics;
    if (configRubrics) {
      Object.assign(rubrics, configRubrics);
    }
    return rubrics;
  }

  private formatRefineRequest(
    championPrompt: string,
    candidatePrompt: string,
    analysis: Analysis,
    context: IterationContext
  ): string {
    const mode = context.refinementMode ?? 'surgical';
    const championIter = context.championIteration ?? 1;
    const championScore = context.championScore ?? 0;
    const championPassRate = context.championPassRate ?? 0;
    const championHighSev = context.championHighSeverityCount ?? 0;

    // Determine if candidate differs from champion
    const isCandidateSameAsChampion = candidatePrompt === championPrompt;
    const lastSummary = context.previousSummaries.at(-1);
    const candidateScore = lastSummary?.qualityScore ?? analysis.overallScore;
    const candidatePassRate = lastSummary?.passRate ?? analysis.passRate;
    const candidateIter = lastSummary?.iteration ?? 'current';

    // Prompt history ledger summary
    const ledgerSummary = context.promptLedger && context.promptLedger.length > 0
      ? context.promptLedger.map(e =>
          `iter ${e.iteration}: ${e.verdict} | score ${(e.score * 100).toFixed(0)}% | passRate ${(e.passRate * 100).toFixed(0)}% | highSev ${e.highSeverityCount} ${e.isChampion ? '★CHAMPION' : ''}`
        ).join('\n')
      : 'No history yet.';

    // Change history
    const changeHistorySummary = context.changeLedger && context.changeLedger.length > 0
      ? context.changeLedger.map(e => {
          const planSummary = e.plan.plannedChanges.map(c => `  [${c.id}] ${c.targetSection}: ${c.description}`).join('\n');
          const impactSummary = e.impact
            ? `  → Impact: ${e.impact.overallVerdict} | ${e.impact.becameChampion ? 'became champion' : 'did not become champion'}`
            : `  → Not yet tested`;
          return `iter ${e.iteration} (${e.plan.mode}):\n${planSummary}\n${impactSummary}`;
        }).join('\n\n')
      : 'No change history yet.';

    // Previous candidate's change plan
    const prevPlanBlock = context.previousCandidateChangePlan
      ? `PREVIOUS CANDIDATE CHANGE PLAN:\n` +
        `Diagnosis: ${context.previousCandidateChangePlan.diagnosis}\n` +
        `Changes attempted:\n` +
        context.previousCandidateChangePlan.plannedChanges.map(c =>
          `  [${c.id}] ${c.targetSection}: ${c.description}\n       Hypothesis: ${c.hypothesis}`
        ).join('\n')
      : '';

    // Failed scenarios
    const failedScenarios = context.failedTranscripts
      .slice(0, 3)
      .map((t) => {
        const messages = t.messages
          .map((m) => `${m.role}: ${m.content}`)
          .join('\n');
        return `${t.scenarioName}:\n${messages}`;
      })
      .join('\n\n');

    // Passed sample (show what's working)
    const passedSampleBlock = context.passedSample && context.passedSample.length > 0
      ? context.passedSample.slice(0, 1).map(t => {
          const messages = t.messages.map(m => `${m.role}: ${m.content}`).join('\n');
          return `${t.scenarioName} (PASSED):\n${messages}`;
        }).join('\n\n')
      : '';

    // Full issue details (non-evaluable scenarios excluded from issue list)
    const evaluableScenarios = analysis.scenarios.filter(
      (s) => !('verdict' in s) || (s as any).verdict !== 'not_evaluable'
    );
    const allIssues = evaluableScenarios.flatMap((s) =>
      s.issues.map((i) => ({ scenarioId: s.scenarioId, ...i }))
    );
    const issueBlock = allIssues.length > 0
      ? allIssues.map((i) => `[${i.severity.toUpperCase()}] ${i.category} (${i.scenarioId})
  Area      : ${i.rootCauseArea ?? (i as any).rootCauseInPrompt ?? 'n/a'}
  Problem   : ${i.description}
  Direction : ${i.improvementDirection ?? (i as any).suggestion ?? 'n/a'}`).join('\n\n')
      : 'No issues found.';

    // Strengths block — what is working well (do not regress these)
    const strengthsBlock = evaluableScenarios
      .filter((s) => (s as any).strengths?.length > 0)
      .map((s) => `${s.scenarioId}: ${((s as any).strengths as string[]).join(' | ')}`)
      .join('\n');

    const guidelinesBlock = context.guidelinesContext
      ? `${'━'.repeat(50)}\n📚 PROMPT ENGINEERING GUIDELINES\n${'━'.repeat(50)}\n${context.guidelinesContext}\n${'━'.repeat(50)}\n\n`
      : '';

    // Cross-run accumulated insights (from previous runs — separate from guidelines)
    const insightsBlock = context.crossRunInsights
      ? `${'━'.repeat(50)}\n🧠 CROSS-RUN INSIGHTS (accumulated from previous runs)\n${'━'.repeat(50)}\n${context.crossRunInsights}\n${'━'.repeat(50)}\n\n`
      : '';

    // Cross-run history block
    const crossRunBlock = context.crossRunHistory && context.crossRunHistory.length > 0
      ? `${'━'.repeat(50)}\n📊 CROSS-RUN HISTORY (last ${context.crossRunHistory.length} runs)\n${'━'.repeat(50)}\n` +
        context.crossRunHistory.map(r => {
          const lines = [
            `Run ${r.runId} (${r.totalIterations} iterations, champion: ${(r.championScore ?? 0 * 100).toFixed(0)}%)`,
          ];
          if (r.confirmedApproaches.length > 0) lines.push(`  Confirmed: ${r.confirmedApproaches.join('; ')}`);
          if (r.disprovenHypotheses.length > 0) lines.push(`  Disproven: ${r.disprovenHypotheses.join('; ')}`);
          if (r.persistentWeakDimensions.length > 0) lines.push(`  Weak dims: ${r.persistentWeakDimensions.join(', ')}`);
          return lines.join('\n');
        }).join('\n\n') + `\n${'━'.repeat(50)}\n\n`
      : '';

    // Oscillation warning block
    const oscillationBlock = context.oscillationWarning?.detected
      ? `⚠️ OSCILLATION WARNING:\n${context.oscillationWarning.summary}\nApproaches tried:\n${context.oscillationWarning.approachesTried.map(a => `  - ${a}`).join('\n')}\n\nConsider: is a global change the right approach, or would context-conditional logic resolve the underlying trade-off?\n\n`
      : '';

    // Section taxonomy reference
    const sectionBlock = context.sectionTaxonomy
      ? `SECTION TAXONOMY (each change must reference one):\n${context.sectionTaxonomy.map(s => `  - ${s}`).join('\n')}\n\n`
      : '';

    // Dimensional delta block (scenario-level dimension scores from current analysis)
    const dimDeltaBlock = analysis.scenarios.some(s => s.dimensionScores)
      ? `DIMENSIONAL SCORES PER SCENARIO:\n` +
        analysis.scenarios.filter(s => s.dimensionScores).map(s => {
          const dims = Object.entries(s.dimensionScores!).map(([d, ds]) =>
            `  ${d}: ${ds.score}/5 (vs champion: ${ds.vsChampion}) — ${ds.evidence}`
          ).join('\n');
          return `${s.scenarioId} (${s.verdict}):\n${dims}`;
        }).join('\n\n') + '\n\n'
      : '';

    // Behavioral metrics block
    const metricsBlock = context.behavioralMetrics && Object.keys(context.behavioralMetrics).length > 0
      ? `BEHAVIORAL METRICS (diagnostic — code-measured):\n` +
        Object.entries(context.behavioralMetrics).map(([sid, m]) =>
          `  ${sid}: questionRatio=${m.questionRatio}, counterQ=${m.counterQuestionsCount}, earlyDisclosure=${m.earlyDisclosureCount}, avgLen=${m.avgResponseLength}, turns=${m.conversationLength}`
        ).join('\n') + '\n\n'
      : '';

    const taskBlock = context.taskDescription
      ? `${'━'.repeat(50)}\n🎯 TASK / GOAL\n${'━'.repeat(50)}\n${context.taskDescription}\n${'━'.repeat(50)}\n\n`
      : '';

    const refMaterialsBlock = context.uploadedContext
      ? `${'━'.repeat(50)}\n📎 REFERENCE MATERIALS (character template, example dialogues, process docs)\n${'━'.repeat(50)}\n${context.uploadedContext}\n${'━'.repeat(50)}\n\n`
      : '';

    return `${taskBlock}${refMaterialsBlock}${guidelinesBlock}${insightsBlock}${crossRunBlock}${oscillationBlock}═══════════════════════════════════════════════
CHAMPION PROMPT (Iteration ${championIter} | Score ${(championScore * 100).toFixed(0)}% | PassRate ${(championPassRate * 100).toFixed(0)}% | ${championHighSev} high severity)
═══════════════════════════════════════════════
${championPrompt}

${isCandidateSameAsChampion ? '' : `═══════════════════════════════════════════════
CURRENT CANDIDATE PROMPT (Iteration ${candidateIter} | Score ${(candidateScore * 100).toFixed(0)}% | PassRate ${(candidatePassRate * 100).toFixed(0)}%)
═══════════════════════════════════════════════
${candidatePrompt}

`}CANDIDATE ANALYSIS:
Quality Score : ${(analysis.overallScore * 100).toFixed(0)}%
Pass Rate     : ${(analysis.passRate * 100).toFixed(0)}%
Total Issues  : ${allIssues.length} (${allIssues.filter(i => i.severity === 'high').length} high, ${allIssues.filter(i => i.severity === 'medium').length} medium, ${allIssues.filter(i => i.severity === 'low').length} low)
Not Evaluable : ${analysis.scenarios.length - evaluableScenarios.length} scenario(s) skipped

WHAT IS WORKING WELL (preserve these behaviors — do not change what is already good):
${strengthsBlock || 'No strengths recorded yet.'}

DETAILED ISSUES (directional guidance — not prompt instructions):
${issueBlock}

GENERAL DIRECTIONS:
${analysis.generalSuggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}

PROMPT HISTORY LEDGER:
${ledgerSummary}

CHANGE HISTORY:
${changeHistorySummary}

${prevPlanBlock ? prevPlanBlock + '\n\n' : ''}FAILED SCENARIO TRANSCRIPTS:
${failedScenarios || 'None — all scenarios passed.'}

${passedSampleBlock ? `PASSING SCENARIO SAMPLE (preserve what works):\n${passedSampleBlock}\n\n` : ''}${sectionBlock}${dimDeltaBlock}${metricsBlock}${this.formatTestQualityBlock(analysis)}REFINEMENT MODE: ${mode.toUpperCase()}

DECISION:
You may either:
A) Refine the current candidate further (if you see clear targeted improvements)
B) Revert to champion and apply fresh targeted changes from there

OUTPUT FORMAT (JSON):
{
  "prompt": "the new refined prompt",
  "changes": ["change 1", "change 2"],
  "reasoning": "why you chose strategy A or B and what you changed",
  "diagnosis": "what problems you observed",
  "decisionRationale": "A (refine candidate) or B (revert to champion) and why",
  "plannedChanges": [
    { "id": "c1", "targetSection": "SECTION_FROM_TAXONOMY", "scope": "small|medium|large", "description": "what is changed", "hypothesis": "why + expected effect" }
  ]
}`;
  }

  private formatTestQualityBlock(analysis: Analysis): string {
    const obs = analysis.testQualityObservations;
    if (!obs) return '';

    const lines: string[] = [];
    lines.push('TEST COVERAGE GAPS (from analyzer — tests cannot change mid-run, but make the prompt robust for these cases):');
    if (obs.notes && obs.notes.length > 0) {
      for (const note of obs.notes) lines.push(`  - ${note}`);
    }
    if (obs.suggestedImprovementsForNextRun && obs.suggestedImprovementsForNextRun.length > 0) {
      lines.push('  Gaps to address proactively in the prompt:');
      for (const s of obs.suggestedImprovementsForNextRun) lines.push(`    → ${s}`);
    }
    lines.push('');
    return lines.join('\n');
  }
}
