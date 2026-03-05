'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

interface IterationSummary {
  iteration: number; passRate: number; passedCount: number; totalCount: number;
  highSeverityCount: number; mainIssues: string[]; changesApplied: string[];
  cost: number; delta?: { improvements: number; regressions: number; unchanged: number };
}
interface RunDetails {
  runId: string; orchestratorId: string; taskId: string;
  status: 'running' | 'success' | 'max_iterations' | 'error';
  startedAt: number; completedAt?: number; currentIteration: number;
  finalScore?: number; totalCost?: number; iterations: IterationSummary[];
}
interface Message { role: 'user' | 'assistant' | 'system'; content: string }
interface UtteranceUsage { utteranceId: string; originalText: string; actualMessage: string; rephrased: boolean; turnIndex: number; group: string }
interface Transcript {
  scenarioId: string; scenarioName: string; expectedBehavior: string; messages: Message[];
  driverMode?: boolean;
  // v2 fields
  utteranceLog?: UtteranceUsage[];
  totalUserTurns?: number;
  // v1 legacy fields (kept for backward compat)
  seedUserMessages?: string[];
  generatedUserMessages?: string[];
  maxTurns?: number; stopReason?: string; userGoal?: string;
}
interface Issue { severity: 'high' | 'medium' | 'low'; category: string; description: string; suggestion: string }
interface ScenarioAnalysis { scenarioId: string; passed: boolean; issues: Issue[] }
interface Analysis { overallScore: number; passRate: number; scenarios: ScenarioAnalysis[]; generalSuggestions: string[] }
interface IterationDetail { iteration: number; prompt: string | null; testDriverPrompt: string | null; analysis: Analysis | null; summary: IterationSummary | null; transcripts: Transcript[] }

const STATUS_STYLE = {
  running:        { label: 'Running',        bg: '#dbeafe', color: '#1d4ed8', dot: '#3b82f6', pulse: true },
  success:        { label: 'Success',        bg: '#d1fae5', color: '#065f46', dot: '#10b981', pulse: false },
  max_iterations: { label: 'Max iterations', bg: '#fef3c7', color: '#92400e', dot: '#f59e0b', pulse: false },
  error:          { label: 'Error',          bg: '#fee2e2', color: '#991b1b', dot: '#ef4444', pulse: false },
};
const BANNER_STYLE = {
  running:        { bg: '#eff6ff', border: '#bfdbfe', color: '#1e40af', icon: '⚙',  text: 'Run in progress — auto-refreshing every 3 seconds.' },
  success:        { bg: '#ecfdf5', border: '#a7f3d0', color: '#065f46', icon: '✓',  text: 'Run completed successfully.' },
  max_iterations: { bg: '#fffbeb', border: '#fde68a', color: '#92400e', icon: '⚠',  text: 'Reached maximum iterations.' },
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
  const [activeTab, setActiveTab]       = useState<'prompt' | 'analysis' | 'transcripts'>('prompt');
  const [openChat, setOpenChat]         = useState<string | null>(null);

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
    return () => clearInterval(iv);
  }, [loadRun]);

  const loadIter = async (n: number) => {
    if (expandedIter === n) { setExpandedIter(null); return; }
    setExpandedIter(n); setIterDetail(null); setIterLoading(true); setActiveTab('prompt'); setOpenChat(null);
    try { const r = await fetch(`/api/runs/${runId}/iterations/${n}`); if (r.ok) setIterDetail(await r.json()); }
    catch {}
    setIterLoading(false);
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
        <code style={{ color: '#374151', textTransform: 'none', letterSpacing: 'normal', fontFamily: 'monospace', fontSize: 11 }}>{runId.substring(0, 20)}…</code>
      </div>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: '#111827', margin: '0 0 6px', letterSpacing: '-0.02em' }}>Run Details</h1>
          <code style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>{runId}</code>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, background: sc.bg, color: sc.color, padding: '6px 14px 6px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: sc.dot, display: 'block', animation: sc.pulse ? 'pulse 2s infinite' : 'none' }} />
          {sc.label}
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

      {/* Banner */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '13px 18px', borderRadius: 12, marginBottom: 16,
        background: bn.bg, border: `1px solid ${bn.border}`, color: bn.color,
        fontSize: 13, fontWeight: 600,
      }}>
        <span style={{ fontSize: 16 }}>{bn.icon}</span>
        <span style={{ flex: 1 }}>{bn.text}</span>
        {run.status !== 'running' && (
          <span style={{ fontSize: 11, opacity: .6 }}>{fmt((run.completedAt || Date.now()) - run.startedAt)}</span>
        )}
      </div>

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
                        <span style={{ fontSize: 12, fontWeight: 800, color: iterColor }}>{(iter.passRate * 100).toFixed(0)}%</span>
                      </div>
                      <div style={{ height: 6, borderRadius: 3, background: '#f3f4f6', overflow: 'hidden' }}>
                        <div style={{ height: '100%', borderRadius: 3, background: iterGrad, width: `${iter.passRate * 100}%`, transition: 'width .4s ease' }} />
                      </div>
                    </div>

                    {/* Tags */}
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                      {iter.highSeverityCount > 0 && (
                        <span style={{ background: '#fee2e2', color: '#991b1b', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20 }}>
                          {iter.highSeverityCount} high
                        </span>
                      )}
                      <span style={{ background: '#f3f4f6', color: '#6b7280', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20 }}>
                        ${iter.cost.toFixed(3)}
                      </span>
                      {iter.delta && (
                        <span style={{ background: '#ecfdf5', color: '#065f46', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 20 }}>
                          +{iter.delta.improvements} improved
                        </span>
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
                          <div style={{ display: 'flex', gap: 0, padding: '12px 24px 0', borderBottom: '1px solid #f0f0f0' }}>
                            {(['prompt', 'analysis', 'transcripts'] as const).map(tab => (
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
                                {tab === 'transcripts' ? `Conversations (${iterDetail.transcripts.length})` : tab.charAt(0).toUpperCase() + tab.slice(1)}
                              </button>
                            ))}
                          </div>

                          <div style={{ padding: 20 }}>
                            {/* PROMPT tab */}
                            {activeTab === 'prompt' && (
                              <div>
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
                                    <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>System Prompt</div>
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
                                    { label: 'Overall Score', value: `${(iterDetail.analysis.overallScore * 100).toFixed(1)}%`, color: iterDetail.analysis.overallScore >= 0.75 ? '#059669' : '#d97706' },
                                    { label: 'Pass Rate',     value: `${(iterDetail.analysis.passRate * 100).toFixed(1)}%`,    color: iterDetail.analysis.passRate >= 0.75 ? '#059669' : '#d97706' },
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
                                    {iterDetail.analysis.scenarios.map(sc => (
                                      <div key={sc.scenarioId} style={{ background: '#fff', border: `1px solid ${sc.passed ? '#a7f3d0' : '#fecaca'}`, borderRadius: 10, padding: '10px 14px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: sc.issues.length ? 8 : 0 }}>
                                          <span style={{ fontSize: 13, padding: '2px 8px', borderRadius: 20, background: sc.passed ? '#d1fae5' : '#fee2e2', color: sc.passed ? '#065f46' : '#991b1b', fontWeight: 700 }}>
                                            {sc.passed ? '✓' : '✕'} {sc.scenarioId}
                                          </span>
                                        </div>
                                        {sc.issues.map((iss, j) => {
                                          const ss = SEV_STYLE[iss.severity] ?? SEV_STYLE.low;
                                          return (
                                            <div key={j} style={{ marginTop: 6, padding: '8px 10px', background: ss.bg, border: `1px solid ${ss.border}`, borderRadius: 8 }}>
                                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                                                <span style={{ fontSize: 10, fontWeight: 800, color: ss.color, background: ss.border, padding: '1px 7px', borderRadius: 20 }}>{iss.severity.toUpperCase()}</span>
                                                <span style={{ fontSize: 11, fontWeight: 700, color: ss.color }}>{iss.category}</span>
                                              </div>
                                              <p style={{ fontSize: 11, color: '#374151', margin: '0 0 3px' }}>{iss.description}</p>
                                              <p style={{ fontSize: 11, color: '#6b7280', margin: 0, fontStyle: 'italic' }}>→ {iss.suggestion}</p>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    ))}
                                  </div>
                                </div>

                                {/* General suggestions */}
                                {iterDetail.analysis.generalSuggestions?.length > 0 && (
                                  <div>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>General Suggestions</div>
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

                            {/* TRANSCRIPTS tab */}
                            {activeTab === 'transcripts' && (
                              <div>
                                {iterDetail.transcripts.length === 0 ? (
                                  <p style={{ color: '#9ca3af', fontSize: 13 }}>No transcripts available</p>
                                ) : (
                                  iterDetail.transcripts.map(tr => {
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
                                    return (
                                      <div key={tr.scenarioId} style={{ marginBottom: 12, border: `1px solid ${tr.driverMode ? '#a5f3fc' : '#e5e7eb'}`, borderRadius: 12, overflow: 'hidden' }}>
                                        {/* Scenario header */}
                                        <div
                                          onClick={() => setOpenChat(open ? null : tr.scenarioId)}
                                          style={{ padding: '12px 16px', background: open ? (tr.driverMode ? '#ecfeff' : '#eef2ff') : '#fafafa', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}
                                        >
                                          <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, flexWrap: 'wrap' }}>
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
