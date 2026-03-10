'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

const MODELS = [
  'gpt-5.4',
  'gpt-5.3',
  'gpt-5.3-thinking',
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5',
  'gpt-4o',
  'gpt-4o-mini',
  'o3',
  'o3-mini',
  'o1',
  'gpt-4-turbo',
  'gpt-4',
];

interface Config {
  id: string; name: string;
  models: { generate: string; test: string; testDriver: string; analyze: string; refine: string };
  temperatures: { generate: number; test: number; testDriver: number; analyze: number; refine: number };
  maxIterations: number;
  stopConditions: { minPassRate: number; consecutiveSuccesses: number; minImprovement: number; maxHighSeverityIssues: number; minIterations?: number; minQualityScore?: number };
  validation: { rulesEnabled: boolean; llmEnabled: boolean; rulesPath: string };
  testing: { testTemperature: number; stressMode: boolean; parallelScenarios: boolean; conversationTimeout: number; scenariosCount?: number; turnsPerScenario?: { min: number; max: number }; maxTurnsDriverMode: number; driverContextWindowExchanges: number };
  costs: { budgetPerRun: number; warnThreshold: number };
  promptBank: string;
  instructions: { generate: string; analyze: string; refine: string; testDriver: string };
}

const PHASES = [
  { key: 'generate' as const, label: 'Generate', icon: '✨', desc: 'Creates Bot Under Test system prompt + Dialogue Blueprint for AI Test Driver', gradient: 'linear-gradient(135deg,#6366f1,#818cf8)', shadow: 'rgba(99,102,241,.3)', accentBg: '#eef2ff', accentBorder: '#c7d2fe', accentText: '#4338ca', placeholder: 'Placeholders: {{scenariosCount}}, {{turnsMin}}, {{turnsMax}}' },
  { key: 'analyze' as const,  label: 'Analyze',  icon: '🔍', desc: 'Scores transcripts and identifies issues',    gradient: 'linear-gradient(135deg,#8b5cf6,#7c3aed)', shadow: 'rgba(139,92,246,.3)', accentBg: '#f5f3ff', accentBorder: '#ddd6fe', accentText: '#6d28d9', placeholder: null },
  { key: 'refine' as const,   label: 'Refine',   icon: '⚡', desc: 'Improves prompt based on analysis results',   gradient: 'linear-gradient(135deg,#10b981,#059669)', shadow: 'rgba(16,185,129,.3)', accentBg: '#ecfdf5', accentBorder: '#a7f3d0', accentText: '#065f46', placeholder: null },
];

const MODEL_LABELS: Record<string, string> = {
  'gpt-5.4':          'GPT-5.4 ✦ (most capable)',
  'gpt-5.3':          'GPT-5.3',
  'gpt-5.3-thinking': 'GPT-5.3 Thinking',
  'gpt-5.2':          'GPT-5.2',
  'gpt-5.1':          'GPT-5.1',
  'gpt-5':            'GPT-5',
  'gpt-4o':           'GPT-4o ★',
  'gpt-4o-mini':      'GPT-4o mini',
  'o3':               'o3 (reasoning)',
  'o3-mini':          'o3-mini (reasoning)',
  'o1':               'o1 (reasoning)',
  'gpt-4-turbo':      'GPT-4 Turbo',
  'gpt-4':            'GPT-4',
};

export default function OrchestratorEditPage() {
  const { id } = useParams() as { id: string };
  const [config, setConfig]         = useState<Config | null>(null);
  const [draft, setDraft]           = useState<Config | null>(null);
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [error, setError]           = useState<string | null>(null);
  const originalRef                 = useRef('');

  // Guidelines state
  type Guideline = { filename: string; content: string };
  const [guidelines, setGuidelines]         = useState<Guideline[]>([]);
  const [glLoading, setGlLoading]           = useState(true);
  const [newGlName, setNewGlName]           = useState('');
  const [newGlContent, setNewGlContent]     = useState('');
  const [editingGl, setEditingGl]           = useState<string | null>(null);
  const [editingGlContent, setEditingGlContent] = useState('');
  const [glSaving, setGlSaving]             = useState(false);

  const loadGuidelines = useCallback(async () => {
    setGlLoading(true);
    try {
      const r = await fetch(`/api/orchestrators/${id}/guidelines`);
      if (r.ok) { const d = await r.json(); setGuidelines(d.guidelines || []); }
    } finally { setGlLoading(false); }
  }, [id]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/orchestrators/${id}`);
        if (!r.ok) throw new Error(await r.text());
        const d: Config = await r.json();
        setConfig(d); setDraft(JSON.parse(JSON.stringify(d)));
        originalRef.current = JSON.stringify(d);
      } catch (e: any) { setError(e.message); }
      finally { setLoading(false); }
    })();
    loadGuidelines();
  }, [id, loadGuidelines]);

  const saveGuideline = async (filename: string, content: string) => {
    setGlSaving(true);
    try {
      const r = await fetch(`/api/orchestrators/${id}/guidelines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
      await loadGuidelines();
    } catch (e: any) { alert(e.message); }
    finally { setGlSaving(false); }
  };

  const deleteGuideline = async (filename: string) => {
    if (!confirm(`Delete "${filename}"?`)) return;
    await fetch(`/api/orchestrators/${id}/guidelines/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    await loadGuidelines();
  };

  const isDirty = draft ? JSON.stringify(draft) !== originalRef.current : false;

  const set_ = (path: string[], val: any) => {
    setDraft(d => {
      if (!d) return d;
      const n = JSON.parse(JSON.stringify(d));
      let cur: any = n;
      for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
      cur[path[path.length - 1]] = val;
      return n;
    });
    setSaveStatus('idle');
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true); setSaveStatus('idle');
    try {
      const r = await fetch(`/api/orchestrators/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
      originalRef.current = JSON.stringify(draft);
      setConfig(JSON.parse(JSON.stringify(draft)));
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 3500);
    } catch (e: any) { setSaveStatus('error'); alert(e.message); }
    finally { setSaving(false); }
  };

  if (loading) return (
    <div style={{ maxWidth: 860, margin: '40px auto', padding: '0 20px' }}>
      {[1,2,3].map(i => <div key={i} className="shimmer" style={{ height: 220, marginBottom: 20 }} />)}
    </div>
  );

  if (error || !draft) return (
    <div style={{ maxWidth: 860, margin: '80px auto', padding: '0 20px', textAlign: 'center' }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>😕</div>
      <p style={{ color: '#dc2626', marginBottom: 16 }}>{error || 'Not found'}</p>
      <Link href="/orchestrators" className="btn-secondary" style={{ textDecoration: 'none' }}>← Back</Link>
    </div>
  );

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '28px 20px 120px' }}>

      {/* Breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, fontSize: 12, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        <Link href="/" style={{ color: '#818cf8', textDecoration: 'none' }}>Runs</Link>
        <span style={{ color: '#d1d5db' }}>/</span>
        <Link href="/orchestrators" style={{ color: '#818cf8', textDecoration: 'none' }}>Orchestrators</Link>
        <span style={{ color: '#d1d5db' }}>/</span>
        <span style={{ color: '#374151', textTransform: 'none', letterSpacing: 'normal' }}>{draft.name}</span>
      </div>

      {/* Title */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: '#111827', margin: '0 0 6px', letterSpacing: '-0.02em' }}>{draft.name}</h1>
          <code style={{ fontSize: 11, color: '#6366f1', background: '#eef2ff', border: '1px solid #c7d2fe', padding: '2px 8px', borderRadius: 6 }}>{draft.id}</code>
        </div>
        {isDirty && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 20, padding: '6px 14px' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#f59e0b', display: 'block' }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: '#92400e' }}>Unsaved changes</span>
          </div>
        )}
      </div>

      {/* ── Test Model card ── */}
      <div className="card" style={{ overflow: 'hidden', marginBottom: 20 }}>
        <div style={{
          padding: '16px 20px',
          background: 'linear-gradient(135deg, #fff7ed, #fff)',
          borderBottom: '1px solid #fed7aa',
          display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 16,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: 'linear-gradient(135deg,#f97316,#ea580c)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, boxShadow: '0 3px 10px rgba(249,115,22,.3)', flexShrink: 0 }}>
              🤖
            </div>
            <div>
              <div style={{ fontWeight: 800, fontSize: 14, color: '#9a3412' }}>Bot Under Test <span style={{ fontWeight: 500, fontSize: 12, color: '#9ca3af' }}>(assistant)</span></div>
              <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                Loaded with the system prompt — plays the defined role as the <strong style={{ color: '#c2410c' }}>assistant</strong> in every conversation
              </div>
            </div>
          </div>

          {/* Test Model */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Model</span>
            <select
              value={draft.models.test}
              onChange={e => set_(['models', 'test'], e.target.value)}
              className="input"
              style={{ width: 'auto', padding: '6px 28px 6px 10px', fontSize: 12, fontWeight: 600 }}
            >
              {MODELS.map(m => <option key={m} value={m}>{MODEL_LABELS[m] ?? m}</option>)}
            </select>
          </div>

          {/* Test Temperature (models.temperatures.test) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Temp</span>
            <input
              type="number" min={0} max={2} step={0.05}
              value={draft.temperatures.test}
              onChange={e => set_(['temperatures', 'test'], parseFloat(e.target.value) || 0)}
              className="input"
              style={{ width: 70, padding: '6px 8px', fontSize: 12, fontWeight: 700, textAlign: 'center' }}
            />
          </div>
        </div>

        {/* Extra: testing.testTemperature */}
        <div style={{ padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 16, background: '#fffaf7' }}>
          <div style={{ flex: 1, fontSize: 12, color: '#78350f' }}>
            <strong>Stress mode temperature</strong> — used when stress mode is enabled (higher temp for robustness testing)
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Stress Temp</span>
            <input
              type="number" min={0} max={2} step={0.05}
              value={draft.testing.testTemperature}
              onChange={e => set_(['testing', 'testTemperature'], parseFloat(e.target.value) || 0)}
              className="input"
              style={{ width: 70, padding: '6px 8px', fontSize: 12, fontWeight: 700, textAlign: 'center' }}
            />
          </div>
        </div>
      </div>

      {/* ── Test Driver card ── */}
      <div className="card" style={{ overflow: 'hidden', marginBottom: 20 }}>
        <div style={{
          padding: '16px 20px',
          background: 'linear-gradient(135deg, #ecfeff, #fff)',
          borderBottom: '1px solid #a5f3fc',
          display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 16,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: 'linear-gradient(135deg,#06b6d4,#0891b2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, boxShadow: '0 3px 10px rgba(6,182,212,.3)', flexShrink: 0 }}>
              🎭
            </div>
            <div>
              <div style={{ fontWeight: 800, fontSize: 14, color: '#164e63' }}>AI Test Driver <span style={{ fontWeight: 500, fontSize: 12, color: '#9ca3af' }}>(user side)</span></div>
              <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                Simulates the user-side role — selects contextually from the Dialogue Blueprint, may rephrase, never repeats
              </div>
            </div>
          </div>

          {/* Driver Model */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Model</span>
            <select
              value={draft.models.testDriver}
              onChange={e => set_(['models', 'testDriver'], e.target.value)}
              className="input"
              style={{ width: 'auto', padding: '6px 28px 6px 10px', fontSize: 12, fontWeight: 600 }}
            >
              {MODELS.map(m => <option key={m} value={m}>{MODEL_LABELS[m] ?? m}</option>)}
            </select>
          </div>

          {/* Driver Temperature */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Temp</span>
            <input
              type="number" min={0} max={2} step={0.05}
              value={draft.temperatures.testDriver}
              onChange={e => set_(['temperatures', 'testDriver'], parseFloat(e.target.value) || 0)}
              className="input"
              style={{ width: 70, padding: '6px 8px', fontSize: 12, fontWeight: 700, textAlign: 'center' }}
            />
          </div>
        </div>

        {/* Driver settings row */}
        <div style={{ padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 24, background: '#f0fdff', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#0e7490', fontWeight: 600 }}>Max turns</span>
            <input
              type="number" min={5} max={50} step={1}
              value={draft.testing.maxTurnsDriverMode}
              onChange={e => set_(['testing', 'maxTurnsDriverMode'], parseInt(e.target.value) || 20)}
              className="input"
              style={{ width: 70, padding: '5px 8px', fontSize: 12, fontWeight: 700, textAlign: 'center' }}
            />
            <span style={{ fontSize: 11, color: '#9ca3af' }}>user turns per scenario (AC5)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#0e7490', fontWeight: 600 }}>Context window</span>
            <input
              type="number" min={1} max={5} step={1}
              value={draft.testing.driverContextWindowExchanges}
              onChange={e => set_(['testing', 'driverContextWindowExchanges'], parseInt(e.target.value) || 2)}
              className="input"
              style={{ width: 60, padding: '5px 8px', fontSize: 12, fontWeight: 700, textAlign: 'center' }}
            />
            <span style={{ fontSize: 11, color: '#9ca3af' }}>last exchanges sent to driver</span>
          </div>
          <div style={{ fontSize: 11, color: '#0891b2', marginLeft: 'auto', background: '#cffafe', padding: '4px 10px', borderRadius: 8, border: '1px solid #a5f3fc', fontWeight: 600 }}>
            Stress mode → temp 0.85
          </div>
        </div>

        {/* Driver instruction textarea */}
        <div style={{ padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#ecfeff', border: '1px solid #a5f3fc', borderRadius: 8, padding: '8px 12px', marginBottom: 10 }}>
            <svg width="12" height="12" viewBox="0 0 20 20" fill="#0891b2" opacity=".8"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd"/></svg>
            <span style={{ fontSize: 11, color: '#0e7490', fontWeight: 600 }}>
              Driver receives: <code style={{ background: '#cffafe', padding: '1px 4px', borderRadius: 3 }}>driverRole</code> · <code style={{ background: '#cffafe', padding: '1px 4px', borderRadius: 3 }}>situation</code> · <code style={{ background: '#cffafe', padding: '1px 4px', borderRadius: 3 }}>goal</code> · <code style={{ background: '#cffafe', padding: '1px 4px', borderRadius: 3 }}>availableUtterances[]</code> · <code style={{ background: '#cffafe', padding: '1px 4px', borderRadius: 3 }}>lastBotReply</code> · <code style={{ background: '#cffafe', padding: '1px 4px', borderRadius: 3 }}>recentConversation</code> · <code style={{ background: '#cffafe', padding: '1px 4px', borderRadius: 3 }}>userTurnNumber</code> · <code style={{ background: '#cffafe', padding: '1px 4px', borderRadius: 3 }}>remainingTurns</code>
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#fefce8', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
            <span style={{ fontSize: 11, color: '#92400e', fontWeight: 600 }}>
              Must return JSON: <code style={{ background: '#fef3c7', padding: '1px 5px', borderRadius: 3 }}>{`{ "message": "...", "stop": false, "utteranceId": "utt_03", "rephrased": true }`}</code>
              &nbsp;or&nbsp;
              <code style={{ background: '#fef3c7', padding: '1px 5px', borderRadius: 3 }}>{`{ "stop": true, "stopReason": "goal_achieved" }`}</code>
            </span>
          </div>
          <textarea
            value={draft.instructions.testDriver}
            onChange={e => set_(['instructions', 'testDriver'], e.target.value)}
            rows={12}
            className="input"
            spellCheck={false}
            style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.7 }}
          />
        </div>
      </div>

      {/* ── Stop Conditions card ── */}
      <div className="card" style={{ overflow: 'hidden', marginBottom: 20 }}>
        <div style={{ padding: '16px 20px', background: 'linear-gradient(135deg,#fdf4ff,#fff)', borderBottom: '1px solid #e9d5ff', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: 12, background: 'linear-gradient(135deg,#a855f7,#7c3aed)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, boxShadow: '0 3px 10px rgba(168,85,247,.3)', flexShrink: 0 }}>
            🎯
          </div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 14, color: '#6b21a8' }}>Stop Conditions</div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>When to stop the refinement loop automatically</div>
          </div>
        </div>
        <div style={{ padding: '16px 20px', display: 'flex', flexWrap: 'wrap', gap: 20 }}>
          {/* Max iterations */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Max Iterations</span>
            <input type="number" min={1} max={30} step={1}
              value={draft.maxIterations}
              onChange={e => set_(['maxIterations'], parseInt(e.target.value) || 5)}
              className="input" style={{ width: 80, padding: '6px 8px', fontSize: 13, fontWeight: 700, textAlign: 'center' }}
            />
            <span style={{ fontSize: 10, color: '#9ca3af' }}>hard limit</span>
          </div>
          {/* Min iterations */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Min Iterations</span>
            <input type="number" min={1} max={20} step={1}
              value={draft.stopConditions.minIterations ?? 3}
              onChange={e => set_(['stopConditions', 'minIterations'], parseInt(e.target.value) || 3)}
              className="input" style={{ width: 80, padding: '6px 8px', fontSize: 13, fontWeight: 700, textAlign: 'center' }}
            />
            <span style={{ fontSize: 10, color: '#9ca3af' }}>never stop before</span>
          </div>
          {/* Min quality score */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Min Quality %</span>
            <input type="number" min={50} max={100} step={1}
              value={Math.round((draft.stopConditions.minQualityScore ?? 0.90) * 100)}
              onChange={e => set_(['stopConditions', 'minQualityScore'], (parseInt(e.target.value) || 90) / 100)}
              className="input" style={{ width: 80, padding: '6px 8px', fontSize: 13, fontWeight: 700, textAlign: 'center' }}
            />
            <span style={{ fontSize: 10, color: '#9ca3af' }}>analyzer score threshold</span>
          </div>
        </div>
        <div style={{ padding: '10px 20px 14px', background: '#faf5ff', borderTop: '1px solid #e9d5ff' }}>
          <span style={{ fontSize: 11, color: '#7c3aed', fontWeight: 600 }}>
            Stop ONLY when: iterations ≥ Min AND quality ≥ Min Quality % AND zero high/medium issues reported by analyzer
          </span>
        </div>
      </div>

      {/* Instruction cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {PHASES.map(p => (
          <div key={p.key} className="card" style={{ overflow: 'hidden' }}>
            {/* Card header */}
            <div style={{
              padding: '16px 20px',
              background: `linear-gradient(135deg, ${p.accentBg}, #fff)`,
              borderBottom: `1px solid ${p.accentBorder}`,
              display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 16,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
                <div style={{ width: 40, height: 40, borderRadius: 12, background: p.gradient, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, boxShadow: `0 3px 10px ${p.shadow}`, flexShrink: 0 }}>
                  {p.icon}
                </div>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 14, color: p.accentText }}>{p.label}</div>
                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{p.desc}</div>
                </div>
              </div>

              {/* Model */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Model</span>
                <select
                  value={draft.models[p.key]}
                  onChange={e => set_(['models', p.key], e.target.value)}
                  className="input"
                  style={{ width: 'auto', padding: '6px 28px 6px 10px', fontSize: 12, fontWeight: 600 }}
                >
                  {MODELS.map(m => <option key={m} value={m}>{MODEL_LABELS[m] ?? m}</option>)}
                </select>
              </div>

              {/* Temperature */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Temp</span>
                <input
                  type="number" min={0} max={2} step={0.05}
                  value={draft.temperatures[p.key]}
                  onChange={e => set_(['temperatures', p.key], parseFloat(e.target.value) || 0)}
                  className="input"
                  style={{ width: 70, padding: '6px 8px', fontSize: 12, fontWeight: 700, textAlign: 'center' }}
                />
              </div>
            </div>

            {/* Textarea */}
            <div style={{ padding: 20 }}>
              {p.placeholder && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: p.accentBg, border: `1px solid ${p.accentBorder}`, borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>
                  <svg width="12" height="12" viewBox="0 0 20 20" fill={p.accentText} opacity=".7"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd"/></svg>
                  <span style={{ fontSize: 11, fontFamily: 'monospace', color: p.accentText, fontWeight: 600 }}>{p.placeholder}</span>
                </div>
              )}
              <textarea
                value={draft.instructions[p.key]}
                onChange={e => set_(['instructions', p.key], e.target.value)}
                rows={12}
                className="input"
                spellCheck={false}
                style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.7 }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* ── Guidelines Section ── */}
      <div className="card" style={{ overflow: 'hidden', marginBottom: 20 }}>
        <div style={{ padding: '16px 20px', background: 'linear-gradient(135deg,#f0fdf4,#fff)', borderBottom: '1px solid #a7f3d0', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: 12, background: 'linear-gradient(135deg,#059669,#047857)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, boxShadow: '0 3px 10px rgba(5,150,105,.3)', flexShrink: 0 }}>
            📚
          </div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 14, color: '#065f46' }}>Prompt Engineering Guidelines</div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
              Text files injected automatically into Generate and Refine agents for every run of this orchestrator
            </div>
          </div>
        </div>

        <div style={{ padding: 20 }}>
          {/* Existing guideline files */}
          {glLoading ? (
            <div className="shimmer" style={{ height: 60, borderRadius: 8 }} />
          ) : guidelines.length === 0 ? (
            <div style={{ padding: '20px', background: '#f9fafb', border: '1px dashed #d1d5db', borderRadius: 10, textAlign: 'center', color: '#9ca3af', fontSize: 13, marginBottom: 16 }}>
              No guidelines yet. Add your first guideline file below.
            </div>
          ) : (
            <div style={{ marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {guidelines.map((gl) => (
                <div key={gl.filename} style={{ border: '1px solid #a7f3d0', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ padding: '10px 14px', background: '#f0fdf4', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12 }}>📄</span>
                      <span style={{ fontWeight: 700, fontSize: 13, color: '#065f46', fontFamily: 'monospace' }}>{gl.filename}</span>
                      <span style={{ fontSize: 11, color: '#9ca3af' }}>{(gl.content.length / 1000).toFixed(1)}k chars</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => { setEditingGl(gl.filename); setEditingGlContent(gl.content); }}
                        style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 8, border: '1px solid #a7f3d0', background: '#ecfdf5', color: '#059669', cursor: 'pointer' }}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => deleteGuideline(gl.filename)}
                        style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 8, border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626', cursor: 'pointer' }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {editingGl === gl.filename && (
                    <div style={{ padding: 14, background: '#fff', borderTop: '1px solid #d1fae5' }}>
                      <textarea
                        value={editingGlContent}
                        onChange={e => setEditingGlContent(e.target.value)}
                        rows={16}
                        className="input"
                        spellCheck={false}
                        style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.7, marginBottom: 10 }}
                      />
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          onClick={async () => { await saveGuideline(gl.filename, editingGlContent); setEditingGl(null); }}
                          disabled={glSaving}
                          className="btn-primary"
                          style={{ fontSize: 12 }}
                        >
                          {glSaving ? 'Saving…' : 'Save'}
                        </button>
                        <button onClick={() => setEditingGl(null)} className="btn-ghost" style={{ fontSize: 12 }}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Add new guideline */}
          <div style={{ border: '1px dashed #6ee7b7', borderRadius: 10, padding: 16, background: '#f9fafb' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#065f46', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              + Add new guideline file
            </div>
            <input
              value={newGlName}
              onChange={e => setNewGlName(e.target.value)}
              placeholder="filename.txt  (e.g. prompt_engineering_guide.txt)"
              className="input"
              style={{ marginBottom: 10, fontFamily: 'monospace', fontSize: 12 }}
            />
            <textarea
              value={newGlContent}
              onChange={e => setNewGlContent(e.target.value)}
              rows={12}
              placeholder="Paste your guideline content here..."
              className="input"
              spellCheck={false}
              style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.7, marginBottom: 10 }}
            />
            <button
              onClick={async () => {
                if (!newGlName.trim() || !newGlContent.trim()) { alert('Filename and content are required'); return; }
                await saveGuideline(newGlName.trim(), newGlContent);
                setNewGlName(''); setNewGlContent('');
              }}
              disabled={glSaving || !newGlName.trim() || !newGlContent.trim()}
              className="btn-primary"
              style={{ fontSize: 12 }}
            >
              {glSaving ? 'Saving…' : 'Add Guideline'}
            </button>
          </div>
        </div>
      </div>

      {/* Sticky save bar */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 40,
        background: 'rgba(255,255,255,.95)',
        backdropFilter: 'blur(16px)',
        borderTop: '1px solid #e5e7eb',
        boxShadow: '0 -4px 24px rgba(0,0,0,.08)',
      }}>
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 13 }}>
            {saveStatus === 'saved' && <span style={{ color: '#059669', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
              <svg width="16" height="16" viewBox="0 0 20 20" fill="#059669"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
              Saved successfully
            </span>}
            {saveStatus === 'error' && <span style={{ color: '#dc2626', fontWeight: 700 }}>Save failed</span>}
            {saveStatus === 'idle' && isDirty && <span style={{ color: '#d97706', fontWeight: 600 }}>You have unsaved changes</span>}
            {saveStatus === 'idle' && !isDirty && <span style={{ color: '#9ca3af' }}>No unsaved changes</span>}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {isDirty && (
              <button onClick={() => { if (config) { setDraft(JSON.parse(JSON.stringify(config))); setSaveStatus('idle'); } }} className="btn-ghost">
                Discard
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={saving || !isDirty}
              className="btn-primary"
              style={{ minWidth: 140 }}
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
