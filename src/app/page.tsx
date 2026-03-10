'use client';

import { useEffect, useState } from 'react';
import { FileUpload } from './components/FileUpload';
import Link from 'next/link';

interface Orchestrator { id: string; name: string }
interface Run {
  runId: string; orchestratorId: string; taskId: string; taskName?: string;
  status: 'running' | 'success' | 'max_iterations' | 'error' | 'stopped';
  startedAt: number; currentIteration: number; finalScore?: number;
}

const STATUS_MAP = {
  running:        { label: 'Running',    bg: '#dbeafe', color: '#1d4ed8', dot: '#3b82f6', pulse: true },
  success:        { label: 'Success',    bg: '#d1fae5', color: '#065f46', dot: '#10b981', pulse: false },
  max_iterations: { label: 'Max iters', bg: '#fef3c7', color: '#92400e', dot: '#f59e0b', pulse: false },
  stopped:        { label: 'Stopped',   bg: '#f3f4f6', color: '#374151', dot: '#6b7280', pulse: false },
  error:          { label: 'Error',      bg: '#fee2e2', color: '#991b1b', dot: '#ef4444', pulse: false },
};

export default function Home() {
  const [orchestrators, setOrchestrators] = useState<Orchestrator[]>([]);
  const [selected, setSelected]           = useState('');
  const [runTitle, setRunTitle]           = useState('');
  const [taskInput, setTaskInput]         = useState('');
  const [inputMode, setInputMode]         = useState<'text' | 'json'>('text');
  const [stressMode, setStressMode]       = useState(false);
  const [manualMode, setManualMode]       = useState(false);
  const [runs, setRuns]                   = useState<Run[]>([]);
  const [loading, setLoading]             = useState(false);
  const [uploadId, setUploadId]           = useState<string | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<string[]>([]);
  const [startedRunId, setStartedRunId]   = useState<string | null>(null);

  useEffect(() => {
    loadOrchestrators(); loadRuns();
    const iv = setInterval(loadRuns, 3000);
    return () => clearInterval(iv);
  }, []);

  const loadOrchestrators = async () => {
    try { const r = await fetch('/api/orchestrators'); if (r.ok) { const d = await r.json(); setOrchestrators(d); if (d.length) { const preferred = d.find((o: Orchestrator) => o.id === 'roleplay_chatbot_creator'); setSelected(preferred ? preferred.id : d[0].id); } } } catch {}
  };
  const loadRuns = async () => {
    try { const r = await fetch('/api/runs'); if (r.ok) setRuns(await r.json()); } catch {}
  };
  const handleStart = async () => {
    if (!selected || !taskInput.trim()) return;
    let payload: Record<string, unknown>;

    if (inputMode === 'json') {
      let task;
      try { task = JSON.parse(taskInput); } catch { alert('Invalid JSON'); return; }
      if (uploadId) task.uploadId = uploadId;
      if (runTitle.trim()) task.name = runTitle.trim();
      payload = { orchestratorId: selected, task, stressMode, manualMode };
    } else {
      payload = { orchestratorId: selected, taskMarkdown: taskInput, stressMode, manualMode };
      if (uploadId) payload.uploadId = uploadId;
      if (runTitle.trim()) payload.runTitle = runTitle.trim();
    }

    setLoading(true); setStartedRunId(null);
    try {
      const r = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (r.ok) { const d = await r.json(); setStartedRunId(d.runId); setTaskInput(''); setRunTitle(''); setUploadId(null); setUploadedFiles([]); loadRuns(); }
      else { const e = await r.json(); alert(`Failed: ${e.error}`); }
    } catch { alert('Failed to start'); } finally { setLoading(false); }
  };

  const stats = { total: runs.length, active: runs.filter(r => r.status === 'running').length, success: runs.filter(r => r.status === 'success').length };

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '28px 20px' }}>

      {/* ── Hero ── */}
      <div style={{
        background: 'linear-gradient(135deg, #4338ca 0%, #5b21b6 50%, #6d28d9 100%)',
        borderRadius: 20,
        padding: '32px 36px',
        marginBottom: 28,
        position: 'relative',
        overflow: 'hidden',
        boxShadow: '0 8px 40px rgba(79,70,229,.35), 0 2px 8px rgba(79,70,229,.2)',
      }}>
        {/* Decorative blobs */}
        <div style={{ position: 'absolute', top: -40, right: -40, width: 200, height: 200, borderRadius: '50%', background: 'rgba(255,255,255,.05)', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', bottom: -30, left: '40%', width: 160, height: 160, borderRadius: '50%', background: 'rgba(167,139,250,.2)', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', top: 20, right: '25%', width: 80, height: 80, borderRadius: '50%', background: 'rgba(255,255,255,.06)', pointerEvents: 'none' }} />

        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ color: '#c4b5fd', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>Automated AI</div>
          <h1 style={{ color: '#fff', fontSize: 26, fontWeight: 800, margin: '0 0 8px', letterSpacing: '-0.02em' }}>Prompt Refinement Engine</h1>
          <p style={{ color: 'rgba(196,181,253,.85)', fontSize: 14, margin: '0 0 24px', maxWidth: 500, lineHeight: 1.6 }}>
            Generate, test, and automatically refine chatbot system prompts through iterative AI-driven analysis.
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {[
              { label: 'Total Runs', value: stats.total },
              { label: 'Active',     value: stats.active,  green: true },
              { label: 'Successful', value: stats.success },
            ].map(s => (
              <div key={s.label} style={{
                background: 'rgba(255,255,255,.12)',
                backdropFilter: 'blur(8px)',
                border: '1px solid rgba(255,255,255,.2)',
                borderRadius: 12,
                padding: '10px 18px',
                display: 'flex', alignItems: 'center', gap: 12,
              }}>
                {s.green && stats.active > 0 && <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#34d399', display: 'block', boxShadow: '0 0 6px #34d399' }} />}
                <span style={{ color: 'rgba(255,255,255,.65)', fontSize: 12, fontWeight: 500 }}>{s.label}</span>
                <span style={{ color: '#fff', fontSize: 20, fontWeight: 800, lineHeight: 1 }}>{s.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Main grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 24, marginBottom: 24 }}>

        {/* ── New Run form ── */}
        <div className="card" style={{ overflow: 'hidden' }}>
          {/* Card header */}
          <div style={{
            padding: '18px 24px 18px',
            borderBottom: '1px solid rgba(99,102,241,.08)',
            background: 'linear-gradient(135deg, rgba(238,242,255,.6) 0%, rgba(245,243,255,.3) 100%)',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 2px 8px rgba(99,102,241,.35)',
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M12 5v14M5 12h14" stroke="white" strokeWidth="2.5" strokeLinecap="round"/>
              </svg>
            </div>
            <div>
              <div style={{ fontWeight: 700, color: '#111827', fontSize: 15 }}>New Refinement Run</div>
              <div style={{ color: '#6b7280', fontSize: 12, marginTop: 1 }}>Configure and launch a new optimization cycle</div>
            </div>
          </div>

          <div style={{ padding: 24 }}>
            {/* Orchestrator */}
            <div style={{ marginBottom: 20 }}>
              <label className="label">Orchestrator</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <select
                  value={selected}
                  onChange={e => setSelected(e.target.value)}
                  className="input"
                  style={{ flex: 1 }}
                >
                  {orchestrators.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
                {selected && (
                  <Link href={`/orchestrators/${selected}/edit`} className="btn-secondary" style={{ whiteSpace: 'nowrap', textDecoration: 'none' }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round"/>
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round"/>
                    </svg>
                    Edit
                  </Link>
                )}
              </div>
            </div>

            {/* Run title */}
            <div style={{ marginBottom: 20 }}>
              <label className="label">Run Name <span style={{ color: '#d1d5db', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
              <input
                type="text"
                value={runTitle}
                onChange={e => setRunTitle(e.target.value)}
                placeholder="e.g. Dermatologist v2 — with objection handling"
                className="input"
                style={{ fontSize: 13 }}
              />
            </div>

            {/* File upload */}
            <div style={{ marginBottom: 20 }}>
              <label className="label">Reference Materials <span style={{ color: '#d1d5db', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
              <FileUpload onUploadComplete={(id, files) => { setUploadId(id); setUploadedFiles(files); }} />
              {uploadedFiles.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, color: '#059669', fontSize: 12, fontWeight: 600 }}>
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="#059669"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
                  {uploadedFiles.length} file(s) attached as context
                </div>
              )}
            </div>

            {/* Task Definition */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <label className="label" style={{ margin: 0 }}>Task Definition</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {/* Mode toggle */}
                  <div style={{
                    display: 'inline-flex', borderRadius: 8, overflow: 'hidden',
                    border: '1.5px solid #e5e7eb', fontSize: 11, fontWeight: 700,
                  }}>
                    <button
                      onClick={() => { setInputMode('text'); setTaskInput(''); }}
                      style={{
                        padding: '4px 12px', border: 'none', cursor: 'pointer',
                        background: inputMode === 'text' ? '#6366f1' : '#fff',
                        color: inputMode === 'text' ? '#fff' : '#6b7280',
                        transition: 'all .15s',
                      }}
                    >Text</button>
                    <button
                      onClick={() => { setInputMode('json'); setTaskInput(''); }}
                      style={{
                        padding: '4px 12px', border: 'none', cursor: 'pointer',
                        borderLeft: '1.5px solid #e5e7eb',
                        background: inputMode === 'json' ? '#6366f1' : '#fff',
                        color: inputMode === 'json' ? '#fff' : '#6b7280',
                        transition: 'all .15s',
                      }}
                    >JSON</button>
                  </div>
                  {/* Load example */}
                  <button
                    onClick={() => {
                      if (inputMode === 'text') {
                        setTaskInput(`# Име на задачата\n\n## Какво правим\nОпиши накратко какъв бот правим и за какво ще се използва.\n\n## Герой\nКой е персонажът? Ако детайлите са във файловете — напиши "виж файловете".\n\n## Цел\nКаква е целта на симулацията? Какво упражнява потребителят?\n\n## Потребители\nКой ще използва бота?\n\n## Специфики\nПоведенчески детайли, контекст, динамика на разговора.\nТези отиват като описание към генератора.\n\n## Ограничения\n- Строго правило 1 (анализаторът ще следи за спазване)\n- Строго правило 2\n- Строго правило 3\n\n## Файлове\nОпиши какво съдържат качените файлове и как да се използват.\n\n## Тон\nКакъв е общият тон на персонажа?\n\n## Краен резултат\nКакви тест сценарии очакваш?\n\n## Други важни неща\nДопълнителни изисквания.`);
                      } else {
                        setTaskInput(`{\n  "id": "my_task",\n  "name": "My Bot",\n  "description": "Describe in detail what the bot should do, its role, tone, and constraints.",\n  "requirements": {\n    "role": "Describe the bot role here",\n    "constraints": ["Constraint 1", "Constraint 2"],\n    "tone": "professional"\n  },\n  "category": "assistant"\n}`);
                      }
                    }}
                    style={{ background: 'none', border: 'none', color: '#6366f1', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0 }}
                  >
                    Шаблон →
                  </button>
                </div>
              </div>
              <textarea
                value={taskInput}
                onChange={e => setTaskInput(e.target.value)}
                placeholder={inputMode === 'text'
                  ? '# Име на задачата\n\n## Какво правим\nОпиши какъв бот правим...\n\n## Герой\nКой е персонажът...\n\n## Цел\nКаква е целта...\n\n## Специфики\nПоведенчески детайли...\n\n## Ограничения\n- Строго правило 1\n- Строго правило 2\n\n## Тон\nОбщ тон на персонажа...'
                  : '{ "description": "Опиши задачата тук — задължително поле." }'}
                rows={inputMode === 'text' ? 14 : 7}
                className="input"
                style={{ resize: 'vertical', fontFamily: inputMode === 'json' ? 'monospace' : 'inherit', fontSize: 13, lineHeight: 1.6 }}
              />
              <div style={{ marginTop: 6, color: '#9ca3af', fontSize: 11 }}>
                {inputMode === 'text'
                  ? <>Задължителна е само <code style={{ background: '#f3f4f6', padding: '1px 6px', borderRadius: 4, fontFamily: 'monospace', color: '#6366f1' }}>## Какво правим</code>. <strong style={{ color: '#6b7280' }}>Специфики</strong> = описание за генератора. <strong style={{ color: '#6b7280' }}>Ограничения</strong> = строги правила за анализатора.</>
                  : <>Единственото задължително поле е <code style={{ background: '#f3f4f6', padding: '1px 6px', borderRadius: 4, fontFamily: 'monospace', color: '#6366f1' }}>"description"</code> — останалите са опционални.</>
                }
              </div>
            </div>

            {/* Mode toggles */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
              {/* Stress mode */}
              <div
                onClick={() => setStressMode(!stressMode)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 14,
                  padding: '12px 16px', borderRadius: 12,
                  border: `1.5px solid ${stressMode ? '#c7d2fe' : '#e5e7eb'}`,
                  background: stressMode ? 'rgba(238,242,255,.5)' : '#fafafa',
                  cursor: 'pointer', transition: 'all .15s', userSelect: 'none',
                }}
              >
                <div className={`toggle-track${stressMode ? ' on' : ''}`}><div className="toggle-thumb" /></div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: stressMode ? '#4338ca' : '#374151' }}>Stress Mode</div>
                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 1 }}>Test at high temperature (0.9) for extra robustness</div>
                </div>
              </div>

              {/* Manual step mode */}
              <div
                onClick={() => setManualMode(!manualMode)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 14,
                  padding: '12px 16px', borderRadius: 12,
                  border: `1.5px solid ${manualMode ? '#a5f3fc' : '#e5e7eb'}`,
                  background: manualMode ? 'rgba(236,254,255,.6)' : '#fafafa',
                  cursor: 'pointer', transition: 'all .15s', userSelect: 'none',
                }}
              >
                <div className={`toggle-track${manualMode ? ' on' : ''}`} style={{ '--on-color': '#06b6d4' } as any}><div className="toggle-thumb" /></div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: manualMode ? '#0e7490' : '#374151' }}>Manual (Step-by-step)</div>
                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 1 }}>Pause after each iteration — click Continue to proceed</div>
                </div>
              </div>
            </div>

            {/* Success banner */}
            {startedRunId && (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: '#d1fae5', border: '1px solid #6ee7b7',
                borderRadius: 12, padding: '12px 16px', marginBottom: 16,
              }}>
                <span style={{ color: '#065f46', fontSize: 13, fontWeight: 600 }}>
                  Run started —{' '}
                  <Link href={`/runs/${startedRunId}`} style={{ color: '#059669', textDecoration: 'underline' }}>view progress</Link>
                </span>
                <button onClick={() => setStartedRunId(null)} style={{ background: 'none', border: 'none', color: '#6ee7b7', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>
              </div>
            )}

            <button
              onClick={handleStart}
              disabled={loading || !selected || !taskInput.trim()}
              className="btn-primary"
              style={{ width: '100%', fontSize: 14 }}
            >
              {loading ? (
                <>
                  <svg style={{ animation: 'spin 1s linear infinite' }} width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,.3)" strokeWidth="3"/>
                    <path d="M12 2a10 10 0 0110 10" stroke="white" strokeWidth="3" strokeLinecap="round"/>
                  </svg>
                  Starting…
                </>
              ) : '▶  Start Run'}
            </button>
          </div>
        </div>

        {/* ── Right sidebar ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Stats card */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontWeight: 700, fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 16 }}>Overview</div>
            {[
              { label: 'Total runs',  val: stats.total,   color: '#111827' },
              { label: 'Running',     val: stats.active,  color: '#2563eb' },
              { label: 'Successful',  val: stats.success, color: '#059669' },
            ].map(row => (
              <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #f3f4f6' }}>
                <span style={{ fontSize: 13, color: '#6b7280' }}>{row.label}</span>
                <span style={{ fontSize: 20, fontWeight: 800, color: row.color }}>{row.val}</span>
              </div>
            ))}
          </div>

          {/* How it works */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontWeight: 700, fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 16 }}>How It Works</div>
            {[
              { n: 1, text: 'Upload reference materials', color: '#6366f1' },
              { n: 2, text: 'Define task — as free text or JSON', color: '#8b5cf6' },
              { n: 3, text: 'Engine generates initial prompt', color: '#7c3aed' },
              { n: 4, text: 'Tests with fixed conversation scenarios', color: '#6366f1' },
              { n: 5, text: 'Analyzes failures and refines prompt', color: '#8b5cf6' },
              { n: 6, text: 'Repeats until quality target is met', color: '#7c3aed' },
            ].map(step => (
              <div key={step.n} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
                <div style={{
                  width: 22, height: 22, borderRadius: 6, flexShrink: 0,
                  background: step.color, color: 'white',
                  fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: `0 2px 6px ${step.color}55`,
                }}>{step.n}</div>
                <span style={{ fontSize: 12, color: '#4b5563', lineHeight: 1.5, marginTop: 2 }}>{step.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Runs table ── */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{
          padding: '18px 24px',
          borderBottom: '1px solid rgba(99,102,241,.08)',
          background: 'linear-gradient(135deg, rgba(238,242,255,.5) 0%, rgba(245,243,255,.2) 100%)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: 'linear-gradient(135deg, #8b5cf6, #7c3aed)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 2px 8px rgba(139,92,246,.35)',
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" stroke="white" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#111827' }}>Recent Runs</div>
              <div style={{ color: '#9ca3af', fontSize: 12 }}>Auto-refreshes every 3 seconds</div>
            </div>
          </div>
          {stats.active > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#dbeafe', border: '1px solid #bfdbfe', borderRadius: 20, padding: '4px 12px' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#3b82f6', display: 'block', animation: 'pulse 2s infinite' }} />
              <span style={{ color: '#1d4ed8', fontSize: 11, fontWeight: 700 }}>{stats.active} active</span>
            </div>
          )}
        </div>

        {runs.length === 0 ? (
          <div style={{ padding: '64px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: 'linear-gradient(135deg, #eef2ff, #f5f3ff)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="#a78bfa" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div style={{ fontWeight: 700, color: '#374151', fontSize: 15 }}>No runs yet</div>
            <div style={{ color: '#9ca3af', fontSize: 13 }}>Start your first refinement run above</div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#fafafa', borderBottom: '1px solid #f0f0f0' }}>
                  {['Name / Run ID', 'Orchestrator', 'Status', 'Iteration', 'Score', 'Started'].map(h => (
                    <th key={h} style={{ padding: '10px 20px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((run, i) => {
                  const st = STATUS_MAP[run.status] ?? STATUS_MAP.error;
                  return (
                    <tr key={run.runId} className="table-row" style={{ borderBottom: i < runs.length - 1 ? '1px solid #f9fafb' : 'none' }}>
                      <td style={{ padding: '13px 20px' }}>
                        <Link href={`/runs/${run.runId}`} style={{ textDecoration: 'none' }}>
                          {run.taskName && (
                            <div style={{ fontWeight: 700, fontSize: 13, color: '#111827', marginBottom: 2 }}>{run.taskName}</div>
                          )}
                          <span style={{
                            fontFamily: 'monospace', fontSize: 11, color: '#6366f1',
                            fontWeight: 600,
                            background: '#eef2ff', padding: '2px 7px', borderRadius: 5,
                            border: '1px solid #c7d2fe',
                          }}>
                            {run.runId.substring(0, 16)}…
                          </span>
                        </Link>
                      </td>
                      <td style={{ padding: '13px 20px' }}>
                        <span style={{ fontSize: 12, color: '#374151', background: '#f3f4f6', padding: '3px 10px', borderRadius: 6, fontWeight: 600 }}>
                          {run.orchestratorId}
                        </span>
                      </td>
                      <td style={{ padding: '13px 20px' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: st.bg, color: st.color, padding: '3px 10px 3px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: st.dot, display: 'block', animation: st.pulse ? 'pulse 2s infinite' : 'none' }} />
                          {st.label}
                        </span>
                      </td>
                      <td style={{ padding: '13px 20px', fontSize: 13, fontWeight: 700, color: '#374151' }}>{run.currentIteration}</td>
                      <td style={{ padding: '13px 20px' }}>
                        {run.finalScore != null
                          ? <span style={{ fontWeight: 800, fontSize: 13, color: run.finalScore >= 0.75 ? '#059669' : '#d97706' }}>{(run.finalScore * 100).toFixed(1)}%</span>
                          : <span style={{ color: '#d1d5db' }}>—</span>}
                      </td>
                      <td style={{ padding: '13px 20px', fontSize: 12, color: '#9ca3af' }}>{new Date(run.startedAt).toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.5; } }
      `}</style>
    </div>
  );
}
