/**
 * Parses a markdown-formatted (or completely free-form) task definition into
 * a TaskSchema-compatible object.
 *
 * Supported sections (all optional except that SOME text must be present):
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
 *
 * Headings are recognized as `#`..`######` (any depth) followed by a space,
 * OR a standalone `**Heading**` / `**Heading:**` line. Matching is lenient:
 * punctuation like `:`, `-`, `/`, `*`, `_` around the heading text is ignored,
 * and combined headings (e.g. "Специфики/Ограничения") are split and matched
 * against every part.
 *
 * IMPORTANT: any text that appears before the first recognized heading, or
 * that the parser cannot attribute to a known/unknown heading, is NEVER
 * discarded — it is kept verbatim as a "preamble" block and always included
 * in the final description. Plain free-form text with no headings at all is
 * therefore preserved in full, not silently dropped.
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
  'персонаж': 'character',
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
  'прикачени файлове': 'files',
  'attached files': 'files',
  'тон': 'tone',
  'tone': 'tone',
  'краен резултат': 'result',
  'result': 'result',
  'сценарии': 'scenarios',
  'scenarios': 'scenarios',
  'тест сценарии': 'scenarios',
  'test scenarios': 'scenarios',
  'допълнителни изисквания': 'other',
  'additional requirements': 'other',
  'други важни неща': 'other',
  'други': 'other',
  'other': 'other',
};

/** Bucket for text that appears before any heading, or between/around headings
 *  that could not be matched to anything — never discarded. */
const PREAMBLE_KEY = '__preamble__';

function stripPunctuation(text: string): string {
  return text.trim().toLowerCase().replace(/[:\-–—*_]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Resolves a heading's text to zero or more canonical section keys.
 * Handles combined headings like "Специфики/Ограничения" by splitting on
 * common separators and matching every part independently.
 */
function normalizeKeys(heading: string): string[] {
  const whole = stripPunctuation(heading);
  const wholeMatch = matchAlias(whole);
  if (wholeMatch) return [wholeMatch];

  const parts = heading.split(/[\/,+]|\bи\b|\band\b/i);
  if (parts.length <= 1) return [];

  const keys = new Set<string>();
  for (const part of parts) {
    const cleaned = stripPunctuation(part);
    const match = matchAlias(cleaned);
    if (match) keys.add(match);
  }
  return Array.from(keys);
}

function matchAlias(cleaned: string): string | null {
  if (!cleaned) return null;
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

/** Matches a heading-like line: `#`..`######` + space + text, or a standalone `**bold**` line. */
function matchHeadingLine(line: string): { text: string; isTitle: boolean } | null {
  const hashMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (hashMatch) {
    return { text: hashMatch[2].trim(), isTitle: hashMatch[1].length === 1 };
  }
  const boldMatch = line.match(/^\*\*([^*]+?)\*\*:?\s*$/);
  if (boldMatch) {
    return { text: boldMatch[1].trim(), isTitle: false };
  }
  return null;
}

export function isMarkdownTask(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.startsWith('{')) return false;
  return /^#{1,6}\s+.+/m.test(trimmed) || /^\*\*[^*]+\*\*:?\s*$/m.test(trimmed);
}

export function parseMarkdownTask(input: string): ParsedTask {
  const lines = input.split('\n');

  let name = '';
  let sawTitle = false;
  const sections: Record<string, string> = {};
  let currentKeys: string[] = [];
  let currentLines: string[] = [];

  const flushSection = () => {
    const text = currentLines.join('\n').trim();
    currentLines = [];
    if (!text) return;

    const keys = currentKeys.length > 0 ? currentKeys : [PREAMBLE_KEY];
    for (const key of keys) {
      sections[key] = sections[key] ? `${sections[key]}\n\n${text}` : text;
    }
  };

  for (const line of lines) {
    const heading = matchHeadingLine(line);
    if (heading) {
      // The very first single-`#` heading in the document is treated as the
      // task title. Any later heading (of any depth) is a section heading —
      // this keeps `# Title` working while also tolerating `###`, `####`, etc.
      if (heading.isTitle && !sawTitle && Object.keys(sections).length === 0 && currentLines.length === 0) {
        flushSection();
        name = heading.text;
        sawTitle = true;
        currentKeys = [];
        continue;
      }

      flushSection();
      sawTitle = true; // no more title-taking once any section has started
      const keys = normalizeKeys(heading.text);
      currentKeys = keys.length > 0 ? keys : ['__unknown_' + heading.text.trim().toLowerCase()];
      continue;
    }

    currentLines.push(line);
  }
  flushSection();

  const descParts: string[] = [];

  // Preamble — anything typed before/around headings, or plain free text
  // with no headings at all. Always preserved, never dropped.
  if (sections[PREAMBLE_KEY]) {
    descParts.push(sections[PREAMBLE_KEY]);
  }

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

  // role = first "real" line of the Герой section — skip purely parenthetical
  // notes like "(виж пълния профил в шаблонния файл)" which carry no actual
  // role content, so we don't accidentally capture a placeholder as the role.
  const role = sections.character
    ? (sections.character
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !/^\(.*\)$/.test(l)) ?? sections.character.split('\n')[0]
      ).trim()
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

  // Only nudge the model to lean on uploaded files if there is genuinely
  // little else to go on — a rich preamble/whatWeAreDoing block already
  // gives it plenty of context, so don't undercut that with the hint.
  const hasSubstantialFreeText = (sections[PREAMBLE_KEY]?.length ?? 0) + (sections.whatWeAreDoing?.length ?? 0) > 200;
  if (missingHints.length > 0 && !hasSubstantialFreeText) {
    descParts.push(
      `\n[Секции ${missingHints.join(', ')} не са попълнени — извлечи детайлите от качените референтни файлове.]`
    );
  }

  const description = descParts.join('\n\n');

  if (!description.trim()) {
    throw new Error('Задачата трябва да съдържа описателен текст.');
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
