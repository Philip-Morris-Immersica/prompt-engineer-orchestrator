'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface Orchestrator { id: string; name: string }

const ORCH_STYLES = [
  { gradient: 'linear-gradient(135deg, #6366f1, #8b5cf6)', shadow: '0 3px 12px rgba(99,102,241,.35)', icon: '⚡', accent: '#6366f1', accentLight: '#eef2ff', accentBorder: '#c7d2fe' },
  { gradient: 'linear-gradient(135deg, #8b5cf6, #7c3aed)', shadow: '0 3px 12px rgba(139,92,246,.35)', icon: '🔬', accent: '#7c3aed', accentLight: '#f5f3ff', accentBorder: '#ddd6fe' },
  { gradient: 'linear-gradient(135deg, #06b6d4, #0891b2)', shadow: '0 3px 12px rgba(6,182,212,.35)', icon: '🧠', accent: '#0891b2', accentLight: '#ecfeff', accentBorder: '#a5f3fc' },
  { gradient: 'linear-gradient(135deg, #10b981, #059669)', shadow: '0 3px 12px rgba(16,185,129,.35)', icon: '🎯', accent: '#059669', accentLight: '#d1fae5', accentBorder: '#a7f3d0' },
];

export default function OrchestratorsPage() {
  const [orchestrators, setOrchestrators] = useState<Orchestrator[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [cloneFrom, setCloneFrom] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const router = useRouter();

  const loadOrchestrators = () => {
    fetch('/api/orchestrators').then(r => r.json()).then(d => { setOrchestrators(d); setLoading(false); }).catch(() => setLoading(false));
  };

  useEffect(() => { loadOrchestrators(); }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true); setCreateError('');
    try {
      const r = await fetch('/api/orchestrators', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), cloneFrom: cloneFrom || undefined }),
      });
      const d = await r.json();
      if (!r.ok) { setCreateError(d.error || 'Failed'); setCreating(false); return; }
      setShowModal(false); setNewName(''); setCloneFrom('');
      loadOrchestrators();
      router.push(`/orchestrators/${d.id}/edit`);
    } catch { setCreateError('Network error'); } finally { setCreating(false); }
  };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '28px 20px' }}>

      {/* Breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, fontSize: 12, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        <Link href="/" style={{ color: '#818cf8', textDecoration: 'none' }}>Runs</Link>
        <span style={{ color: '#d1d5db' }}>/</span>
        <span style={{ color: '#374151' }}>Orchestrators</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: '#111827', marginBottom: 6, letterSpacing: '-0.02em' }}>Orchestrators</h1>
          <p style={{ color: '#6b7280', fontSize: 14, lineHeight: 1.5, margin: 0 }}>
            Control the Lead Agent instructions that drive the prompt refinement process.
          </p>
        </div>
        <button
          onClick={() => { setShowModal(true); setCreateError(''); }}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '10px 20px', borderRadius: 12, border: 'none', cursor: 'pointer',
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            color: 'white', fontSize: 13, fontWeight: 700, flexShrink: 0,
            boxShadow: '0 2px 10px rgba(99,102,241,.4)',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="white" strokeWidth="2.5" strokeLinecap="round"/>
          </svg>
          New Orchestrator
        </button>
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {[1, 2].map(i => <div key={i} className="shimmer" style={{ height: 100 }} />)}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {orchestrators.map((o, i) => {
            const s = ORCH_STYLES[i % ORCH_STYLES.length];
            return (
              <div key={o.id} className="card" style={{ padding: '20px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <div style={{
                    width: 52, height: 52, borderRadius: 14,
                    background: s.gradient,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 24, boxShadow: s.shadow, flexShrink: 0,
                  }}>
                    {s.icon}
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, color: '#111827', fontSize: 16, marginBottom: 4 }}>{o.name}</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 11, color: s.accent, background: s.accentLight, border: `1px solid ${s.accentBorder}`, padding: '2px 8px', borderRadius: 6, display: 'inline-block', fontWeight: 600 }}>
                      {o.id}
                    </div>
                  </div>
                </div>
                <Link href={`/orchestrators/${o.id}/edit`} style={{
                  textDecoration: 'none',
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  padding: '10px 18px', borderRadius: 10,
                  background: s.accentLight, border: `1.5px solid ${s.accentBorder}`,
                  color: s.accent, fontSize: 13, fontWeight: 700,
                  transition: 'all .15s', flexShrink: 0,
                }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" stroke={s.accent} strokeWidth="2.5" strokeLinecap="round"/>
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke={s.accent} strokeWidth="2.5" strokeLinecap="round"/>
                  </svg>
                  Edit Instructions
                </Link>
              </div>
            );
          })}
        </div>
      )}

      {/* Info panel */}
      <div style={{
        marginTop: 24, borderRadius: 16,
        background: 'linear-gradient(135deg, #eef2ff, #f5f3ff)',
        border: '1px solid #c7d2fe', padding: '20px 24px',
      }}>
        <div style={{ fontWeight: 700, color: '#4338ca', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>About Orchestrator Instructions</div>
        <p style={{ color: '#4338ca', fontSize: 13, lineHeight: 1.7, margin: 0, opacity: .85 }}>
          Each orchestrator has three core instruction sets — <strong>Generate</strong> (creates the initial prompt and test plan), <strong>Analyze</strong> (scores conversation transcripts and identifies issues), and <strong>Refine</strong> (improves the prompt based on analysis results). The quality of these instructions directly determines how effective and stable the refinement process is.
        </p>
      </div>

      {/* Create Orchestrator Modal */}
      {showModal && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }} onClick={e => { if (e.target === e.currentTarget) setShowModal(false); }}>
          <div style={{
            background: 'white', borderRadius: 20, padding: 32, width: '100%', maxWidth: 480,
            boxShadow: '0 20px 60px rgba(0,0,0,.2)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24 }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, boxShadow: '0 3px 10px rgba(99,102,241,.4)' }}>🆕</div>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16, color: '#111827' }}>New Orchestrator</div>
                <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>Clones settings & instructions from an existing one</div>
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label className="label">Name</label>
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                placeholder="e.g. Sales Coach Bot"
                className="input"
                autoFocus
                style={{ fontSize: 14 }}
              />
              {newName.trim() && (
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 5 }}>
                  ID: <span style={{ fontFamily: 'monospace', color: '#6366f1', fontWeight: 600 }}>
                    {newName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}
                  </span>
                </div>
              )}
            </div>

            <div style={{ marginBottom: 20 }}>
              <label className="label">Clone from</label>
              <select
                value={cloneFrom}
                onChange={e => setCloneFrom(e.target.value)}
                className="input"
                style={{ fontSize: 13 }}
              >
                {orchestrators.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 5 }}>All settings, models and instructions will be copied. You can edit them after creation.</div>
            </div>

            {createError && (
              <div style={{ marginBottom: 14, background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: '#991b1b', fontWeight: 600 }}>
                {createError}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
                style={{
                  flex: 1, padding: '11px 0', borderRadius: 12, border: 'none', cursor: creating || !newName.trim() ? 'not-allowed' : 'pointer',
                  background: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
                  color: 'white', fontSize: 13, fontWeight: 700,
                  opacity: !newName.trim() || creating ? 0.6 : 1,
                  boxShadow: '0 2px 8px rgba(99,102,241,.35)',
                }}
              >
                {creating ? 'Creating…' : 'Create & Edit'}
              </button>
              <button
                onClick={() => setShowModal(false)}
                style={{
                  padding: '11px 20px', borderRadius: 12, border: '1.5px solid #e5e7eb', cursor: 'pointer',
                  background: 'white', color: '#6b7280', fontSize: 13, fontWeight: 700,
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
