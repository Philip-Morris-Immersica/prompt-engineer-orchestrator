import fs from 'fs/promises';
import path from 'path';

export interface PlaygroundMessage {
  role: 'user' | 'assistant';
  content: string;
  promptRev: number;
  error?: boolean;
}

/** A finished chat of one version, parked so it can be previewed or restored later. */
export interface PlaygroundChatArchive {
  id: string;          // e.g. "chat_1772726976092"
  savedAt: number;
  messages: PlaygroundMessage[];
}

export const MAX_CHAT_ARCHIVES = 20;

export interface PlaygroundEvaluation {
  status: 'idle' | 'testing' | 'analyzing' | 'done' | 'stopped' | 'error';
  scenarioIds: string[];
  passedCount?: number;
  totalCount?: number;
  passRate?: number;
  qualityScore?: number;
  analysis?: unknown;      // Analysis
  transcripts?: unknown[]; // Transcript[]
  cost?: number;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface PlaygroundVersion {
  id: string;          // "v1", "v2", ...
  label: string;       // "Original", "V2", ...
  locked: boolean;     // true only for the first (Original) version
  prompt: string;
  promptRev: number;
  messages: PlaygroundMessage[];
  cost: number;
  chatHistory?: PlaygroundChatArchive[];  // newest first; absent in sessions saved before archiving existed
}

export interface PlaygroundSession {
  runId: string;
  baseIteration: number;
  basePromptHash: string;
  view: 'tabs' | 'parallel';
  visibleVersionIds: string[];
  model: string;
  temperature: number;
  seed: number;
  versions: PlaygroundVersion[];   // 1..5
  createdAt: number;
  updatedAt: number;
}

export const MAX_VERSIONS = 5;

const RUN_ID_RE = /^run_\d+$/;
const ITER_RE = /^\d{1,2}$/;
const VERSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Reject path-traversal-shaped ids. Every playground route must call this
 * and return 400 when it yields null.
 */
export function sanitizeIds(
  runId: string,
  iter: string,
): { runId: string; iter: number } | null {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return null;
  if (typeof iter !== 'string' || !ITER_RE.test(iter)) return null;
  const iterNum = parseInt(iter, 10);
  if (!Number.isInteger(iterNum) || iterNum < 1 || iterNum > 99) return null;
  return { runId, iter: iterNum };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateMessage(value: unknown): PlaygroundMessage | null {
  if (!isPlainObject(value)) return null;
  if (value.role !== 'user' && value.role !== 'assistant') return null;
  if (typeof value.content !== 'string') return null;
  let promptRev = 0;
  if (value.promptRev !== undefined) {
    if (!isFiniteNumber(value.promptRev)) return null;
    promptRev = value.promptRev;
  }
  const message: PlaygroundMessage = {
    role: value.role,
    content: value.content,
    promptRev,
  };
  if (value.error !== undefined) {
    if (typeof value.error !== 'boolean') return null;
    message.error = value.error;
  }
  return message;
}

function validateChatArchive(value: unknown): PlaygroundChatArchive | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.id !== 'string' || !value.id) return null;
  if (!isFiniteNumber(value.savedAt)) return null;
  if (!Array.isArray(value.messages)) return null;

  const messages: PlaygroundMessage[] = [];
  for (const raw of value.messages) {
    const message = validateMessage(raw);
    if (!message) return null;
    messages.push(message);
  }

  return { id: value.id, savedAt: value.savedAt, messages };
}

function validateVersion(value: unknown): PlaygroundVersion | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.id !== 'string' || !value.id) return null;
  if (typeof value.label !== 'string') return null;
  if (typeof value.prompt !== 'string') return null;
  if (typeof value.locked !== 'boolean') return null;
  if (!isFiniteNumber(value.promptRev)) return null;
  if (!isFiniteNumber(value.cost)) return null;
  if (!Array.isArray(value.messages)) return null;

  const messages: PlaygroundMessage[] = [];
  for (const raw of value.messages) {
    const message = validateMessage(raw);
    if (!message) return null;
    messages.push(message);
  }

  const version: PlaygroundVersion = {
    id: value.id,
    label: value.label,
    locked: value.locked,
    prompt: value.prompt,
    promptRev: value.promptRev,
    messages,
    cost: value.cost,
  };

  // A single corrupt archive drops itself, not the whole version — losing the
  // live chat over an unreadable piece of history would be the worse trade.
  if (Array.isArray(value.chatHistory)) {
    const archives: PlaygroundChatArchive[] = [];
    for (const raw of value.chatHistory) {
      const archive = validateChatArchive(raw);
      if (archive) archives.push(archive);
    }
    archives.sort((a, b) => b.savedAt - a.savedAt);
    version.chatHistory = archives.slice(0, MAX_CHAT_ARCHIVES);
  }

  return version;
}

/**
 * Hand-written session validator (no Zod). Returns a cleaned session or null.
 */
export function validateSession(input: unknown): PlaygroundSession | null {
  if (!isPlainObject(input)) return null;

  if (typeof input.runId !== 'string' || !input.runId) return null;
  if (!isFiniteNumber(input.baseIteration)) return null;
  if (typeof input.basePromptHash !== 'string') return null;
  if (input.view !== 'tabs' && input.view !== 'parallel') return null;
  if (!Array.isArray(input.visibleVersionIds)) return null;
  if (!input.visibleVersionIds.every((id) => typeof id === 'string')) return null;
  if (typeof input.model !== 'string' || !input.model) return null;
  if (!isFiniteNumber(input.temperature)) return null;
  if (!isFiniteNumber(input.seed)) return null;
  if (!Array.isArray(input.versions)) return null;
  if (input.versions.length < 1 || input.versions.length > MAX_VERSIONS) return null;
  if (!isFiniteNumber(input.createdAt)) return null;

  const versions: PlaygroundVersion[] = [];
  for (const raw of input.versions) {
    const version = validateVersion(raw);
    if (!version) return null;
    versions.push(version);
  }

  if (versions[0].locked !== true) return null;

  return {
    runId: input.runId,
    baseIteration: input.baseIteration,
    basePromptHash: input.basePromptHash,
    view: input.view,
    visibleVersionIds: input.visibleVersionIds as string[],
    model: input.model,
    temperature: Math.min(2, Math.max(0, input.temperature)),
    seed: input.seed,
    versions,
    createdAt: input.createdAt,
    updatedAt: isFiniteNumber(input.updatedAt) ? input.updatedAt : input.createdAt,
  };
}

function safeVersionId(versionId: string): string {
  if (VERSION_ID_RE.test(versionId)) return versionId;
  return 'unknown';
}

export class PlaygroundStore {
  private dataDir: string;

  constructor(dataDir = process.env.DATA_DIR || './data') {
    this.dataDir = dataDir;
  }

  private padIter(iter: number): string {
    return String(iter).padStart(2, '0');
  }

  private sessionDir(runId: string): string {
    return path.join(this.dataDir, 'playground', runId);
  }

  private sessionPath(runId: string, iter: number): string {
    return path.join(this.sessionDir(runId), `${this.padIter(iter)}.json`);
  }

  private evalPath(runId: string, iter: number): string {
    return path.join(this.sessionDir(runId), `${this.padIter(iter)}.eval.json`);
  }

  async loadSession(runId: string, iter: number): Promise<PlaygroundSession | null> {
    try {
      const text = await fs.readFile(this.sessionPath(runId, iter), 'utf-8');
      return validateSession(JSON.parse(text));
    } catch {
      return null;
    }
  }

  async saveSession(runId: string, iter: number, session: PlaygroundSession): Promise<void> {
    session.updatedAt = Date.now();
    const dir = this.sessionDir(runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      this.sessionPath(runId, iter),
      JSON.stringify(session, null, 2),
      'utf-8',
    );
  }

  async loadEvaluations(runId: string, iter: number): Promise<Record<string, PlaygroundEvaluation>> {
    try {
      const text = await fs.readFile(this.evalPath(runId, iter), 'utf-8');
      const parsed = JSON.parse(text);
      if (!isPlainObject(parsed)) return {};
      return parsed as Record<string, PlaygroundEvaluation>;
    } catch {
      return {};
    }
  }

  async setEvaluation(
    runId: string,
    iter: number,
    versionId: string,
    evaluation: PlaygroundEvaluation,
  ): Promise<void> {
    const all = await this.loadEvaluations(runId, iter);
    all[versionId] = evaluation;
    const dir = this.sessionDir(runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.evalPath(runId, iter), JSON.stringify(all, null, 2), 'utf-8');
  }

  stopSignalPath(runId: string, iter: number, versionId: string): string {
    return path.join(
      this.sessionDir(runId),
      `${this.padIter(iter)}.${safeVersionId(versionId)}.stop`,
    );
  }

  async requestStop(runId: string, iter: number, versionId: string): Promise<void> {
    const filePath = this.stopSignalPath(runId, iter, versionId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, new Date().toISOString(), 'utf-8');
  }

  async clearStop(runId: string, iter: number, versionId: string): Promise<void> {
    try {
      await fs.unlink(this.stopSignalPath(runId, iter, versionId));
    } catch {
      // already gone
    }
  }

  async deleteSession(runId: string, iter: number): Promise<void> {
    await Promise.all([
      fs.unlink(this.sessionPath(runId, iter)).catch(() => {}),
      fs.unlink(this.evalPath(runId, iter)).catch(() => {}),
    ]);
  }
}
