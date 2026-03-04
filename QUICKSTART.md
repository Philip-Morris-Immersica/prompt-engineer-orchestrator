# Quick Start Guide

Get the Prompt Refinement Engine running in 5 minutes.

## Prerequisites

- Node.js 18+ installed
- OpenAI API key

## Step-by-Step Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure API Key

Create `.env` file:

```bash
cp .env.example .env
```

Edit `.env` and add your OpenAI key:

```
OPENAI_API_KEY=sk-your-actual-key-here
```

### 3. Verify Setup

List available orchestrators:

```bash
npm run run:cli -- --list
```

You should see:
```
Available orchestrators:
  - mentor_bot: Mentor Bot Orchestrator
  - analyzer_bot: Conversation Analyzer Bot
```

### 4. Run First Refinement

```bash
npm run run:cli -- --orchestrator=mentor_bot --task=examples/tasks/mentor_task.json
```

**What happens:**
1. Generates initial prompt (30s)
2. Creates test plan with 6-8 scenarios
3. Runs tests, analyzes results
4. Refines prompt based on feedback
5. Repeats until success criteria met

**Expected:**
- Duration: 3-8 minutes
- Cost: $0.50 - $1.50
- Iterations: 3-6

### 5. View Results

**In Terminal:**
You'll see real-time progress and final summary.

**In Dashboard:**
```bash
npm run dev
```

Visit http://localhost:3000 to see all runs.

**In Files:**
```bash
data/runs/run_[timestamp]/
├── metadata.json          # Run info
├── task.json              # Task definition
├── iterations/
│   ├── 01/
│   │   ├── prompt.txt     # Generated prompt
│   │   ├── test_plan.json # Test scenarios
│   │   ├── tests/         # Transcripts
│   │   └── summary.json   # Iteration results
│   └── 02/...
└── final_summary.md       # Final results
```

## Common Commands

```bash
# List orchestrators
npm run run:cli -- --list

# Run with specific orchestrator
npm run run:cli -- --orchestrator=mentor_bot --task=examples/tasks/mentor_task.json

# Run with stress mode (temp=0.9 for edge cases)
npm run run:cli -- --orchestrator=mentor_bot --task=examples/tasks/mentor_task.json --stress

# Start dashboard
npm run dev

# Type check
npx tsc --noEmit
```

## What's Next?

1. **Try analyzer_bot**: `npm run run:cli -- --orchestrator=analyzer_bot --task=examples/tasks/analyzer_task.json`

2. **Create custom task**: Copy `examples/tasks/mentor_task.json`, modify it, and run

3. **Create custom orchestrator**: See `data/configs/orchestrators/mentor_bot.json` as template

4. **Adjust stop conditions**: Edit orchestrator config to change quality thresholds

## Troubleshooting

**"OPENAI_API_KEY not found"**
→ Make sure `.env` exists and contains valid key

**"Orchestrator config not found"**
→ Run `npm run run:cli -- --list` to see available orchestrators

**Taking too long?**
→ This is normal for first run. GPT-4o needs time to generate quality prompts.

**Cost too high?**
→ Reduce `maxIterations` in orchestrator config or use fewer test scenarios

## Architecture Overview

```
┌─────────────┐
│ CLI / UI    │
└──────┬──────┘
       │
┌──────▼─────────────────┐
│ OrchestrationEngine    │
│ (refinement loop)      │
└──────┬─────────────────┘
       │
   ┌───┴────┬────────┬──────────┐
   │        │        │          │
┌──▼──┐ ┌──▼───┐ ┌──▼────┐ ┌───▼──────┐
│Lead │ │Test  │ │Storage│ │Config    │
│Agent│ │Runner│ │       │ │Loader    │
└─────┘ └──────┘ └───────┘ └──────────┘
```

**Lead Agent**: Single GPT-4o with 3 roles (generate, analyze, refine)  
**Test Runner**: Executes scenarios at temp=0.2  
**Storage**: File-based storage for all run data  
**Config Loader**: Manages multiple orchestrator configs

## Key Features

✅ **Transcript Indexing**: Handles 20-30 scenarios without token overflow  
✅ **High Severity Gate**: Won't stop with critical issues  
✅ **Cost Tracking**: Real-time budget monitoring  
✅ **Stress Mode**: Test edge cases with temp=0.9  
✅ **Multiple Orchestrators**: Different configs for different bot types

## Next Steps

Read [README.md](README.md) for full documentation.

Check [examples/README.md](examples/README.md) for more task examples.
