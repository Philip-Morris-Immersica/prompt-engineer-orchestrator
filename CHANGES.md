# Recent Changes - Fixed Test Set & Delta Analysis

## Summary
Updated the Prompt Refinement Engine to match real testing workflows with fixed test scenarios and iteration-to-iteration delta tracking.

## Key Changes

### 1. Fixed Test Set Strategy
**Previous**: Generated 6-8 new scenarios per iteration
**Now**: Generate 4 fixed scenarios at start, reuse across all iterations

**Rationale**: 
- Matches real testing process (same test cases, observe behavior changes)
- Makes delta analysis meaningful (comparing same scenarios)
- More stable evaluation (no random scenario variation)
- Smaller test set is faster and more focused

**Configuration**:
```json
"testing": {
  "scenariosCount": 4,
  "turnsPerScenario": {
    "min": 4,
    "max": 6
  }
}
```

**Total test volume**: ~20-25 user messages per iteration (4 scenarios × 4-6 turns)

### 2. Delta Analysis Between Iterations
**Feature**: Track improvements, regressions, and unchanged scenarios between iterations

**Data Structure** (added to `Analysis` type):
```typescript
delta?: {
  improvements: number;      // Scenarios that got better
  regressions: number;        // Scenarios that got worse
  unchanged: number;          // Scenarios with same result
  changes: ScenarioDelta[];   // Detailed per-scenario changes
}
```

**Per-Scenario Delta** (`ScenarioDelta`):
```typescript
{
  scenarioId: string;
  change: 'improved' | 'regressed' | 'unchanged' | 'new';
  previousPassed?: boolean;
  currentPassed: boolean;
  previousIssueCount?: number;
  currentIssueCount: number;
  description: string;  // e.g., "Now passing", "More issues (3 → 5)"
}
```

**Delta Calculation Logic**:
- **Improved**: Failed → Passed, OR same pass state but fewer issues
- **Regressed**: Passed → Failed, OR same pass state but more issues
- **Unchanged**: Same pass state, same issue count

**Console Output Example**:
```
✓ Pass rate: 3/4 (75.0%)
  ✓ High severity issues: 0

  📊 Delta Analysis:
    ↑ Improvements: 2 scenario(s)
    ↓ Regressions: 0 scenario(s)
    → Unchanged: 2 scenario(s)
```

**Dashboard Display**:
- Delta box shown for each iteration (except first)
- Color-coded: green (improvements), red (regressions), gray (unchanged)
- Visible in iteration timeline

### 3. Updated Stop Conditions

**Previous Conditions**:
- `minPassRate >= 0.9` (90%)
- `consecutiveSuccesses: 3`
- Diminishing returns check

**New Conditions** (optimized for small test sets):

#### Condition 1: Perfect Pass (Highest Priority)
```
allScenariosPass (4/4) && highSeverityCount == 0
```
✅ Stops immediately if all scenarios pass with no critical issues

#### Condition 2: Good Enough + Stable
```
mostPass (3/4+) && highSeverityCount == 0 && 2 consecutive successes
```
✅ Stops if 75%+ pass for 2 iterations in a row (with no high severity)

#### Condition 3: Stable Prompt (No Delta)
```
delta.improvements == 0 && delta.regressions == 0 && allPass
```
✅ Stops if no changes detected and all scenarios pass (prompt is stable)

#### Condition 0: High Severity Gate (Override)
```
highSeverityCount > 0  →  DO NOT STOP
```
🚫 Never stops if there are high severity issues, even if pass rate is high

**Config Updates**:
```json
"maxIterations": 10,
"stopConditions": {
  "minPassRate": 0.75,              // 3/4 scenarios
  "consecutiveSuccesses": 2,         // Reduced from 3
  "minImprovement": 0.05,            // Still used for diminishing returns
  "maxHighSeverityIssues": 0         // Critical: must be 0 to stop
}
```

### 4. Configuration Changes

**Both orchestrators** (`mentor_bot.json`, `analyzer_bot.json`):
- `maxIterations`: 8 → **10**
- `stopConditions.minPassRate`: 0.9 → **0.75**
- `stopConditions.consecutiveSuccesses`: 3 → **2**
- **Added**: `testing.scenariosCount: 4`
- **Added**: `testing.turnsPerScenario: { min: 4, max: 6 }`

### 5. Type System Updates

**Modified Types**:
- `IterationSummary`: Added `passedCount`, `totalCount`, `delta`
- `Analysis`: Added `delta` object
- **New Types**: `DeltaChange`, `ScenarioDelta`
- `TestingConfigSchema`: Added `scenariosCount`, `turnsPerScenario`

### 6. Lead Agent Prompt Updates

**Generate Template**:
- Now instructs to create **exactly 4 scenarios** (config-driven)
- Each scenario should have 4-6 turns
- Emphasizes scenarios will be reused across all iterations
- Focus on critical edge cases

**Analyze Template**:
- Acknowledges small test set (3-4 scenarios)
- Notes that each scenario is 25-33% of total result
- Emphasizes precision in evaluation

### 7. OrchestrationEngine Updates

**Core Changes**:
- Fixed test plan generated once, reused in all iterations
- Delta calculation added after each analysis
- Stop conditions updated for small test sets
- Console output enhanced with delta display

**New Method**: `calculateDelta(previousAnalysis, currentAnalysis)`
- Compares scenario-by-scenario results
- Counts improvements, regressions, unchanged
- Returns detailed delta object

### 8. Dashboard Updates

**Run Details Page**:
- Shows `passedCount/totalCount` instead of just pass rate
- Displays delta box for each iteration (blue background)
- Color-coded delta indicators (↑ green, ↓ red, → gray)
- More compact iteration display

## Files Modified

### Backend
- `src/backend/types.ts` - Added delta types, updated IterationSummary
- `src/backend/orchestration-engine.ts` - Delta calculation, new stop conditions, fixed test set
- `src/backend/lead-agent.ts` - Updated prompts for fixed test set
- `src/backend/config-loader.ts` - No changes (already supports new config fields)

### Configurations
- `data/configs/orchestrators/mentor_bot.json` - Updated settings
- `data/configs/orchestrators/analyzer_bot.json` - Updated settings

### Frontend
- `src/app/runs/[runId]/page.tsx` - Delta display, updated types
- `src/app/api/runs/[runId]/route.ts` - Returns iteration summaries

## Testing Recommendations

### 1. Test with Small Prompts
Run a quick test with 4 scenarios to verify:
```bash
npm run run:cli -- --orchestrator=mentor_bot --task=examples/tasks/mentor_task.json
```

Expected behavior:
- Iteration 1: Generate 4 scenarios, run tests, analyze
- Iteration 2+: Same 4 scenarios reused, delta shown
- Should stop at iteration 2-5 if scenarios pass
- If issues persist, continues up to iteration 10

### 2. Check Delta Display
After iteration 2, console should show:
```
📊 Delta Analysis:
  ↑ Improvements: X scenario(s)
  ↓ Regressions: Y scenario(s)
  → Unchanged: Z scenario(s)
```

Dashboard should show delta box in blue with color-coded changes.

### 3. Verify Stop Conditions
- Test should stop when 3/4 or 4/4 scenarios pass (with no high severity)
- Should NOT stop if high severity issues exist, even at 75% pass rate
- Should stop after 2 consecutive good iterations

## Migration Notes

**No Breaking Changes**: Existing runs are not affected. New runs will use the updated strategy.

**Config Compatibility**: Old configs without `scenariosCount` will default to 4 scenarios (safe fallback in code).

## Rationale for Changes

These changes align the system with real-world prompt testing workflows:

1. **Fixed Test Set**: Practitioners reuse the same test cases to observe behavior changes, not generate new random tests each time
2. **Small Test Set**: 4 scenarios with 4-6 turns each (20-25 messages total) is realistic and cost-effective for MVP
3. **Delta Tracking**: Essential for understanding if prompt changes are helping or hurting
4. **Adjusted Stop Conditions**: With only 4 scenarios, 75% (3/4) is a reasonable success threshold, and 2 consecutive successes is sufficient for stability

## Performance Impact

**Positive**:
- ✅ Faster iterations (fewer scenarios to test)
- ✅ Lower API costs (fewer API calls per iteration)
- ✅ More stable evaluation (no random scenario variation)

**Neutral**:
- Delta calculation adds minimal overhead (in-memory comparison)
- Storage size similar (same number of files, smaller transcripts)

**Expected Cost**: ~$0.30-0.50 per run (down from ~$0.50-0.80 previously)

## Future Enhancements (Not in MVP)

- **Delta Detail View**: Click on a scenario delta to see exact changes in responses
- **Custom Test Sets**: Allow users to provide their own fixed test scenarios
- **Progressive Testing**: Start with 4 scenarios, add more if needed
- **Delta Trend Charts**: Visualize improvements/regressions over time
