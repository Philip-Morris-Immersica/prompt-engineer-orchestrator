'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';

/* ────────────────────────────────────────────────────────────────────────────
   Types — mirrored from the playground API on purpose. Nothing is imported
   from src/backend so the sandbox stays a pure client-side add-on.
   ──────────────────────────────────────────────────────────────────────────── */

interface PlaygroundMessage {
  role: 'user' | 'assistant';
  content: string;
  promptRev: number;
  error?: boolean;
}

interface PlaygroundChatArchive {
  id: string;
  savedAt: number;
  messages: PlaygroundMessage[];
}

interface PlaygroundIssue {
  severity: 'high' | 'medium' | 'low';
  category: string;
  description: string;
  improvementDirection?: string;
  rootCauseArea?: string;
}

type ScenarioVerdict = 'pass' | 'fail' | 'mixed' | 'not_evaluable';
type VsChampion = 'better' | 'same' | 'worse' | 'n/a';

/** Scores are 1..5 in half steps; the analyzer writes one entry per evaluated dimension. */
interface PlaygroundDimensionScore {
  score: number;
  vsChampion: VsChampion;
  evidence: string;
}

interface PlaygroundScenarioAnalysis {
  scenarioId: string;
  verdict?: ScenarioVerdict;
  passed?: boolean;
  strengths?: string[];
  issues?: PlaygroundIssue[];
  dimensionScores?: Record<string, PlaygroundDimensionScore>;
}

interface PlaygroundTestQuality {
  overallQuality?: string;
  isChallengingEnough?: boolean;
  isRealistic?: boolean;
  notes?: string[];
  suggestedImprovementsForNextRun?: string[];
}

interface PlaygroundAnalysis {
  overallScore?: number;
  passRate?: number;
  scenarios?: PlaygroundScenarioAnalysis[];
  generalSuggestions?: string[];
  testQualityObservations?: PlaygroundTestQuality;
}

interface PlaygroundTranscriptMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface PlaygroundUtterance {
  utteranceId: string;
  originalText: string;
  actualMessage: string;
  rephrased: boolean;
  turnIndex: number;
  group: string;
}

/** Structural mirror of the backend `Transcript` — only the fields this panel renders. */
interface PlaygroundTranscript {
  scenarioId: string;
  scenarioName: string;
  expectedBehavior: string;
  messages: PlaygroundTranscriptMessage[];
  driverMode?: boolean;
  stopReason?: string;
  userGoal?: string;
  maxTurns?: number;
  totalUserTurns?: number;
  utteranceLog?: PlaygroundUtterance[];
}

type EvaluationStatus = 'idle' | 'testing' | 'analyzing' | 'done' | 'stopped' | 'error';

interface PlaygroundEvaluation {
  status: EvaluationStatus;
  scenarioIds: string[];
  passedCount?: number;
  totalCount?: number;
  passRate?: number;
  qualityScore?: number;
  analysis?: PlaygroundAnalysis;
  transcripts?: unknown[];   // narrowed through `asTranscripts` — the payload is not validated server-side
  cost?: number;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

interface PlaygroundVersion {
  id: string;
  label: string;
  locked: boolean;
  prompt: string;
  promptRev: number;
  messages: PlaygroundMessage[];
  cost: number;
  chatHistory?: PlaygroundChatArchive[];  // newest first; undefined for sessions saved before archiving
}

interface PlaygroundSession {
  runId: string;
  baseIteration: number;
  basePromptHash: string;
  view: 'tabs' | 'parallel';
  visibleVersionIds: string[];
  model: string;
  temperature: number;
  seed: number;
  versions: PlaygroundVersion[];
  createdAt: number;
  updatedAt: number;
}

interface PlaygroundScenarioRef { id: string; name: string }

interface PlaygroundDefaults {
  basePrompt: string;
  basePromptHash: string;
  model: string;
  temperature: number;
  seed: number;
  scenarios: PlaygroundScenarioRef[];
  championIteration: number | null;
  runStatus: string;
}

interface GetPlaygroundResponse {
  session: PlaygroundSession | null;
  evaluations: Record<string, PlaygroundEvaluation>;
  defaults: PlaygroundDefaults;
}

interface ChatResponse { reply: string; cost: number; model: string }

export interface PromptPlaygroundProps {
  runId: string;
  iteration: number;
  onClose: () => void;
}

const MAX_VERSIONS       = 5;
const AUTOSAVE_MS        = 800;
const EVAL_POLL_MS       = 4000;
const MIN_COL_WIDTH      = 280;
const MAX_CHAT_ARCHIVES  = 20;   // must match playground-store.ts
const DIFF_CONTEXT_LINES = 6;    // longer runs of unchanged lines fold away
const DIFF_LCS_MAX_LINES = 2000; // above this an n·m table is not worth allocating
const REPLAY_CONFIRM_AT  = 4;    // ask before re-sending more than this many replies

/* ── Shared inline-style helpers (the codebase styles with objects, not classes) ── */

const SEG_WRAP: CSSProperties = {
  display: 'inline-flex', background: '#f3f4f6', borderRadius: 10, padding: 3, gap: 2,
};
const segBtn = (active: boolean): CSSProperties => ({
  padding: '6px 14px', fontSize: 12, fontWeight: 700, borderRadius: 8,
  border: 'none', cursor: 'pointer', transition: 'all .15s',
  background: active ? '#fff' : 'transparent',
  color: active ? '#6366f1' : '#9ca3af',
  boxShadow: active ? '0 1px 3px rgba(0,0,0,.08)' : 'none',
});
const ghostBtn = (disabled = false): CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 14px', fontSize: 12, fontWeight: 600,
  color: '#6b7280', background: '#fff', border: '1.5px solid #e5e7eb', borderRadius: 10,
  cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
  transition: 'all .15s',
});
const primaryBtn = (disabled = false): CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 7,
  padding: '9px 18px', fontSize: 12, fontWeight: 700, color: '#fff',
  border: 'none', borderRadius: 10,
  cursor: disabled ? 'not-allowed' : 'pointer',
  background: disabled ? '#d1d5db' : 'linear-gradient(135deg,#6366f1,#8b5cf6)',
  boxShadow: disabled ? 'none' : '0 2px 8px rgba(99,102,241,.35)',
});
const SEV_STYLE: Record<string, { bg: string; color: string; border: string }> = {
  high:   { bg: '#fee2e2', color: '#991b1b', border: '#fecaca' },
  medium: { bg: '#fef3c7', color: '#92400e', border: '#fde68a' },
  low:    { bg: '#f3f4f6', color: '#374151', border: '#e5e7eb' },
};

const fmtCost = (c: number) => `$${c.toFixed(3)}`;
/** The evaluation cost is small enough that three decimals hide the difference. */
const fmtCostPrecise = (c: number) => `$${c.toFixed(4)}`;

const VERDICT_STYLE: Record<ScenarioVerdict, { bg: string; color: string; border: string; label: string; headerBg: string }> = {
  pass:          { bg: '#d1fae5', color: '#065f46', border: '#a7f3d0', label: '✓ PASS',  headerBg: '#f0fdf4' },
  fail:          { bg: '#fee2e2', color: '#991b1b', border: '#fecaca', label: '✕ FAIL',  headerBg: '#fef2f2' },
  mixed:         { bg: '#fef3c7', color: '#92400e', border: '#fde68a', label: '◑ MIXED', headerBg: '#fffbeb' },
  not_evaluable: { bg: '#f1f5f9', color: '#64748b', border: '#e2e8f0', label: '— N/A',   headerBg: '#f8fafc' },
};

const UTTERANCE_GROUP_STYLE: Record<string, { bg: string; color: string; border: string }> = {
  opening:    { bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
  discovery:  { bg: '#f0fdf4', color: '#166534', border: '#bbf7d0' },
  objections: { bg: '#fef3c7', color: '#92400e', border: '#fde68a' },
  close:      { bg: '#f5f3ff', color: '#6d28d9', border: '#ddd6fe' },
  improvised: { bg: '#f9fafb', color: '#6b7280', border: '#e5e7eb' },
};

const VS_CHAMPION_STYLE: Record<'better' | 'same' | 'worse', { color: string; bg: string; border: string; label: string }> = {
  better: { color: '#065f46', bg: '#d1fae5', border: '#a7f3d0', label: '↑ по-добре' },
  same:   { color: '#4b5563', bg: '#f3f4f6', border: '#e5e7eb', label: '= същото' },
  worse:  { color: '#991b1b', bg: '#fee2e2', border: '#fecaca', label: '↓ по-зле' },
};

/* ── Small pure helpers ── */

/** Multiset line comparison — enough for an "N added / M removed" badge, no diff library. */
function diffLineCounts(base: string, next: string): { added: number; removed: number } {
  const remaining = new Map<string, number>();
  for (const line of base.split('\n')) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of next.split('\n')) {
    const left = remaining.get(line) ?? 0;
    if (left > 0) remaining.set(line, left - 1);
    else added++;
  }
  let removed = 0;
  remaining.forEach(count => { removed += count; });
  return { added, removed };
}

/** Same threshold the run page uses for its Analysis score cards. */
const ratioColor = (ratio: number) => (ratio >= 0.75 ? '#059669' : '#d97706');

/** Dimension scores are on a 1..5 scale, so they need their own thresholds. */
const dimensionColor = (score: number) => (score >= 4 ? '#059669' : score >= 3 ? '#d97706' : '#dc2626');

const fmtPercent = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;

/** `role_consistency` → `Role consistency`. */
function humaniseDimension(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The evaluation payload is stored by the evaluator and returned as-is by the API —
 * it is never validated, so the panel narrows it defensively instead of casting.
 */
function asTranscripts(value: unknown): PlaygroundTranscript[] {
  if (!Array.isArray(value)) return [];
  const out: PlaygroundTranscript[] = [];
  for (const raw of value) {
    if (!isRecordValue(raw)) continue;
    if (typeof raw.scenarioId !== 'string' || !Array.isArray(raw.messages)) continue;
    const messages: PlaygroundTranscriptMessage[] = [];
    for (const msg of raw.messages) {
      if (!isRecordValue(msg)) continue;
      if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'system') continue;
      if (typeof msg.content !== 'string') continue;
      messages.push({ role: msg.role, content: msg.content });
    }
    const utteranceLog: PlaygroundUtterance[] = [];
    if (Array.isArray(raw.utteranceLog)) {
      for (const utt of raw.utteranceLog) {
        if (!isRecordValue(utt)) continue;
        if (typeof utt.utteranceId !== 'string' || typeof utt.actualMessage !== 'string') continue;
        utteranceLog.push({
          utteranceId: utt.utteranceId,
          originalText: typeof utt.originalText === 'string' ? utt.originalText : '',
          actualMessage: utt.actualMessage,
          rephrased: utt.rephrased === true,
          turnIndex: typeof utt.turnIndex === 'number' ? utt.turnIndex : 0,
          group: typeof utt.group === 'string' ? utt.group : 'improvised',
        });
      }
    }
    out.push({
      scenarioId: raw.scenarioId,
      scenarioName: typeof raw.scenarioName === 'string' ? raw.scenarioName : raw.scenarioId,
      expectedBehavior: typeof raw.expectedBehavior === 'string' ? raw.expectedBehavior : '',
      messages,
      driverMode: raw.driverMode === true,
      stopReason: typeof raw.stopReason === 'string' ? raw.stopReason : undefined,
      userGoal: typeof raw.userGoal === 'string' ? raw.userGoal : undefined,
      maxTurns: typeof raw.maxTurns === 'number' ? raw.maxTurns : undefined,
      totalUserTurns: typeof raw.totalUserTurns === 'number' ? raw.totalUserTurns : undefined,
      utteranceLog: utteranceLog.length > 0 ? utteranceLog : undefined,
    });
  }
  return out;
}

/** Weakest dimensions first — that is what a calibration pass needs to see. */
function sortedDimensions(
  scores: Record<string, PlaygroundDimensionScore> | undefined,
): Array<[string, PlaygroundDimensionScore]> {
  if (!scores) return [];
  return Object.entries(scores)
    .filter(([, dim]) => isRecordValue(dim) && typeof dim.score === 'number')
    .sort((a, b) => a[1].score - b[1].score);
}

const verdictOf = (sc: PlaygroundScenarioAnalysis): ScenarioVerdict =>
  sc.verdict ?? (sc.passed ? 'pass' : 'fail');

type DiffLineType = 'same' | 'add' | 'del';

interface DiffLine {
  type: DiffLineType;
  text: string;
  oldLine?: number;
  newLine?: number;
}

/**
 * Prefix/suffix trim with everything between reported as one replaced block.
 * Used instead of the LCS table when a side is too long to diff line by line.
 */
function coarseLineDiff(base: string[], next: string[]): DiffLine[] {
  let start = 0;
  while (start < base.length && start < next.length && base[start] === next[start]) start++;

  let endBase = base.length - 1;
  let endNext = next.length - 1;
  while (endBase >= start && endNext >= start && base[endBase] === next[endNext]) { endBase--; endNext--; }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ type: 'same', text: base[i], oldLine: i + 1, newLine: i + 1 });
  for (let i = start; i <= endBase; i++) out.push({ type: 'del', text: base[i], oldLine: i + 1 });
  for (let j = start; j <= endNext; j++) out.push({ type: 'add', text: next[j], newLine: j + 1 });
  for (let i = endBase + 1; i < base.length; i++) {
    out.push({ type: 'same', text: base[i], oldLine: i + 1, newLine: endNext + 1 + (i - endBase) });
  }
  return out;
}

/** Plain LCS line diff — no dependency, and an n·m table over ~600 lines costs nothing. */
function computeLineDiff(base: string, next: string): DiffLine[] {
  const a = base.split('\n');
  const b = next.split('\n');
  if (a.length > DIFF_LCS_MAX_LINES || b.length > DIFF_LCS_MAX_LINES) return coarseLineDiff(a, b);

  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + (j + 1)] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + (j + 1)]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i], oldLine: i + 1, newLine: j + 1 });
      i++; j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + (j + 1)]) {
      out.push({ type: 'del', text: a[i], oldLine: i + 1 });
      i++;
    } else {
      out.push({ type: 'add', text: b[j], newLine: j + 1 });
      j++;
    }
  }
  while (i < n) { out.push({ type: 'del', text: a[i], oldLine: i + 1 }); i++; }
  while (j < m) { out.push({ type: 'add', text: b[j], newLine: j + 1 }); j++; }
  return out;
}

/**
 * Archive ids double as sort keys, so the stamp must be strictly increasing:
 * `Нов чат` archives every version inside a single tick.
 */
let lastArchiveStamp = 0;
function nextArchiveStamp(): number {
  const now = Date.now();
  lastArchiveStamp = now > lastArchiveStamp ? now : lastArchiveStamp + 1;
  return lastArchiveStamp;
}

/** Moves the live chat of a version into its history. Versions without messages are untouched. */
function archiveChat(version: PlaygroundVersion): PlaygroundVersion {
  if (version.messages.length === 0) return version;
  const savedAt = nextArchiveStamp();
  const archive: PlaygroundChatArchive = { id: `chat_${savedAt}`, savedAt, messages: version.messages };
  return {
    ...version,
    messages: [],
    chatHistory: [archive, ...(version.chatHistory ?? [])].slice(0, MAX_CHAT_ARCHIVES),
  };
}

const archiveCount = (version: PlaygroundVersion | null | undefined) => version?.chatHistory?.length ?? 0;

const fmtArchiveTime = (savedAt: number) =>
  new Date(savedAt).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });

const fmtMessageCount = (count: number) => `${count} ${count === 1 ? 'съобщение' : 'съобщения'}`;

/** Index of the last user message, or -1. `findLastIndex` is newer than the tsconfig lib. */
function lastUserIndex(messages: PlaygroundMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

/** Splits a thread into one group per user turn, so parallel columns can align by index. */
function groupByUserTurn(messages: PlaygroundMessage[]): Array<{ user: PlaygroundMessage | null; replies: PlaygroundMessage[] }> {
  const groups: Array<{ user: PlaygroundMessage | null; replies: PlaygroundMessage[] }> = [];
  for (const msg of messages) {
    if (msg.role === 'user') { groups.push({ user: msg, replies: [] }); continue; }
    if (groups.length === 0) groups.push({ user: null, replies: [] });
    groups[groups.length - 1].replies.push(msg);
  }
  return groups;
}

const userTexts = (messages: PlaygroundMessage[]) =>
  messages.filter(m => m.role === 'user').map(m => m.content);

function sameUserHistory(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((text, i) => text === b[i]);
}

function nextVersionNumber(versions: PlaygroundVersion[]): number {
  let max = 0;
  for (const v of versions) {
    const n = Number.parseInt(v.id.replace(/^v/, ''), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

function highSeverityCount(analysis?: PlaygroundAnalysis): number {
  if (!analysis?.scenarios) return 0;
  return analysis.scenarios.reduce(
    (sum, sc) => sum + (sc.issues ?? []).filter(i => i.severity === 'high').length, 0,
  );
}

/** Same thresholds as the run page: all passed → green, high severity → red, otherwise amber. */
function evalColor(ev: PlaygroundEvaluation): string {
  const passed = ev.passedCount ?? 0;
  const total  = ev.totalCount ?? 0;
  if (total > 0 && passed === total) return '#059669';
  if (highSeverityCount(ev.analysis) > 0) return '#dc2626';
  return '#d97706';
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Неизвестна грешка';
}

/* ────────────────────────────────────────────────────────────────────────────
   Sub-components
   ──────────────────────────────────────────────────────────────────────────── */

function Spinner({ size = 11 }: { size?: number }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%', display: 'inline-block', flexShrink: 0,
      border: '2px solid #c7d2fe', borderTopColor: '#6366f1', animation: 'spin .7s linear infinite',
    }} />
  );
}

function PulseDot() {
  return (
    <span style={{
      width: 6, height: 6, borderRadius: '50%', background: '#6366f1', flexShrink: 0,
      animation: 'pgPulse 1.1s ease-in-out infinite',
    }} />
  );
}

function Bubble({ msg, compact = false }: { msg: PlaygroundMessage; compact?: boolean }) {
  const isUser = msg.role === 'user';
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div style={{
        maxWidth: compact ? '100%' : '78%',
        padding: compact ? '8px 11px' : '10px 14px',
        fontSize: compact ? 11 : 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
        background: msg.error ? '#fef2f2' : isUser ? '#eef2ff' : '#fff',
        color: msg.error ? '#991b1b' : '#1f2937',
        border: `1px solid ${msg.error ? '#fecaca' : isUser ? '#c7d2fe' : '#e5e7eb'}`,
        boxShadow: '0 1px 4px rgba(0,0,0,.05)',
      }}>
        {msg.error && <span style={{ fontWeight: 700, marginRight: 6 }}>✕</span>}
        {msg.content}
      </div>
    </div>
  );
}

function PromptChangeDivider() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0' }}>
      <div style={{ flex: 1, height: 1, background: '#e5e7eb' }} />
      <span style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', whiteSpace: 'nowrap' }}>
        ⚙️ промптът е сменен оттук
      </span>
      <div style={{ flex: 1, height: 1, background: '#e5e7eb' }} />
    </div>
  );
}

function MessageThread({ messages, awaiting }: { messages: PlaygroundMessage[]; awaiting: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, awaiting]);

  return (
    <div ref={boxRef} style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', background: '#fafafa' }}>
      {messages.length === 0 && !awaiting ? (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <div style={{ fontSize: 34 }}>💬</div>
          <p style={{ fontSize: 13, fontWeight: 700, color: '#6b7280', margin: 0 }}>Още няма съобщения</p>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, textAlign: 'center', maxWidth: 380 }}>
            Напиши реплика долу, за да пробваш промпта на тази версия. Нищо от чата не влиза в ръна.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {messages.map((msg, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {i > 0 && messages[i - 1].promptRev !== msg.promptRev && <PromptChangeDivider />}
              <Bubble msg={msg} />
            </div>
          ))}
          {awaiting && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#6b7280' }}>
              <Spinner /> ботът пише…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ArchiveBanner({
  archive, onExit,
}: {
  archive: PlaygroundChatArchive;
  onExit: () => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      padding: '9px 20px', background: '#fffbeb', borderBottom: '1px solid #fde68a',
    }}>
      <span style={{ fontSize: 11, fontWeight: 800, color: '#92400e' }}>
        🗂 Разглеждаш архивиран чат от {fmtArchiveTime(archive.savedAt)}
      </span>
      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
        {fmtMessageCount(archive.messages.length)}
      </span>
      <button
        type="button"
        onClick={onExit}
        title="Върни се към живия чат на версията"
        style={{ ...ghostBtn(), marginLeft: 'auto', padding: '4px 12px', fontSize: 11, color: '#92400e', borderColor: '#fde68a' }}
      >
        Изход
      </button>
    </div>
  );
}

function HistoryMenu({
  archives, onView, onRestore,
}: {
  archives: PlaygroundChatArchive[];
  onView: (archiveId: string) => void;
  onRestore: (archiveId: string) => void;
}) {
  return (
    <div style={{
      position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 40,
      width: 290, padding: 6, background: '#fff', border: '1px solid #e5e7eb',
      borderRadius: 12, boxShadow: '0 8px 32px rgba(17,24,39,.16)',
      maxHeight: 280, overflowY: 'auto',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', padding: '4px 6px 8px' }}>
        Архивирани чатове
      </div>
      {archives.map(archive => (
        <div
          key={archive.id}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 6px', borderRadius: 8 }}
        >
          <span style={{ fontSize: 11, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap' }}>
            {fmtArchiveTime(archive.savedAt)}
          </span>
          <span style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>
            · {fmtMessageCount(archive.messages.length)}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            <button
              type="button"
              onClick={() => onView(archive.id)}
              title="Прегледай чата, без да го връщаш"
              style={{ ...ghostBtn(), padding: '3px 9px', fontSize: 11 }}
            >
              Виж
            </button>
            <button
              type="button"
              onClick={() => onRestore(archive.id)}
              title="Върни този чат като активен"
              style={{ ...ghostBtn(), padding: '3px 9px', fontSize: 11, color: '#6366f1', borderColor: '#c7d2fe', background: '#eef2ff' }}
            >
              Възстанови
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ScenarioPicker({
  scenarios, onStart, onCancel,
}: {
  scenarios: PlaygroundScenarioRef[];
  onStart: (scenarioIds: string[]) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(scenarios.map(s => s.id));

  const toggle = (id: string) =>
    setSelected(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));

  return (
    <div style={{
      position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 40,
      width: 300, padding: 12, background: '#fff', border: '1px solid #e5e7eb',
      borderRadius: 12, boxShadow: '0 8px 32px rgba(17,24,39,.16)',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
        Сценарии за тестване
      </div>
      {scenarios.length === 0 ? (
        <p style={{ fontSize: 11, color: '#9ca3af', margin: '0 0 10px' }}>
          Рънът няма запазен тест план — оценяването не е възможно.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto', marginBottom: 10 }}>
          {scenarios.map(sc => (
            <label key={sc.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 8, cursor: 'pointer', fontSize: 11, color: '#374151' }}>
              <input type="checkbox" checked={selected.includes(sc.id)} onChange={() => toggle(sc.id)} style={{ accentColor: '#6366f1' }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sc.name || sc.id}</span>
            </label>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel} style={ghostBtn()}>Отказ</button>
        <button
          type="button"
          onClick={() => onStart(selected)}
          disabled={selected.length === 0}
          style={primaryBtn(selected.length === 0)}
        >
          Стартирай
        </button>
      </div>
    </div>
  );
}

function EvalControls({
  versionId, evaluation, scenarios, showRunWarning, expanded, onToggleExpanded, onStart, onStop,
}: {
  versionId: string;
  evaluation?: PlaygroundEvaluation;
  scenarios: PlaygroundScenarioRef[];
  showRunWarning: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onStart: (versionId: string, scenarioIds: string[]) => void;
  onStop: (versionId: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const status = evaluation?.status ?? 'idle';
  const inFlight = status === 'testing' || status === 'analyzing';

  if (inFlight) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: '#6366f1' }}>
          <Spinner /> {status === 'testing' ? 'Тестване…' : 'Анализ…'}
        </span>
        <button
          type="button"
          onClick={() => onStop(versionId)}
          style={{ ...ghostBtn(), padding: '4px 10px', fontSize: 11, color: '#dc2626', borderColor: '#fecaca' }}
        >
          Спри
        </button>
      </div>
    );
  }

  const done = status === 'done';
  const color = evaluation ? evalColor(evaluation) : '#6b7280';
  const scorePct = evaluation
    ? Math.round(((evaluation.qualityScore ?? evaluation.passRate ?? 0) * 100))
    : 0;

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6 }}>
      {done && (
        <button
          type="button"
          onClick={onToggleExpanded}
          title="Покажи issues по сценарий"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '3px 9px', borderRadius: 20, cursor: 'pointer',
            fontSize: 10, fontWeight: 800, color: '#fff', border: 'none',
            background: `linear-gradient(135deg,${color},${color}dd)`,
            boxShadow: `0 2px 6px ${color}55`,
          }}
        >
          {evaluation?.passedCount ?? 0}/{evaluation?.totalCount ?? 0} · {scorePct}%
          <span style={{ opacity: 0.8 }}>{expanded ? '▴' : '▾'}</span>
        </button>
      )}
      {status === 'stopped' && (
        <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20, background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0' }}>
          ■ спряна
        </span>
      )}
      {status === 'error' && (
        <span title={evaluation?.error} style={{ fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20, background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}>
          ✕ грешка
        </span>
      )}
      <button
        type="button"
        onClick={() => setPickerOpen(o => !o)}
        disabled={scenarios.length === 0}
        title={scenarios.length === 0 ? 'Рънът няма запазен тест план' : 'Пусни фиксирания тест план на ръна с този промпт'}
        style={{ ...ghostBtn(scenarios.length === 0), padding: '4px 10px', fontSize: 11, color: '#6366f1', borderColor: '#c7d2fe', background: '#eef2ff' }}
      >
        🎯 Оцени
      </button>
      {showRunWarning && (
        <span
          title="Рънът още работи — паралелните тестове споделят същия rate limit."
          style={{ fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}
        >
          ⚠ Рънът още работи — паралелните тестове споделят същия rate limit.
        </span>
      )}
      {pickerOpen && (
        <ScenarioPicker
          scenarios={scenarios}
          onCancel={() => setPickerOpen(false)}
          onStart={ids => { setPickerOpen(false); onStart(versionId, ids); }}
        />
      )}
    </div>
  );
}

const SECTION_LABEL: CSSProperties = {
  fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em',
};

/** Metric cards copied from the run page's Analysis tab, so the sandbox reads the same. */
function EvalMetrics({
  evaluation, scenarios,
}: {
  evaluation: PlaygroundEvaluation;
  scenarios: PlaygroundScenarioRef[];
}) {
  const quality  = evaluation.qualityScore ?? evaluation.analysis?.overallScore;
  const passRate = evaluation.passRate ?? evaluation.analysis?.passRate;
  const total    = evaluation.totalCount ?? 0;
  const passed   = evaluation.passedCount ?? 0;

  const cards: Array<{ label: string; value: string; color: string }> = [
    {
      label: 'Качество',
      value: typeof quality === 'number' ? fmtPercent(quality) : '—',
      color: typeof quality === 'number' ? ratioColor(quality) : '#9ca3af',
    },
    {
      label: 'Pass rate',
      value: typeof passRate === 'number' ? fmtPercent(passRate) : '—',
      color: typeof passRate === 'number' ? ratioColor(passRate) : '#9ca3af',
    },
    {
      label: 'Преминали',
      value: total > 0 ? `${passed}/${total}` : '—',
      color: total > 0 ? ratioColor(passed / total) : '#9ca3af',
    },
    {
      label: 'Цена',
      value: typeof evaluation.cost === 'number' ? fmtCostPrecise(evaluation.cost) : '—',
      color: '#374151',
    },
  ];

  const nameById = new Map(scenarios.map(s => [s.id, s.name]));
  const evaluated = (evaluation.scenarioIds ?? []).map(id => ({ id, name: nameById.get(id) || id }));

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        {cards.map(card => (
          <div key={card.label} style={{
            flex: 1, minWidth: 110, padding: '12px 16px', background: '#fff',
            border: '1px solid #f0f0f0', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,.04)',
          }}>
            <div style={{ ...SECTION_LABEL, color: '#9ca3af', marginBottom: 4 }}>{card.label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: card.color }}>{card.value}</div>
          </div>
        ))}
      </div>
      {evaluated.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          <span style={SECTION_LABEL}>Тествани сценарии</span>
          {evaluated.map(sc => (
            <span key={sc.id} style={{
              fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
              background: '#eef2ff', color: '#4338ca', border: '1px solid #c7d2fe',
            }}>
              {sc.name}
            </span>
          ))}
        </div>
      )}
      <p style={{ fontSize: 10, color: '#9ca3af', margin: 0 }}>
        Резултатът е запазен — ще е тук и след като затвориш и отвориш песъчника отново.
      </p>
    </div>
  );
}

/** 1..5 scores with a bar, a champion comparison and the evidence quote behind a click. */
function DimensionScores({ scores }: { scores?: Record<string, PlaygroundDimensionScore> }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const entries = useMemo(() => sortedDimensions(scores), [scores]);

  if (entries.length === 0) return null;

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ ...SECTION_LABEL, marginBottom: 6 }}>Оценка по дименсии · най-слабите отгоре</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {entries.map(([key, dim]) => {
          const color       = dimensionColor(dim.score);
          const open        = openKey === key;
          const vs          = dim.vsChampion && dim.vsChampion !== 'n/a' ? VS_CHAMPION_STYLE[dim.vsChampion] : null;
          const hasEvidence = typeof dim.evidence === 'string' && dim.evidence.trim().length > 0;
          return (
            <div key={key} style={{ background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8, padding: '7px 10px' }}>
              <button
                type="button"
                onClick={() => { if (hasEvidence) setOpenKey(prev => (prev === key ? null : key)); }}
                title={hasEvidence ? 'Покажи цитата от разговора' : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: 0, border: 'none', background: 'transparent', textAlign: 'left',
                  fontFamily: 'inherit', cursor: hasEvidence ? 'pointer' : 'default',
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 700, color: '#374151', flex: 1, minWidth: 0 }}>
                  {humaniseDimension(key)}
                </span>
                {vs && (
                  <span style={{
                    fontSize: 9, fontWeight: 800, padding: '1px 7px', borderRadius: 20,
                    background: vs.bg, color: vs.color, border: `1px solid ${vs.border}`, whiteSpace: 'nowrap',
                  }}>
                    {vs.label}
                  </span>
                )}
                <span style={{ fontSize: 11, fontWeight: 800, color, whiteSpace: 'nowrap' }}>
                  {dim.score} / 5
                </span>
                {hasEvidence && <span style={{ fontSize: 9, color: '#9ca3af' }}>{open ? '▴' : '▾'}</span>}
              </button>
              <div style={{ marginTop: 6, height: 6, borderRadius: 20, background: '#f3f4f6', overflow: 'hidden' }}>
                <div style={{
                  width: `${Math.max(0, Math.min(1, dim.score / 5)) * 100}%`, height: '100%',
                  borderRadius: 20, background: `linear-gradient(90deg,${color},${color}bb)`,
                }} />
              </div>
              {open && hasEvidence && (
                <p style={{
                  margin: '7px 0 0', padding: '6px 10px', fontSize: 11, lineHeight: 1.6,
                  fontStyle: 'italic', color: '#6b7280', background: '#f9fafb',
                  borderLeft: '2px solid #e5e7eb', borderRadius: 6,
                }}>
                  „{dim.evidence}“
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TranscriptEntry({
  transcript, verdict, open, onToggle,
}: {
  transcript: PlaygroundTranscript;
  verdict?: ScenarioVerdict;
  open: boolean;
  onToggle: () => void;
}) {
  const chat       = transcript.messages.filter(m => m.role !== 'system');
  const userTurns  = chat.filter(m => m.role === 'user').length;
  const utterances = transcript.utteranceLog ?? [];
  const uttByMsg   = new Map(utterances.map(u => [u.actualMessage, u]));
  const vs         = verdict ? VERDICT_STYLE[verdict] : null;
  const border     = vs ? vs.border : transcript.driverMode ? '#a5f3fc' : '#e5e7eb';

  return (
    <div style={{ border: `1px solid ${border}`, borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%',
          padding: '10px 12px', textAlign: 'left', fontFamily: 'inherit', cursor: 'pointer',
          border: 'none', background: open ? (vs ? vs.headerBg : '#ecfeff') : '#fafafa',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginBottom: 4 }}>
            {vs && (
              <span style={{ fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 20, background: vs.bg, color: vs.color, border: `1px solid ${vs.border}` }}>
                {vs.label}
              </span>
            )}
            <span style={{ fontSize: 12, fontWeight: 800, color: '#111827' }}>{transcript.scenarioName}</span>
            {transcript.driverMode && (
              <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20, background: '#cffafe', color: '#0e7490', border: '1px solid #a5f3fc' }}>
                🎭 AI Test Driver
              </span>
            )}
            {transcript.stopReason && (
              <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20, background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0' }}>
                ⏹ {transcript.stopReason}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 10, color: '#6b7280' }}>
            <span>
              {fmtMessageCount(chat.length)} · {userTurns} реплики
              {transcript.maxTurns ? ` от ${transcript.maxTurns} макс.` : ''}
            </span>
            {utterances.length > 0 && (
              <span>
                {utterances.filter(u => u.utteranceId !== 'improvised').length} по план ·{' '}
                {utterances.filter(u => u.rephrased).length} преформулирани ·{' '}
                {utterances.filter(u => u.utteranceId === 'improvised').length} импровизирани
              </span>
            )}
          </div>
        </div>
        <span style={{ fontSize: 10, color: '#9ca3af', flexShrink: 0, marginTop: 2 }}>{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <>
          {(transcript.expectedBehavior || transcript.userGoal) && (
            <div style={{ padding: '10px 12px', background: '#f9fafb', borderTop: '1px solid #f0f0f0' }}>
              {transcript.expectedBehavior && (
                <div style={{ marginBottom: transcript.userGoal ? 8 : 0 }}>
                  <div style={{ ...SECTION_LABEL, marginBottom: 3 }}>Очаквано поведение</div>
                  <p style={{ fontSize: 11, lineHeight: 1.6, color: '#374151', margin: 0 }}>{transcript.expectedBehavior}</p>
                </div>
              )}
              {transcript.userGoal && (
                <div>
                  <div style={{ ...SECTION_LABEL, marginBottom: 3 }}>Цел на потребителя</div>
                  <p style={{ fontSize: 11, lineHeight: 1.6, color: '#374151', margin: 0 }}>{transcript.userGoal}</p>
                </div>
              )}
            </div>
          )}

          {utterances.length > 0 && (
            <div style={{ padding: '10px 12px', background: '#f8fafc', borderTop: '1px solid #f0f0f0' }}>
              <div style={{ ...SECTION_LABEL, marginBottom: 6 }}>Репликите на драйвъра</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {utterances.map((u, i) => {
                  const gc = UTTERANCE_GROUP_STYLE[u.group] ?? UTTERANCE_GROUP_STYLE.improvised;
                  return (
                    <span
                      key={`${u.utteranceId}-${i}`}
                      title={u.rephrased ? `Оригинал: „${u.originalText}“` : u.originalText}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px',
                        borderRadius: 20, background: gc.bg, border: `1px solid ${gc.border}`,
                      }}
                    >
                      <span style={{ fontSize: 9, fontWeight: 800, color: gc.color }}>
                        {u.utteranceId === 'improvised' ? 'IMP' : u.utteranceId.toUpperCase()}
                      </span>
                      <span style={{ fontSize: 9, color: gc.color, opacity: 0.8 }}>{u.group}</span>
                      {u.rephrased && <span style={{ fontSize: 9, fontWeight: 700, color: '#f59e0b' }}>~</span>}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{
            display: 'flex', flexDirection: 'column', gap: 8,
            padding: '12px', maxHeight: 420, overflowY: 'auto',
            background: '#fafafa', borderTop: '1px solid #f0f0f0',
          }}>
            {chat.length === 0 ? (
              <p style={{ fontSize: 11, color: '#9ca3af', margin: 0 }}>Разговорът е празен.</p>
            ) : chat.map((msg, i) => {
              const utt = msg.role === 'user' ? uttByMsg.get(msg.content) : undefined;
              const gc  = utt ? (UTTERANCE_GROUP_STYLE[utt.group] ?? UTTERANCE_GROUP_STYLE.improvised) : null;
              return (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap',
                    justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  }}>
                    <span style={{ fontSize: 9, fontWeight: 700, color: msg.role === 'user' ? '#0891b2' : '#7c3aed' }}>
                      {msg.role === 'user'
                        ? (transcript.driverMode ? '🎭 потребител (драйвър)' : '🎭 потребител')
                        : '🤖 тестваният бот'}
                    </span>
                    {utt && gc && (
                      <span style={{
                        fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 20,
                        background: gc.bg, color: gc.color, border: `1px solid ${gc.border}`,
                      }}>
                        {utt.utteranceId === 'improvised' ? 'импровизирана' : `${utt.utteranceId} · ${utt.group}`}
                        {utt.rephrased ? ' ~' : ''}
                      </span>
                    )}
                  </div>
                  <Bubble msg={{ role: msg.role === 'assistant' ? 'assistant' : 'user', content: msg.content, promptRev: 0 }} />
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function TranscriptList({
  transcripts, verdictById,
}: {
  transcripts: PlaygroundTranscript[];
  verdictById: Map<string, ScenarioVerdict>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  /* Failures first — same ordering as the run page's Transcripts tab. */
  const ordered = useMemo(() => {
    const rank: Record<ScenarioVerdict, number> = { fail: 0, mixed: 1, pass: 2, not_evaluable: 3 };
    return [...transcripts].sort((a, b) => {
      const av = verdictById.get(a.scenarioId);
      const bv = verdictById.get(b.scenarioId);
      return (av ? rank[av] : 2) - (bv ? rank[bv] : 2);
    });
  }, [transcripts, verdictById]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {ordered.map(tr => (
        <TranscriptEntry
          key={tr.scenarioId}
          transcript={tr}
          verdict={verdictById.get(tr.scenarioId)}
          open={openId === tr.scenarioId}
          onToggle={() => setOpenId(prev => (prev === tr.scenarioId ? null : tr.scenarioId))}
        />
      ))}
    </div>
  );
}

function EvalDetails({ evaluation, scenarios }: { evaluation: PlaygroundEvaluation; scenarios: PlaygroundScenarioRef[] }) {
  const nameById    = useMemo(() => new Map(scenarios.map(s => [s.id, s.name])), [scenarios]);
  const list        = useMemo(() => evaluation.analysis?.scenarios ?? [], [evaluation.analysis]);
  const transcripts = useMemo(() => asTranscripts(evaluation.transcripts), [evaluation.transcripts]);
  const verdictById = useMemo(() => {
    const map = new Map<string, ScenarioVerdict>();
    for (const sc of list) map.set(sc.scenarioId, verdictOf(sc));
    return map;
  }, [list]);

  const suggestions = evaluation.analysis?.generalSuggestions ?? [];
  const testQuality = evaluation.analysis?.testQualityObservations;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '12px 16px', background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 12 }}>

      {/* ── 1. Metrics ── */}
      <div>
        <div style={{ ...SECTION_LABEL, marginBottom: 8 }}>Резултат от оценката</div>
        <EvalMetrics evaluation={evaluation} scenarios={scenarios} />
      </div>

      {/* ── 2. Per scenario: verdict, dimensions, strengths, issues ── */}
      <div>
        <div style={{ ...SECTION_LABEL, marginBottom: 8 }}>Оценка по сценарии</div>
        {list.length === 0 ? (
          <p style={{ fontSize: 11, color: '#9ca3af', margin: 0 }}>Няма подробен анализ за тази оценка.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {list.map(sc => {
              const vs = VERDICT_STYLE[verdictOf(sc)];
              return (
                <div key={sc.scenarioId} style={{ background: '#fff', border: `1px solid ${vs.border}`, borderRadius: 10, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 20, background: vs.bg, color: vs.color, border: `1px solid ${vs.border}` }}>
                      {vs.label}
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#374151' }}>
                      {nameById.get(sc.scenarioId) || sc.scenarioId}
                    </span>
                  </div>

                  <DimensionScores scores={sc.dimensionScores} />

                  {sc.strengths && sc.strengths.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ ...SECTION_LABEL, color: '#059669', marginBottom: 4 }}>Какво работи добре</div>
                      {sc.strengths.map((s, i) => (
                        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 3, padding: '5px 8px', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 6 }}>
                          <span style={{ color: '#059669', fontWeight: 700, fontSize: 11 }}>✓</span>
                          <span style={{ fontSize: 11, color: '#065f46' }}>{s}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {(sc.issues ?? []).map((iss, i) => {
                    const ss = SEV_STYLE[iss.severity] ?? SEV_STYLE.low;
                    return (
                      <div key={i} style={{ marginTop: 6, padding: '8px 10px', background: ss.bg, border: `1px solid ${ss.border}`, borderRadius: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 10, fontWeight: 800, color: ss.color, background: ss.border, padding: '1px 7px', borderRadius: 20 }}>
                            {iss.severity.toUpperCase()}
                          </span>
                          <span style={{ fontSize: 11, fontWeight: 700, color: ss.color }}>{iss.category}</span>
                          {iss.rootCauseArea && iss.rootCauseArea !== iss.category && (
                            <span style={{ fontSize: 10, color: '#6b7280', background: '#f3f4f6', padding: '1px 6px', borderRadius: 10, border: '1px solid #e5e7eb' }}>
                              {iss.rootCauseArea}
                            </span>
                          )}
                        </div>
                        <p style={{ fontSize: 11, color: '#374151', margin: '0 0 3px' }}>{iss.description}</p>
                        {iss.improvementDirection && (
                          <p style={{ fontSize: 11, color: '#6b7280', margin: 0, fontStyle: 'italic' }}>→ {iss.improvementDirection}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── General guidance from the analyzer ── */}
      {suggestions.length > 0 && (
        <div>
          <div style={{ ...SECTION_LABEL, marginBottom: 8 }}>Посоки за подобрение</div>
          {suggestions.map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 5, padding: '8px 12px', background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 8 }}>
              <span style={{ color: '#6366f1', fontWeight: 800, fontSize: 12, lineHeight: 1.3 }}>→</span>
              <span style={{ fontSize: 11, lineHeight: 1.6, color: '#3730a3' }}>{s}</span>
            </div>
          ))}
        </div>
      )}

      {testQuality && (
        <div>
          <div style={{ ...SECTION_LABEL, marginBottom: 8 }}>Качество на тест плана</div>
          <div style={{ padding: '10px 12px', background: '#fff', border: '1px solid #f0f0f0', borderRadius: 10 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: (testQuality.notes?.length || testQuality.suggestedImprovementsForNextRun?.length) ? 8 : 0 }}>
              {testQuality.overallQuality && (
                <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb' }}>
                  {testQuality.overallQuality}
                </span>
              )}
              {typeof testQuality.isChallengingEnough === 'boolean' && (
                <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: testQuality.isChallengingEnough ? '#d1fae5' : '#fef3c7', color: testQuality.isChallengingEnough ? '#065f46' : '#92400e', border: `1px solid ${testQuality.isChallengingEnough ? '#a7f3d0' : '#fde68a'}` }}>
                  {testQuality.isChallengingEnough ? '✓ достатъчно предизвикателен' : '⚠ недостатъчно предизвикателен'}
                </span>
              )}
              {typeof testQuality.isRealistic === 'boolean' && (
                <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: testQuality.isRealistic ? '#d1fae5' : '#fef3c7', color: testQuality.isRealistic ? '#065f46' : '#92400e', border: `1px solid ${testQuality.isRealistic ? '#a7f3d0' : '#fde68a'}` }}>
                  {testQuality.isRealistic ? '✓ реалистичен' : '⚠ не е реалистичен'}
                </span>
              )}
            </div>
            {[...(testQuality.notes ?? []), ...(testQuality.suggestedImprovementsForNextRun ?? [])].map((note, i) => (
              <p key={i} style={{ fontSize: 11, lineHeight: 1.6, color: '#6b7280', margin: '0 0 4px' }}>· {note}</p>
            ))}
          </div>
        </div>
      )}

      {/* ── 3. Conversations ── */}
      <div>
        <div style={{ ...SECTION_LABEL, marginBottom: 8 }}>Разговори ({transcripts.length})</div>
        {transcripts.length === 0 ? (
          <p style={{ fontSize: 11, color: '#9ca3af', margin: 0 }}>
            Тази оценка не е запазила разговори.
          </p>
        ) : (
          <TranscriptList transcripts={transcripts} verdictById={verdictById} />
        )}
      </div>
    </div>
  );
}

function RenameInput({
  initial, onCommit, onCancel,
}: {
  initial: string;
  onCommit: (label: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      value={value}
      onChange={e => setValue(e.target.value)}
      onClick={e => e.stopPropagation()}
      onBlur={() => onCommit(value)}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); onCommit(value); }
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      }}
      style={{
        width: 90, fontSize: 12, fontWeight: 700, color: '#111827', background: '#f9fafb',
        border: '1.5px solid #c7d2fe', borderRadius: 6, padding: '2px 6px', outline: 'none',
      }}
    />
  );
}

function VersionTab({
  version, active, awaiting, menuOpen, renaming, onSelect, onToggleMenu, onStartRename,
  onCommitRename, onCancelRename, onDuplicate, onDelete,
}: {
  version: PlaygroundVersion;
  active: boolean;
  awaiting: boolean;
  menuOpen: boolean;
  renaming: boolean;
  onSelect: () => void;
  onToggleMenu: () => void;
  onStartRename: () => void;
  onCommitRename: (label: string) => void;
  onCancelRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={() => { if (!version.locked) onStartRename(); }}
        title={version.locked ? 'Оригиналният промпт — само за четене' : 'Двоен клик за преименуване'}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: version.locked ? '7px 14px' : '7px 26px 7px 14px',
          fontSize: 12, fontWeight: 700, cursor: 'pointer',
          background: active ? '#fff' : 'transparent',
          color: active ? '#6366f1' : '#9ca3af',
          border: `1.5px solid ${active ? '#c7d2fe' : 'transparent'}`,
          borderRadius: 10, transition: 'all .15s',
        }}
      >
        {version.locked && <span style={{ fontSize: 11 }}>🔒</span>}
        {renaming ? (
          <RenameInput initial={version.label} onCommit={onCommitRename} onCancel={onCancelRename} />
        ) : (
          <span>{version.label}</span>
        )}
        {awaiting && <PulseDot />}
      </button>
      {!version.locked && (
        <button
          type="button"
          onClick={onToggleMenu}
          title="Действия за версията"
          style={{
            position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
            width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: 'none', background: 'transparent', color: '#9ca3af', cursor: 'pointer',
            fontSize: 13, lineHeight: 1, borderRadius: 6,
          }}
        >
          ⋯
        </button>
      )}
      {menuOpen && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 30,
          minWidth: 150, padding: 4, background: '#fff', border: '1px solid #e5e7eb',
          borderRadius: 10, boxShadow: '0 8px 24px rgba(17,24,39,.14)',
        }}>
          {[
            { label: '✎ Преименувай', action: onStartRename, danger: false },
            { label: '⧉ Дублирай',    action: onDuplicate,   danger: false },
            { label: '🗑 Изтрий',      action: onDelete,      danger: true },
          ].map(item => (
            <button
              key={item.label}
              type="button"
              onClick={item.action}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '7px 10px', fontSize: 12, fontWeight: 600,
                border: 'none', background: 'transparent', borderRadius: 8, cursor: 'pointer',
                color: item.danger ? '#dc2626' : '#374151',
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PromptPane({
  version, basePrompt, onChange, onReset, onShowDiff,
}: {
  version: PlaygroundVersion;
  basePrompt: string;
  onChange: (prompt: string) => void;
  onReset: () => void;
  onShowDiff: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const diff = useMemo(() => diffLineCounts(basePrompt, version.prompt), [basePrompt, version.prompt]);
  const changed = diff.added > 0 || diff.removed > 0;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(version.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard unavailable — nothing useful to show */ }
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '14px 20px', background: '#fafafa' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
          Системен промпт · rev {version.promptRev}
        </span>
        {version.locked ? (
          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
            🔒 Оригиналът е защитен
          </span>
        ) : (
          <button
            type="button"
            onClick={onShowDiff}
            title="Отвори промените ред по ред в изгледа «Разлики»"
            style={{
              fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 20,
              border: 'none', cursor: 'pointer',
              background: changed ? 'linear-gradient(135deg,#6366f1,#8b5cf6)' : '#f3f4f6',
              color: changed ? '#fff' : '#6b7280',
            }}
          >
            {changed ? `+${diff.added} / −${diff.removed} реда спрямо оригинала` : 'без разлика спрямо оригинала'}
          </button>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button type="button" onClick={copy} style={ghostBtn()}>{copied ? '✓ Копирано' : 'Копирай'}</button>
          {!version.locked && (
            <button type="button" onClick={onReset} disabled={!changed} style={ghostBtn(!changed)}>
              Върни оригинала
            </button>
          )}
        </div>
      </div>
      <textarea
        value={version.prompt}
        readOnly={version.locked}
        onChange={e => onChange(e.target.value)}
        spellCheck={false}
        style={{
          flex: 1, minHeight: 0, width: '100%', resize: 'none',
          padding: '14px 16px', fontSize: 12, lineHeight: 1.7,
          fontFamily: "'Fira Code', 'JetBrains Mono', 'Cascadia Code', monospace",
          color: '#111827', background: version.locked ? '#f3f4f6' : '#fff',
          border: '1.5px solid #e5e7eb', borderRadius: 12, outline: 'none',
        }}
      />
    </div>
  );
}

type DiffBlock =
  | { kind: 'line'; index: number; line: DiffLine }
  | { kind: 'fold'; index: number; count: number };

const DIFF_ROW: Record<DiffLineType, { bg: string; color: string; sign: string; signColor: string }> = {
  same: { bg: '#fff',    color: '#6b7280', sign: '',  signColor: '#d1d5db' },
  add:  { bg: '#ecfdf5', color: '#065f46', sign: '+', signColor: '#059669' },
  del:  { bg: '#fef2f2', color: '#991b1b', sign: '−', signColor: '#dc2626' },
};

const DIFF_GUTTER: CSSProperties = {
  width: 34, flexShrink: 0, textAlign: 'right', paddingRight: 8,
  color: '#d1d5db', userSelect: 'none',
};

/** Read-only line diff against the locked Original — a textarea cannot colour its own text. */
function DiffPane({ version, basePrompt }: { version: PlaygroundVersion; basePrompt: string }) {
  const [onlyChanges, setOnlyChanges] = useState(true);
  const [expandedRuns, setExpandedRuns] = useState<number[]>([]);

  const lines = useMemo(() => computeLineDiff(basePrompt, version.prompt), [basePrompt, version.prompt]);

  const counts = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const line of lines) {
      if (line.type === 'add') added++;
      else if (line.type === 'del') removed++;
    }
    return { added, removed };
  }, [lines]);

  const blocks = useMemo(() => {
    const out: DiffBlock[] = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i].type !== 'same') {
        out.push({ kind: 'line', index: i, line: lines[i] });
        i++;
        continue;
      }
      let end = i;
      while (end < lines.length && lines[end].type === 'same') end++;
      const runLength = end - i;
      if (onlyChanges && runLength > DIFF_CONTEXT_LINES && !expandedRuns.includes(i)) {
        out.push({ kind: 'fold', index: i, count: runLength });
      } else {
        for (let k = i; k < end; k++) out.push({ kind: 'line', index: k, line: lines[k] });
      }
      i = end;
    }
    return out;
  }, [lines, onlyChanges, expandedRuns]);

  const changed = counts.added > 0 || counts.removed > 0;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '14px 20px', background: '#fafafa' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
          Разлики спрямо оригинала
        </span>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 20,
          background: changed ? 'linear-gradient(135deg,#6366f1,#8b5cf6)' : '#f3f4f6',
          color: changed ? '#fff' : '#6b7280',
        }}>
          {changed ? `+${counts.added} реда · −${counts.removed} реда` : 'без разлика спрямо оригинала'}
        </span>
        <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: '#374151', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={onlyChanges}
            onChange={() => { setOnlyChanges(o => !o); setExpandedRuns([]); }}
            style={{ accentColor: '#6366f1' }}
          />
          само промените
        </label>
      </div>

      <div style={{
        flex: 1, minHeight: 0, overflow: 'auto', background: '#fff',
        border: '1.5px solid #e5e7eb', borderRadius: 12, padding: '10px 0',
        fontSize: 11, lineHeight: 1.7,
        fontFamily: "'Fira Code', 'JetBrains Mono', 'Cascadia Code', monospace",
      }}>
        {blocks.length === 0 ? (
          <p style={{ fontSize: 11, color: '#9ca3af', margin: 0, padding: '0 14px' }}>Промптът е празен.</p>
        ) : blocks.map(block => {
          if (block.kind === 'fold') {
            return (
              <button
                key={`fold-${block.index}`}
                type="button"
                onClick={() => setExpandedRuns(prev => [...prev, block.index])}
                title="Покажи непроменените редове"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  width: '100%', padding: '5px 14px', margin: '3px 0',
                  fontSize: 10, fontWeight: 700, fontFamily: 'inherit',
                  color: '#9ca3af', background: '#f9fafb',
                  borderTop: '1px solid #f0f0f0', borderBottom: '1px solid #f0f0f0',
                  borderLeft: 'none', borderRight: 'none', cursor: 'pointer',
                }}
              >
                ⋯ {block.count} непроменени реда
              </button>
            );
          }
          const row = DIFF_ROW[block.line.type];
          return (
            <div
              key={`line-${block.index}`}
              style={{ display: 'flex', alignItems: 'flex-start', padding: '0 14px', background: row.bg }}
            >
              <span style={DIFF_GUTTER}>{block.line.oldLine ?? ''}</span>
              <span style={DIFF_GUTTER}>{block.line.newLine ?? ''}</span>
              <span style={{ width: 14, flexShrink: 0, fontWeight: 700, color: row.signColor, userSelect: 'none' }}>
                {row.sign}
              </span>
              <span style={{ flex: 1, minWidth: 0, color: row.color, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {block.line.text || '\u00A0'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Main component
   ──────────────────────────────────────────────────────────────────────────── */

export default function PromptPlayground({ runId, iteration, onClose }: PromptPlaygroundProps) {
  const [session, setSession]         = useState<PlaygroundSession | null>(null);
  const [defaults, setDefaults]       = useState<PlaygroundDefaults | null>(null);
  const [evaluations, setEvaluations] = useState<Record<string, PlaygroundEvaluation>>({});
  const [loading, setLoading]         = useState(true);
  const [loadError, setLoadError]     = useState<string | null>(null);

  const [activeVersionId, setActiveVersionId] = useState<string>('');
  const [pane, setPane]                       = useState<'chat' | 'prompt' | 'diff'>('chat');
  const [draft, setDraft]                     = useState('');
  const [awaiting, setAwaiting]               = useState<Record<string, boolean>>({});
  const [replay, setReplay]                   = useState<{ versionId: string; done: number; total: number } | null>(null);
  const [menuVersionId, setMenuVersionId]     = useState<string | null>(null);
  const [renameVersionId, setRenameVersionId] = useState<string | null>(null);
  const [expandedEvalId, setExpandedEvalId]   = useState<string | null>(null);
  const [historyVersionId, setHistoryVersionId] = useState<string | null>(null);
  const [preview, setPreview]                   = useState<{ versionId: string; archiveId: string } | null>(null);

  const mountedRef        = useRef(true);
  const sessionRef        = useRef<PlaygroundSession | null>(null);
  const savedSnapshotRef  = useRef<string | null>(null);
  const bootstrappedRef   = useRef(false);
  const busyRef           = useRef(false);
  const replayAbortRef    = useRef<AbortController | null>(null);
  const replayCancelRef   = useRef(false);
  const activeVersionRef  = useRef('');

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { activeVersionRef.current = activeVersionId; }, [activeVersionId]);

  /* ── Derived state ── */

  const versions       = useMemo(() => session?.versions ?? [], [session]);
  const activeVersion  = versions.find(v => v.id === activeVersionId) ?? versions[0] ?? null;
  const anyEvalRunning = useMemo(
    () => Object.values(evaluations).some(e => e.status === 'testing' || e.status === 'analyzing'),
    [evaluations],
  );
  const anyAwaiting = useMemo(() => Object.values(awaiting).some(Boolean), [awaiting]);
  const totalCost   = useMemo(() => {
    const chat = versions.reduce((sum, v) => sum + (v.cost ?? 0), 0);
    const evals = Object.values(evaluations).reduce((sum, e) => sum + (e.cost ?? 0), 0);
    return chat + evals;
  }, [versions, evaluations]);

  useEffect(() => {
    busyRef.current = anyEvalRunning || anyAwaiting || replay !== null;
  }, [anyEvalRunning, anyAwaiting, replay]);

  /* ── Persistence ── */

  const persist = useCallback(async (candidate: PlaygroundSession | null) => {
    if (!candidate) return;
    const snapshot = JSON.stringify(candidate);
    if (snapshot === savedSnapshotRef.current) return;
    savedSnapshotRef.current = snapshot;
    try {
      await fetch(`/api/playground/${runId}/${iteration}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: candidate }),
      });
    } catch {
      savedSnapshotRef.current = null;
    }
  }, [runId, iteration]);

  const mutate = useCallback((fn: (s: PlaygroundSession) => PlaygroundSession) => {
    setSession(prev => (prev ? { ...fn(prev), updatedAt: Date.now() } : prev));
  }, []);

  const mutateVersion = useCallback((versionId: string, fn: (v: PlaygroundVersion) => PlaygroundVersion) => {
    mutate(s => ({ ...s, versions: s.versions.map(v => (v.id === versionId ? fn(v) : v)) }));
  }, [mutate]);

  /* ── Bootstrap ── */

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/playground/${runId}/${iteration}`);
      if (!r.ok) throw new Error(`Заявката се провали (${r.status})`);
      const data = await r.json() as GetPlaygroundResponse;
      if (!mountedRef.current) return;

      setDefaults(data.defaults);
      setEvaluations(data.evaluations ?? {});

      if (data.session) {
        setSession(data.session);
        savedSnapshotRef.current = JSON.stringify(data.session);
        setActiveVersionId(data.session.versions[0]?.id ?? '');
      } else {
        const now = Date.now();
        const fresh: PlaygroundSession = {
          runId,
          baseIteration: iteration,
          basePromptHash: data.defaults.basePromptHash,
          view: 'tabs',
          visibleVersionIds: ['v1'],
          model: data.defaults.model,
          temperature: data.defaults.temperature,
          seed: data.defaults.seed,
          versions: [{
            id: 'v1', label: 'Original', locked: true,
            prompt: data.defaults.basePrompt, promptRev: 0, messages: [], cost: 0,
          }],
          createdAt: now,
          updatedAt: now,
        };
        setSession(fresh);
        setActiveVersionId('v1');
        savedSnapshotRef.current = JSON.stringify(fresh);
        await fetch(`/api/playground/${runId}/${iteration}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: fresh }),
        }).catch(() => { savedSnapshotRef.current = null; });
      }
    } catch (err) {
      if (mountedRef.current) setLoadError(errorText(err));
    } finally {
      if (mountedRef.current) {
        bootstrappedRef.current = true;
        setLoading(false);
      }
    }
  }, [runId, iteration]);

  useEffect(() => { void load(); }, [load]);

  /* ── Debounced autosave (never while the initial load is in flight) ── */

  useEffect(() => {
    if (loading || !bootstrappedRef.current || !session) return;
    const timer = setTimeout(() => { void persist(sessionRef.current); }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [session, loading, persist]);

  /* ── Chrome: body scroll lock + Esc ── */

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);

  const requestClose = useCallback(() => {
    if (busyRef.current && !window.confirm('В момента върви изпращане или оценка. Да затворя ли песъчника?')) return;
    replayCancelRef.current = true;
    replayAbortRef.current?.abort();
    onClose();
  }, [onClose]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); requestClose(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [requestClose]);

  /* ── Chat ── */

  const callChat = useCallback(async (
    prompt: string, history: PlaygroundMessage[], signal?: AbortSignal,
  ): Promise<ChatResponse> => {
    const s = sessionRef.current;
    const r = await fetch('/api/playground/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        runId,
        prompt,
        messages: history.map(m => ({ role: m.role, content: m.content })),
        model: s?.model,
        temperature: s?.temperature,
        seed: s?.seed,
      }),
    });
    if (!r.ok) {
      const payload = await r.json().catch(() => ({} as { error?: string }));
      throw new Error(payload.error ?? `Заявката се провали (${r.status})`);
    }
    return await r.json() as ChatResponse;
  }, [runId]);

  const appendAssistant = useCallback((
    versionId: string, content: string, promptRev: number, cost: number, isError: boolean,
  ) => {
    mutateVersion(versionId, v => ({
      ...v,
      cost: v.cost + cost,
      messages: [...v.messages, isError
        ? { role: 'assistant' as const, content, promptRev, error: true }
        : { role: 'assistant' as const, content, promptRev }],
    }));
  }, [mutateVersion]);

  /**
   * One assistant turn for one version — the single place where the awaiting flag,
   * the cost bookkeeping and the error bubble live. Both `send` and `replayLast` use it.
   */
  const runTurn = useCallback(async (job: {
    id: string; prompt: string; promptRev: number; history: PlaygroundMessage[];
  }) => {
    try {
      const res = await callChat(job.prompt, job.history);
      if (mountedRef.current) appendAssistant(job.id, res.reply, job.promptRev, res.cost, false);
    } catch (err) {
      if (mountedRef.current) appendAssistant(job.id, errorText(err), job.promptRev, 0, true);
    } finally {
      if (mountedRef.current) {
        setAwaiting(prev => {
          const next = { ...prev };
          delete next[job.id];
          return next;
        });
      }
    }
  }, [callChat, appendAssistant]);

  const send = useCallback(async (text: string, versionIds: string[]) => {
    const s = sessionRef.current;
    const content = text.trim();
    if (!s || !content) return;

    const jobs = s.versions
      .filter(v => versionIds.includes(v.id))
      .map(v => ({
        id: v.id,
        prompt: v.prompt,
        promptRev: v.promptRev,
        history: [...v.messages, { role: 'user' as const, content, promptRev: v.promptRev }],
      }));
    if (jobs.length === 0) return;

    mutate(prev => ({
      ...prev,
      versions: prev.versions.map(v => (versionIds.includes(v.id)
        ? { ...v, messages: [...v.messages, { role: 'user' as const, content, promptRev: v.promptRev }] }
        : v)),
    }));
    setAwaiting(prev => {
      const next = { ...prev };
      for (const job of jobs) next[job.id] = true;
      return next;
    });

    await Promise.allSettled(jobs.map(job => runTurn(job)));
  }, [mutate, runTurn]);

  /**
   * Re-sends only the last user message: drops the assistant replies that follow it,
   * re-stamps it with the current promptRev and asks again through the same plumbing.
   */
  const replayLast = useCallback(async (versionId: string) => {
    const version = sessionRef.current?.versions.find(v => v.id === versionId);
    if (!version) return;
    const cut = lastUserIndex(version.messages);
    if (cut < 0) return;

    const rev = version.promptRev;
    const history = version.messages
      .slice(0, cut + 1)
      .map((m, i) => (i === cut ? { ...m, promptRev: rev } : m));

    mutateVersion(versionId, v => ({ ...v, messages: history }));
    setAwaiting(prev => ({ ...prev, [versionId]: true }));
    await runTurn({ id: versionId, prompt: version.prompt, promptRev: rev, history });
  }, [mutateVersion, runTurn]);

  const cancelReplay = useCallback(() => {
    replayCancelRef.current = true;
    replayAbortRef.current?.abort();
  }, []);

  const runReplay = useCallback(async (versionId: string) => {
    const s = sessionRef.current;
    const version = s?.versions.find(v => v.id === versionId);
    if (!version) return;

    const script = userTexts(version.messages);
    if (script.length === 0) return;

    const prompt   = version.prompt;
    const rev      = version.promptRev;
    const abort    = new AbortController();
    replayAbortRef.current  = abort;
    replayCancelRef.current = false;

    setReplay({ versionId, done: 0, total: script.length });
    mutateVersion(versionId, v => ({ ...v, messages: [] }));
    setAwaiting(prev => ({ ...prev, [versionId]: true }));

    const history: PlaygroundMessage[] = [];
    for (let i = 0; i < script.length; i++) {
      if (replayCancelRef.current || !mountedRef.current) break;
      const userMsg: PlaygroundMessage = { role: 'user', content: script[i], promptRev: rev };
      history.push(userMsg);
      mutateVersion(versionId, v => ({ ...v, messages: [...v.messages, userMsg] }));
      try {
        const res = await callChat(prompt, history, abort.signal);
        if (replayCancelRef.current || !mountedRef.current) break;
        history.push({ role: 'assistant', content: res.reply, promptRev: rev });
        appendAssistant(versionId, res.reply, rev, res.cost, false);
      } catch (err) {
        if (replayCancelRef.current || !mountedRef.current) break;
        appendAssistant(versionId, errorText(err), rev, 0, true);
      }
      if (mountedRef.current) setReplay(prev => (prev ? { ...prev, done: i + 1 } : prev));
    }

    replayAbortRef.current = null;
    if (mountedRef.current) {
      setReplay(null);
      setAwaiting(prev => {
        const next = { ...prev };
        delete next[versionId];
        return next;
      });
    }
  }, [mutateVersion, callChat, appendAssistant]);

  /** `Пусни отново` throws away every bot answer, so a long thread asks first. */
  const startReplay = useCallback((versionId: string) => {
    const version = sessionRef.current?.versions.find(v => v.id === versionId);
    if (!version) return;
    const total = userTexts(version.messages).length;
    if (total === 0) return;
    if (total > REPLAY_CONFIRM_AT && !window.confirm(
      `Ще пратя наново всичките ти ${total} реплики от началото през текущия промпт на ${version.label}. `
      + 'Всички сегашни отговори на бота ще бъдат заменени. Да продължа ли?',
    )) return;
    void runReplay(versionId);
  }, [runReplay]);

  /* ── Evaluation ── */

  const startEvaluation = useCallback(async (versionId: string, scenarioIds: string[]) => {
    const version = sessionRef.current?.versions.find(v => v.id === versionId);
    if (!version) return;
    setEvaluations(prev => ({ ...prev, [versionId]: { status: 'testing', scenarioIds } }));
    try {
      const r = await fetch(`/api/playground/${runId}/${iteration}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId, prompt: version.prompt, scenarioIds }),
      });
      // 409 means a job for this version is already running — the poll below
      // will report its real phase, so the optimistic state stays.
      if (!r.ok && r.status !== 409) {
        const payload = await r.json().catch(() => ({} as { error?: string }));
        if (!mountedRef.current) return;
        setEvaluations(prev => ({
          ...prev,
          [versionId]: { status: 'error', scenarioIds, error: payload.error ?? `Заявката се провали (${r.status})` },
        }));
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setEvaluations(prev => ({ ...prev, [versionId]: { status: 'error', scenarioIds, error: errorText(err) } }));
    }
  }, [runId, iteration]);

  const stopEvaluation = useCallback(async (versionId: string) => {
    try {
      await fetch(`/api/playground/${runId}/${iteration}/evaluate?versionId=${encodeURIComponent(versionId)}`, {
        method: 'DELETE',
      });
    } catch { /* the poll will report the real state anyway */ }
  }, [runId, iteration]);

  /* Poll only while something is actually in flight. */
  useEffect(() => {
    if (loading || !anyEvalRunning) return;
    let active = true;
    const poll = async () => {
      try {
        const r = await fetch(`/api/playground/${runId}/${iteration}`);
        if (!r.ok) return;
        const data = await r.json() as GetPlaygroundResponse;
        if (!active || !mountedRef.current) return;
        if (data.evaluations) setEvaluations(prev => ({ ...prev, ...data.evaluations }));
      } catch { /* transient — retry on the next tick */ }
    };
    const iv = setInterval(poll, EVAL_POLL_MS);
    return () => { active = false; clearInterval(iv); };
  }, [loading, anyEvalRunning, runId, iteration]);

  /* ── Version management ── */

  const addVersionFrom = useCallback((sourceId: string) => {
    const s = sessionRef.current;
    if (!s || s.versions.length >= MAX_VERSIONS) return;
    const source = s.versions.find(v => v.id === sourceId) ?? s.versions[0];
    if (!source) return;
    const n = nextVersionNumber(s.versions);
    const created: PlaygroundVersion = {
      id: `v${n}`,
      label: `V${n}`,
      locked: false,
      prompt: source.prompt,
      promptRev: source.promptRev,
      messages: source.messages.map(m => ({ ...m })),
      cost: 0,
    };
    mutate(prev => ({
      ...prev,
      versions: [...prev.versions, created],
      visibleVersionIds: [...prev.visibleVersionIds, created.id],
    }));
    setActiveVersionId(created.id);
    setMenuVersionId(null);
  }, [mutate]);

  const deleteVersion = useCallback((versionId: string) => {
    const s = sessionRef.current;
    const target = s?.versions.find(v => v.id === versionId);
    if (!s || !target || target.locked) return;
    if (!window.confirm(`Да изтрия ли версия ${target.label} заедно с чата ѝ?`)) return;
    const fallbackId = s.versions.find(v => v.id !== versionId)?.id ?? '';
    mutate(prev => ({
      ...prev,
      versions: prev.versions.filter(v => v.id !== versionId),
      visibleVersionIds: prev.visibleVersionIds.filter(id => id !== versionId),
    }));
    setEvaluations(prev => {
      const next = { ...prev };
      delete next[versionId];
      return next;
    });
    setMenuVersionId(null);
    setRenameVersionId(null);
    if (activeVersionRef.current === versionId) setActiveVersionId(fallbackId);
  }, [mutate]);

  const renameVersion = useCallback((versionId: string, label: string) => {
    const trimmed = label.trim();
    if (trimmed) mutateVersion(versionId, v => (v.locked ? v : { ...v, label: trimmed }));
    setRenameVersionId(null);
    setMenuVersionId(null);
  }, [mutateVersion]);

  /** Bumps promptRev only once per editing burst — i.e. when the current rev already produced a message. */
  const editPrompt = useCallback((versionId: string, prompt: string) => {
    mutateVersion(versionId, v => {
      if (v.locked) return v;
      const revUsed = v.messages.some(m => m.promptRev === v.promptRev);
      return { ...v, prompt, promptRev: revUsed ? v.promptRev + 1 : v.promptRev };
    });
  }, [mutateVersion]);

  /* ── Chat history ── */

  const closeHistoryUi = useCallback(() => {
    setHistoryVersionId(null);
    setPreview(null);
  }, []);

  /** Header action: archives every non-empty chat at once, nothing is thrown away. */
  const archiveAllChats = useCallback(() => {
    if (!window.confirm(
      'Да започна ли нов чат във всички версии? Сегашните чатове се архивират в «История» '
      + 'и могат да бъдат възстановени — нищо не се губи.',
    )) return;
    mutate(prev => ({ ...prev, versions: prev.versions.map(archiveChat) }));
    closeHistoryUi();
  }, [mutate, closeHistoryUi]);

  const archiveVersionChat = useCallback((versionId: string) => {
    const version = sessionRef.current?.versions.find(v => v.id === versionId);
    if (!version || version.messages.length === 0) return;
    if (!window.confirm(
      `Да започна ли нов чат за ${version.label}? Сегашният се архивира в «История» и може да бъде възстановен.`,
    )) return;
    mutateVersion(versionId, archiveChat);
    closeHistoryUi();
  }, [mutateVersion, closeHistoryUi]);

  const restoreArchive = useCallback((versionId: string, archiveId: string) => {
    const version = sessionRef.current?.versions.find(v => v.id === versionId);
    const archive = version?.chatHistory?.find(a => a.id === archiveId);
    if (!version || !archive) return;
    if (!window.confirm(
      `Да възстановя ли чата от ${fmtArchiveTime(archive.savedAt)} (${fmtMessageCount(archive.messages.length)})? `
      + 'Сегашният чат се архивира.',
    )) return;
    mutateVersion(versionId, v => {
      const parked = archiveChat(v);
      return {
        ...parked,
        messages: archive.messages.map(m => ({ ...m })),
        chatHistory: (parked.chatHistory ?? []).filter(a => a.id !== archiveId),
      };
    });
    closeHistoryUi();
  }, [mutateVersion, closeHistoryUi]);

  const setView = useCallback((view: 'tabs' | 'parallel') => {
    mutate(prev => ({ ...prev, view }));
    closeHistoryUi();
  }, [mutate, closeHistoryUi]);

  const toggleVisible = useCallback((versionId: string) => {
    mutate(prev => ({
      ...prev,
      visibleVersionIds: prev.visibleVersionIds.includes(versionId)
        ? prev.visibleVersionIds.filter(id => id !== versionId)
        : [...prev.visibleVersionIds, versionId],
    }));
  }, [mutate]);

  /* ── Composer wiring ── */

  const visibleVersions = versions.filter(v => (session?.visibleVersionIds ?? []).includes(v.id));
  const parallel        = session?.view === 'parallel';
  const replayTarget    = parallel
    ? (visibleVersions.find(v => v.id === activeVersionId) ?? visibleVersions[0] ?? null)
    : activeVersion;
  const sendBusy        = anyAwaiting || replay !== null;

  /* The locked Original has nothing to diff against, so it keeps the two-segment control. */
  const activePane        = pane === 'diff' && activeVersion?.locked ? 'prompt' : pane;
  const previewedArchive  = !parallel && activeVersion && preview?.versionId === activeVersion.id
    ? activeVersion.chatHistory?.find(a => a.id === preview.archiveId) ?? null
    : null;
  const previewing        = activePane === 'chat' && previewedArchive !== null;
  const replayLastCount   = replayTarget ? userTexts(replayTarget.messages).length : 0;
  const anyChatToArchive  = versions.some(v => v.messages.length > 0);
  /* The diff reference is the locked Original version, not the version's own earlier state. */
  const originalPrompt    = versions[0]?.prompt ?? '';
  /* Archiving mid-turn would land the pending reply in the fresh chat, so the tools wait. */
  const activeChatBusy    = Boolean(activeVersion && (awaiting[activeVersion.id] || replay?.versionId === activeVersion.id));

  const selectPane = useCallback((next: 'chat' | 'prompt' | 'diff') => {
    setPane(next);
    setHistoryVersionId(null);
    if (next !== 'chat') setPreview(null);
  }, []);

  const submitDraft = useCallback((broadcast: boolean) => {
    const text = draft.trim();
    if (!text) return;
    const targets = broadcast
      ? versions.map(v => v.id)
      : (activeVersion ? [activeVersion.id] : []);
    if (targets.length === 0) return;
    setDraft('');
    void send(text, targets);
  }, [draft, versions, activeVersion, send]);

  /* ── Render ── */

  const overlayStyle: CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'rgba(17,24,39,.55)',
    display: 'flex', alignItems: 'stretch', justifyContent: 'stretch',
  };
  const panelStyle: CSSProperties = {
    flex: 1, minWidth: 0, background: '#fff',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  };

  // Rendered through a portal on document.body: the run page's root div carries
  // `.animate-in`, whose final keyframe is `transform: translateY(0)`. A non-none
  // transform establishes a containing block, which would otherwise trap this
  // `position: fixed` overlay inside the page's max-width column.
  const content = (
    <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Prompt Playground">
      <div style={panelStyle} className="animate-in">

        {/* ── Header ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          padding: '14px 20px', borderBottom: '1px solid #f0f0f0', background: '#fff',
        }}>
          <span style={{ fontSize: 15, fontWeight: 800, color: '#111827', letterSpacing: '-0.01em' }}>
            🧪 Playground · Iteration #{iteration}
          </span>
          {session && (
            <code
              title={`Base prompt hash: ${session.basePromptHash}`}
              style={{ fontSize: 10, fontFamily: 'monospace', color: '#9ca3af', background: '#f9fafb', padding: '3px 8px', borderRadius: 8, border: '1px solid #f0f0f0' }}
            >
              {session.basePromptHash.substring(0, 7)}
            </code>
          )}
          {session && (
            <div style={SEG_WRAP}>
              {([['tabs', 'Табове'], ['parallel', 'Паралелно']] as const).map(([value, label]) => (
                <button key={value} type="button" onClick={() => setView(value)} style={segBtn(session.view === value)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <span
            title="Цената на песъчника се пази само тук и не влиза в цената на ръна."
            style={{ fontSize: 11, fontWeight: 800, color: '#065f46', background: '#d1fae5', padding: '4px 10px', borderRadius: 20 }}
          >
            {fmtCost(totalCost)}
          </span>
          {defaults && (
            <span style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af' }}>
              {defaults.model} · temp {defaults.temperature} · seed {defaults.seed}
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              onClick={archiveAllChats}
              disabled={!anyChatToArchive}
              title={anyChatToArchive
                ? 'Архивира чата на всяка версия в «История» и започва нов — нищо не се губи.'
                : 'Няма съобщения за архивиране.'}
              style={ghostBtn(!anyChatToArchive)}
            >
              Нов чат
            </button>
            <button
              type="button"
              onClick={requestClose}
              title="Затвори (Esc)"
              style={{
                width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 10, border: '1.5px solid #e5e7eb', background: '#fff',
                color: '#6b7280', fontSize: 14, fontWeight: 700, cursor: 'pointer',
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* ── Body ── */}
        {loading ? (
          <div style={{ flex: 1, padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="shimmer" style={{ height: 40 }} />
            <div className="shimmer" style={{ height: 26, width: 220 }} />
            <div className="shimmer" style={{ flex: 1 }} />
            <div className="shimmer" style={{ height: 68 }} />
          </div>
        ) : loadError || !session || !defaults || !activeVersion ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            <div style={{ fontSize: 40 }}>⚠</div>
            <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>
              {loadError ?? 'Сесията на песъчника не може да бъде заредена.'}
            </p>
            <button type="button" onClick={onClose} style={ghostBtn()}>Затвори</button>
          </div>
        ) : (
          <>
            {!parallel ? (
              <>
                {/* Version tabs */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
                  padding: '10px 20px', borderBottom: '1px solid #f0f0f0', background: '#f9fafb',
                }}>
                  {versions.map(v => (
                    <VersionTab
                      key={v.id}
                      version={v}
                      active={v.id === activeVersion.id}
                      awaiting={Boolean(awaiting[v.id])}
                      menuOpen={menuVersionId === v.id}
                      renaming={renameVersionId === v.id}
                      onSelect={() => { setActiveVersionId(v.id); setMenuVersionId(null); closeHistoryUi(); }}
                      onToggleMenu={() => setMenuVersionId(prev => (prev === v.id ? null : v.id))}
                      onStartRename={() => { setRenameVersionId(v.id); setMenuVersionId(null); }}
                      onCommitRename={label => renameVersion(v.id, label)}
                      onCancelRename={() => setRenameVersionId(null)}
                      onDuplicate={() => addVersionFrom(v.id)}
                      onDelete={() => deleteVersion(v.id)}
                    />
                  ))}
                  <button
                    type="button"
                    onClick={() => addVersionFrom(activeVersion.id)}
                    disabled={versions.length >= MAX_VERSIONS}
                    title={versions.length >= MAX_VERSIONS
                      ? `Лимитът е ${MAX_VERSIONS} версии — изтрий някоя, за да добавиш нова.`
                      : `Създава копие на ${activeVersion.label} (промпт и история)`}
                    style={{ ...ghostBtn(versions.length >= MAX_VERSIONS), color: '#6366f1', borderColor: '#c7d2fe' }}
                  >
                    + Версия
                  </button>
                  <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <EvalControls
                      versionId={activeVersion.id}
                      evaluation={evaluations[activeVersion.id]}
                      scenarios={defaults.scenarios}
                      showRunWarning={defaults.runStatus === 'running'}
                      expanded={expandedEvalId === activeVersion.id}
                      onToggleExpanded={() => setExpandedEvalId(prev => (prev === activeVersion.id ? null : activeVersion.id))}
                      onStart={startEvaluation}
                      onStop={stopEvaluation}
                    />
                  </div>
                </div>

                {/* The panel now carries metrics, dimensions and full conversations, so it
                    scrolls inside the modal instead of pushing the chat out of view. */}
                {expandedEvalId === activeVersion.id && evaluations[activeVersion.id] && (
                  <div style={{ flexShrink: 0, padding: '12px 20px', borderBottom: '1px solid #f0f0f0', maxHeight: '55vh', overflowY: 'auto' }}>
                    <EvalDetails evaluation={evaluations[activeVersion.id]} scenarios={defaults.scenarios} />
                  </div>
                )}

                {/* Chat / Prompt / Разлики toggle + per-version chat tools */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, flexWrap: 'wrap', padding: '10px 20px 0' }}>
                  <div style={SEG_WRAP}>
                    {(activeVersion.locked
                      ? ([['chat', 'Чат'], ['prompt', 'Промпт']] as const)
                      : ([['chat', 'Чат'], ['prompt', 'Промпт'], ['diff', 'Разлики']] as const)
                    ).map(([value, label]) => (
                      <button key={value} type="button" onClick={() => selectPane(value)} style={segBtn(activePane === value)}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => archiveVersionChat(activeVersion.id)}
                    disabled={activeVersion.messages.length === 0 || activeChatBusy}
                    title={`Архивира чата на ${activeVersion.label} и започва нов — старият остава в «История».`}
                    style={{ ...ghostBtn(activeVersion.messages.length === 0 || activeChatBusy), padding: '6px 12px' }}
                  >
                    ↺ Нов чат
                  </button>
                  <div style={{ position: 'relative' }}>
                    <button
                      type="button"
                      onClick={() => setHistoryVersionId(prev => (prev === activeVersion.id ? null : activeVersion.id))}
                      disabled={archiveCount(activeVersion) === 0 || activeChatBusy}
                      title={archiveCount(activeVersion) === 0
                        ? 'Още няма архивирани чатове за тази версия.'
                        : 'Предишните чатове на тази версия — за преглед или възстановяване.'}
                      style={{ ...ghostBtn(archiveCount(activeVersion) === 0 || activeChatBusy), padding: '6px 12px' }}
                    >
                      История ({archiveCount(activeVersion)})
                    </button>
                    {historyVersionId === activeVersion.id && archiveCount(activeVersion) > 0 && (
                      <HistoryMenu
                        archives={activeVersion.chatHistory ?? []}
                        onView={archiveId => {
                          setPreview({ versionId: activeVersion.id, archiveId });
                          setPane('chat');
                          setHistoryVersionId(null);
                        }}
                        onRestore={archiveId => restoreArchive(activeVersion.id, archiveId)}
                      />
                    )}
                  </div>
                </div>

                {activePane === 'chat' ? (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, marginTop: 10, borderTop: '1px solid #f0f0f0' }}>
                    {previewedArchive ? (
                      <>
                        <ArchiveBanner archive={previewedArchive} onExit={() => setPreview(null)} />
                        <MessageThread messages={previewedArchive.messages} awaiting={false} />
                      </>
                    ) : (
                      <MessageThread messages={activeVersion.messages} awaiting={Boolean(awaiting[activeVersion.id])} />
                    )}
                  </div>
                ) : activePane === 'prompt' ? (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, marginTop: 10, borderTop: '1px solid #f0f0f0' }}>
                    <PromptPane
                      version={activeVersion}
                      basePrompt={defaults.basePrompt}
                      onChange={prompt => editPrompt(activeVersion.id, prompt)}
                      onReset={() => editPrompt(activeVersion.id, defaults.basePrompt)}
                      onShowDiff={() => selectPane('diff')}
                    />
                  </div>
                ) : (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, marginTop: 10, borderTop: '1px solid #f0f0f0' }}>
                    <DiffPane version={activeVersion} basePrompt={originalPrompt} />
                  </div>
                )}
              </>
            ) : (
              <ParallelBoard
                versions={versions}
                visibleVersions={visibleVersions}
                awaiting={awaiting}
                evaluations={evaluations}
                defaults={defaults}
                expandedEvalId={expandedEvalId}
                onToggleVisible={toggleVisible}
                onToggleExpandedEval={id => setExpandedEvalId(prev => (prev === id ? null : id))}
                onStartEvaluation={startEvaluation}
                onStopEvaluation={stopEvaluation}
                onArchiveChat={archiveVersionChat}
              />
            )}

            {/* ── Composer ── */}
            <div style={{ borderTop: '1px solid #f0f0f0', padding: '12px 20px', background: '#fff' }}>
              {replay && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10,
                  padding: '8px 12px', background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 10,
                }}>
                  <Spinner />
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#3730a3' }}>
                    Пускам отново · {replay.done}/{replay.total}
                  </span>
                  <button
                    type="button"
                    onClick={cancelReplay}
                    style={{ ...ghostBtn(), marginLeft: 'auto', padding: '4px 10px', fontSize: 11, color: '#dc2626', borderColor: '#fecaca' }}
                  >
                    Отмени
                  </button>
                </div>
              )}
              {previewing ? (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '11px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10,
                  fontSize: 11, fontWeight: 700, color: '#92400e',
                }}>
                  Архивиран чат — само за четене. Натисни «Изход» горе, за да продължиш живия чат.
                </div>
              ) : (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
                <textarea
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (!sendBusy) submitDraft(parallel);
                    }
                  }}
                  placeholder={parallel
                    ? 'пиши тук… (Enter праща на всички версии, Shift+Enter нов ред)'
                    : `пиши тук… (Enter праща на ${activeVersion.label}, Shift+Enter нов ред)`}
                  rows={2}
                  style={{
                    flex: 1, resize: 'none', padding: '10px 14px', fontSize: 13, lineHeight: 1.6,
                    color: '#111827', background: '#fafafa', border: '1.5px solid #e5e7eb',
                    borderRadius: 10, outline: 'none', fontFamily: 'inherit',
                  }}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {!parallel && (
                    <button
                      type="button"
                      onClick={() => submitDraft(false)}
                      disabled={sendBusy || draft.trim().length === 0}
                      style={primaryBtn(sendBusy || draft.trim().length === 0)}
                    >
                      Изпрати
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => submitDraft(true)}
                    disabled={sendBusy || draft.trim().length === 0}
                    title="Добавя същата реплика във всяка версия и пуска извикванията паралелно"
                    style={parallel
                      ? primaryBtn(sendBusy || draft.trim().length === 0)
                      : ghostBtn(sendBusy || draft.trim().length === 0)}
                  >
                    Изпрати на всички
                  </button>
                  <button
                    type="button"
                    onClick={() => { if (replayTarget) startReplay(replayTarget.id); }}
                    disabled={sendBusy || replayLastCount === 0}
                    title="Праща наново ВСИЧКИ твои реплики от началото през текущия промпт и заменя всички отговори на бота."
                    style={ghostBtn(sendBusy || replayLastCount === 0)}
                  >
                    Пусни отново{replayTarget ? ` (${replayTarget.label})` : ''}
                  </button>
                  <button
                    type="button"
                    onClick={() => { if (replayTarget) void replayLast(replayTarget.id); }}
                    disabled={sendBusy || replayLastCount === 0}
                    title="Повтаря само последната ти реплика с текущия промпт."
                    style={ghostBtn(sendBusy || replayLastCount === 0)}
                  >
                    ↻ Само последната{replayTarget ? ` (${replayTarget.label})` : ''}
                  </button>
                </div>
              </div>
              )}
            </div>
          </>
        )}
      </div>

      <style>{`
        @keyframes pgPulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.75); } }
      `}</style>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(content, document.body);
}

/* ────────────────────────────────────────────────────────────────────────────
   Parallel view
   ──────────────────────────────────────────────────────────────────────────── */

function ParallelBoard({
  versions, visibleVersions, awaiting, evaluations, defaults, expandedEvalId,
  onToggleVisible, onToggleExpandedEval, onStartEvaluation, onStopEvaluation, onArchiveChat,
}: {
  versions: PlaygroundVersion[];
  visibleVersions: PlaygroundVersion[];
  awaiting: Record<string, boolean>;
  evaluations: Record<string, PlaygroundEvaluation>;
  defaults: PlaygroundDefaults;
  expandedEvalId: string | null;
  onToggleVisible: (versionId: string) => void;
  onToggleExpandedEval: (versionId: string) => void;
  onStartEvaluation: (versionId: string, scenarioIds: string[]) => void;
  onStopEvaluation: (versionId: string) => void;
  onArchiveChat: (versionId: string) => void;
}) {
  const reference   = visibleVersions[0] ?? null;
  const refUsers    = reference ? userTexts(reference.messages) : [];
  const columnCount = visibleVersions.length;

  const columns = visibleVersions.map(v => {
    const own = userTexts(v.messages);
    return {
      version: v,
      groups: groupByUserTurn(v.messages),
      diverged: reference ? !sameUserHistory(refUsers, own) : false,
      ownUserCount: own.length,
    };
  });

  const rowCount = columns.reduce(
    (max, col) => (col.diverged ? Math.max(max, col.ownUserCount) : max),
    refUsers.length,
  );

  const gridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `repeat(${Math.max(columnCount, 1)}, minmax(${MIN_COL_WIDTH}px, 1fr))`,
    gap: 10,
    minWidth: columnCount > 4 ? columnCount * MIN_COL_WIDTH : undefined,
    alignItems: 'stretch',
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>

      {/* Visibility checkboxes */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
        padding: '10px 20px', borderBottom: '1px solid #f0f0f0', background: '#f9fafb',
      }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
          Видими колони
        </span>
        {versions.map(v => (
          <label key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: '#374151', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={visibleVersions.some(x => x.id === v.id)}
              onChange={() => onToggleVisible(v.id)}
              style={{ accentColor: '#6366f1' }}
            />
            {v.locked ? '🔒 ' : ''}{v.label}
          </label>
        ))}
        {defaults.runStatus === 'running' && (
          <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
            ⚠ Рънът още работи — паралелните тестове споделят същия rate limit.
          </span>
        )}
      </div>

      {columnCount === 0 ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <div style={{ fontSize: 34 }}>🧮</div>
          <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>Избери поне една версия за сравнение.</p>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 20px', background: '#fafafa' }}>
          <div style={gridStyle}>

            {/* Column headers */}
            {columns.map(col => (
              <div key={`head-${col.version.id}`} style={{
                padding: '10px 12px', background: '#fff', border: '1px solid #f0f0f0',
                borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 8,
                position: 'sticky', top: 0, zIndex: 10,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                  {col.version.locked && <span style={{ fontSize: 11 }}>🔒</span>}
                  <span style={{ fontSize: 13, fontWeight: 800, color: '#111827' }}>{col.version.label}</span>
                  {awaiting[col.version.id] && <PulseDot />}
                  {col.diverged && (
                    <span
                      title="Потребителската история на тази версия се различава от референтната — подравняването за нея е изключено."
                      style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}
                    >
                      ⚠ разминаване
                    </span>
                  )}
                  <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, color: '#9ca3af' }}>
                    rev {col.version.promptRev} · {fmtCost(col.version.cost)}
                  </span>
                  {/* Only the restart fits here — the history dropdown would be clipped by
                      the horizontally scrolling board, so it stays in the tabs view. */}
                  <button
                    type="button"
                    onClick={() => onArchiveChat(col.version.id)}
                    disabled={col.version.messages.length === 0 || Boolean(awaiting[col.version.id])}
                    title={`Архивира чата на ${col.version.label} и започва нов — виж «История» в изгледа «Табове».`}
                    style={{
                      ...ghostBtn(col.version.messages.length === 0 || Boolean(awaiting[col.version.id])),
                      padding: '2px 8px', fontSize: 11,
                    }}
                  >
                    ↺
                  </button>
                </div>
                <EvalControls
                  versionId={col.version.id}
                  evaluation={evaluations[col.version.id]}
                  scenarios={defaults.scenarios}
                  showRunWarning={false}
                  expanded={expandedEvalId === col.version.id}
                  onToggleExpanded={() => onToggleExpandedEval(col.version.id)}
                  onStart={onStartEvaluation}
                  onStop={onStopEvaluation}
                />
                {expandedEvalId === col.version.id && evaluations[col.version.id] && (
                  <div style={{ maxHeight: '45vh', overflowY: 'auto' }}>
                    <EvalDetails evaluation={evaluations[col.version.id]} scenarios={defaults.scenarios} />
                  </div>
                )}
              </div>
            ))}

            {/* Aligned rows: shared user message once, then one reply cell per column */}
            {Array.from({ length: rowCount }, (_, rowIndex) => (
              <div key={`row-${rowIndex}`} style={{ display: 'contents' }}>
                {rowIndex < refUsers.length && (
                  <div style={{
                    gridColumn: '1 / -1', display: 'flex', gap: 8, alignItems: 'flex-start',
                    padding: '9px 12px', background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 10,
                  }}>
                    <span style={{ fontSize: 9, fontWeight: 800, color: '#4338ca', background: '#e0e7ff', padding: '2px 7px', borderRadius: 20, flexShrink: 0 }}>
                      USER #{rowIndex + 1}
                    </span>
                    <span style={{ fontSize: 12, color: '#312e81', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {refUsers[rowIndex]}
                    </span>
                  </div>
                )}
                {columns.map(col => {
                  const group = col.groups[rowIndex];
                  const hasContent = Boolean(group);
                  return (
                    <div key={`cell-${col.version.id}-${rowIndex}`} style={{
                      padding: 10, background: '#fff', border: '1px solid #f0f0f0', borderRadius: 12,
                      display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
                    }}>
                      {!hasContent ? (
                        <span style={{ fontSize: 11, color: '#d1d5db' }}>—</span>
                      ) : (
                        <>
                          {col.diverged && group.user && (
                            <div style={{ display: 'flex', gap: 6, padding: '6px 8px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8 }}>
                              <span style={{ fontSize: 9, fontWeight: 800, color: '#92400e', flexShrink: 0 }}>USER</span>
                              <span style={{ fontSize: 11, color: '#92400e', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                {group.user.content}
                              </span>
                            </div>
                          )}
                          {group.replies.length === 0 ? (
                            awaiting[col.version.id]
                              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#6b7280' }}><Spinner /> ботът пише…</span>
                              : <span style={{ fontSize: 11, color: '#d1d5db' }}>—</span>
                          ) : group.replies.map((reply, i) => (
                            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {i > 0 && group.replies[i - 1].promptRev !== reply.promptRev && <PromptChangeDivider />}
                              <Bubble msg={reply} compact />
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}

            {rowCount === 0 && (
              <div style={{ gridColumn: '1 / -1', padding: '28px 12px', textAlign: 'center' }}>
                <div style={{ fontSize: 30, marginBottom: 6 }}>💬</div>
                <p style={{ fontSize: 12, color: '#9ca3af', margin: 0 }}>
                  Няма съобщения. Напиши реплика долу — тя отива до всички версии наведнъж.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
