'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Orchestrator { id: string; name: string }

const ORCH_STYLES = [
  { gradient: 'linear-gradient(135deg, #6366f1, #8b5cf6)', shadow: '0 3px 12px rgba(99,102,241,.35)', icon: '⚡', accent: '#6366f1', accentLight: '#eef2ff', accentBorder: '#c7d2fe' },
  { gradient: 'linear-gradient(135deg, #8b5cf6, #7c3aed)', shadow: '0 3px 12px rgba(139,92,246,.35)', icon: '🔬', accent: '#7c3aed', accentLight: '#f5f3ff', accentBorder: '#ddd6fe' },
];

export default function OrchestratorsPage() {
  const [orchestrators, setOrchestrators] = useState<Orchestrator[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/orchestrators').then(r => r.json()).then(d => { setOrchestrators(d); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '28px 20px' }}>

      {/* Breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, fontSize: 12, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        <Link href="/" style={{ color: '#818cf8', textDecoration: 'none' }}>Runs</Link>
        <span style={{ color: '#d1d5db' }}>/</span>
        <span style={{ color: '#374151' }}>Orchestrators</span>
      </div>

      <h1 style={{ fontSize: 24, fontWeight: 800, color: '#111827', marginBottom: 6, letterSpacing: '-0.02em' }}>Orchestrators</h1>
      <p style={{ color: '#6b7280', fontSize: 14, marginBottom: 28, lineHeight: 1.5 }}>
        Control the Lead Agent instructions that drive the prompt refinement process.
      </p>

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
    </div>
  );
}
