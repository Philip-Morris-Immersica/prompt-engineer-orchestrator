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
    promptBank: PromptExample[]
  ): Promise<GenerateResult> {
    return this.rateLimiter.execute(async () => {
      const systemPrompt = this.buildGenerateSystemPrompt();
      const userMessage = this.formatGenerateRequest(task, promptBank);

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
  // Prompt Templates
  // ========================================

  private buildGenerateSystemPrompt(): string {
    const scenariosCount = this.config.testing.scenariosCount || 4;
    const turnsMin = this.config.testing.turnsPerScenario?.min || 4;
    const turnsMax = this.config.testing.turnsPerScenario?.max || 6;
    
    return `Ти си expert prompt engineer. Твоята задача е да създадеш висококачествен промпт за чатбот.

ВАЖНО: Винаги върни валиден JSON в точно този формат:
{
  "prompt": "System prompt text here...",
  "testPlan": {
    "scenarios": [
      {
        "id": "scenario_01",
        "name": "Scenario name",
        "userMessages": ["message 1", "message 2", "message 3", "message 4"],
        "expectedBehavior": "What should happen"
      }
    ]
  },
  "reasoning": "Explanation of your approach..."
}

При създаването на промпта:
1. Бъди ясен и конкретен
2. Дефинирай ясно ролята на бота
3. Задай ограничения (constraints)
4. Дай примери за правилно поведение
5. Обясни какво НЕ трябва да прави ботът

При създаването на test plan:
КРИТИЧНО: Създай ТОЧНО ${scenariosCount} scenarios (не повече, не по-малко)
Всеки scenario трябва да има ${turnsMin}-${turnsMax} user messages (turns)
Сценариите трябва да са:
1. Реалистични и фокусирани
2. Да покриват edge cases
3. Да тестват ограниченията
4. Да проверят дали ботът остава в роля

ВАЖНО: Тези ${scenariosCount} scenarios ще се използват през целия refinement процес. Избери ги внимателно да покриват най-важното.`;
  }

  private buildAnalyzeSystemPrompt(): string {
    return `Ти си експерт по анализ на чатбот разговори. Анализирай дали ботът следва изискванията.

ВАЖНО: Винаги върни валиден JSON в точно този формат:
{
  "overallScore": 0.85,
  "passRate": 0.75,
  "scenarios": [
    {
      "scenarioId": "scenario_01",
      "passed": true,
      "issues": [
        {
          "severity": "high",
          "category": "out_of_role",
          "description": "Description of issue",
          "suggestion": "How to fix it"
        }
      ]
    }
  ],
  "generalSuggestions": ["suggestion 1", "suggestion 2"]
}

ФОКУС: Тестовете са малко на брой (3-4 scenarios) но са фиксирани за целия run.
Всеки сценарий е внимателно избран да тества критични аспекти.
Дори 1 failing scenario е 25-33% от общия резултат, така че бъди прецизен.

Категории за severity:
- "high": Критични проблеми (излиза от роля, вреден контент, игнорира основни constraints)
- "medium": Важни но не критични (твърде дълъг отговор, тон не съответства)
- "low": Малки подобрения (форматиране, стил)

Категории за issues:
- "out_of_role": Ботът излиза от зададената роля
- "forbidden_content": Използва забранени фрази или дава забранена информация
- "constraint_violation": Нарушава зададени ограничения
- "tone_mismatch": Тонът не съответства на изискванията
- "incomplete_response": Непълен или неясен отговор
- "response_too_long": Прекалено дълъг отговор`;
  }

  private buildRefineSystemPrompt(): string {
    return `Ти си expert prompt engineer. Подобри промпта базирано на test резултатите.

ВАЖНО: Винаги върни валиден JSON в точно този формат:
{
  "prompt": "Improved system prompt here...",
  "changes": ["change 1", "change 2", "change 3"],
  "reasoning": "Why these changes will improve the prompt..."
}

При подобряването:
1. Фокусирай се върху проблемите с high severity
2. Бъди конкретен и директен
3. Не добавяй излишна сложност
4. Запази работещите части от текущия prompt
5. Ако нещо работи добре, не го променяй`;
  }

  private formatGenerateRequest(
    task: Task,
    promptBank: PromptExample[]
  ): string {
    const examples = promptBank
      .slice(0, 3)
      .map(
        (ex, i) =>
          `Пример ${i + 1}: ${ex.name}\n${ex.prompt}\n(Rating: ${ex.rating || 'N/A'})`
      )
      .join('\n\n');

    return `ЗАДАЧА:
${task.description}

ИЗИСКВАНИЯ:
Роля: ${task.requirements.role}
Ограничения:
${task.requirements.constraints.map((c) => `- ${c}`).join('\n')}
${task.requirements.tone ? `Тон: ${task.requirements.tone}` : ''}
${task.requirements.maxResponseLength ? `Макс дължина отговор: ${task.requirements.maxResponseLength} chars` : ''}

${promptBank.length > 0 ? `ПРИМЕРИ ОТ PROMPT BANK:\n${examples}` : ''}

Създай system prompt за чатбота и test plan с 6-8 scenarios.`;
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

    return `CURRENT PROMPT:
${currentPrompt}

ANALYSIS:
Pass Rate: ${(analysis.passRate * 100).toFixed(0)}%
Overall Score: ${(analysis.overallScore * 100).toFixed(0)}%
Issues: ${analysis.scenarios.flatMap((s) => s.issues).length} total

Top Issues:
${analysis.scenarios
  .flatMap((s) =>
    s.issues.map((i) => `- [${i.severity}] ${i.category}: ${i.description}`)
  )
  .slice(0, 5)
  .join('\n')}

Suggestions:
${analysis.generalSuggestions.map((s) => `- ${s}`).join('\n')}

CONTEXT (последни итерации):
${previousSummary}

FAILED SCENARIOS:
${failedScenarios}

Подобри промпта за да реши проблемите. Фокусирай се върху high severity issues.`;
  }
}
