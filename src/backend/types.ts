import { z } from 'zod';

// ========================================
// Task & Requirements
// ========================================

export const RequirementsSchema = z.object({
  role: z.string(),
  constraints: z.array(z.string()),
  tone: z.string().optional(),
  maxResponseLength: z.number().optional(),
});

export const TaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  requirements: RequirementsSchema,
  category: z.string(),
  uploadId: z.string().optional(),
});

export type Task = z.infer<typeof TaskSchema>;
export type Requirements = z.infer<typeof RequirementsSchema>;

// ========================================
// Test Plan & Scenarios
// ========================================

// v2 Driver: a single utterance in the Dialogue Blueprint
export const UserUtteranceSchema = z.object({
  id: z.string(),                                                              // "utt_01"
  text: z.string(),                                                            // original text
  group: z.enum(['opening', 'discovery', 'objections', 'close']),             // stage group
  useWhen: z.string().optional(),                                              // context hint
  maxUses: z.number().int().positive().default(1),
  canRephrase: z.boolean().default(true),
});

export type UserUtterance = z.infer<typeof UserUtteranceSchema>;

export const ScenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  // ── Legacy mode ──────────────────────────────────
  userMessages: z.array(z.string()).optional(),
  // ── Driver v1 (seed) — kept for backward compat ──
  seedUserMessages: z.array(z.string()).optional(),
  // ── Driver v2 (Dialogue Blueprint) ───────────────
  driverRole: z.string().optional(),       // who the AI Test Driver plays — USER side (e.g. "sales rep")
  situation: z.string().optional(),        // context of the encounter
  userUtterances: z.array(UserUtteranceSchema).optional(),  // 15-20 utterances for the user side
  // ── Shared driver fields ──────────────────────────
  userGoal: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),         // counts user (driver) turns — AC5
  stopRules: z.array(z.string()).optional(),
  expectedBehavior: z.string(),
});

export const TestPlanSchema = z.object({
  scenarios: z.array(ScenarioSchema),
});

export type Scenario = z.infer<typeof ScenarioSchema>;
export type TestPlan = z.infer<typeof TestPlanSchema>;

// ========================================
// Transcripts & Messages
// ========================================

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// Log entry for each utterance selection made by the driver (v2)
export interface UtteranceUsage {
  utteranceId: string;
  originalText: string;
  actualMessage: string;   // may be rephrased
  rephrased: boolean;
  turnIndex: number;       // 0-based user turn index
  group: string;
}

export interface Transcript {
  scenarioId: string;
  scenarioName: string;
  expectedBehavior: string;
  // Bot Under Test is always assistant (system = prompt) — AC2
  messages: Message[];
  timestamp: number;
  // Driver metadata
  driverMode: boolean;
  // v1 fields (kept for compat)
  seedUserMessages?: string[];
  generatedUserMessages?: string[];
  // v2 fields
  utteranceLog?: UtteranceUsage[];
  maxTurns?: number;
  stopReason?: string;
  userGoal?: string;
  totalUserTurns?: number;
}

// ========================================
// Analysis & Issues
// ========================================

export type IssueSeverity = 'low' | 'medium' | 'high';

export interface Issue {
  severity: IssueSeverity;
  category: string;
  description: string;
  suggestion: string;
}

export interface ScenarioAnalysis {
  scenarioId: string;
  passed: boolean;
  issues: Issue[];
}

export type DeltaChange = 'improved' | 'regressed' | 'unchanged' | 'new';

export interface ScenarioDelta {
  scenarioId: string;
  change: DeltaChange;
  previousPassed?: boolean;
  currentPassed: boolean;
  previousIssueCount?: number;
  currentIssueCount: number;
  description: string;
}

export interface Analysis {
  overallScore: number;
  passRate: number;
  scenarios: ScenarioAnalysis[];
  generalSuggestions: string[];
  delta?: {
    improvements: number;
    regressions: number;
    unchanged: number;
    changes: ScenarioDelta[];
  };
  needsAdditionalTranscripts?: string[];
}

// ========================================
// Validation Rules
// ========================================

export interface ValidationRules {
  maxResponseLength?: number;
  forbiddenPhrases?: string[];
  requiredElements?: string[];
}

export interface Violation {
  type: string;
  scenarioId: string;
  message: string;
  value: any;
}

export interface RuleValidationResult {
  passed: boolean;
  violations: Violation[];
}

// ========================================
// Transcript Index (Context Management)
// ========================================

export interface TranscriptIndexEntry {
  scenarioId: string;
  scenarioName: string;
  passed: boolean;
  severityTags: string[];
  summary: string;
  messageCount: number;
  tokenEstimate: number;
  hasHighSeverity: boolean;
}

export interface TranscriptIndex {
  scenarios: TranscriptIndexEntry[];
}

// ========================================
// Iteration Summary
// ========================================

export interface IterationSummary {
  iteration: number;
  passRate: number;
  passedCount: number;
  totalCount: number;
  highSeverityCount: number;
  mainIssues: string[];
  changesApplied: string[];
  cost: number;
  delta?: {
    improvements: number;
    regressions: number;
    unchanged: number;
  };
}

// ========================================
// Orchestrator Configuration
// ========================================

export const ModelConfigSchema = z.object({
  generate: z.string(),
  test: z.string(),
  testDriver: z.string().default('gpt-4o-mini'),
  analyze: z.string(),
  refine: z.string(),
});

export const TemperatureConfigSchema = z.object({
  generate: z.number().min(0).max(2),
  test: z.number().min(0).max(2),
  testDriver: z.number().min(0).max(2).default(0.4),
  analyze: z.number().min(0).max(2),
  refine: z.number().min(0).max(2),
});

export const StopConditionsSchema = z.object({
  minPassRate: z.number().min(0).max(1),
  consecutiveSuccesses: z.number().int().positive(),
  minImprovement: z.number().min(0),
  maxHighSeverityIssues: z.number().int().min(0),
});

export const ValidationConfigSchema = z.object({
  rulesEnabled: z.boolean(),
  llmEnabled: z.boolean(),
  rulesPath: z.string(),
});

export const TestingConfigSchema = z.object({
  testTemperature: z.number().min(0).max(2),
  stressMode: z.boolean(),
  parallelScenarios: z.boolean(),
  conversationTimeout: z.number().int().positive(),
  scenariosCount: z.number().int().positive().optional(),
  turnsPerScenario: z.object({
    min: z.number().int().positive(),
    max: z.number().int().positive(),
  }).optional(),
  maxTurnsDriverMode: z.number().int().positive().default(20),
  driverContextWindowExchanges: z.number().int().positive().default(2),
});

export const CostsConfigSchema = z.object({
  budgetPerRun: z.number().positive(),
  warnThreshold: z.number().positive(),
});

export const InstructionsConfigSchema = z.object({
  generate: z.string(),
  analyze: z.string(),
  refine: z.string(),
  testDriver: z.string().default(''),
});

export const OrchestratorConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  models: ModelConfigSchema,
  temperatures: TemperatureConfigSchema,
  maxIterations: z.number().int().positive(),
  stopConditions: StopConditionsSchema,
  validation: ValidationConfigSchema,
  testing: TestingConfigSchema,
  costs: CostsConfigSchema,
  promptBank: z.string(),
  instructions: InstructionsConfigSchema,
});

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;
export type InstructionsConfig = z.infer<typeof InstructionsConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type TemperatureConfig = z.infer<typeof TemperatureConfigSchema>;
export type StopConditions = z.infer<typeof StopConditionsSchema>;

// ========================================
// Run Metadata
// ========================================

export type RunStatus = 'running' | 'success' | 'max_iterations' | 'error';

export interface RunMetadata {
  runId: string;
  orchestratorId: string;
  taskId: string;
  status: RunStatus;
  startedAt: number;
  completedAt?: number;
  currentIteration: number;
  finalScore?: number;
  totalCost?: number;
  uploadId?: string;
  uploadedFiles?: string[];
}

// ========================================
// Iteration Data
// ========================================

export interface IterationData {
  prompt: string;
  testDriverPrompt?: string;
  testPlan?: TestPlan;
  transcripts: Transcript[];
  transcriptIndex: TranscriptIndex;
  ruleValidation: RuleValidationResult;
  llmAnalysis: Analysis;
  summary: IterationSummary;
}

// ========================================
// Context for Refining
// ========================================

export interface IterationContext {
  currentAnalysis: Analysis;
  transcriptIndex: TranscriptIndex;
  previousSummaries: IterationSummary[];
  failedTranscripts: Transcript[];
  passedSample: Transcript[];
}

// ========================================
// Results from Lead Agent
// ========================================

export interface GenerateResult {
  prompt: string;
  testPlan: TestPlan;
  reasoning: string;
  cost: number;
}

export interface RefineResult {
  refinedPrompt: string;
  changes: string[];
  reasoning: string;
  cost: number;
}

// ========================================
// Prompt Bank Entry
// ========================================

export interface PromptExample {
  id: string;
  category: string;
  name: string;
  prompt: string;
  notes: string;
  rating?: number;
  testResults?: {
    passRate: number;
    iterations: number;
  };
}

// ========================================
// Run Result
// ========================================

export interface RunResult {
  runId: string;
  status: RunStatus;
  finalPrompt: string;
  finalScore: number;
  totalIterations: number;
  totalCost: number;
  duration: number;
}

// ========================================
// Orchestrator Info (for listing)
// ========================================

export interface OrchestratorInfo {
  id: string;
  name: string;
  category?: string;
}
