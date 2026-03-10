import { z } from 'zod';

// ========================================
// Task & Requirements
// ========================================

export const RequirementsSchema = z.object({
  role: z.string().optional().default(''),
  constraints: z.array(z.string()).optional().default([]),
  tone: z.string().optional(),
  maxResponseLength: z.number().optional(),
});

export const TaskSchema = z.object({
  id: z.string().optional().default(() => `task_${Date.now()}`),
  name: z.string().optional().default('Bot'),
  description: z.string(),
  requirements: RequirementsSchema.optional().default({}),
  category: z.string().optional().default('assistant'),
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
// Section Taxonomy
// ========================================

export const UNIVERSAL_SECTIONS = [
  'ROLE',
  'SITUATION',
  'DEFAULT_POSTURE',
  'ADAPTATION_RULES',
  'CONSTRAINTS',
  'LANGUAGE_STYLE',
  'OUT_OF_ROLE_PROTECTION',
] as const;

export const ROLEPLAY_EXTENSION_SECTIONS = [
  'OPENING_BEHAVIOR',
  'DISCLOSURE_LOGIC',
  'OBJECTION_LOGIC',
] as const;

export type UniversalSection = typeof UNIVERSAL_SECTIONS[number];
export type RoleplaySection = typeof ROLEPLAY_EXTENSION_SECTIONS[number];

// ========================================
// Evaluation Dimensions & Rubrics
// ========================================

export const UNIVERSAL_DIMENSIONS = [
  'role_consistency',
  'naturalness',
  'constraint_adherence',
  'conversational_appropriateness',
] as const;

export const DEFAULT_DIMENSION_RUBRICS: Record<string, Record<string, string>> = {
  role_consistency: {
    '1': 'Frequently breaks character, contradicts persona, sounds like a generic AI',
    '3': 'Mostly in character but with occasional inconsistencies or generic moments',
    '5': 'Fully in character throughout — sounds like a specific, believable person',
  },
  naturalness: {
    '1': 'Sounds robotic, scripted, or like a template response engine',
    '3': 'Generally natural but with occasional stiff or formulaic turns',
    '5': 'Fully natural — indistinguishable from a real conversation with that person',
  },
  constraint_adherence: {
    '1': 'Repeatedly violates explicit constraints from the system prompt',
    '3': 'Follows most constraints but misses some or applies them inconsistently',
    '5': 'Respects all hard constraints without exception',
  },
  conversational_appropriateness: {
    '1': 'Responses consistently miss context — wrong length, tone, or timing',
    '3': 'Generally appropriate but with some contextually off responses',
    '5': 'Every response fits the conversational context perfectly',
  },
};

export interface DimensionScore {
  score: number;           // integer 1-5
  vsChampion: 'better' | 'same' | 'worse' | 'n/a';
  evidence: string;        // quote or reference from transcript
}

export interface BehavioralMetrics {
  questionRatio: number;          // % of bot turns containing "?"
  counterQuestionsCount: number;  // bot turns with counter-questions
  earlyDisclosureCount: number;   // details shared in first 3 bot turns
  avgResponseLength: number;      // average chars per bot response
  conversationLength: number;     // total turns
}

// ========================================
// Analysis & Issues
// ========================================

export type IssueSeverity = 'low' | 'medium' | 'high';

export type ScenarioVerdict = 'pass' | 'fail' | 'mixed' | 'not_evaluable';

export type RootCauseArea =
  | 'role_consistency'
  | 'openness_progression'
  | 'objection_behavior'
  | 'tone_and_reserve'
  | 'response_length'
  | 'information_disclosure'
  | 'constraint_adherence'
  | 'other';

export interface Issue {
  severity: IssueSeverity;
  category: string;
  description: string;
  improvementDirection: string;  // behavioral, directional — not prescriptive
  rootCauseArea: RootCauseArea;  // diagnostic category
  // legacy — kept for backward compat with old runs
  suggestion?: string;
}

export interface ScenarioAnalysis {
  scenarioId: string;
  verdict: ScenarioVerdict;      // pass / fail / mixed / not_evaluable
  passed: boolean;               // backward compat: true when verdict === 'pass'
  strengths: string[];           // what is working well — do not change
  issues: Issue[];
  dimensionScores?: Record<string, DimensionScore>;
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

export interface TestQualityObservations {
  overallQuality: 'good' | 'medium' | 'weak';
  isChallengingEnough: boolean;
  isRealistic: boolean;
  notes: string[];
  suggestedImprovementsForNextRun?: string[];
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
  testQualityObservations?: TestQualityObservations;
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
// Refinement Modes & Verdicts
// ========================================

export type RefinementMode = 'restructure' | 'surgical';
export type PromptVerdict = 'baseline' | 'improvement' | 'regression' | 'best_so_far' | 'rejected';

// ========================================
// Prompt Ledger
// ========================================

export interface PromptLedgerEntry {
  iteration: number;
  score: number;
  passRate: number;
  highSeverityCount: number;
  mediumSeverityCount: number;
  verdict: PromptVerdict;
  isChampion: boolean;
  mode: RefinementMode;
  promptPath: string;      // e.g. "iterations/03/prompt.txt"
  promptHash: string;      // sha1 for quick diff checking
  promptSummary?: string;  // optional 1-2 sentence summary for UI
  dimensionProfile?: Record<string, number>;  // avg score per dimension
}

export interface PromptLedger {
  runId: string;
  championIteration: number;
  championScore: number;
  championPassRate: number;
  championHighSeverityCount: number;
  entries: PromptLedgerEntry[];
}

// ========================================
// Change Plan & Impact
// ========================================

export type ChangeScope = 'small' | 'medium' | 'large';

export interface PlannedChange {
  id: string;               // "c1", "c2", ...
  targetSection: string;    // must reference section from taxonomy
  description: string;      // what is being changed
  hypothesis: string;       // why + expected effect
  scope?: ChangeScope;      // budget category
}

export interface ChangePlan {
  iteration: number;                    // the candidate iteration this plan is for
  basedOnChampionIteration: number;     // which champion version we start from
  basedOnCandidateIteration?: number;   // previous candidate (for context)
  mode: RefinementMode;
  diagnosis: string;                    // what was observed
  decisionRationale: string;            // why this strategy (refine candidate vs revert to champion)
  plannedChanges: PlannedChange[];
}

export type AttributionMode = 'direct' | 'likely' | 'mixed' | 'unclear';

export interface ChangeImpactEntry {
  changeId: string;
  verdict: 'helped' | 'hurt' | 'neutral' | 'unknown';
  evidence: string;
  attributionMode?: AttributionMode;
  dimensionDeltas?: Record<string, { before: number; after: number; delta: number }>;
}

export interface ChangeImpact {
  iteration: number;                // SAME iteration as the ChangePlan
  newScore: number;
  newPassRate: number;
  newHighSeverityCount: number;
  previousChampionScore: number;
  becameChampion: boolean;
  overallVerdict: 'improvement' | 'regression' | 'neutral';
  changeImpacts: ChangeImpactEntry[];
  dimensionProfile?: Record<string, number>;  // avg score per dimension across scenarios
}

export interface ChangeLedgerEntry {
  iteration: number;
  plan: ChangePlan;
  impact?: ChangeImpact;    // undefined until tested
}

export interface ChangeLedger {
  runId: string;
  entries: ChangeLedgerEntry[];
}

// ========================================
// Test Asset Meta (versioning + quality)
// ========================================

export interface TestAssetMeta {
  runId: string;
  generatedAt: number;
  testDriverPromptVersion: string;    // hash of test driver prompt
  testPlanVersion: string;            // hash of test plan JSON
  scenarioBlueprintVersion: string;   // hash of utterances
  scenarioCount: number;
  testDriverPromptPath: string;       // "test_driver_prompt.txt" at run level
  testPlanPath: string;               // "test_plan.json" at run level
  qualityObservations: Array<{
    iteration: number;
    quality: 'good' | 'medium' | 'weak';
    isChallengingEnough: boolean;
    isRealistic: boolean;
    notes: string[];
    suggestedImprovementsForNextRun?: string[];
  }>;
}

// ========================================
// Iteration Summary
// ========================================

export interface IterationSummary {
  iteration: number;
  passRate: number;        // binary: passedCount/totalCount
  qualityScore?: number;   // LLM 0-1 quality rating
  passedCount: number;
  totalCount: number;
  highSeverityCount: number;
  mediumSeverityCount?: number;
  mainIssues: string[];
  changesApplied: string[];
  cost: number;            // cumulative cost up to this iteration
  iterationCost?: number;  // cost for this iteration only
  delta?: {
    improvements: number;
    regressions: number;
    unchanged: number;
  };
  isChampion?: boolean;
  verdict?: PromptVerdict;
  mode?: RefinementMode;
  dimensionProfile?: Record<string, number>;  // avg score per dimension
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
  minIterations: z.number().int().min(1).optional().default(2),
  minQualityScore: z.number().min(0).max(1).optional().default(0.80),
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

export const RefinementConfigSchema = z.object({
  earlyIterations: z.number().int().min(1).optional().default(2),
  restructureBelow: z.number().min(0).max(1).optional().default(0.65),
  restructureAboveHighSeverity: z.number().int().min(0).optional().default(3),
}).optional();

export const EvaluationDimensionsSchema = z.object({
  universal: z.array(z.string()).optional(),
  specific: z.array(z.string()).optional(),
}).optional();

export const DimensionRubricsSchema = z.record(
  z.string(),
  z.record(z.string(), z.string())
).optional();

export const SectionTaxonomySchema = z.object({
  extensions: z.array(z.string()).optional(),
  specific: z.array(z.string()).optional(),
}).optional();

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
  refinement: RefinementConfigSchema,
  evaluationDimensions: EvaluationDimensionsSchema,
  dimensionRubrics: DimensionRubricsSchema,
  sectionTaxonomy: SectionTaxonomySchema,
});

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;
export type InstructionsConfig = z.infer<typeof InstructionsConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type TemperatureConfig = z.infer<typeof TemperatureConfigSchema>;
export type StopConditions = z.infer<typeof StopConditionsSchema>;

// ========================================
// Run Metadata
// ========================================

export type RunStatus = 'running' | 'success' | 'max_iterations' | 'stopped' | 'error';

export interface RunMetadata {
  runId: string;
  orchestratorId: string;
  taskId: string;
  taskName?: string;
  status: RunStatus;
  startedAt: number;
  completedAt?: number;
  currentIteration: number;
  finalScore?: number;
  totalCost?: number;
  uploadId?: string;
  uploadedFiles?: string[];
  continuedFromRunId?: string;
  championIteration?: number;
  championScore?: number;
  championPassRate?: number;
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
  changePlan?: ChangePlan;
  changeImpact?: ChangeImpact;
  isChampion?: boolean;
  verdict?: PromptVerdict;
}

// ========================================
// Context for Refining
// ========================================

export interface CrossRunHistoryEntry {
  runId: string;
  startedAt: number;
  finalScore?: number;
  championScore?: number;
  totalIterations: number;
  confirmedApproaches: string[];
  disprovenHypotheses: string[];
  persistentWeakDimensions: string[];
  sectionImpactSummary: string[];
}

export interface OscillationWarning {
  detected: boolean;
  dimensions: string[];
  summary: string;
  approachesTried: string[];
}

export interface IterationContext {
  currentAnalysis: Analysis;
  transcriptIndex: TranscriptIndex;
  previousSummaries: IterationSummary[];
  failedTranscripts: Transcript[];
  passedSample: Transcript[];
  // Champion / Candidate context
  championPrompt?: string;
  candidatePrompt?: string;
  championIteration?: number;
  championScore?: number;
  championPassRate?: number;
  championHighSeverityCount?: number;
  promptLedger?: PromptLedgerEntry[];   // metadata only, no prompt text
  changeLedger?: ChangeLedgerEntry[];
  refinementMode?: RefinementMode;
  previousCandidateChangePlan?: ChangePlan;
  // Orchestrator-specific guidelines
  guidelinesContext?: string;
  // Uploaded reference file paths available for on-demand reading
  uploadedFilePaths?: Array<{ filename: string; path: string }>;
  // Task description and reference materials for refiner context
  taskDescription?: string;
  uploadedContext?: string;
  // Cross-run memory (Phase 1)
  crossRunInsights?: string;
  crossRunHistory?: CrossRunHistoryEntry[];
  oscillationWarning?: OscillationWarning;
  behavioralMetrics?: Record<string, BehavioralMetrics>;  // keyed by scenarioId
  // Section taxonomy for refiner reference
  sectionTaxonomy?: string[];
  // Dimension config for refiner reference
  evaluationDimensions?: string[];
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
  changePlan?: ChangePlan;
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
