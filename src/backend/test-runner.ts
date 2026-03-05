import OpenAI from 'openai';
import {
  TestPlan,
  Transcript,
  UtteranceUsage,
  Message,
  Scenario,
  UserUtterance,
  OrchestratorConfig,
} from './types';

// Fallback messages when driver model fails or returns invalid output (AC6)
const DRIVER_FALLBACK_MESSAGES = [
  'Разбирам. Какво друго можете да ми кажете по темата?',
  'Интересно. Нека продължим — имате ли нещо конкретно предвид?',
  'Добре. Как стоят нещата от ваша страна?',
  'Ясно. Има ли нещо важно, което трябва да обсъдим?',
  'Нека продължим. Какво е следващата стъпка за вас?',
];

// ── Driver result types ───────────────────────────────────────────────────

interface DriverResultContinue {
  stop: false;
  message: string;
  utteranceId?: string;
  rephrased?: boolean;
}

interface DriverResultStop {
  stop: true;
  stopReason: string;
}

type DriverResult = DriverResultContinue | DriverResultStop;

// ─────────────────────────────────────────────────────────────────────────

export class TestRunner {
  private openai: OpenAI;
  private config: OrchestratorConfig;
  private stressModeOverride: boolean;

  constructor(
    apiKey: string,
    config: OrchestratorConfig,
    stressModeOverride = false
  ) {
    this.openai = new OpenAI({ apiKey });
    this.config = config;
    this.stressModeOverride = stressModeOverride;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Public entry point
  // ─────────────────────────────────────────────────────────────────────

  async runTests(prompt: string, testPlan: TestPlan): Promise<Transcript[]> {
    const transcripts: Transcript[] = [];
    console.log(`  Running ${testPlan.scenarios.length} test scenarios...`);

    for (const scenario of testPlan.scenarios) {
      const mode = this.detectMode(scenario);
      console.log(`    → ${scenario.name} [${mode}]...`);

      let transcript: Transcript;
      if (mode === 'v2') {
        transcript = await this.runV2Scenario(prompt, scenario);
      } else if (mode === 'v1') {
        transcript = await this.runV1Scenario(prompt, scenario);
      } else {
        transcript = await this.runLegacyScenario(prompt, scenario);
      }
      transcripts.push(transcript);
    }

    return transcripts;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Mode detection
  // ─────────────────────────────────────────────────────────────────────

  private detectMode(scenario: Scenario): 'v2' | 'v1' | 'legacy' {
    if (Array.isArray(scenario.userUtterances) && scenario.userUtterances.length > 0) return 'v2';
    if (Array.isArray(scenario.seedUserMessages) && scenario.seedUserMessages.length > 0) return 'v1';
    return 'legacy';
  }

  // ─────────────────────────────────────────────────────────────────────
  // v2: Dialogue Blueprint — contextual utterance selection
  // AC2: Bot Under Test is always assistant (system = prompt)
  // AC3: AI Test Driver is always user
  // AC5: maxTurns counts user (driver) turns
  // AC6: Driver does not stop early unless stopRules or maxTurns
  // ─────────────────────────────────────────────────────────────────────

  private async runV2Scenario(prompt: string, scenario: Scenario): Promise<Transcript> {
    // AC2: Bot Under Test loaded with system prompt
    const conversation: Message[] = [{ role: 'system', content: prompt }];
    const utteranceLog: UtteranceUsage[] = [];
    // Track how many times each utterance has been used
    const usageCount = new Map<string, number>();
    const maxTurns = scenario.maxTurns ?? this.config.testing.maxTurnsDriverMode ?? 20;
    const testTemp = this.getBotTemperature();
    let stopReason = 'max_turns_reached';

    // AC5: loop counts user turns
    for (let userTurn = 0; userTurn < maxTurns; userTurn++) {
      // Available = utterances not yet exhausted
      const available = (scenario.userUtterances ?? []).filter(u => {
        const used = usageCount.get(u.id) ?? 0;
        return used < (u.maxUses ?? 1);
      });

      // AC3: driver call produces user message
      const driverResult = await this.callV2DriverModel(
        scenario,
        conversation,
        available,
        userTurn + 1,
      );

      // AC6: only stop on explicit stopRules or maxTurns
      if (driverResult.stop) {
        stopReason = driverResult.stopReason;
        console.log(`      ✓ Driver stopped at user turn ${userTurn + 1}: ${stopReason}`);
        break;
      }

      // Record utterance usage
      if (driverResult.utteranceId) {
        const count = usageCount.get(driverResult.utteranceId) ?? 0;
        usageCount.set(driverResult.utteranceId, count + 1);
        const original = (scenario.userUtterances ?? []).find(u => u.id === driverResult.utteranceId);
        if (original) {
          utteranceLog.push({
            utteranceId: driverResult.utteranceId,
            originalText: original.text,
            actualMessage: driverResult.message,
            rephrased: driverResult.rephrased ?? (driverResult.message.trim() !== original.text.trim()),
            turnIndex: userTurn,
            group: original.group,
          });
        }
      } else {
        // Improvised turn — no utteranceId
        utteranceLog.push({
          utteranceId: 'improvised',
          originalText: '',
          actualMessage: driverResult.message,
          rephrased: false,
          turnIndex: userTurn,
          group: 'improvised',
        });
      }

      // AC3: driver message is user role
      conversation.push({ role: 'user', content: driverResult.message });
      // AC2: bot under test responds as assistant
      const botReply = await this.callBotModel(conversation, testTemp);
      conversation.push({ role: 'assistant', content: botReply });
    }

    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      expectedBehavior: scenario.expectedBehavior,
      messages: conversation.filter(m => m.role !== 'system'),
      timestamp: Date.now(),
      driverMode: true,
      utteranceLog,
      maxTurns,
      stopReason,
      userGoal: scenario.userGoal,
      totalUserTurns: utteranceLog.length,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // v2 driver model call
  // ─────────────────────────────────────────────────────────────────────

  private async callV2DriverModel(
    scenario: Scenario,
    conversation: Message[],
    availableUtterances: UserUtterance[],
    userTurnNumber: number,
  ): Promise<DriverResult> {
    const driverPrompt = this.config.instructions.testDriver;
    if (!driverPrompt) {
      return { stop: false, message: this.getFallback(userTurnNumber) };
    }

    const contextWindow = this.config.testing.driverContextWindowExchanges ?? 2;
    const nonSystem = conversation.filter(m => m.role !== 'system');
    const recent = nonSystem.slice(-(contextWindow * 2));
    const recentConversation = recent
      .map(m => `${m.role === 'user' ? 'You' : 'Bot'}: ${m.content}`)
      .join('\n');
    const lastBotReply = nonSystem.filter(m => m.role === 'assistant').at(-1)?.content ?? '';

    // Compact utterance payload — only unused
    const utterancePayload = availableUtterances.map(u => ({
      id: u.id,
      text: u.text,
      group: u.group,
      ...(u.useWhen ? { useWhen: u.useWhen } : {}),
      canRephrase: u.canRephrase ?? true,
    }));

    const input = {
      driverRole: scenario.driverRole ?? '',
      situation: scenario.situation ?? '',
      goal: scenario.userGoal ?? '',
      stopRules: scenario.stopRules ?? [],
      availableUtterances: utterancePayload,
      lastBotReply,
      recentConversation,
      userTurnNumber,
      remainingTurns: (scenario.maxTurns ?? this.config.testing.maxTurnsDriverMode ?? 20) - userTurnNumber,
    };

    try {
      const response = await this.openai.chat.completions.create({
        model: this.config.models.testDriver ?? 'gpt-4o-mini',
        temperature: this.getDriverTemperature(),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: driverPrompt },
          { role: 'user', content: JSON.stringify(input) },
        ],
        max_tokens: 400,
      });

      const raw = response.choices[0].message.content ?? '';
      return this.parseV2Result(raw, userTurnNumber);
    } catch (error) {
      console.warn(`      ⚠ Driver error at user turn ${userTurnNumber}: ${(error as Error).message}`);
      return { stop: false, message: this.getFallback(userTurnNumber) };
    }
  }

  private parseV2Result(raw: string, userTurnNumber: number): DriverResult {
    try {
      const parsed = JSON.parse(raw);

      // Stop case — AC6: only accept stop if stopRules/natural end, not laziness
      if (parsed.stop === true) {
        const reason = typeof parsed.stopReason === 'string' && parsed.stopReason.trim().length > 0
          ? parsed.stopReason.trim()
          : 'conversation_complete';
        return { stop: true, stopReason: reason };
      }

      // Continue case — validate message
      const msg = parsed.message;
      if (typeof msg !== 'string' || msg.trim().length === 0) {
        console.warn(`      ⚠ Driver empty message at user turn ${userTurnNumber}, using fallback`);
        return { stop: false, message: this.getFallback(userTurnNumber) };
      }
      const trimmed = msg.trim();
      if (trimmed.length > 600) {
        console.warn(`      ⚠ Driver message too long (${trimmed.length} chars), truncating`);
        return {
          stop: false,
          message: trimmed.substring(0, 600),
          utteranceId: parsed.utteranceId,
          rephrased: parsed.rephrased ?? false,
        };
      }

      return {
        stop: false,
        message: trimmed,
        utteranceId: typeof parsed.utteranceId === 'string' ? parsed.utteranceId : undefined,
        rephrased: parsed.rephrased === true,
      };
    } catch {
      console.warn(`      ⚠ Driver invalid JSON at user turn ${userTurnNumber}, using fallback`);
      return { stop: false, message: this.getFallback(userTurnNumber) };
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // v1: seed → free improvise (backward compat, no removal)
  // ─────────────────────────────────────────────────────────────────────

  private async runV1Scenario(prompt: string, scenario: Scenario): Promise<Transcript> {
    const conversation: Message[] = [{ role: 'system', content: prompt }];
    const generatedMsgs: string[] = [];
    const seedMsgs = scenario.seedUserMessages ?? [];
    const maxTurns = scenario.maxTurns ?? this.config.testing.maxTurnsDriverMode ?? 20;
    const testTemp = this.getBotTemperature();
    let stopReason = 'max_turns_reached';

    // Send seed messages first
    for (const userMsg of seedMsgs) {
      conversation.push({ role: 'user', content: userMsg });
      const botReply = await this.callBotModel(conversation, testTemp);
      conversation.push({ role: 'assistant', content: botReply });
    }

    // Free driver from turn (seedMsgs.length) to maxTurns
    for (let userTurn = seedMsgs.length; userTurn < maxTurns; userTurn++) {
      const driverResult = await this.callV1DriverModel(scenario, conversation, userTurn + 1);
      if (driverResult.stop) {
        stopReason = driverResult.stopReason;
        break;
      }
      generatedMsgs.push(driverResult.message);
      conversation.push({ role: 'user', content: driverResult.message });
      const botReply = await this.callBotModel(conversation, testTemp);
      conversation.push({ role: 'assistant', content: botReply });
    }

    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      expectedBehavior: scenario.expectedBehavior,
      messages: conversation.filter(m => m.role !== 'system'),
      timestamp: Date.now(),
      driverMode: true,
      seedUserMessages: seedMsgs,
      generatedUserMessages: generatedMsgs,
      maxTurns,
      stopReason,
      userGoal: scenario.userGoal,
      totalUserTurns: seedMsgs.length + generatedMsgs.length,
    };
  }

  private async callV1DriverModel(
    scenario: Scenario,
    conversation: Message[],
    userTurnNumber: number,
  ): Promise<DriverResult> {
    const driverPrompt = this.config.instructions.testDriver;
    if (!driverPrompt) return { stop: false, message: this.getFallback(userTurnNumber) };

    const contextWindow = this.config.testing.driverContextWindowExchanges ?? 2;
    const nonSystem = conversation.filter(m => m.role !== 'system');
    const recent = nonSystem.slice(-(contextWindow * 2));
    const recentContext = recent.map(m => `${m.role === 'user' ? 'You' : 'Bot'}: ${m.content}`).join('\n');
    const lastBotReply = nonSystem.filter(m => m.role === 'assistant').at(-1)?.content ?? '';

    try {
      const response = await this.openai.chat.completions.create({
        model: this.config.models.testDriver ?? 'gpt-4o-mini',
        temperature: this.getDriverTemperature(),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: driverPrompt },
          {
            role: 'user',
            content: JSON.stringify({
              scenarioName: scenario.name,
              expectedBehavior: scenario.expectedBehavior,
              userGoal: scenario.userGoal ?? '',
              stopRules: scenario.stopRules ?? [],
              lastBotReply,
              recentContext,
              userTurnNumber,
            }),
          },
        ],
        max_tokens: 300,
      });
      const raw = response.choices[0].message.content ?? '';
      return this.parseV2Result(raw, userTurnNumber);
    } catch {
      return { stop: false, message: this.getFallback(userTurnNumber) };
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Legacy: fixed userMessages array
  // ─────────────────────────────────────────────────────────────────────

  private async runLegacyScenario(prompt: string, scenario: Scenario): Promise<Transcript> {
    const conversation: Message[] = [{ role: 'system', content: prompt }];
    const testTemp = this.getBotTemperature();

    for (const userMsg of scenario.userMessages ?? []) {
      conversation.push({ role: 'user', content: userMsg });
      try {
        const response = await this.openai.chat.completions.create({
          model: this.config.models.test,
          messages: conversation,
          temperature: testTemp,
          max_tokens: 1000,
        });
        conversation.push({ role: 'assistant', content: response.choices[0].message.content || '' });
      } catch (error) {
        conversation.push({ role: 'assistant', content: `[ERROR: ${(error as Error).message}]` });
      }
    }

    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      expectedBehavior: scenario.expectedBehavior,
      messages: conversation.filter(m => m.role !== 'system'),
      timestamp: Date.now(),
      driverMode: false,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Shared helpers
  // ─────────────────────────────────────────────────────────────────────

  private async callBotModel(conversation: Message[], temperature: number): Promise<string> {
    try {
      const response = await this.openai.chat.completions.create({
        model: this.config.models.test,
        messages: conversation,
        temperature,
        max_tokens: 1000,
      });
      return response.choices[0].message.content || '';
    } catch (error) {
      console.error(`      ✗ Bot model error: ${(error as Error).message}`);
      return `[ERROR: ${(error as Error).message}]`;
    }
  }

  private getBotTemperature(): number {
    if (this.stressModeOverride || this.config.testing.stressMode) return 0.9;
    return this.config.temperatures.test;
  }

  private getDriverTemperature(): number {
    if (this.stressModeOverride || this.config.testing.stressMode) return 0.85;
    return this.config.temperatures.testDriver ?? 0.4;
  }

  private getFallback(userTurnNumber: number): string {
    return DRIVER_FALLBACK_MESSAGES[userTurnNumber % DRIVER_FALLBACK_MESSAGES.length];
  }

  isStressMode(): boolean {
    return this.stressModeOverride || this.config.testing.stressMode;
  }
}
