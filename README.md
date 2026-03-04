# Prompt Refinement Engine MVP

Automated system for generating, testing, and refining chatbot prompts using GPT-4o.

## Overview

This tool automates the iterative prompt refinement process:
**Generate → Test → Analyze → Refine → Retest**

The system:
- Generates initial prompts and test plans from task descriptions
- Executes test scenarios against a simulated chatbot
- Analyzes results using code-based rules + LLM analysis
- Refines prompts based on feedback
- Repeats until quality thresholds are met

## Features

✅ **Single Lead Agent** - One GPT-4o model handles all AI tasks (generate, analyze, refine)  
✅ **Transcript Indexing** - Efficient context management for long conversations  
✅ **High Severity Gate** - Prevents premature stopping with critical issues  
✅ **Multiple Orchestrators** - Support different bot types (mentor, analyzer, etc.)  
✅ **Stress Mode** - Test with temp=0.9 for edge case validation  
✅ **Cost Tracking** - Monitor OpenAI API usage per run  
✅ **Local Dashboard** - Web UI for monitoring runs  
✅ **CLI Interface** - Command-line control

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and add your OpenAI API key:

```
OPENAI_API_KEY=sk-your-key-here
```

### 3. List Available Orchestrators

```bash
npm run run:cli -- --list
```

### 4. Run Your First Refinement

```bash
npm run run:cli -- --orchestrator=mentor_bot --task=examples/tasks/mentor_task.json
```

### 5. View Results

**CLI Output**: Full summary in terminal  
**Dashboard**: `npm run dev` then visit http://localhost:3000  
**Files**: Check `data/runs/[runId]/`

## Project Structure

```
prompt-engineer-orchestrator/
├── src/
│   ├── app/                     # Next.js frontend
│   │   ├── api/                 # REST API routes
│   │   │   ├── orchestrators/   # List orchestrators
│   │   │   └── runs/            # Manage runs
│   │   ├── runs/[runId]/        # Run details page
│   │   └── page.tsx             # Home page
│   │
│   ├── backend/                 # Core engine
│   │   ├── types.ts             # TypeScript types + Zod schemas
│   │   ├── config-loader.ts     # Load orchestrator configs
│   │   ├── storage.ts           # File system operations
│   │   ├── lead-agent.ts        # GPT-4o wrapper with 3 roles
│   │   ├── test-runner.ts       # Test execution
│   │   └── orchestration-engine.ts  # Main refinement loop
│   │
│   └── components/              # UI components
│       └── ui/                  # shadcn/ui components
│
├── data/                        # Runtime data (not in git)
│   ├── configs/
│   │   └── orchestrators/       # Orchestrator configs
│   ├── validation_rules/        # Validation rules
│   ├── prompt_bank/             # Example prompts
│   └── runs/                    # Run results
│
├── examples/                    # Example tasks
│   └── tasks/
│
└── scripts/
    └── start-run.ts             # CLI entry point
```

## CLI Usage

### Start a Run

```bash
npm run run:cli -- --orchestrator=<id> --task=<path>
```

**Options:**
- `--orchestrator <id>` - Orchestrator to use (required)
- `--task <path>` - Path to task JSON (required)
- `--stress` - Enable stress mode (temp=0.9)
- `--list` - List available orchestrators
- `--help` - Show help

### Examples

```bash
# List orchestrators
npm run run:cli -- --list

# Run with mentor bot
npm run run:cli -- --orchestrator=mentor_bot --task=examples/tasks/mentor_task.json

# Run with stress mode
npm run run:cli -- --orchestrator=mentor_bot --task=examples/tasks/mentor_task.json --stress
```

## Creating Custom Orchestrators

1. Create config in `data/configs/orchestrators/your_bot.json`:

```json
{
  "id": "your_bot",
  "name": "Your Bot Name",
  "models": {
    "generate": "gpt-4o",
    "test": "gpt-4o",
    "analyze": "gpt-4o",
    "refine": "gpt-4o"
  },
  "temperatures": {
    "generate": 0.7,
    "test": 0.2,
    "analyze": 0,
    "refine": 0.7
  },
  "maxIterations": 8,
  "stopConditions": {
    "minPassRate": 0.9,
    "consecutiveSuccesses": 3,
    "minImprovement": 0.05,
    "maxHighSeverityIssues": 0
  },
  "validation": {
    "rulesEnabled": true,
    "llmEnabled": true,
    "rulesPath": "validation_rules/your_bot.json"
  },
  "testing": {
    "testTemperature": 0.2,
    "stressMode": false,
    "parallelScenarios": false,
    "conversationTimeout": 60000
  },
  "costs": {
    "budgetPerRun": 5.0,
    "warnThreshold": 3.0
  },
  "promptBank": "prompt_bank/your_bot/"
}
```

2. Create validation rules in `data/validation_rules/your_bot.json`

3. (Optional) Add prompt examples to `data/prompt_bank/your_bot/`

## Architecture

### Lead Agent Pattern

Instead of multiple AI agents, we use **one GPT-4o model** with three different prompt templates:

- **Generate**: Creates initial prompt + test plan
- **Analyze**: Reviews test transcripts and identifies issues
- **Refine**: Improves prompt based on analysis

Benefits:
- Simpler architecture
- Consistent behavior
- Lower cost
- Easier to debug

### Transcript Indexing

To handle large test suites without token overflow:

1. **Generate Index**: Create summaries of all test scenarios
2. **Selective Loading**: Send only failed/high-severity transcripts in full
3. **Context Window**: Lead Agent sees "big picture" via index

This allows scaling to 20-30 test scenarios per iteration.

### Stop Conditions

Refinement cycle stops when:

1. **High Pass Rate** (≥ 90%) AND **No High Severity Issues** (gate)
2. **Diminishing Returns** (< 5% improvement over 3 iterations)
3. **Consecutive Successes** (3 iterations at ≥ 85% with no critical issues)
4. **Max Iterations** (8 by default)

The **High Severity Gate** is critical - prevents false positives.

## Cost Estimates

For a typical run (8 scenarios, 5 iterations) with **GPT-4o**:

- **Total API calls**: ~120-150
- **Total tokens**: ~200-250K
- **Estimated cost**: $0.80 - $1.50
- **Duration**: 3-10 minutes

Compare to GPT-4: ~$2.50 per run (60% savings with GPT-4o)

## Configuration

### Environment Variables

```env
OPENAI_API_KEY=sk-...           # Required
DEFAULT_MODEL=gpt-4o            # Default model
DEFAULT_TEST_TEMPERATURE=0.2    # Stable testing
MAX_CONCURRENT_REQUESTS=3       # Rate limiting
RATE_LIMIT_INTERVAL_MS=300      # 300ms between requests
MAX_ITERATIONS=8                # Default max iterations
DATA_DIR=./data                 # Data directory
```

### Model Configuration

Each orchestrator can specify models per role:

```json
"models": {
  "generate": "gpt-4o",  // Prompt generation
  "test": "gpt-4o",      // Bot simulation
  "analyze": "gpt-4o",   // Transcript analysis
  "refine": "gpt-4o"     // Prompt refinement
}
```

### Temperature Strategy

- **generate/refine**: 0.7 (creative but controlled)
- **test**: 0.2 (stable, reproducible)
- **analyze**: 0 (deterministic)
- **stress mode**: 0.9 (edge case testing)

## Dashboard

Start the development server:

```bash
npm run dev
```

Visit http://localhost:3000

**Features:**
- Start new runs
- View run history
- Monitor progress (auto-refresh)
- View iteration details
- Check status and costs

## Troubleshooting

### "OPENAI_API_KEY not found"

Ensure `.env` file exists and contains valid API key.

### "Orchestrator config not found"

Check that config file exists in `data/configs/orchestrators/[id].json`

### "Budget exceeded"

Increase `budgetPerRun` in orchestrator config or optimize test scenarios.

### Runs taking too long

- Reduce `maxIterations`
- Increase `minPassRate` (less strict)
- Use fewer test scenarios

## Development

### Building for Production

```bash
npm run build
npm start
```

### Type Checking

TypeScript + Zod schemas ensure type safety throughout the system.

## MVP Scope

**Included:**
- ✅ Core refinement engine
- ✅ CLI interface
- ✅ Basic dashboard
- ✅ Multiple orchestrator configs
- ✅ Transcript indexing
- ✅ High severity gate
- ✅ Cost tracking

**Deferred to v2:**
- WebSocket real-time updates
- Prompt diff viewer
- Manual intervention
- Advanced analytics
- External chatbot integration

## Contributing

This is an internal tool. For questions or improvements, contact the team.

## License

Internal use only.
