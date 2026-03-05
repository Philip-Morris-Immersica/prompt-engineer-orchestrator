'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

export function Navbar() {
  const pathname = usePathname();
  const [activeRuns, setActiveRuns] = useState(0);

  useEffect(() => {
    const fetch_ = async () => {
      try {
        const r = await fetch('/api/runs');
        if (r.ok) { const d = await r.json(); setActiveRuns(d.filter((x: any) => x.status === 'running').length); }
      } catch {}
    };
    fetch_();
    const iv = setInterval(fetch_, 5000);
    return () => clearInterval(iv);
  }, []);

  const isActive = (href: string) => href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <nav style={{
      background: 'linear-gradient(135deg, #1e1b4b 0%, #2e2b77 50%, #3730a3 100%)',
      boxShadow: '0 4px 24px rgba(30,27,75,.4), 0 1px 0 rgba(255,255,255,.06) inset',
      position: 'sticky',
      top: 0,
      zIndex: 50,
    }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '0 20px', height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>

        {/* Logo */}
        <Link href="/" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 34, height: 34,
            background: 'linear-gradient(135deg, #818cf8 0%, #a78bfa 100%)',
            borderRadius: 10,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 2px 8px rgba(129,140,248,.5), inset 0 1px 0 rgba(255,255,255,.3)',
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M12 2L3 7l9 5 9-5-9-5z" fill="white"/>
              <path d="M3 12l9 5 9-5" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
              <path d="M3 17l9 5 9-5" stroke="white" strokeWidth="1.8" strokeLinecap="round" opacity=".6"/>
            </svg>
          </div>
          <div>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: 14, letterSpacing: '-0.01em', lineHeight: 1.2 }}>Prompt Engine</div>
            <div style={{ color: '#a5b4fc', fontSize: 10, fontWeight: 500, letterSpacing: '0.05em', lineHeight: 1.2 }}>AI ORCHESTRATOR</div>
          </div>
        </Link>

        {/* Nav links */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {[{ href: '/', label: 'Runs' }, { href: '/orchestrators', label: 'Orchestrators' }].map(({ href, label }) => {
            const active = isActive(href);
            return (
              <Link key={href} href={href} style={{
                textDecoration: 'none',
                padding: '7px 16px',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                color: active ? '#fff' : '#a5b4fc',
                background: active ? 'rgba(255,255,255,.15)' : 'transparent',
                border: active ? '1px solid rgba(255,255,255,.2)' : '1px solid transparent',
                transition: 'all .15s',
                letterSpacing: '0.01em',
              }}>
                {label}
              </Link>
            );
          })}
        </div>

        {/* Status */}
        <div>
          {activeRuns > 0 ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: 'rgba(16,185,129,.15)',
              border: '1px solid rgba(16,185,129,.3)',
              borderRadius: 20, padding: '5px 12px',
            }}>
              <span style={{ position: 'relative', display: 'inline-flex' }}>
                <span className="pulse-ring" style={{
                  position: 'absolute', inset: -2,
                  borderRadius: '50%', background: 'rgba(52,211,153,.5)',
                }} />
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#34d399', display: 'block', position: 'relative' }} />
              </span>
              <span style={{ color: '#6ee7b7', fontSize: 12, fontWeight: 700 }}>{activeRuns} running</span>
            </div>
          ) : (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 12px', borderRadius: 20,
              background: 'rgba(255,255,255,.06)',
              border: '1px solid rgba(255,255,255,.1)',
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#6366f1', opacity: .5, display: 'block' }} />
              <span style={{ color: '#818cf8', fontSize: 11, fontWeight: 600 }}>Idle</span>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
