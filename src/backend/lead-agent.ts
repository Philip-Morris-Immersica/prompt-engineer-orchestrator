import OpenAI from 'openai';
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

  constructor(apiKey: string, config: OrchestratorConfig) {
    this.openai = new OpenAI({ apiKey });
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
    uploadedContext: string = ''
  ): Promise<GenerateResult> {
    return this.rateLimiter.execute(async () => {
      const systemPrompt = this.buildGenerateSystemPrompt();
      const userMessage = this.formatGenerateRequest(task, promptBank, uploadedContext);

      const response = await this.openai.chat.completions.create({
        model: this.config.models.generate,
        temperature: this.config.temperatures.generate,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        response_format: { type: 'json_object' },
      });

      const cost = this.calculateCost(response.usage);
      this.totalCost += cost;

      const result = JSON.parse(response.choices[0].message.content || '{}');

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
    rules: ValidationRules
  ): Promise<Analysis> {
    return this.rateLimiter.execute(async () => {
      const systemPrompt = this.buildAnalyzeSystemPrompt();
      const userMessage = this.formatAnalyzeRequest(
        selectedTranscripts,
        transcriptIndex,
        requirements,
        rules
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

      const cost = this.calculateCost(response.usage);
      this.totalCost += cost;

      const result = JSON.parse(response.choices[0].message.content || '{}');

      return {
        overallScore: result.overallScore || 0,
        passRate: result.passRate || 0,
        scenarios: result.scenarios || [],
        generalSuggestions: result.generalSuggestions || [],
        needsAdditionalTranscripts: result.needsAdditionalTranscripts,
      };
    });
  }

  /**
   * Role 3: Refine Prompt
   */
  async refinePrompt(
    currentPrompt: string,
    analysis: Analysis,
    context: IterationContext
  ): Promise<RefineResult> {
    return this.rateLimiter.execute(async () => {
      const systemPrompt = this.buildRefineSystemPrompt();
      const userMessage = this.formatRefineRequest(
        currentPrompt,
        analysis,
        context
      );

      const response = await this.openai.chat.completions.create({
        model: this.config.models.refine,
        temperature: this.config.temperatures.refine,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        response_format: { type: 'json_object' },
      });

      const cost = this.calculateCost(response.usage);
      this.totalCost += cost;

      const result = JSON.parse(response.choices[0].message.content || '{}');

      return {
        refinedPrompt: result.prompt || currentPrompt,
        changes: result.changes || [],
        reasoning: result.reasoning || '',
        cost,
      };
    });
  }

  /**
   * Get total cost accumulated
   */
  getTotalCost(): number {
    return this.totalCost;
  }

  /**
   * Calculate cost based on token usage
   */
  private calculateCost(usage: any): number {
    if (!usage) return 0;

    // GPT-4o pricing: $2.50 per 1M input tokens, $10 per 1M output tokens
    const inputCost = (usage.prompt_tokens / 1_000_000) * 2.5;
    const outputCost = (usage.completion_tokens / 1_000_000) * 10;

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
    return this.config.instructions.analyze;
  }

  private buildRefineSystemPrompt(): string {
    return this.config.instructions.refine;
  }

  private formatGenerateRequest(
    task: Task,
    promptBank: PromptExample[],
    uploadedContext: string = ''
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

    if (uploadedContext) {
      message += `\n\n📎 REFERENCE MATERIALS:\n${uploadedContext}\n\nВАЖНО: Използвай uploaded reference materials като контекст при създаването на prompt-а.`;
    }

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
    rules: ValidationRules
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

    return `ИЗИСКВАНИЯ:
Роля: ${requirements.role}
Ограничения:
${requirements.constraints.map((c) => `- ${c}`).join('\n')}

VALIDATION RULES:
${rules.maxResponseLength ? `- Макс дължина: ${rules.maxResponseLength} chars` : ''}
${rules.forbiddenPhrases ? `- Забранени фрази: ${rules.forbiddenPhrases.join(', ')}` : ''}

TRANSCRIPT INDEX (всички scenarios):
${indexSummary}

FULL TRANSCRIPTS (failed + high severity):
${fullTranscripts}

Анализирай дали ботът следва изискванията и върни детайлна оценка.`;
  }

  private formatRefineRequest(
    currentPrompt: string,
    analysis: Analysis,
    context: IterationContext
  ): string {
    const failedScenarios = context.failedTranscripts
      .slice(0, 3)
      .map((t) => {
        const messages = t.messages
          .map((m) => `${m.role}: ${m.content}`)
          .join('\n');
        return `${t.scenarioName}:\n${messages}`;
      })
      .join('\n\n');

    const previousSummary =
      context.previousSummaries.length > 0
        ? context.previousSummaries
            .map(
              (s) =>
                `Iteration ${s.iteration}: Pass rate ${(s.passRate * 100).toFixed(0)}%, Main issues: ${s.mainIssues.join(', ')}`
            )
            .join('\n')
        : 'Няма предишни итерации';

    // Full issue details — rootCauseInPrompt + suggestion for every issue
    const allIssues = analysis.scenarios.flatMap((s) =>
      s.issues.map((i) => ({
        scenarioId: s.scenarioId,
        ...i,
      }))
    );
    const issueBlock = allIssues.length > 0
      ? allIssues.map((i) => `[${i.severity.toUpperCase()}] ${i.category} (${i.scenarioId})
  Problem   : ${i.description}
  Root cause: ${(i as any).rootCauseInPrompt ?? 'n/a'}
  Fix       : ${(i as any).suggestion ?? 'n/a'}`).join('\n\n')
      : 'No issues found.';

    return `CURRENT PROMPT:
${currentPrompt}

ANALYSIS RESULTS:
Quality Score : ${(analysis.overallScore * 100).toFixed(0)}%
Pass Rate     : ${(analysis.passRate * 100).toFixed(0)}%
Total Issues  : ${allIssues.length} (${allIssues.filter(i => i.severity === 'high').length} high, ${allIssues.filter(i => i.severity === 'medium').length} medium, ${allIssues.filter(i => i.severity === 'low').length} low)

DETAILED ISSUES (apply ALL fixes — do not skip low/medium):
${issueBlock}

GENERAL SUGGESTIONS (apply all):
${analysis.generalSuggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}

ITERATION HISTORY:
${previousSummary}

FAILED SCENARIO TRANSCRIPTS:
${failedScenarios || 'None — all scenarios passed.'}

INSTRUCTIONS:
Apply ALL fixes from the issues above (high → medium → low in priority order).
Each issue has a specific root cause and fix — implement them precisely in the prompt.
Do NOT rewrite everything — make surgical targeted edits.
Preserve what is already working.`;
  }
}
