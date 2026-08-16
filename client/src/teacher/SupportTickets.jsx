import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { Msg } from '../components.jsx';

const CATEGORIES = ['Test builder', 'Assigning tests', 'Students', 'Navigation', 'Account / login', 'Billing', 'Other'];
export const STATUS = {
  open: { label: 'Open', cls: 'amber' },
  in_progress: { label: 'In progress', cls: 'brand' },
  resolved: { label: 'Resolved', cls: 'green' },
  closed: { label: 'Closed', cls: 'gray' },
};
export const fmtWhen = (s) => { const d = new Date(s); return isNaN(d) ? s : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
export const StatusPill = ({ status }) => <span className={'pill ' + (STATUS[status]?.cls || 'gray')}>{STATUS[status]?.label || status}</span>;

// Attach a screenshot (≤ 2 MB) to a ticket or reply. Uploads immediately and
// reports the stored URL via onChange.
export function ScreenshotAttach({ image, onChange }) {
  const [err, setErr] = useState('');
  async function pick(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setErr('Image must be 2 MB or smaller.'); return; }
    setErr('');
    try {
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read the file.')); r.readAsDataURL(file); });
      const { url } = await api('/api/ticket-upload', 'POST', { dataUrl });
      onChange(url);
    } catch (e) { setErr(e.message); }
  }
  return (
    <div>
      {image ? (
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <img src={image} alt="screenshot" style={{ maxHeight: 56, borderRadius: 6, border: '1px solid var(--line)' }} />
          <button type="button" className="btn ghost small" onClick={() => onChange('')}>Remove</button>
        </div>
      ) : (
        <label className="btn ghost small" style={{ cursor: 'pointer', display: 'inline-block' }}>
          📎 Attach screenshot
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: 'none' }} onChange={(e) => pick(e.target.files[0])} />
        </label>
      )}
      {err && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 4 }}>{err}</div>}
    </div>
  );
}

// A message bubble's optional screenshot (click to open full size).
export const MsgImage = ({ src }) => src ? (
  <a href={src} target="_blank" rel="noreferrer"><img src={src} alt="screenshot" style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 8, border: '1px solid var(--line)', marginTop: 6, display: 'block' }} /></a>
) : null;

export default function SupportTickets() {
  const [view, setView] = useState('list'); // 'list' | 'new' | <ticketId>
  const [tickets, setTickets] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = () => api('/api/tickets').then((d) => setTickets(d.tickets)).catch(() => setTickets([]));
  useEffect(() => { if (view === 'list') load(); }, [view]);

  if (view === 'new') return <NewTicket onDone={(text) => { setMsg({ ok: true, text }); setView('list'); }} onCancel={() => setView('list')} />;
  if (view !== 'list') return <TicketThread id={view} onBack={() => setView('list')} />;

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h1 style={{ margin: 0 }}>🎫 Support</h1>
          <button className="btn" onClick={() => setView('new')}>➕ Raise a ticket</button>
        </div>
        <p className="muted">Hitting a problem while building a test or using the app? Raise a ticket and our team will help.</p>
        {msg && <Msg text={msg.text} kind={msg.ok ? 'ok' : 'error'} />}
      </div>
      <div className="card">
        {tickets === null ? <p className="muted">Loading…</p> : tickets.length === 0 ? (
          <p className="muted">You haven't raised any tickets yet.</p>
        ) : (
          <table>
            <thead><tr><th>Subject</th><th>Category</th><th>Status</th><th>Updated</th></tr></thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => setView(t.id)}>
                  <td><b>{t.subject}</b>{t.messageCount > 1 && <span className="muted"> · {t.messageCount} messages</span>}</td>
                  <td>{t.category}</td>
                  <td><StatusPill status={t.status} /></td>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtWhen(t.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function NewTicket({ onDone, onCancel }) {
  const [form, setForm] = useState({ subject: '', category: 'Test builder', priority: 'normal', message: '', image: '' });
  const [msg, setMsg] = useState('');
  const up = (patch) => setForm((f) => ({ ...f, ...patch }));
  async function submit() {
    try { await api('/api/tickets', 'POST', form); onDone('Ticket raised — our team will get back to you here.'); }
    catch (e) { setMsg(e.message); }
  }
  return (
    <div className="card">
      <h1>Raise a support ticket</h1>
      <Msg text={msg} />
      <label>Subject</label>
      <input type="text" value={form.subject} onChange={(e) => up({ subject: e.target.value })} placeholder="e.g. Can't add an image to a question" />
      <div className="grid two" style={{ marginTop: 8 }}>
        <div><label>Category</label>
          <select value={form.category} onChange={(e) => up({ category: e.target.value })}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
        </div>
        <div><label>Priority</label>
          <select value={form.priority} onChange={(e) => up({ priority: e.target.value })}>
            <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option>
          </select>
        </div>
      </div>
      <label>Describe the issue</label>
      <textarea value={form.message} onChange={(e) => up({ message: e.target.value })} placeholder="What were you trying to do, and what happened? Steps to reproduce help us a lot." style={{ minHeight: 120 }} />
      <div style={{ marginTop: 8 }}>
        <label>Screenshot (optional, ≤ 2 MB)</label>
        <ScreenshotAttach image={form.image} onChange={(url) => up({ image: url })} />
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn" onClick={submit}>Submit ticket</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function TicketThread({ id, onBack }) {
  const [data, setData] = useState(null);
  const [reply, setReply] = useState('');
  const [replyImage, setReplyImage] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api('/api/tickets/' + id).then(setData).catch((e) => setMsg(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  async function send() {
    if (!reply.trim() && !replyImage) return;
    try { await api('/api/tickets/' + id + '/messages', 'POST', { body: reply, image: replyImage }); setReply(''); setReplyImage(''); load(); }
    catch (e) { setMsg(e.message); }
  }
  if (!data) return <div className="card"><button className="btn ghost small" onClick={onBack}>← Back</button><Msg text={msg} /></div>;
  const t = data.ticket;
  const closed = t.status === 'closed';
  return (
    <div className="card">
      <button className="btn ghost small" onClick={onBack}>← Back to tickets</button>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
        <h1 style={{ margin: 0 }}>{t.subject}</h1>
        <StatusPill status={t.status} />
      </div>
      <p className="muted">{t.category} · priority {t.priority}</p>
      <Msg text={msg} />
      <div style={{ margin: '12px 0' }}>
        {data.messages.map((m) => (
          <div key={m.id} style={{ display: 'flex', justifyContent: m.authorRole === 'support' ? 'flex-start' : 'flex-end', margin: '8px 0' }}>
            <div style={{ maxWidth: '78%', padding: '8px 12px', borderRadius: 10, background: m.authorRole === 'support' ? '#eef2ff' : '#f1f5f9' }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 2 }}>{m.authorRole === 'support' ? '🛟 ' + (m.authorName || 'Support') : m.authorName} · {fmtWhen(m.at)}</div>
              {m.body && <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>}
              <MsgImage src={m.image} />
            </div>
          </div>
        ))}
      </div>
      {closed ? (
        <p className="muted">This ticket is closed. Raise a new one if you still need help.</p>
      ) : (
        <>
          <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
            <textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write a reply…" style={{ flex: 1, minHeight: 60 }} />
            <button className="btn" onClick={send} disabled={!reply.trim() && !replyImage}>Send</button>
          </div>
          <div style={{ marginTop: 6 }}><ScreenshotAttach image={replyImage} onChange={setReplyImage} /></div>
        </>
      )}
    </div>
  );
}
