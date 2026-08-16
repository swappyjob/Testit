import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { useRequireRole } from '../auth.js';
import { DashboardBar, Msg } from '../components.jsx';
import { StatusPill, fmtWhen, STATUS } from '../teacher/SupportTickets.jsx';

const FILTERS = [['', 'All'], ['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved'], ['closed', 'Closed']];

export default function SupportDashboard() {
  const me = useRequireRole('support', '/support-login');
  const [filter, setFilter] = useState('');
  const [data, setData] = useState(null);
  const [openId, setOpenId] = useState(null);

  const load = () => api('/api/support/tickets' + (filter ? '?status=' + filter : '')).then(setData).catch(() => setData({ tickets: [], counts: {} }));
  useEffect(() => { if (me) load(); /* eslint-disable-next-line */ }, [me, filter]);

  if (!me) return null;

  return (
    <>
      <DashboardBar who={me.name + ' · Support'} />
      <div className="container">
        <div className="card">
          <h1>🛟 Support queue</h1>
          <p className="muted">Tickets raised by teachers across all organizations.</p>
          <div className="tabs" style={{ marginTop: 8 }}>
            {FILTERS.map(([val, label]) => (
              <button key={val} className={'tab' + (filter === val ? ' active' : '')} onClick={() => { setFilter(val); setOpenId(null); }}>
                {label}{data && val && data.counts[val] ? ` (${data.counts[val]})` : ''}
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          {data === null ? <p className="muted">Loading…</p> : data.tickets.length === 0 ? (
            <p className="muted">No {filter ? STATUS[filter]?.label.toLowerCase() : ''} tickets.</p>
          ) : (
            <table>
              <thead><tr><th>Subject</th><th>From</th><th>Priority</th><th>Status</th><th>Updated</th></tr></thead>
              <tbody>
                {data.tickets.map((t) => (
                  <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => setOpenId(t.id)}>
                    <td><b>{t.subject}</b> <span className="muted">· {t.category}</span></td>
                    <td>{t.teacherName}<div className="muted" style={{ fontSize: 12 }}>{t.orgName}</div></td>
                    <td>{t.priority === 'high' ? <span className="pill amber">high</span> : <span className="muted">{t.priority}</span>}</td>
                    <td><StatusPill status={t.status} /></td>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtWhen(t.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {openId && <TicketPanel id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </>
  );
}

function TicketPanel({ id, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [reply, setReply] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api('/api/support/tickets/' + id).then(setData).catch((e) => setMsg(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  async function send() {
    if (!reply.trim()) return;
    try { await api('/api/support/tickets/' + id + '/messages', 'POST', { body: reply }); setReply(''); await load(); onChanged(); }
    catch (e) { setMsg(e.message); }
  }
  async function setStatus(status) {
    try { await api('/api/support/tickets/' + id, 'PATCH', { status }); await load(); onChanged(); }
    catch (e) { setMsg(e.message); }
  }

  const t = data && data.ticket;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', justifyContent: 'flex-end', zIndex: 50 }} onClick={onClose}>
      <div style={{ width: 'min(560px, 100%)', background: 'var(--bg, #fff)', height: '100%', overflowY: 'auto', padding: 20, boxShadow: '-4px 0 20px rgba(0,0,0,.15)' }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <button className="btn ghost small" onClick={onClose}>✕ Close</button>
        </div>
        <Msg text={msg} />
        {!data ? <p className="muted">Loading…</p> : (
          <>
            <h2 style={{ marginBottom: 4 }}>{t.subject}</h2>
            <p className="muted" style={{ marginTop: 0 }}>{t.category} · {t.priority} priority · from <b>{t.teacherName}</b> ({t.teacherEmail}) · {t.orgName}</p>
            <div className="row" style={{ gap: 8, alignItems: 'center', margin: '10px 0' }}>
              <label style={{ margin: 0 }}>Status:</label>
              <select value={t.status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
                <option value="open">Open</option><option value="in_progress">In progress</option>
                <option value="resolved">Resolved</option><option value="closed">Closed</option>
              </select>
              <StatusPill status={t.status} />
            </div>
            <div style={{ margin: '12px 0' }}>
              {data.messages.map((m) => (
                <div key={m.id} style={{ display: 'flex', justifyContent: m.authorRole === 'support' ? 'flex-end' : 'flex-start', margin: '8px 0' }}>
                  <div style={{ maxWidth: '82%', padding: '8px 12px', borderRadius: 10, background: m.authorRole === 'support' ? '#eef2ff' : '#f1f5f9' }}>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 2 }}>{m.authorRole === 'support' ? '🛟 ' + (m.authorName || 'Support') : m.authorName} · {fmtWhen(m.at)}</div>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
              <textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply to the teacher…" style={{ flex: 1, minHeight: 70 }} />
              <button className="btn" onClick={send} disabled={!reply.trim()}>Send</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
