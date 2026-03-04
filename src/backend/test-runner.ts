import OpenAI from 'openai';
import {
  TestPlan,
  Transcript,
  Message,
  Scenario,
  OrchestratorConfig,
} from './types';

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

  /**
   * Run all test scenarios and return transcripts
   */
  async runTests(prompt: string, testPlan: TestPlan): Promise<Transcript[]> {
    const transcripts: Transcript[] = [];

    console.log(`  Running ${testPlan.scenarios.length} test scenarios...`);

    for (const scenario of testPlan.scenarios) {
      console.log(`    → ${scenario.name}...`);
      const messages = await this.runScenario(prompt, scenario);

      transcripts.push({
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        expectedBehavior: scenario.expectedBehavior,
        messages,
        timestamp: Date.now(),
      });
    }

    return transcripts;
  }

  /**
   * Run a single scenario
   */
  private async runScenario(
    prompt: string,
    scenario: Scenario
  ): Promise<Message[]> {
    const conversation: Message[] = [{ role: 'system', content: prompt }];

    // Determine temperature
    const testTemp = this.getTestTemperature();

    for (const userMsg of scenario.userMessages) {
      conversation.push({ role: 'user', content: userMsg });

      try {
        const response = await this.openai.chat.completions.create({
          model: this.config.models.test,
          messages: conversation,
          temperature: testTemp,
          max_tokens: 1000,
        });

        const botReply = response.choices[0].message.content || '';
        conversation.push({ role: 'assistant', content: botReply });
      } catch (error) {
        console.error(
          `    ✗ Error in scenario ${scenario.id}: ${(error as Error).message}`
        );
        // Add error as assistant message
        conversation.push({
          role: 'assistant',
          content: `[ERROR: ${(error as Error).message}]`,
        });
      }
    }

    // Remove system message from transcript (only user-assistant)
    return conversation.filter((m) => m.role !== 'system');
  }

  /**
   * Get test temperature based on config and stress mode
   */
  private getTestTemperature(): number {
    if (this.stressModeOverride || this.config.testing.stressMode) {
      return 0.9; // Stress mode
    }
    return this.config.temperatures.test; // Default 0.2
  }

  /**
   * Check if stress mode is enabled
   */
  isStressMode(): boolean {
    return this.stressModeOverride || this.config.testing.stressMode;
  }
}
