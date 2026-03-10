/**
 * Parses a markdown-formatted task definition into a TaskSchema-compatible object.
 *
 * Supported sections (all optional except "Какво правим"):
 *   # Title              → name
 *   ## Какво правим      → description (core)
 *   ## Герой             → description + role
 *   ## Цел               → description
 *   ## Потребители       → description
 *   ## Специфики         → description (behavioral details, broad)
 *   ## Ограничения       → constraints[] (strict rules for the analyzer)
 *   ## Файлове           → description
 *   ## Сценарии          → description (scenario definitions for the generator)
 *   ## Тон               → tone
 *   ## Краен резултат    → description
 *   ## Други важни неща  → description
 */

interface ParsedTask {
  id: string;
  name: string;
  description: string;
  category: string;
  requirements: {
    role: string;
    constraints: string[];
    tone?: string;
    maxResponseLength?: number;
  };
}

const SECTION_ALIASES: Record<string, string> = {
  'какво правим': 'whatWeAreDoing',
  'what we are doing': 'whatWeAreDoing',
  'герой': 'character',
  'hero': 'character',
  'character': 'character',
  'цел': 'goal',
  'goal': 'goal',
  'потребители': 'users',
  'users': 'users',
  'специфики': 'specifics',
  'specifics': 'specifics',
  'ограничения': 'constraints',
  'червени линии': 'constraints',
  'constraints': 'constraints',
  'red lines': 'constraints',
  'файлове': 'files',
  'files': 'files',
  'тон': 'tone',
  'tone': 'tone',
  'краен резултат': 'result',
  'result': 'result',
  'сценарии': 'scenarios',
  'scenarios': 'scenarios',
  'други важни неща': 'other',
  'други': 'other',
  'other': 'other',
};

function normalizeKey(heading: string): string | null {
  const cleaned = heading.trim().toLowerCase().replace(/[:\-–—]/g, '').trim();
  for (const [alias, key] of Object.entries(SECTION_ALIASES)) {
    if (cleaned === alias || cleaned.startsWith(alias + ' ')) return key;
  }
  return null;
}

function extractBullets(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter((line) => line.length > 0);
}

function extractMaxResponseLength(text: string): number | undefined {
  const match = text.match(/(?:макс(?:имална)?\s*дължина|max\s*(?:response\s*)?length)[:\s]*(\d+)/i);
  return match ? parseInt(match[1], 10) : undefined;
}

export function isMarkdownTask(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.startsWith('{')) return false;
  return /^#\s+.+/m.test(trimmed) || /^##\s+.+/m.test(trimmed);
}

export function parseMarkdownTask(input: string): ParsedTask {
  const lines = input.split('\n');

  let name = '';
  const sections: Record<string, string> = {};
  let currentKey: string | null = null;
  let currentLines: string[] = [];

  const flushSection = () => {
    if (currentKey) {
      sections[currentKey] = currentLines.join('\n').trim();
    }
    currentLines = [];
  };

  for (const line of lines) {
    const h1Match = line.match(/^#\s+(.+)/);
    if (h1Match) {
      flushSection();
      name = h1Match[1].trim();
      currentKey = null;
      continue;
    }

    const h2Match = line.match(/^##\s+(.+)/);
    if (h2Match) {
      flushSection();
      const key = normalizeKey(h2Match[1]);
      currentKey = key;
      if (!key) {
        currentKey = '__unknown_' + h2Match[1].trim().toLowerCase();
      }
      continue;
    }

    currentLines.push(line);
  }
  flushSection();

  const descParts: string[] = [];

  if (sections.whatWeAreDoing) {
    descParts.push(sections.whatWeAreDoing);
  }

  if (sections.character) {
    descParts.push(`Герой: ${sections.character}`);
  }

  if (sections.goal) {
    descParts.push(`Цел: ${sections.goal}`);
  }

  if (sections.users) {
    descParts.push(`Потребители: ${sections.users}`);
  }

  if (sections.specifics) {
    descParts.push(`Специфики: ${sections.specifics}`);
  }

  if (sections.files) {
    descParts.push(`Файлове: ${sections.files}`);
  }

  if (sections.scenarios) {
    descParts.push(`Сценарии:\n${sections.scenarios}`);
  }

  if (sections.result) {
    descParts.push(`Краен резултат: ${sections.result}`);
  }

  if (sections.other) {
    descParts.push(`Други: ${sections.other}`);
  }

  for (const [key, value] of Object.entries(sections)) {
    if (key.startsWith('__unknown_') && value) {
      descParts.push(value);
    }
  }

  const constraints = sections.constraints ? extractBullets(sections.constraints) : [];

  const role = sections.character
    ? sections.character.split('\n')[0].trim()
    : '';

  const tone = sections.tone?.trim() || undefined;

  const maxLen =
    extractMaxResponseLength(sections.result || '') ||
    extractMaxResponseLength(sections.other || '') ||
    extractMaxResponseLength(sections.constraints || '') ||
    extractMaxResponseLength(sections.specifics || '');

  const missingHints: string[] = [];
  if (!sections.character) missingHints.push('Герой');
  if (!sections.specifics && !sections.constraints) missingHints.push('Специфики/Ограничения');
  if (!sections.tone) missingHints.push('Тон');

  if (missingHints.length > 0) {
    descParts.push(
      `\n[Секции ${missingHints.join(', ')} не са попълнени — извлечи детайлите от качените референтни файлове.]`
    );
  }

  const description = descParts.join('\n\n');

  if (!description.trim()) {
    throw new Error('Задачата трябва да съдържа поне "## Какво правим" или описателен текст.');
  }

  return {
    id: `task_${Date.now()}`,
    name: name || 'Bot',
    description,
    category: 'assistant',
    requirements: {
      role,
      constraints,
      ...(tone ? { tone } : {}),
      ...(maxLen ? { maxResponseLength: maxLen } : {}),
    },
  };
}
