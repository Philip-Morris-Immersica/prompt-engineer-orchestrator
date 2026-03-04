# Orchestrator Configurations Guide

This document explains the different orchestrator configurations available in the Prompt Refinement Engine and when to use each one.

## Overview

Orchestrators are configuration profiles that control how the refinement engine generates, tests, and refines prompts. Each orchestrator is optimized for different types of chatbots and use cases.

## Available Orchestrators

### 1. Mentor Bot (`mentor_bot`)

**Purpose**: Conversational AI that guides, teaches, or mentors users

**Best For**:
- Educational chatbots
- Training assistants
- Coaching/mentoring bots
- Onboarding assistants
- Tutorial guides
- Customer support tutors

**Configuration Highlights**:
```json
{
  "maxIterations": 10,
  "stopConditions": {
    "minPassRate": 0.75,
    "consecutiveSuccesses": 2,
    "maxHighSeverityIssues": 0
  },
  "testing": {
    "testTemperature": 0.2,
    "stressMode": false,
    "scenariosCount": 4
  },
  "costs": {
    "budgetPerRun": 5.0
  }
}
```

**Characteristics**:
- Higher budget ($5) for longer conversations
- Focuses on conversational flow and tone
- Validates that the bot stays in mentor role
- Tests guidance quality and teaching effectiveness

**Example Use Case**:
Creating a programming mentor bot that helps developers learn new frameworks through Socratic questioning and guided examples.

---

### 2. Conversation Analyzer Bot (`analyzer_bot`)

**Purpose**: AI that analyzes, evaluates, or processes conversations and data

**Best For**:
- Sentiment analysis bots
- Conversation quality evaluators
- Data extraction assistants
- Report generators
- Classification systems
- Insight extractors

**Configuration Highlights**:
```json
{
  "maxIterations": 10,
  "stopConditions": {
    "minPassRate": 0.75,
    "consecutiveSuccesses": 2,
    "maxHighSeverityIssues": 0
  },
  "testing": {
    "testTemperature": 0.2,
    "stressMode": false,
    "scenariosCount": 4
  },
  "costs": {
    "budgetPerRun": 3.0
  }
}
```

**Characteristics**:
- Lower budget ($3) for shorter, focused responses
- Emphasizes accuracy and consistency
- Validates analytical precision
- Tests structured output quality

**Example Use Case**:
Building a bot that analyzes customer support transcripts to identify pain points, sentiment trends, and improvement opportunities.

---

## Key Differences

| Feature | Mentor Bot | Analyzer Bot |
|---------|------------|--------------|
| **Budget** | $5.00 | $3.00 |
| **Focus** | Conversational guidance | Analytical precision |
| **Typical Response Length** | Longer, conversational | Shorter, structured |
| **Tone** | Warm, encouraging | Neutral, factual |
| **Example Domains** | Education, coaching, support | Analysis, reporting, classification |

## How to Choose

### Use **Mentor Bot** when:
- ✅ Your bot needs to have back-and-forth conversations
- ✅ Tone and personality are important
- ✅ You want the bot to guide users through processes
- ✅ Empathy and encouragement matter
- ✅ Responses should be educational and explanatory

### Use **Analyzer Bot** when:
- ✅ Your bot needs to process and analyze data
- ✅ Output should be structured and factual
- ✅ Consistency and accuracy are critical
- ✅ Responses should be concise and to-the-point
- ✅ The bot extracts insights rather than provides guidance

## Creating Custom Orchestrators

You can create your own orchestrator configurations by adding a JSON file to `data/configs/orchestrators/`.

### Example: Customer Support Bot

```json
{
  "id": "support_bot",
  "name": "Customer Support Bot",
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
  "maxIterations": 10,
  "stopConditions": {
    "minPassRate": 0.85,
    "consecutiveSuccesses": 2,
    "maxHighSeverityIssues": 0
  },
  "validation": {
    "rulesEnabled": true,
    "llmEnabled": true,
    "rulesPath": "validation_rules/support_bot.json"
  },
  "testing": {
    "testTemperature": 0.2,
    "stressMode": false,
    "parallelScenarios": false,
    "conversationTimeout": 60000,
    "scenariosCount": 4,
    "turnsPerScenario": {
      "min": 5,
      "max": 8
    }
  },
  "costs": {
    "budgetPerRun": 4.0,
    "warnThreshold": 2.5
  },
  "promptBank": "prompt_bank/support/"
}
```

### Key Parameters to Customize:

1. **maxIterations**: How many refinement cycles to allow (default: 10)
2. **minPassRate**: Minimum pass rate to stop (0.75 = 3/4 scenarios)
3. **budgetPerRun**: Maximum cost per run in USD
4. **scenariosCount**: Number of test scenarios (recommended: 4)
5. **turnsPerScenario**: Conversation length (min-max user messages)
6. **temperatures**: Control creativity vs consistency
   - `generate`: 0.7 for creative prompt writing
   - `test`: 0.2 for stable, realistic testing
   - `analyze`: 0 for consistent analysis
   - `refine`: 0.7 for creative improvements

## Validation Rules

Each orchestrator can have custom validation rules in `data/validation_rules/[orchestrator_id].json`:

```json
{
  "maxResponseLength": 800,
  "forbiddenPhrases": [
    "I don't know",
    "I cannot help",
    "That's not my job"
  ],
  "requiredElements": []
}
```

## Prompt Banks

Each orchestrator references a prompt bank directory with example prompts:

```
data/prompt_bank/
├── mentor/
│   ├── example_01.json
│   └── example_02.json
├── analyzer/
│   ├── example_01.json
│   └── example_02.json
└── support/
    └── example_01.json
```

Example prompt bank entry:

```json
{
  "id": "mentor_example_01",
  "category": "educational",
  "name": "Programming Mentor",
  "prompt": "You are a patient programming mentor...",
  "notes": "Good for Socratic teaching method",
  "rating": 9
}
```

## Advanced: Model Selection

You can use different models for different roles:

```json
{
  "models": {
    "generate": "gpt-4o",        // Creative prompt generation
    "test": "gpt-4o-mini",        // Cost-effective testing
    "analyze": "gpt-4o",          // High-quality analysis
    "refine": "gpt-4o"            // Creative refinement
  }
}
```

This allows you to optimize cost vs quality for each step.

## Testing Your Orchestrator

After creating a custom orchestrator, test it with:

```bash
# List all orchestrators
npm run run:cli -- --list

# Test your orchestrator
npm run run:cli -- --orchestrator=your_bot_id --task=examples/tasks/test_task.json
```

## Best Practices

1. **Start with defaults**: Begin with mentor_bot or analyzer_bot and customize
2. **Test budget limits**: Run a few tests to estimate actual costs
3. **Tune pass rate**: Adjust `minPassRate` based on your quality requirements
4. **Iterate on validation rules**: Add forbidden phrases based on observed failures
5. **Build a prompt bank**: Collect good examples for your domain
6. **Monitor delta analysis**: Use improvements/regressions to tune refinement strategy

## Troubleshooting

### Orchestrator not found
- Check that the JSON file exists in `data/configs/orchestrators/`
- Verify the `id` field matches the filename (without `.json`)
- Restart the server to reload configurations

### Budget exceeded
- Increase `budgetPerRun` in the config
- Reduce `maxIterations`
- Consider using `gpt-4o-mini` for testing

### Too many iterations
- Lower `maxIterations`
- Adjust `minPassRate` (higher = stricter, but may never succeed)
- Check if validation rules are too strict

### Inconsistent results
- Lower `testTemperature` for more stable testing
- Increase `scenariosCount` for better coverage
- Review and tighten validation rules

## Support

For questions or issues with orchestrator configurations:
1. Check the logs in `data/runs/[run_id]/`
2. Review the analysis in `iterations/XX/llm_analysis.json`
3. Adjust configuration parameters incrementally
4. Test with simple tasks first before complex ones
