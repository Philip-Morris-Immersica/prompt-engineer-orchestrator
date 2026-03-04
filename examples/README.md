# Examples - Prompt Refinement Engine

Този folder съдържа примерни tasks и конфигурации за тестване на системата.

## Quick Start

### 1. Setup Environment

Копирай `.env.example` към `.env` и добави твоя OpenAI API key:

```bash
cp .env.example .env
# Edit .env и добави: OPENAI_API_KEY=sk-...
```

### 2. List Available Orchestrators

```bash
npm run run:cli -- --list
```

### 3. Run Example Task

**Mentor Bot** (Educational guidance):
```bash
npm run run:cli -- --orchestrator=mentor_bot --task=examples/tasks/mentor_task.json
```

**Analyzer Bot** (Conversation analysis):
```bash
npm run run:cli -- --orchestrator=analyzer_bot --task=examples/tasks/analyzer_task.json
```

**With Stress Mode** (temp=0.9 for edge case testing):
```bash
npm run run:cli -- --orchestrator=mentor_bot --task=examples/tasks/mentor_task.json --stress
```

## Task Structure

Tasks са JSON файлове с следната структура:

```json
{
  "id": "unique_id",
  "name": "Display Name",
  "description": "What the bot should do",
  "requirements": {
    "role": "Bot's role description",
    "constraints": ["constraint 1", "constraint 2"],
    "tone": "Tone description",
    "maxResponseLength": 500
  },
  "category": "educational|analysis|character"
}
```

## Expected Output

След стартиране на run, системата ще:

1. Генерира първоначален prompt
2. Създаде test plan с 6-8 scenarios
3. Изпълни тестове
4. Анализира резултатите
5. Подобри промпта
6. Повтаря до достигане на качество threshold

Очаквана продължителност: 3-10 минути  
Очакван cost: $0.50 - $2.00 (в зависимост от итерации)

## Viewing Results

След приключване можеш да видиш резултатите в:

- **CLI Output**: Пълен summary в терминала
- **Dashboard**: http://localhost:3000/runs/[runId]
- **Files**: `data/runs/[runId]/`

## Creating Custom Tasks

1. Копирай един от примерните tasks
2. Модифицирай description, requirements, constraints
3. Запази в `examples/tasks/your_task.json`
4. Run със `--task=examples/tasks/your_task.json`

## Tips

- **Stable mode (default)**: temp=0.2 за последователни резултати
- **Stress mode**: temp=0.9 за тестване на edge cases
- **Iterations**: Обикновено 3-6 итерации са достатъчни
- **Cost**: Следи budget warnings в output-а
