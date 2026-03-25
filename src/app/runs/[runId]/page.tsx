'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

interface LogEntry { ts: number; level: 'info' | 'success' | 'warn' | 'error' | 'step' | 'detail'; msg: string }

type RefinementMode = 'restructure' | 'surgical';
type PromptVerdict = 'baseline' | 'improvement' | 'regression' | 'best_so_far' | 'rejected';

interface IterationSummary {
  iteration: number; passRate: number; qualityScore?: number;
  passedCount: number; totalCount: number;
  highSeverityCount: number; mainIssues: string[]; changesApplied: string[];
  cost: number; iterationCost?: number;
  delta?: { improvements: number; regressions: number; unchanged: number };
  isChampion?: boolean;
  verdict?: PromptVerdict;
  mode?: RefinementMode;
}

interface PromptLedgerEntry {
  iteration: number; score: number; passRate: number;
  highSeverityCount: number; mediumSeverityCount: number;
  verdict: PromptVerdict; isChampion: boolean; mode: RefinementMode;
  promptPath: string; promptHash: string; promptSummary?: string;
}
interface PromptLedger {
  runId: string; championIteration: number; championScore: number;
  championPassRate: number; championHighSeverityCount: number;
  entries: PromptLedgerEntry[];
}

interface PlannedChange { id: string; targetSection: string; description: string; hypothesis: string }
interface ChangePlan {
  iteration: number; basedOnChampionIteration: number; basedOnCandidateIteration?: number;
  mode: RefinementMode; diagnosis: string; decisionRationale: string;
  plannedChanges: PlannedChange[];
}
interface ChangeImpactEntry { changeId: string; verdict: 'helped' | 'hurt' | 'neutral' | 'unknown'; evidence: string }
interface ChangeImpact {
  iteration: number; newScore: number; newPassRate: number; newHighSeverityCount: number;
  previousChampionScore: number; becameChampion: boolean;
  overallVerdict: 'improvement' | 'regression' | 'neutral';
  changeImpacts: ChangeImpactEntry[];
}

interface RunDetails {
  runId: string; orchestratorId: string; taskId: string; taskName?: string;
  status: 'running' | 'success' | 'max_iterations' | 'stopped' | 'error';
  startedAt: number; completedAt?: number; currentIteration: number;
  finalScore?: number; totalCost?: number; iterations: IterationSummary[];
  isPaused?: boolean; isStopping?: boolean; manualMode?: boolean;
  hasFinalPrompt?: boolean; hasFeedback?: boolean;
  continuedFromRunId?: string;
  championIteration?: number; championScore?: number; championPassRate?: number;
  promptLedger?: PromptLedger;
  changeLedger?: { runId: string; entries: Array<{ iteration: number; plan: ChangePlan; impact?: ChangeImpact }> };
  testAssetMeta?: {
    runId: string; generatedAt: number;
    testDriverPromptVersion: string; testPlanVersion: string; scenarioBlueprintVersion: string;
    scenarioCount: number; testDriverPromptPath: string; testPlanPath: string;
    qualityObservations: Array<{
      iteration: number; quality: 'good' | 'medium' | 'weak';
      isChallengingEnough: boolean; isRealistic: boolean; notes: string[];
      suggestedImprovementsForNextRun?: string[];
    }>;
  };
}
interface Message { role: 'user' | 'assistant' | 'system'; content: string }
interface UtteranceUsage { utteranceId: string; originalText: string; actualMessage: string; rephrased: boolean; turnIndex: number; group: string }
interface Transcript {
  scenarioId: string; scenarioName: string; expectedBehavior: string; messages: Message[];
  driverMode?: boolean; passed?: boolean; verdict?: ScenarioVerdict;
  utteranceLog?: UtteranceUsage[];
  totalUserTurns?: number;
  seedUserMessages?: string[];
  generatedUserMessages?: string[];
  maxTurns?: number; stopReason?: string; userGoal?: string;
}
type ScenarioVerdict = 'pass' | 'fail' | 'mixed' | 'not_evaluable';
type RootCauseArea = 'role_consistency' | 'openness_progression' | 'objection_behavior' | 'tone_and_reserve' | 'response_length' | 'information_disclosure' | 'constraint_adherence' | 'other';
interface Issue { severity: 'high' | 'medium' | 'low'; category: string; description: string; improvementDirection?: string; rootCauseArea?: RootCauseArea; suggestion?: string }
interface ScenarioAnalysis { scenarioId: string; verdict?: ScenarioVerdict; passed: boolean; strengths?: string[]; issues: Issue[] }
interface Analysis { overallScore: number; passRate: number; scenarios: ScenarioAnalysis[]; generalSuggestions: string[] }
interface IterationDetail {
  iteration: number; prompt: string | null; testDriverPrompt: string | null;
  analysis: Analysis | null; summary: IterationSummary | null; transcripts: Transcript[];
  changePlan?: ChangePlan; changeImpact?: ChangeImpact;
  verdict?: PromptVerdict; isChampion?: boolean;
}

const STATUS_STYLE: Record<string, { label: string; bg: string; color: string; dot: string; pulse: boolean }> = {
  running:        { label: 'Running',        bg: '#dbeafe', color: '#1d4ed8', dot: '#3b82f6', pulse: true },
  success:        { label: 'Success',        bg: '#d1fae5', color: '#065f46', dot: '#10b981', pulse: false },
  max_iterations: { label: 'Max iterations', bg: '#fef3c7', color: '#92400e', dot: '#f59e0b', pulse: false },
  stopped:        { label: 'Stopped',        bg: '#f1f5f9', color: '#475569', dot: '#94a3b8', pulse: false },
  error:          { label: 'Error',          bg: '#fee2e2', color: '#991b1b', dot: '#ef4444', pulse: false },
};
const BANNER_STYLE: Record<string, { bg: string; border: string; color: string; icon: string; text: string }> = {
  running:        { bg: '#eff6ff', border: '#bfdbfe', color: '#1e40af', icon: '⚙',  text: 'Run in progress — auto-refreshing every 3 seconds.' },
  success:        { bg: '#ecfdf5', border: '#a7f3d0', color: '#065f46', icon: '✓',  text: 'Run completed successfully.' },
  max_iterations: { bg: '#fffbeb', border: '#fde68a', color: '#92400e', icon: '⚠',  text: 'Reached maximum iterations.' },
  stopped:        { bg: '#f8fafc', border: '#e2e8f0', color: '#475569', icon: '■',  text: 'Run was stopped by user.' },
  error:          { bg: '#fef2f2', border: '#fecaca', color: '#991b1b', icon: '✕',  text: 'Run failed. Check logs for details.' },
};
const SEV_STYLE: Record<string, { bg: string; color: string; border: string }> = {
  high:   { bg: '#fee2e2', color: '#991b1b', border: '#fecaca' },
  medium: { bg: '#fef3c7', color: '#92400e', border: '#fde68a' },
  low:    { bg: '#f3f4f6', color: '#374151', border: '#e5e7eb' },
};

const fmt = (ms: number) => { const m = Math.floor(ms / 60000); const s = Math.floor((ms % 60000) / 1000); return `${m}m ${s}s`; };

export default function RunDetailsPage() {
  const { runId } = useParams() as { runId: string };
  const [run, setRun]                   = useState<RunDetails | null>(null);
  const [loading, setLoading]           = useState(true);
  const [notFound, setNotFound]         = useState(false);
  const [expandedIter, setExpandedIter] = useState<number | null>(null);
  const [iterDetail, setIterDetail]     = useState<IterationDetail | null>(null);
  const [iterLoading, setIterLoading]   = useState(false);
  const [activeTab, setActiveTab]       = useState<'prompt' | 'analysis' | 'transcripts' | 'testdriver'>('prompt');
  const [championPrompt, setChampionPrompt] = useState<string | null>(null);
  const [championPromptLoading, setChampionPromptLoading] = useState(false);
  const [showChampionPrompt, setShowChampionPrompt] = useState(false);
  const [openChat, setOpenChat]         = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<'stop' | 'pause' | 'resume' | null>(null);
  const [feedback, setFeedback]           = useState('');
  const [feedbackSaved, setFeedbackSaved] = useState(false);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [extendLoading, setExtendLoading]   = useState(false);
  const [extendCount, setExtendCount]       = useState(5);
  const [restartLoading, setRestartLoading] = useState(false);
  const [taskInfo, setTaskInfo]             = useState<{ name?: string; description?: string; uploadId?: string; scenariosCount?: number } | null>(null);
  const [uploadedFiles, setUploadedFiles]   = useState<string[]>([]);
  const [taskExpanded, setTaskExpanded]     = useState(false);

  // Live log state
  const [logEntries, setLogEntries]       = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen]             = useState(true);
  const logBottomRef                      = useRef<HTMLDivElement>(null);
  const lastLogTs                         = useRef<number>(0);

  const loadRun = useCallback(async () => {
    try {
      const r = await fetch(`/api/runs/${runId}`);
      if (r.ok) { setRun(await r.json()); setNotFound(false); }
      else setNotFound(true);
    } catch { setNotFound(true); }
    finally { setLoading(false); }
  }, [runId]);

  useEffect(() => {
    loadRun();
    const iv = setInterval(() => { setRun(p => { if (p?.status === 'running') loadRun(); return p; }); }, 3000);
    // Load task info and uploaded files once
    fetch(`/api/runs/${runId}/task`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setTaskInfo({ name: d.name, description: d.description, uploadId: d.uploadId, scenariosCount: d.scenariosCount }); })
      .catch(() => {});
    fetch(`/api/runs/${runId}/files`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.files?.length) setUploadedFiles(d.files); })
      .catch(() => {});
    return () => clearInterval(iv);
  }, [loadRun, runId]);

  // Poll the live log file
  useEffect(() => {
    let active = true;

    const poll = async () => {
      if (!active) return;
      try {
        const url = lastLogTs.current > 0
          ? `/api/runs/${runId}/log?since=${lastLogTs.current}`
          : `/api/runs/${runId}/log?tail=150`;
        const r = await fetch(url);
        if (!r.ok) return;
        const data = await r.json() as { entries: LogEntry[] };
        if (data.entries.length > 0) {
          lastLogTs.current = data.entries[data.entries.length - 1].ts;
          setLogEntries(prev => {
            const existingTs = new Set(prev.map(e => `${e.ts}${e.msg}`));
            const newOnly = data.entries.filter(e => !existingTs.has(`${e.ts}${e.msg}`));
            return newOnly.length > 0 ? [...prev, ...newOnly].slice(-300) : prev;
          });
        }
      } catch {}
    };

    poll(); // initial load
    const iv = setInterval(poll, 2500);

    return () => { active = false; clearInterval(iv); };
  }, [runId]);

  // Auto-scroll log to bottom when new entries arrive and log is open
  useEffect(() => {
    if (logOpen && logBottomRef.current) {
      const container = logBottomRef.current.parentElement;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    }
  }, [logEntries, logOpen]);

  // Load existing feedback when run completes
  useEffect(() => {
    if (run?.hasFeedback && !feedback) {
      fetch(`/api/runs/${runId}/feedback`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.feedback) setFeedback(d.feedback); })
        .catch(() => {});
    }
  }, [run?.hasFeedback, runId, feedback]);

  const saveFeedback = async () => {
    setFeedbackLoading(true);
    try {
      await fetch(`/api/runs/${runId}/feedback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
      });
      setFeedbackSaved(true);
      setTimeout(() => setFeedbackSaved(false), 3000);
    } catch {} finally { setFeedbackLoading(false); }
  };

  const handleRestart = async () => {
    if (!run) return;
    if (!confirm('Restart this run from scratch with the same task and uploaded files?')) return;
    setRestartLoading(true);
    try {
      const taskR = await fetch(`/api/runs/${runId}/task`);
      const task = taskR.ok ? await taskR.json() : {};
      const r = await fetch('/api/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orchestratorId: run.orchestratorId, task }),
      });
      if (r.ok) {
        const d = await r.json();
        window.location.href = `/runs/${d.runId}`;
      } else {
        const e = await r.json();
        alert(`Failed: ${e.error}`);
      }
    } catch { alert('Failed to restart run'); } finally { setRestartLoading(false); }
  };

  const handleExtend = async () => {
    if (!run) return;
    setExtendLoading(true);
    try {
      const r = await fetch(`/api/runs/${runId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'extend', additionalIterations: extendCount }),
      });
      if (r.ok) {
        // Same run — just reload to see it running
        window.location.reload();
      } else {
        const e = await r.json();
        alert(`Failed: ${e.error}`);
      }
    } catch { alert('Failed to extend'); } finally { setExtendLoading(false); }
  };

  const loadChampionPrompt = async () => {
    if (championPrompt) { setShowChampionPrompt(true); return; }
    setChampionPromptLoading(true);
    try {
      const r = await fetch(`/api/runs/${runId}/champion-prompt`);
      if (r.ok) { const d = await r.json(); setChampionPrompt(d.promptText); setShowChampionPrompt(true); }
    } catch {} finally { setChampionPromptLoading(false); }
  };

  const loadIter = async (n: number) => {
    if (expandedIter === n) { setExpandedIter(null); return; }
    setExpandedIter(n); setIterDetail(null); setIterLoading(true); setActiveTab('prompt'); setOpenChat(null);
    try { const r = await fetch(`/api/runs/${runId}/iterations/${n}`); if (r.ok) setIterDetail(await r.json()); }
    catch {}
    setIterLoading(false);
  };

  const sendAction = async (action: 'stop' | 'pause' | 'resume') => {
    setActionLoading(action);
    try {
      await fetch(`/api/runs/${runId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      await loadRun();
    } catch {}
    setActionLoading(null);
  };

  if (loading) return (
    <div style={{ maxWidth: 1000, margin: '40px auto', padding: '0 20px' }}>
      {[1,2,3].map(i => <div key={i} className="shimmer" style={{ height: 80, marginBottom: 16 }} />)}
    </div>
  );

  if (notFound || !run) return (
    <div style={{ maxWidth: 1000, margin: '80px auto', padding: '0 20px', textAlign: 'center' }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>🔍</div>
      <p style={{ color: '#6b7280', marginBottom: 16 }}>Run not found.</p>
      <Link href="/" className="btn-secondary" style={{ textDecoration: 'none' }}>← Back to runs</Link>
    </div>
  );

  const sc = STATUS_STYLE[run.status] ?? STATUS_STYLE.error;
  const bn = BANNER_STYLE[run.status];

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '28px 20px' }} className="animate-in">

      {/* Breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, fontSize: 12, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        <Link href="/" style={{ color: '#818cf8', textDecoration: 'none' }}>Runs</Link>
        <span style={{ color: '#d1d5db' }}>/</span>
        {run.continuedFromRunId && (
          <>
            <Link href={`/runs/${run.continuedFromRunId}`} style={{ color: '#818cf8', textDecoration: 'none', textTransform: 'none', letterSpacing: 'normal', fontSize: 11, fontFamily: 'monospace' }}>
              ↩ {run.continuedFromRunId.substring(0, 20)}…
            </Link>
            <span style={{ color: '#d1d5db' }}>/</span>
          </>
        )}
        <code style={{ color: '#374151', textTransform: 'none', letterSpacing: 'normal', fontFamily: 'monospace', fontSize: 11 }}>{runId.substring(0, 20)}…</code>
      </div>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: '#111827', margin: '0 0 6px', letterSpacing: '-0.02em' }}>
            {run.taskName || 'Run Details'}
          </h1>
          <code style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>{runId}</code>
          {run.continuedFromRunId && (
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#6366f1', fontWeight: 600 }}>
              <span>↩ Continued from</span>
              <Link href={`/runs/${run.continuedFromRunId}`} style={{ color: '#6366f1', textDecoration: 'underline', fontFamily: 'monospace', fontSize: 11 }}>
                {run.continuedFromRunId.substring(0, 20)}…
              </Link>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          {/* Run control buttons — only when running */}
          {run.status === 'running' && !run.isStopping && (
            <>
              {run.isPaused ? (
                <button
                  onClick={() => sendAction('resume')}
                  disabled={actionLoading !== null}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 7,
                    padding: '8px 16px', borderRadius: 20, border: 'none', cursor: 'pointer',
                    background: 'linear-gradient(135deg,#059669,#10b981)',
                    color: 'white', fontSize: 12, fontWeight: 700,
                    boxShadow: '0 2px 8px rgba(5,150,105,.35)',
                    opacity: actionLoading ? 0.7 : 1,
                  }}
                >
                  <span style={{ fontSize: 14 }}>▶</span>
                  {actionLoading === 'resume' ? 'Resuming…' : 'Resume'}
                </button>
              ) : (
                <button
                  onClick={() => sendAction('pause')}
                  disabled={actionLoading !== null}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 7,
                    padding: '8px 16px', borderRadius: 20, border: 'none', cursor: 'pointer',
                    background: 'linear-gradient(135deg,#f59e0b,#d97706)',
                    color: 'white', fontSize: 12, fontWeight: 700,
                    boxShadow: '0 2px 8px rgba(245,158,11,.35)',
                    opacity: actionLoading ? 0.7 : 1,
                  }}
                >
                  <span style={{ fontSize: 14 }}>⏸</span>
                  {actionLoading === 'pause' ? 'Pausing…' : 'Pause'}
                </button>
              )}
              <button
                onClick={() => {
                  if (confirm('Stop this run after the current iteration completes?')) sendAction('stop');
                }}
                disabled={actionLoading !== null}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7,
                  padding: '8px 16px', borderRadius: 20, border: 'none', cursor: 'pointer',
                  background: 'linear-gradient(135deg,#ef4444,#dc2626)',
                  color: 'white', fontSize: 12, fontWeight: 700,
                  boxShadow: '0 2px 8px rgba(239,68,68,.35)',
                  opacity: actionLoading ? 0.7 : 1,
                }}
              >
                <span style={{ fontSize: 14 }}>⏹</span>
                {actionLoading === 'stop' ? 'Stopping…' : 'Stop'}
              </button>
            </>
          )}
          {run.status === 'running' && run.isStopping && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 16px', borderRadius: 20, background: '#fee2e2', color: '#991b1b', fontSize: 12, fontWeight: 700 }}>
              <span style={{ fontSize: 14 }}>⏹</span> Stopping after iteration…
            </div>
          )}
          {/* Restart button — shown for error / stopped / max_iterations */}
          {(run.status === 'error' || run.status === 'stopped' || run.status === 'max_iterations') && (
            <button
              onClick={handleRestart}
              disabled={restartLoading}
              title="Restart from scratch with the same task and files"
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '8px 16px', borderRadius: 20, border: 'none', cursor: 'pointer',
                background: run.status === 'error'
                  ? 'linear-gradient(135deg,#dc2626,#b91c1c)'
                  : 'linear-gradient(135deg,#6366f1,#8b5cf6)',
                color: 'white', fontSize: 12, fontWeight: 700,
                boxShadow: run.status === 'error'
                  ? '0 2px 8px rgba(220,38,38,.35)'
                  : '0 2px 8px rgba(99,102,241,.35)',
                opacity: restartLoading ? 0.7 : 1,
              }}
            >
              <span style={{ fontSize: 14 }}>↺</span>
              {restartLoading ? 'Restarting…' : 'Restart Run'}
            </button>
          )}
          {/* Status badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, background: run.isPaused ? '#fef3c7' : sc.bg, color: run.isPaused ? '#92400e' : sc.color, padding: '6px 14px 6px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: run.isPaused ? '#f59e0b' : sc.dot, display: 'block', animation: (!run.isPaused && sc.pulse) ? 'pulse 2s infinite' : 'none' }} />
            {run.isPaused ? 'Paused' : sc.label}
          </div>
        </div>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 16 }}>
        {[
          { label: 'Orchestrator', value: run.orchestratorId, mono: true, color: '#111827' },
          { label: 'Iterations',   value: String(run.currentIteration), color: '#4338ca' },
          { label: 'Final Score',  value: run.finalScore != null ? `${(run.finalScore * 100).toFixed(1)}%` : 'In progress', color: run.finalScore == null ? '#9ca3af' : run.finalScore >= 0.75 ? '#059669' : '#d97706' },
          { label: 'Total Cost',   value: run.totalCost ? `$${run.totalCost.toFixed(3)}` : '—', color: '#374151' },
        ].map(c => (
          <div key={c.label} className="card" style={{ padding: '14px 18px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>{c.label}</div>
            <div style={{ fontSize: c.mono ? 11 : 18, fontWeight: 800, color: c.color, fontFamily: c.mono ? 'monospace' : 'inherit', lineHeight: 1.2, wordBreak: 'break-all' }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* ── Task Info Panel ── */}
      {(taskInfo || uploadedFiles.length > 0) && (
        <div className="card" style={{ padding: '14px 20px', marginBottom: 16, display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          {taskInfo?.description && (
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Задача</div>
              <div style={{
                fontSize: 13, color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap',
                maxHeight: taskExpanded ? 'none' : 80, overflow: 'hidden',
                maskImage: (!taskExpanded && taskInfo.description.length > 200) ? 'linear-gradient(to bottom, black 50%, transparent)' : 'none',
              }}>
                {taskInfo.description}
              </div>
              {taskInfo.description.length > 200 && (
                <button
                  onClick={() => setTaskExpanded(e => !e)}
                  style={{ marginTop: 6, background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#6366f1', padding: 0 }}
                >
                  {taskExpanded ? '▲ Скрий' : '▼ Покажи всичко'}
                </button>
              )}
            </div>
          )}
          {(uploadedFiles.length > 0 || taskInfo?.scenariosCount) && (
            <div style={{ flexShrink: 0 }}>
              {uploadedFiles.length > 0 && (
                <>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Прикачени файлове</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {uploadedFiles.map(f => (
                      <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#374151' }}>
                        <span style={{ fontSize: 14 }}>📎</span>
                        <span style={{ fontWeight: 500 }}>{f}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {taskInfo?.scenariosCount && (
                <div style={{ marginTop: uploadedFiles.length > 0 ? 10 : 0 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Сценарии</div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#6366f1', background: '#eef2ff', border: '1px solid #c7d2fe', padding: '2px 10px', borderRadius: 20 }}>
                    {taskInfo.scenariosCount} сценария
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Banner */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '13px 18px', borderRadius: 12, marginBottom: 16,
        background: run.isPaused ? '#fffbeb' : run.isStopping ? '#fef2f2' : bn.bg,
        border: `1px solid ${run.isPaused ? '#fde68a' : run.isStopping ? '#fecaca' : bn.border}`,
        color: run.isPaused ? '#92400e' : run.isStopping ? '#991b1b' : bn.color,
        fontSize: 13, fontWeight: 600,
      }}>
        <span style={{ fontSize: 16 }}>{run.isPaused ? (run.manualMode ? '👆' : '⏸') : run.isStopping ? '⏹' : bn.icon}</span>
        <span style={{ flex: 1 }}>
          {run.isPaused && run.manualMode
            ? `Iteration #${run.currentIteration} complete — review results below, then click Continue.`
            : run.isPaused ? 'Run is paused — click Resume to continue.'
            : run.isStopping ? 'Stop requested — will finish after current iteration.'
            : bn.text}
        </span>
        {/* Manual mode: show Continue as primary CTA inside banner */}
        {run.isPaused && run.manualMode && (
          <button
            onClick={() => sendAction('resume')}
            disabled={actionLoading !== null}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 20px', borderRadius: 20, border: 'none', cursor: 'pointer',
              background: 'linear-gradient(135deg,#059669,#10b981)',
              color: 'white', fontSize: 13, fontWeight: 700,
              boxShadow: '0 2px 8px rgba(5,150,105,.4)', flexShrink: 0,
            }}
          >
            {actionLoading === 'resume' ? 'Starting…' : '▶ Continue to next iteration'}
          </button>
        )}
        {run.status !== 'running' && (
          <span style={{ fontSize: 11, opacity: .6 }}>{fmt((run.completedAt || Date.now()) - run.startedAt)}</span>
        )}
      </div>

      {/* ── Live Activity Log ─────────────────────────────────────────── */}
      {logEntries.length > 0 && (() => {
        const LOG_LEVEL_STYLE: Record<string, { color: string; prefix: string }> = {
          info:    { color: '#cbd5e1', prefix: '' },
          success: { color: '#4ade80', prefix: '✓ ' },
          warn:    { color: '#fbbf24', prefix: '⚠ ' },
          error:   { color: '#f87171', prefix: '✗ ' },
          step:    { color: '#818cf8', prefix: '⚙ ' },
          detail:  { color: '#94a3b8', prefix: '' },
        };
        const fmtTs = (ts: number) => {
          const d = new Date(ts);
          return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
        };
        return (
          <div className="card" style={{ overflow: 'hidden', marginBottom: 20 }}>
            {/* Header */}
            <div
              onClick={() => setLogOpen(o => !o)}
              style={{
                padding: '13px 20px', cursor: 'pointer', userSelect: 'none',
                background: 'linear-gradient(135deg,rgba(30,58,138,.06),rgba(99,102,241,.04))',
                borderBottom: logOpen ? '1px solid #e5e7eb' : 'none',
                display: 'flex', alignItems: 'center', gap: 12,
              }}
            >
              <div style={{
                width: 32, height: 32, borderRadius: 9,
                background: run.status === 'running'
                  ? 'linear-gradient(135deg,#3b82f6,#6366f1)'
                  : 'linear-gradient(135deg,#6b7280,#9ca3af)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 14, boxShadow: '0 2px 6px rgba(99,102,241,.25)',
                flexShrink: 0,
              }}>
                {run.status === 'running' ? (
                  <span style={{ animation: 'spin 1.5s linear infinite', display: 'inline-block' }}>⚙</span>
                ) : '📋'}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>Live Activity</div>
                <div style={{ fontSize: 12, color: '#9ca3af' }}>
                  {run.status === 'running' ? `${logEntries.length} events — auto-updating` : `${logEntries.length} events — run complete`}
                </div>
              </div>
              <span style={{ fontSize: 12, color: '#9ca3af', fontWeight: 600 }}>{logOpen ? '▲ Hide' : '▼ Show'}</span>
            </div>

            {/* Log body */}
            {logOpen && (
              <div style={{
                background: '#1e293b', maxHeight: 320, overflowY: 'auto',
                fontFamily: 'ui-monospace, "Cascadia Code", "Fira Code", monospace',
                fontSize: 12, lineHeight: 1.75, padding: '12px 16px',
              }}>
                {logEntries.map((e, i) => {
                  const s = LOG_LEVEL_STYLE[e.level] ?? LOG_LEVEL_STYLE.info;
                  const rowBg = e.level === 'step' ? 'rgba(129,140,248,.20)'
                              : e.level === 'error' ? 'rgba(248,113,113,.18)'
                              : e.level === 'warn'  ? 'rgba(251,191,36,.15)'
                              : e.level === 'success' ? 'rgba(74,222,128,.12)'
                              : 'transparent';
                  return (
                    <div key={i} style={{ display: 'flex', gap: 12, padding: '2px 6px', borderRadius: 4, background: rowBg }}>
                      <span style={{ color: '#64748b', flexShrink: 0, fontSize: 11, marginTop: 1 }}>{fmtTs(e.ts)}</span>
                      <span style={{ color: s.color, wordBreak: 'break-all' }}>
                        <span style={{ opacity: .8 }}>{s.prefix}</span>{e.msg}
                      </span>
                    </div>
                  );
                })}
                <div ref={logBottomRef} />
              </div>
            )}
          </div>
        );
      })()}

      {/* Human Feedback — visible during running AND after completion */}
      {(run.status === 'running' || run.status === 'success' || run.status === 'max_iterations' || run.status === 'stopped') && (
        <div className="card" style={{ overflow: 'hidden', marginBottom: 20 }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f0', background: 'linear-gradient(135deg,rgba(238,242,255,.4),rgba(245,243,255,.2))', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 34, height: 34, borderRadius: 10, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, boxShadow: '0 2px 8px rgba(99,102,241,.3)' }}>💬</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>Human Feedback</div>
              <div style={{ fontSize: 12, color: '#9ca3af' }}>
                {run.status === 'running'
                  ? 'Add notes now — will be injected into the NEXT refine step automatically'
                  : 'Your notes will be used by the Refine agent in the next run'}
              </div>
            </div>
            {(run.hasFinalPrompt || (['stopped', 'max_iterations'].includes(run.status) && run.currentIteration > 0)) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={extendCount}
                  onChange={e => setExtendCount(Math.max(1, parseInt(e.target.value) || 1))}
                  disabled={extendLoading}
                  style={{
                    width: 64, padding: '8px 10px', borderRadius: 12,
                    border: '1.5px solid #c7d2fe', fontSize: 14, fontWeight: 800,
                    textAlign: 'center', color: '#4338ca',
                    background: extendLoading ? '#f3f4f6' : 'white',
                    outline: 'none',
                  }}
                  title="Брой допълнителни итерации"
                />
                <button
                  onClick={handleExtend}
                  disabled={extendLoading}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 7,
                    padding: '9px 20px', borderRadius: 20, border: 'none', cursor: 'pointer',
                    background: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
                    color: 'white', fontSize: 13, fontWeight: 700,
                    boxShadow: '0 2px 8px rgba(99,102,241,.35)',
                    opacity: extendLoading ? 0.7 : 1,
                  }}
                >
                  <span>🔄</span> {extendLoading ? 'Starting…' : 'Run more iterations'}
                </button>
              </div>
            )}
          </div>
          <div style={{ padding: 16 }}>
            <textarea
              value={feedback}
              onChange={e => { setFeedback(e.target.value); setFeedbackSaved(false); }}
              placeholder={run.status === 'running'
                ? 'Write your observations while the run is in progress — will be injected into the next refine step automatically...'
                : 'Write your observations — what worked, what didn\'t, what the bot should do differently. Will be passed to the Refine agent in the next run.'}
              rows={4}
              className="input"
              style={{ resize: 'vertical', fontSize: 13, lineHeight: 1.6, marginBottom: 10 }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={saveFeedback}
                disabled={feedbackLoading || !feedback.trim()}
                style={{
                  padding: '7px 18px', borderRadius: 20, border: 'none', cursor: 'pointer',
                  background: feedbackSaved ? 'linear-gradient(135deg,#059669,#10b981)' : 'linear-gradient(135deg,#6366f1,#818cf8)',
                  color: 'white', fontSize: 12, fontWeight: 700,
                  opacity: (!feedback.trim() || feedbackLoading) ? 0.6 : 1,
                  boxShadow: feedbackSaved ? '0 2px 8px rgba(5,150,105,.3)' : '0 2px 8px rgba(99,102,241,.25)',
                  transition: 'all .2s',
                }}
              >
                {feedbackSaved ? '✓ Saved' : feedbackLoading ? 'Saving…' : 'Save feedback'}
              </button>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>
                {feedback.trim() ? `${feedback.trim().length} chars` : 'No feedback yet'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Output path */}
      <div className="card" style={{ padding: '14px 18px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: 'linear-gradient(135deg, #eef2ff, #f5f3ff)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" stroke="#818cf8" strokeWidth="2"/>
          </svg>
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>Output Location</div>
          <code style={{ fontSize: 12, color: '#6366f1', background: '#eef2ff', padding: '2px 10px', borderRadius: 6, border: '1px solid #c7d2fe' }}>
            data/runs/{runId}/
          </code>
        </div>
      </div>

      {/* ── Champion vs Current Candidate Panel ── */}
      {run.promptLedger && run.promptLedger.entries.length > 0 && (
        <div className="card" style={{ overflow: 'hidden', marginBottom: 16 }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(99,102,241,.08)', background: 'linear-gradient(135deg,rgba(251,191,36,.08),rgba(245,158,11,.04))', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18 }}>🏆</span>
            <div style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>Champion vs. Current Candidate</div>
          </div>
          <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Champion row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10 }}>
              <span style={{ fontSize: 16, flexShrink: 0 }}>⭐</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 12, color: '#92400e' }}>
                  Champion — Iteration {run.promptLedger.championIteration}
                </div>
                <div style={{ fontSize: 11, color: '#b45309', display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 2 }}>
                  <span>Score: {(run.promptLedger.championScore * 100).toFixed(0)}%</span>
                  <span>PassRate: {(run.promptLedger.championPassRate * 100).toFixed(0)}%</span>
                  <span>{run.promptLedger.championHighSeverityCount} high severity</span>
                </div>
              </div>
              <button
                onClick={loadChampionPrompt}
                disabled={championPromptLoading}
                style={{ padding: '5px 14px', borderRadius: 16, border: '1px solid #fde68a', background: 'white', color: '#92400e', fontSize: 11, fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}
              >
                {championPromptLoading ? 'Loading…' : showChampionPrompt ? 'Hide' : 'View'}
              </button>
            </div>

            {/* Champion prompt text (expanded) */}
            {showChampionPrompt && championPrompt && (
              <div style={{ position: 'relative' }}>
                <pre style={{ background: '#111827', color: '#e5e7eb', borderRadius: 10, padding: '14px 16px', fontSize: 11, lineHeight: 1.7, overflow: 'auto', fontFamily: 'monospace', margin: 0, maxHeight: 300, border: '1px solid #1f2937' }}>
                  {championPrompt}
                </pre>
                <button
                  onClick={() => { navigator.clipboard.writeText(championPrompt); }}
                  style={{ position: 'absolute', top: 8, right: 8, padding: '4px 10px', background: '#374151', color: '#e5e7eb', border: 'none', borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: 'pointer' }}
                >
                  Copy
                </button>
              </div>
            )}

            {/* Current candidate row (last entry that is not champion, or last entry) */}
            {(() => {
              const lastEntry = run.promptLedger.entries.at(-1);
              if (!lastEntry || lastEntry.isChampion) return null;
              const delta = lastEntry.score - run.promptLedger.championScore;
              const deltaColor = delta >= 0 ? '#059669' : '#dc2626';
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10 }}>
                  <span style={{ fontSize: 16, flexShrink: 0 }}>{delta < -0.05 ? '📉' : delta > 0 ? '📈' : '→'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 12, color: '#374151' }}>
                      Candidate — Iteration {lastEntry.iteration}
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 2 }}>
                      <span>Score: {(lastEntry.score * 100).toFixed(0)}%</span>
                      <span style={{ color: deltaColor, fontWeight: 700 }}>
                        {delta >= 0 ? '+' : ''}{(delta * 100).toFixed(0)}% vs champion
                      </span>
                      <span>{lastEntry.highSeverityCount} high sev</span>
                    </div>
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 12, background: lastEntry.verdict === 'regression' ? '#fee2e2' : lastEntry.verdict === 'best_so_far' ? '#d1fae5' : '#f3f4f6', color: lastEntry.verdict === 'regression' ? '#991b1b' : lastEntry.verdict === 'best_so_far' ? '#065f46' : '#6b7280', border: '1px solid', borderColor: lastEntry.verdict === 'regression' ? '#fecaca' : lastEntry.verdict === 'best_so_far' ? '#a7f3d0' : '#e5e7eb' }}>
                    {lastEntry.verdict}
                  </span>
                </div>
              );
            })()}

            {/* Ledger summary */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingTop: 4 }}>
              {run.promptLedger.entries.map(e => (
                <div
                  key={e.iteration}
                  title={`Iter ${e.iteration}: ${e.verdict} | Score ${(e.score * 100).toFixed(0)}% | ${e.highSeverityCount} high sev`}
                  style={{
                    width: 28, height: 28, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, fontWeight: 800, cursor: 'default',
                    background: e.isChampion ? 'linear-gradient(135deg,#f59e0b,#d97706)' : e.verdict === 'regression' ? '#fee2e2' : e.verdict === 'improvement' || e.verdict === 'best_so_far' ? '#d1fae5' : '#f3f4f6',
                    color: e.isChampion ? 'white' : e.verdict === 'regression' ? '#991b1b' : e.verdict === 'improvement' || e.verdict === 'best_so_far' ? '#065f46' : '#6b7280',
                    border: e.isChampion ? 'none' : '1px solid #e5e7eb',
                    boxShadow: e.isChampion ? '0 2px 6px rgba(245,158,11,.4)' : 'none',
                  }}
                >
                  {e.iteration}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Test Package Quality ── */}
      {run.testAssetMeta && (
        <div className="card" style={{ overflow: 'hidden', marginBottom: 16 }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(99,102,241,.08)', background: 'linear-gradient(135deg,rgba(14,165,233,.06),rgba(6,182,212,.03))', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18 }}>🧪</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>Test Package Quality</div>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>
                v{run.testAssetMeta.testDriverPromptVersion.substring(0, 7)} · {run.testAssetMeta.scenarioCount} scenarios · generated {new Date(run.testAssetMeta.generatedAt).toLocaleDateString()}
              </div>
            </div>
          </div>
          <div style={{ padding: '14px 20px' }}>
            {run.testAssetMeta.qualityObservations.length === 0 ? (
              <p style={{ color: '#9ca3af', fontSize: 13, margin: 0 }}>No quality observations yet — will appear after first iteration.</p>
            ) : (
              <>
                {/* Summary stats */}
                {(() => {
                  const obs = run.testAssetMeta!.qualityObservations;
                  const goodCount = obs.filter(o => o.quality === 'good').length;
                  const weakCount = obs.filter(o => o.quality === 'weak').length;
                  const challengingCount = obs.filter(o => o.isChallengingEnough).length;
                  const realisticCount = obs.filter(o => o.isRealistic).length;
                  const lastObs = obs.at(-1);
                  const avgQuality = goodCount >= obs.length / 2 ? 'good' : weakCount >= obs.length / 2 ? 'weak' : 'medium';
                  const qColor = avgQuality === 'good' ? '#065f46' : avgQuality === 'weak' ? '#991b1b' : '#92400e';
                  const qBg = avgQuality === 'good' ? '#d1fae5' : avgQuality === 'weak' ? '#fee2e2' : '#fef3c7';
                  return (
                    <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                      <div style={{ padding: '8px 14px', background: qBg, borderRadius: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: qColor }}>Avg Quality: {avgQuality}</span>
                      </div>
                      <div style={{ padding: '8px 14px', background: challengingCount === obs.length ? '#d1fae5' : '#fef3c7', borderRadius: 8 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: challengingCount === obs.length ? '#065f46' : '#92400e' }}>
                          Challenging: {challengingCount}/{obs.length}
                        </span>
                      </div>
                      <div style={{ padding: '8px 14px', background: realisticCount === obs.length ? '#d1fae5' : '#fef3c7', borderRadius: 8 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: realisticCount === obs.length ? '#065f46' : '#92400e' }}>
                          Realistic: {realisticCount}/{obs.length}
                        </span>
                      </div>
                      {lastObs?.suggestedImprovementsForNextRun && lastObs.suggestedImprovementsForNextRun.length > 0 && (
                        <div style={{ padding: '8px 14px', background: '#eef2ff', borderRadius: 8 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: '#4338ca' }}>
                            💡 {lastObs.suggestedImprovementsForNextRun.length} suggestion(s) for next run
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Per-iteration observations */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {run.testAssetMeta.qualityObservations.map((obs, i) => {
                    const qColor = obs.quality === 'good' ? '#065f46' : obs.quality === 'weak' ? '#991b1b' : '#92400e';
                    const qBg = obs.quality === 'good' ? '#d1fae5' : obs.quality === 'weak' ? '#fee2e2' : '#fef3c7';
                    return (
                      <div key={i} style={{ padding: '8px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                        <div style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: '#f3f4f6', color: '#6b7280', marginTop: 1 }}>
                          iter {obs.iteration}
                        </div>
                        <div style={{ flexShrink: 0 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: qBg, color: qColor }}>
                            {obs.quality}
                          </span>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', gap: 6, marginBottom: obs.notes.length ? 4 : 0, flexWrap: 'wrap' }}>
                            {obs.isChallengingEnough ? null : <span style={{ fontSize: 9, fontWeight: 700, color: '#92400e', background: '#fef3c7', padding: '1px 6px', borderRadius: 8 }}>not challenging enough</span>}
                            {obs.isRealistic ? null : <span style={{ fontSize: 9, fontWeight: 700, color: '#7c3aed', background: '#f5f3ff', padding: '1px 6px', borderRadius: 8 }}>not realistic</span>}
                          </div>
                          {obs.notes.map((n, j) => (
                            <div key={j} style={{ fontSize: 11, color: '#475569' }}>• {n}</div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Signal for next run */}
                {run.testAssetMeta.qualityObservations.at(-1)?.suggestedImprovementsForNextRun?.length ? (
                  <div style={{ marginTop: 10, padding: '10px 14px', background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#4338ca', marginBottom: 4 }}>Signal for next run:</div>
                    {run.testAssetMeta.qualityObservations.at(-1)!.suggestedImprovementsForNextRun!.map((s, i) => (
                      <div key={i} style={{ fontSize: 11, color: '#3730a3' }}>→ {s}</div>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Iteration History ── */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{
          padding: '18px 24px',
          borderBottom: '1px solid rgba(99,102,241,.08)',
          background: 'linear-gradient(135deg, rgba(238,242,255,.5), rgba(245,243,255,.2))',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, #8b5cf6, #7c3aed)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 8px rgba(139,92,246,.35)' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" stroke="white" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#111827' }}>Iteration History</div>
              <div style={{ color: '#9ca3af', fontSize: 12 }}>Click a row to view prompt, analysis and conversations</div>
            </div>
          </div>
          {run.iterations.length > 0 && <span style={{ fontSize: 12, color: '#9ca3af', fontWeight: 600 }}>{run.iterations.length} iteration(s)</span>}
        </div>

        {run.iterations.length === 0 ? (
          <div style={{ padding: '56px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 52, height: 52, borderRadius: 14, background: 'linear-gradient(135deg, #eef2ff, #f5f3ff)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="#c7d2fe" strokeWidth="1.5"/>
                <path d="M12 8v4M12 16h.01" stroke="#818cf8" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </div>
            <p style={{ color: '#6b7280', fontSize: 14 }}>{run.status === 'running' ? 'Waiting for first iteration…' : 'No iterations recorded.'}</p>
          </div>
        ) : (
          <div>
            {run.iterations.map(iter => {
              const allPass = iter.passedCount === iter.totalCount;
              const hasHigh = iter.highSeverityCount > 0;
              const isExp   = expandedIter === iter.iteration;
              const isChampion = iter.isChampion ?? false;
              const iterColor = allPass ? '#059669' : hasHigh ? '#dc2626' : '#d97706';
              const iterGrad  = allPass ? 'linear-gradient(135deg,#10b981,#059669)' : hasHigh ? 'linear-gradient(135deg,#ef4444,#dc2626)' : 'linear-gradient(135deg,#f59e0b,#d97706)';
              const iterShadow= allPass ? 'rgba(16,185,129,.35)' : hasHigh ? 'rgba(239,68,68,.35)' : 'rgba(245,158,11,.35)';
              return (
                <div key={iter.iteration} style={{ borderBottom: '1px solid #f9fafb' }}>
                  {/* Row header */}
                  <div
                    onClick={() => loadIter(iter.iteration)}
                    className="table-row"
                    style={{ padding: '16px 24px', display: 'flex', alignItems: 'center', gap: 16, cursor: 'pointer' }}
                  >
                    {/* Iteration badge */}
                    <div style={{ width: 40, height: 40, borderRadius: 12, background: iterGrad, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 3px 10px ${iterShadow}`, flexShrink: 0 }}>
                      <span style={{ color: 'white', fontWeight: 800, fontSize: 14 }}>#{iter.iteration}</span>
                    </div>

                    {/* Pass rate bar */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: iterColor }}>{iter.passedCount}/{iter.totalCount} passed</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {iter.qualityScore !== undefined && (
                            <span style={{ fontSize: 11, color: '#6b7280', background: '#f3f4f6', padding: '2px 6px', borderRadius: 6 }} title="LLM quality score">
                              Q: {(iter.qualityScore * 100).toFixed(0)}%
                            </span>
                          )}
                          <span style={{ fontSize: 12, fontWeight: 800, color: iterColor }} title="Binary pass rate (passed scenarios / total)">
                            {(iter.passRate * 100).toFixed(0)}%
                          </span>
                        </div>
                      </div>
                      <div style={{ height: 6, borderRadius: 3, background: '#f3f4f6', overflow: 'hidden' }}>
                        <div style={{ height: '100%', borderRadius: 3, background: iterGrad, width: `${iter.passRate * 100}%`, transition: 'width .4s ease' }} />
                      </div>
                    </div>

                    {/* Tags */}
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {isChampion && (
                        <span style={{ background: 'linear-gradient(135deg,#f59e0b,#d97706)', color: 'white', fontSize: 10, fontWeight: 800, padding: '3px 8px', borderRadius: 20, boxShadow: '0 1px 4px rgba(245,158,11,.4)' }}>
                          ⭐ Champion
                        </span>
                      )}
                      {!isChampion && iter.verdict === 'regression' && (
                        <span style={{ background: '#fee2e2', color: '#991b1b', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20, border: '1px solid #fecaca' }}>
                          ↓ Below Champion
                        </span>
                      )}
                      {iter.mode && (
                        <span style={{ background: iter.mode === 'surgical' ? '#f0fdf4' : '#faf5ff', color: iter.mode === 'surgical' ? '#166534' : '#6d28d9', fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 20, border: `1px solid ${iter.mode === 'surgical' ? '#bbf7d0' : '#ddd6fe'}` }}>
                          {iter.mode}
                        </span>
                      )}
                      {iter.highSeverityCount > 0 && (
                        <span style={{ background: '#fee2e2', color: '#991b1b', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20 }}>
                          {iter.highSeverityCount} high
                        </span>
                      )}
                      <span style={{ background: '#f3f4f6', color: '#6b7280', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20 }}
                            title={`Cumulative: $${iter.cost.toFixed(3)}`}>
                        {iter.iterationCost !== undefined ? `$${iter.iterationCost.toFixed(3)}` : `$${iter.cost.toFixed(3)}`}
                      </span>
                      {iter.delta && (
                        <>
                          {iter.delta.improvements > 0 && (
                            <span style={{ background: '#ecfdf5', color: '#065f46', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20 }}>
                              +{iter.delta.improvements} improved
                            </span>
                          )}
                          {iter.delta.regressions > 0 && (
                            <span style={{ background: '#fee2e2', color: '#991b1b', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20 }}>
                              -{iter.delta.regressions} regressed
                            </span>
                          )}
                        </>
                      )}
                    </div>

                    {/* Chevron */}
                    <div style={{ width: 28, height: 28, borderRadius: 8, background: isExp ? '#eef2ff' : '#f9fafb', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all .15s' }}>
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ transform: isExp ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>
                        <path d="M2 4l4 4 4-4" stroke={isExp ? '#6366f1' : '#9ca3af'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  </div>

                  {/* Expanded detail panel */}
                  {isExp && (
                    <div style={{ borderTop: '1px solid #f3f4f6', background: '#fafafa' }}>
                      {iterLoading ? (
                        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
                          {[1,2,3].map(i => <div key={i} className="shimmer" style={{ height: 44 }} />)}
                        </div>
                      ) : !iterDetail ? (
                        <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Could not load details</div>
                      ) : (
                        <div style={{ padding: '0 0 0' }}>
                          {/* Tabs */}
                          <div style={{ display: 'flex', gap: 0, padding: '12px 24px 0', borderBottom: '1px solid #f0f0f0', flexWrap: 'wrap' }}>
                            {(['prompt', 'analysis', 'transcripts', 'testdriver'] as const).map(tab => (
                              <button
                                key={tab}
                                onClick={() => setActiveTab(tab)}
                                style={{
                                  padding: '8px 18px',
                                  fontSize: 12, fontWeight: 700,
                                  background: 'none', border: 'none', cursor: 'pointer',
                                  color: activeTab === tab ? '#6366f1' : '#9ca3af',
                                  borderBottom: `2px solid ${activeTab === tab ? '#6366f1' : 'transparent'}`,
                                  marginBottom: -1,
                                  textTransform: 'capitalize',
                                  transition: 'all .15s',
                                }}
                              >
                                {tab === 'transcripts' ? `Conversations (${iterDetail.transcripts.length})` : tab === 'testdriver' ? 'Test Driver' : tab.charAt(0).toUpperCase() + tab.slice(1)}
                              </button>
                            ))}
                          </div>

                          <div style={{ padding: 20 }}>
                            {/* PROMPT tab */}
                            {activeTab === 'prompt' && (
                              <div>
                                {/* Iteration Focus panel */}
                                {iterDetail.changePlan && (
                                  <div style={{ marginBottom: 16, padding: '14px 16px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                                      <span style={{ fontSize: 14 }}>🎯</span>
                                      <span style={{ fontWeight: 700, fontSize: 12, color: '#374151' }}>Iteration Focus</span>
                                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 12, background: iterDetail.changePlan.mode === 'surgical' ? '#f0fdf4' : '#faf5ff', color: iterDetail.changePlan.mode === 'surgical' ? '#166534' : '#6d28d9', border: `1px solid ${iterDetail.changePlan.mode === 'surgical' ? '#bbf7d0' : '#ddd6fe'}` }}>
                                        {iterDetail.changePlan.mode}
                                      </span>
                                      <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 4 }}>
                                        Based on: Champion iter {iterDetail.changePlan.basedOnChampionIteration}
                                      </span>
                                    </div>
                                    <div style={{ fontSize: 11, color: '#475569', marginBottom: 10, fontStyle: 'italic' }}>
                                      {iterDetail.changePlan.diagnosis}
                                    </div>
                                    {iterDetail.changePlan.decisionRationale && (
                                      <div style={{ fontSize: 11, color: '#6366f1', marginBottom: 10, padding: '6px 10px', background: '#eef2ff', borderRadius: 6 }}>
                                        Strategy: {iterDetail.changePlan.decisionRationale}
                                      </div>
                                    )}
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                      {iterDetail.changePlan.plannedChanges.map((pc, i) => {
                                        const impact = iterDetail.changeImpact?.changeImpacts?.find(ci => ci.changeId === pc.id);
                                        return (
                                          <div key={i} style={{ padding: '8px 10px', background: 'white', border: '1px solid #e2e8f0', borderRadius: 8 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                                              <span style={{ fontSize: 10, fontWeight: 800, color: '#6366f1', background: '#eef2ff', padding: '1px 6px', borderRadius: 10 }}>{pc.id}</span>
                                              <span style={{ fontSize: 11, fontWeight: 700, color: '#374151' }}>{pc.targetSection}</span>
                                              {impact && (
                                                <span style={{ fontSize: 9, fontWeight: 700, marginLeft: 'auto', padding: '1px 6px', borderRadius: 10, background: impact.verdict === 'helped' ? '#d1fae5' : impact.verdict === 'hurt' ? '#fee2e2' : '#f3f4f6', color: impact.verdict === 'helped' ? '#065f46' : impact.verdict === 'hurt' ? '#991b1b' : '#6b7280' }}>
                                                  {impact.verdict}
                                                </span>
                                              )}
                                            </div>
                                            <div style={{ fontSize: 11, color: '#475569', marginBottom: 3 }}>{pc.description}</div>
                                            <div style={{ fontSize: 10, color: '#9ca3af', fontStyle: 'italic' }}>→ {pc.hypothesis}</div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                    {iterDetail.changeImpact && (
                                      <div style={{ marginTop: 10, padding: '8px 10px', background: iterDetail.changeImpact.becameChampion ? '#f0fdf4' : iterDetail.changeImpact.overallVerdict === 'regression' ? '#fef2f2' : '#f8fafc', border: `1px solid ${iterDetail.changeImpact.becameChampion ? '#a7f3d0' : iterDetail.changeImpact.overallVerdict === 'regression' ? '#fecaca' : '#e2e8f0'}`, borderRadius: 8 }}>
                                        <div style={{ fontSize: 11, fontWeight: 700, color: iterDetail.changeImpact.becameChampion ? '#065f46' : iterDetail.changeImpact.overallVerdict === 'regression' ? '#991b1b' : '#475569' }}>
                                          {iterDetail.changeImpact.becameChampion ? '🏆 Became Champion' : iterDetail.changeImpact.overallVerdict === 'regression' ? '↓ Regression vs Champion' : '→ No significant change'}
                                          {' · '}Score: {(iterDetail.changeImpact.newScore * 100).toFixed(0)}% · PassRate: {(iterDetail.changeImpact.newPassRate * 100).toFixed(0)}%
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )}

                                {iterDetail.summary?.changesApplied?.length ? (
                                  <div style={{ marginBottom: 16 }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>Changes Applied</div>
                                    {iterDetail.summary.changesApplied.map((c, i) => (
                                      <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6, padding: '8px 12px', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8 }}>
                                        <span style={{ color: '#059669', fontSize: 14, lineHeight: 1.2 }}>↑</span>
                                        <span style={{ fontSize: 12, color: '#065f46' }}>{c}</span>
                                      </div>
                                    ))}
                                  </div>
                                ) : null}
                                {iterDetail.prompt ? (
                                  <div>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                                      <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em' }}>System Prompt</div>
                                      {iterDetail.isChampion && (
                                        <span style={{ fontSize: 10, fontWeight: 800, background: 'linear-gradient(135deg,#f59e0b,#d97706)', color: 'white', padding: '3px 10px', borderRadius: 20 }}>⭐ Champion</span>
                                      )}
                                    </div>
                                    <pre style={{
                                      background: '#111827', color: '#e5e7eb',
                                      borderRadius: 12, padding: '16px 18px',
                                      fontSize: 11, lineHeight: 1.7, overflow: 'auto',
                                      fontFamily: 'monospace', margin: 0,
                                      maxHeight: 320, border: '1px solid #1f2937',
                                    }}>{iterDetail.prompt}</pre>
                                  </div>
                                ) : <p style={{ color: '#9ca3af', fontSize: 13 }}>No prompt recorded</p>}
                              </div>
                            )}

                            {/* ANALYSIS tab */}
                            {activeTab === 'analysis' && iterDetail.analysis && (
                              <div>
                                {/* Score row */}
                                <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
                                  {[
                                    { label: 'LLM Quality Score', value: `${(iterDetail.analysis.overallScore * 100).toFixed(1)}%`, color: iterDetail.analysis.overallScore >= 0.75 ? '#059669' : '#d97706' },
                                    { label: 'LLM Pass Rate',     value: `${(iterDetail.analysis.passRate * 100).toFixed(1)}%`,    color: iterDetail.analysis.passRate >= 0.75 ? '#059669' : '#d97706' },
                                  ].map(s => (
                                    <div key={s.label} style={{ flex: 1, padding: '12px 16px', background: '#fff', border: '1px solid #f0f0f0', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,.04)' }}>
                                      <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>{s.label}</div>
                                      <div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.value}</div>
                                    </div>
                                  ))}
                                </div>

                                {/* Scenarios */}
                                <div style={{ marginBottom: 16 }}>
                                  <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>Scenarios</div>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                    {iterDetail.analysis.scenarios.map(sc => {
                                      const scVerdict: ScenarioVerdict = sc.verdict ?? (sc.passed ? 'pass' : 'fail');
                                      const AV_STYLE: Record<ScenarioVerdict, { bg: string; color: string; border: string; label: string }> = {
                                        pass:          { bg: '#d1fae5', color: '#065f46', border: '#a7f3d0', label: '✓ PASS' },
                                        fail:          { bg: '#fee2e2', color: '#991b1b', border: '#fecaca', label: '✕ FAIL' },
                                        mixed:         { bg: '#fef3c7', color: '#92400e', border: '#fde68a', label: '◑ MIXED' },
                                        not_evaluable: { bg: '#f1f5f9', color: '#64748b', border: '#e2e8f0', label: '— N/A' },
                                      };
                                      const avs = AV_STYLE[scVerdict];
                                      return (
                                        <div key={sc.scenarioId} style={{ background: '#fff', border: `1px solid ${avs.border}`, borderRadius: 10, padding: '10px 14px' }}>
                                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: (sc.strengths?.length || sc.issues.length) ? 8 : 0 }}>
                                            <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 20, background: avs.bg, color: avs.color, fontWeight: 700, border: `1px solid ${avs.border}` }}>
                                              {avs.label}
                                            </span>
                                            <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>{sc.scenarioId}</span>
                                          </div>
                                          {/* Strengths */}
                                          {sc.strengths && sc.strengths.length > 0 && (
                                            <div style={{ marginBottom: 8 }}>
                                              <div style={{ fontSize: 10, fontWeight: 700, color: '#059669', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>What is working well</div>
                                              {sc.strengths.map((s, si) => (
                                                <div key={si} style={{ display: 'flex', gap: 6, marginBottom: 3, padding: '5px 8px', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 6 }}>
                                                  <span style={{ color: '#059669', fontWeight: 700, fontSize: 11 }}>✓</span>
                                                  <span style={{ fontSize: 11, color: '#065f46' }}>{s}</span>
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                          {/* Issues */}
                                          {sc.issues.map((iss, j) => {
                                            const ss = SEV_STYLE[iss.severity] ?? SEV_STYLE.low;
                                            return (
                                              <div key={j} style={{ marginTop: 6, padding: '8px 10px', background: ss.bg, border: `1px solid ${ss.border}`, borderRadius: 8 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' }}>
                                                  <span style={{ fontSize: 10, fontWeight: 800, color: ss.color, background: ss.border, padding: '1px 7px', borderRadius: 20 }}>{iss.severity.toUpperCase()}</span>
                                                  <span style={{ fontSize: 11, fontWeight: 700, color: ss.color }}>{iss.category}</span>
                                                  {iss.rootCauseArea && (
                                                    <span style={{ fontSize: 10, color: '#6b7280', background: '#f3f4f6', padding: '1px 6px', borderRadius: 10, border: '1px solid #e5e7eb' }}>{iss.rootCauseArea}</span>
                                                  )}
                                                </div>
                                                <p style={{ fontSize: 11, color: '#374151', margin: '0 0 3px' }}>{iss.description}</p>
                                                <p style={{ fontSize: 11, color: '#6b7280', margin: 0, fontStyle: 'italic' }}>
                                                  → {iss.improvementDirection ?? iss.suggestion ?? ''}
                                                </p>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>

                                {/* General directional guidance */}
                                {iterDetail.analysis.generalSuggestions?.length > 0 && (
                                  <div>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>General Improvement Directions</div>
                                    {iterDetail.analysis.generalSuggestions.map((s, i) => (
                                      <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6, padding: '8px 12px', background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 8 }}>
                                        <span style={{ color: '#6366f1', fontWeight: 800, fontSize: 13, lineHeight: 1.2 }}>→</span>
                                        <span style={{ fontSize: 12, color: '#3730a3' }}>{s}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* TEST DRIVER tab */}
                            {activeTab === 'testdriver' && (
                              <div>
                                {iterDetail.testDriverPrompt ? (
                                  <div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                                      <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Test Driver Prompt</div>
                                      {run.status === 'running' && (
                                        <span style={{ fontSize: 10, fontWeight: 700, background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: 10, border: '1px solid #fde68a' }}>
                                          🔒 Locked — active run
                                        </span>
                                      )}
                                    </div>
                                    <pre style={{ background: '#111827', color: '#e5e7eb', borderRadius: 12, padding: '16px 18px', fontSize: 11, lineHeight: 1.7, overflow: 'auto', fontFamily: 'monospace', margin: 0, maxHeight: 400, border: '1px solid #1f2937' }}>
                                      {iterDetail.testDriverPrompt}
                                    </pre>
                                  </div>
                                ) : (
                                  <p style={{ color: '#9ca3af', fontSize: 13 }}>No test driver prompt recorded for this iteration.</p>
                                )}
                              </div>
                            )}

                            {/* TRANSCRIPTS tab */}
                            {activeTab === 'transcripts' && (
                              <div>
                                {iterDetail.transcripts.length === 0 ? (
                                  <p style={{ color: '#9ca3af', fontSize: 13 }}>No transcripts available</p>
                                ) : (
                                  // Sort: fail first, then mixed, then pass, then not_evaluable
                                  [...iterDetail.transcripts].sort((a, b) => {
                                    const order: Record<string, number> = { fail: 0, mixed: 1, pass: 2, not_evaluable: 3 };
                                    const aV = a.verdict ?? (a.passed === false ? 'fail' : a.passed === true ? 'pass' : 'pass');
                                    const bV = b.verdict ?? (b.passed === false ? 'fail' : b.passed === true ? 'pass' : 'pass');
                                    return (order[aV] ?? 2) - (order[bV] ?? 2);
                                  }).map(tr => {
                                    const open = openChat === tr.scenarioId;
                                    // Build a map from actualMessage → utterance log entry (for chat bubble annotation)
                                    const uttByMsg = new Map<string, UtteranceUsage>();
                                    (tr.utteranceLog ?? []).forEach(u => uttByMsg.set(u.actualMessage, u));
                                    const nonSysMsgs = tr.messages.filter(m => m.role !== 'system');
                                    const userTurns = nonSysMsgs.filter(m => m.role === 'user').length;
                                    const isV2 = tr.driverMode && (tr.utteranceLog?.length ?? 0) > 0;
                                    const GROUP_COLOR: Record<string, { bg: string; color: string; border: string }> = {
                                      opening:   { bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
                                      discovery: { bg: '#f0fdf4', color: '#166534', border: '#bbf7d0' },
                                      objections:{ bg: '#fef3c7', color: '#92400e', border: '#fde68a' },
                                      close:     { bg: '#f5f3ff', color: '#6d28d9', border: '#ddd6fe' },
                                      improvised:{ bg: '#f9fafb', color: '#6b7280', border: '#e5e7eb' },
                                    };
                                    const trVerdict: ScenarioVerdict | undefined = tr.verdict ?? (tr.passed === true ? 'pass' : tr.passed === false ? 'fail' : undefined);
                                    const VERDICT_STYLE: Record<ScenarioVerdict, { bg: string; color: string; border: string; label: string; headerBg: string; cardBorder: string }> = {
                                      pass:          { bg: '#d1fae5', color: '#065f46', border: '#a7f3d0', label: '✓ PASS',          headerBg: '#f0fdf4', cardBorder: '#a7f3d0' },
                                      fail:          { bg: '#fee2e2', color: '#991b1b', border: '#fecaca', label: '✕ FAIL',          headerBg: '#fef2f2', cardBorder: '#fecaca' },
                                      mixed:         { bg: '#fef3c7', color: '#92400e', border: '#fde68a', label: '◑ MIXED',         headerBg: '#fffbeb', cardBorder: '#fde68a' },
                                      not_evaluable: { bg: '#f1f5f9', color: '#64748b', border: '#e2e8f0', label: '— N/A',           headerBg: '#f8fafc', cardBorder: '#e2e8f0' },
                                    };
                                    const vs = trVerdict ? VERDICT_STYLE[trVerdict] : null;
                                    const borderColor = vs ? vs.cardBorder : (tr.driverMode ? '#a5f3fc' : '#e5e7eb');
                                    return (
                                      <div key={tr.scenarioId} style={{ marginBottom: 12, border: `1px solid ${borderColor}`, borderRadius: 12, overflow: 'hidden' }}>
                                        {/* Scenario header */}
                                        <div
                                          onClick={() => setOpenChat(open ? null : tr.scenarioId)}
                                          style={{ padding: '12px 16px', background: open ? (vs ? vs.headerBg : tr.driverMode ? '#ecfeff' : '#eef2ff') : '#fafafa', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}
                                        >
                                          <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, flexWrap: 'wrap' }}>
                                              {/* Verdict badge */}
                                              {vs && (
                                                <span style={{ fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 20, background: vs.bg, color: vs.color, border: `1px solid ${vs.border}` }}>
                                                  {vs.label}
                                                </span>
                                              )}
                                              <span style={{ fontWeight: 700, fontSize: 13, color: '#111827' }}>{tr.scenarioName}</span>
                                              {tr.driverMode && (
                                                <span style={{ fontSize: 10, fontWeight: 700, background: '#cffafe', color: '#0e7490', padding: '2px 7px', borderRadius: 20, border: '1px solid #a5f3fc' }}>
                                                  🎭 AI Test Driver (user side)
                                                </span>
                                              )}
                                              {tr.stopReason && (
                                                <span style={{ fontSize: 10, fontWeight: 700, background: '#f0fdf4', color: '#166534', padding: '2px 7px', borderRadius: 20, border: '1px solid #bbf7d0' }}>
                                                  ⏹ {tr.stopReason}
                                                </span>
                                              )}
                                            </div>
                                            <div style={{ fontSize: 11, color: '#6b7280', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                                              <span>{nonSysMsgs.length} messages · {userTurns} user turns</span>
                                              {isV2 && tr.utteranceLog && (
                                                <span>
                                                  {tr.utteranceLog.filter(u => u.utteranceId !== 'improvised').length} blueprint ·{' '}
                                                  {tr.utteranceLog.filter(u => u.rephrased).length} rephrased ·{' '}
                                                  {tr.utteranceLog.filter(u => u.utteranceId === 'improvised').length} improvised
                                                </span>
                                              )}
                                              {tr.userGoal && <span>Goal: {tr.userGoal.substring(0, 50)}{tr.userGoal.length > 50 ? '…' : ''}</span>}
                                            </div>
                                          </div>
                                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s', flexShrink: 0, marginTop: 4 }}>
                                            <path d="M2 4l4 4 4-4" stroke="#9ca3af" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                                          </svg>
                                        </div>

                                        {/* Utterance log strip (v2) */}
                                        {open && isV2 && tr.utteranceLog && tr.utteranceLog.length > 0 && (
                                          <div style={{ padding: '10px 16px', background: '#f8fafc', borderBottom: '1px solid #e5e7eb' }}>
                                            <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
                                              Utterance Log — AI Test Driver (user side)
                                            </div>
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                              {tr.utteranceLog.map((u, i) => {
                                                const gc = GROUP_COLOR[u.group] ?? GROUP_COLOR.improvised;
                                                return (
                                                  <div key={i} title={u.rephrased ? `Original: "${u.originalText}"` : u.originalText} style={{
                                                    display: 'flex', alignItems: 'center', gap: 5,
                                                    padding: '4px 9px', borderRadius: 20,
                                                    background: gc.bg, border: `1px solid ${gc.border}`,
                                                    cursor: 'default',
                                                  }}>
                                                    <span style={{ fontSize: 9, fontWeight: 800, color: gc.color }}>{u.utteranceId === 'improvised' ? 'IMP' : u.utteranceId.toUpperCase()}</span>
                                                    <span style={{ fontSize: 9, color: gc.color, opacity: 0.8 }}>{u.group}</span>
                                                    {u.rephrased && <span style={{ fontSize: 9, color: '#f59e0b', fontWeight: 700 }} title="Rephrased">~</span>}
                                                  </div>
                                                );
                                              })}
                                            </div>
                                            <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                                              {(['opening','discovery','objections','close','improvised'] as const).map(g => {
                                                const gc = GROUP_COLOR[g];
                                                const count = (tr.utteranceLog ?? []).filter(u => u.group === g).length;
                                                if (count === 0) return null;
                                                return (
                                                  <span key={g} style={{ fontSize: 10, color: gc.color, background: gc.bg, padding: '2px 8px', borderRadius: 20, border: `1px solid ${gc.border}`, fontWeight: 600 }}>
                                                    {g}: {count}
                                                  </span>
                                                );
                                              })}
                                            </div>
                                          </div>
                                        )}

                                        {/* Chat messages */}
                                        {open && (
                                          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 500, overflowY: 'auto', background: '#fff' }}>
                                            {nonSysMsgs.map((msg, i) => {
                                              const uttEntry = msg.role === 'user' ? uttByMsg.get(msg.content) : undefined;
                                              const gc = uttEntry ? (GROUP_COLOR[uttEntry.group] ?? GROUP_COLOR.improvised) : null;
                                              return (
                                                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-start' : 'flex-end', gap: 3 }}>
                                                  {msg.role === 'user' && tr.driverMode && (
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, paddingLeft: 4 }}>
                                                      <span style={{ fontSize: 10, fontWeight: 700, color: '#0891b2' }}>🎭 user (driver)</span>
                                                      {uttEntry && uttEntry.utteranceId !== 'improvised' && (
                                                        <span style={{ fontSize: 9, fontWeight: 700, color: gc?.color, background: gc?.bg, padding: '1px 6px', borderRadius: 20, border: `1px solid ${gc?.border}` }}>
                                                          {uttEntry.utteranceId} · {uttEntry.group}{uttEntry.rephrased ? ' ~' : ''}
                                                        </span>
                                                      )}
                                                      {uttEntry && uttEntry.utteranceId === 'improvised' && (
                                                        <span style={{ fontSize: 9, fontWeight: 700, color: '#6b7280', background: '#f3f4f6', padding: '1px 6px', borderRadius: 20 }}>
                                                          improvised
                                                        </span>
                                                      )}
                                                    </div>
                                                  )}
                                                  {msg.role === 'assistant' && (
                                                    <div style={{ paddingRight: 4, textAlign: 'right' }}>
                                                      <span style={{ fontSize: 10, fontWeight: 700, color: '#7c3aed' }}>🤖 bot under test</span>
                                                    </div>
                                                  )}
                                                  <div style={{
                                                    maxWidth: '78%', padding: '10px 14px', fontSize: 12, lineHeight: 1.6,
                                                    borderRadius: msg.role === 'user' ? '16px 16px 16px 4px' : '16px 16px 4px 16px',
                                                    background: msg.role === 'user'
                                                      ? (gc ? gc.bg : '#f3f4f6')
                                                      : 'linear-gradient(135deg,#6366f1,#8b5cf6)',
                                                    color: msg.role === 'user' ? '#1f2937' : 'white',
                                                    border: gc ? `1px solid ${gc.border}` : 'none',
                                                    boxShadow: '0 1px 4px rgba(0,0,0,.06)',
                                                  }}>
                                                    {msg.content}
                                                  </div>
                                                </div>
                                              );
                                            })}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <style>{`
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.5; } }
      `}</style>
    </div>
  );
}
