import { useState, useEffect } from 'react';
import { api } from '../api.js';

// Human-readable labels + a colored "chip" style for each action type.
const ACTION = {
  'test.create':    { label: 'Created test',      color: '#065f46', bg: '#d1fae5' },
  'test.update':    { label: 'Edited test',       color: '#92400e', bg: '#fef3c7' },
  'test.delete':    { label: 'Deleted test',      color: '#991b1b', bg: '#fee2e2' },
  'test.assign':    { label: 'Assigned test',     color: '#1e40af', bg: '#dbeafe' },
  'test.reopen_slot': { label: 'Reopened slot',   color: '#92400e', bg: '#fef3c7' },
  'student.create': { label: 'Added student',     color: '#065f46', bg: '#d1fae5' },
  'student.disable':{ label: 'Disabled student',  color: '#991b1b', bg: '#fee2e2' },
  'student.enable': { label: 'Enabled student',   color: '#065f46', bg: '#d1fae5' },
  'teacher.create': { label: 'Invited teacher',   color: '#065f46', bg: '#d1fae5' },
  'teacher.disable':{ label: 'Disabled teacher',  color: '#991b1b', bg: '#fee2e2' },
  'teacher.enable': { label: 'Enabled teacher',   color: '#065f46', bg: '#d1fae5' },
};
const ENTITY_ICON = { test: '📋', student: '👤', teacher: '🧑‍🏫' };

function fmt(at) {
  const d = new Date(at);
  if (isNaN(d)) return at;
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function AuditLogs() {
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api('/api/audit' + (q.trim() ? '?q=' + encodeURIComponent(q.trim()) : ''))
        .then((d) => { if (alive) setData(d); })
        .catch(() => { if (alive) setData({ logs: [] }); });
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h1 style={{ margin: 0 }}>📜 Audit Logs</h1>
        </div>
        <p className="muted">A record of every change across your organization — who did what, and when. Shared by all teachers for transparency.</p>
        <input type="text" placeholder="🔍 Search by person, action, or item..." value={q} onChange={(e) => setQ(e.target.value)} style={{ marginTop: 8 }} />
      </div>

      <div className="card">
        {data === null ? <p className="muted">Loading…</p> : data.logs.length === 0 ? (
          <p className="muted">No activity {q.trim() ? 'matches your search' : 'recorded yet'}.</p>
        ) : (
          <table>
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Item</th><th>Details</th></tr></thead>
            <tbody>
              {data.logs.map((l) => {
                const a = ACTION[l.action] || { label: l.action, color: '#334155', bg: '#e2e8f0' };
                return (
                  <tr key={l.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmt(l.at)}</td>
                    <td>{l.actor || <span className="muted">—</span>}</td>
                    <td>
                      <span style={{ background: a.bg, color: a.color, padding: '2px 8px', borderRadius: 12, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{a.label}</span>
                    </td>
                    <td>{l.entityLabel ? <>{ENTITY_ICON[l.entityType] || ''} {l.entityLabel}</> : <span className="muted">—</span>}</td>
                    <td className="muted">{l.details || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {data && data.logs.length >= 300 && (
          <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>Showing the 300 most recent entries. Use search to find older activity.</p>
        )}
      </div>
    </>
  );
}
