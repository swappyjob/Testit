import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useRequireRole } from '../auth.js';
import { DashboardBar, Modal, fmtDateTime } from '../components.jsx';

export default function StudentDashboard() {
  const user = useRequireRole('student', '/student-login');
  const [assignments, setAssignments] = useState(null);
  const [orgs, setOrgs] = useState(null);
  const [activeOrg, setActiveOrg] = useState(null); // 'all' | orgId(number) | null (not chosen yet)
  const [bookingFor, setBookingFor] = useState(null); // assignment whose slot is being booked

  const loadAssignments = () => api('/api/my-assignments').then((d) => setAssignments(d.assignments)).catch(() => setAssignments([]));
  useEffect(() => {
    if (!user) return;
    loadAssignments();
    api('/api/my-orgs').then((d) => setOrgs(d.orgs)).catch(() => setOrgs([]));
  }, [user]);

  // Ranks/percentiles keep shifting as other students finish over the next few
  // days, so refresh in the background: on a timer, and whenever the student
  // returns to the tab.
  useEffect(() => {
    if (!user) return;
    const id = setInterval(loadAssignments, 45000);
    const onFocus = () => { if (!document.hidden) loadAssignments(); };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onFocus); window.removeEventListener('focus', onFocus); };
  }, [user]);

  const storeKey = user ? 'testit-active-org-' + user.id : null;

  // Once orgs are known: single-org students skip straight in; multi-org students
  // restore a saved choice, or get the "choose organization" popup.
  useEffect(() => {
    if (!orgs || !storeKey) return;
    if (orgs.length <= 1) { setActiveOrg('all'); return; }
    const saved = localStorage.getItem(storeKey);
    if (saved === 'all') setActiveOrg('all');
    else if (orgs.some((o) => String(o.id) === saved)) setActiveOrg(Number(saved));
    // else: leave null so the chooser modal appears
  }, [orgs, storeKey]);

  function chooseOrg(v) {
    setActiveOrg(v);
    if (storeKey) localStorage.setItem(storeKey, String(v));
  }

  if (!user) return null;

  const multi = orgs && orgs.length > 1;
  const showChooser = multi && activeOrg === null;
  const perOrg = multi && activeOrg !== 'all' && activeOrg !== null;
  const visible = (assignments || []).filter((a) => (perOrg ? a.orgId === activeOrg : true));
  const activeName = perOrg ? (orgs.find((o) => o.id === activeOrg) || {}).name : null;
  // Overall standing across the tests the student has completed (live).
  const ranked = visible.filter((a) => a.submitted && a.percentile != null);
  const avgPct = ranked.length ? Math.round((ranked.reduce((s, a) => s + a.percentile, 0) / ranked.length) * 10) / 10 : null;
  const bestPct = ranked.length ? Math.max(...ranked.map((a) => a.percentile)) : null;

  return (
    <>
      <DashboardBar who={user.name + ' · Student'}>
        {multi && !showChooser && (
          <label className="row" style={{ gap: 6, alignItems: 'center', margin: 0 }}>
            <span className="muted" style={{ fontSize: 13 }}>Institute:</span>
            <select value={String(activeOrg)} onChange={(e) => chooseOrg(e.target.value === 'all' ? 'all' : Number(e.target.value))} style={{ width: 'auto' }}>
              <option value="all">All organizations</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
        )}
      </DashboardBar>
      <div className="container">
        <div className="card">
          <h1>My Tests</h1>
          <p className="muted">
            {perOrg
              ? <>Showing tests from <b>{activeName}</b>. Switch institute from the top bar to see the others.</>
              : 'Tests your teachers have assigned to you.'}
          </p>
        </div>
        {ranked.length > 0 && (
          <div className="card" style={{ background: 'linear-gradient(135deg, #eef2ff, #f5f3ff)' }}>
            <div className="row" style={{ gap: 28, flexWrap: 'wrap', alignItems: 'center' }}>
              <Stat big={avgPct} label="Average percentile" />
              <Stat big={bestPct} label="Best percentile" />
              <Stat big={ranked.length} label="Tests completed" />
            </div>
            <p className="muted" style={{ margin: '10px 0 0', fontSize: 12 }}>
              🔄 Your percentile &amp; rank update live as classmates finish — this page refreshes automatically.
            </p>
          </div>
        )}
        {assignments === null ? (
          <div className="card"><p className="muted">Loading…</p></div>
        ) : visible.length === 0 ? (
          <div className="card"><p className="muted">No tests {perOrg ? 'from this organization ' : ''}assigned yet. Check back later!</p></div>
        ) : (
          visible.map((a) => (
            <div className="list-item" key={a.assignmentId}>
              <div>
                <h3>{a.title} {!perOrg && a.orgName && <span className="pill brand" style={{ fontSize: 12, fontWeight: 600 }}>{a.orgName}</span>}</h3>
                <div className="muted" style={{ fontSize: 13 }}>
                  {a.description} {a.questionCount} question(s){a.dueDate ? ' · Due ' + fmtDateTime(a.dueDate) : ''}
                </div>
              </div>
              <div className="row">
                {a.submitted ? (
                  <>
                    {a.needsGrading
                      ? <span className="pill amber">submitted · awaiting grade</span>
                      : <span className="pill green">Score: {a.score} / {a.maxScore}</span>}
                    {a.percentile != null && (
                      <span className="pill" style={{ background: '#e0e7ff', color: '#3730a3', fontWeight: 600 }} title="Live — updates as more students finish">
                        📊 {a.percentile} %ile · Rank {a.rank}/{a.totalTakers}
                      </span>
                    )}
                    <Link className="btn secondary small" to={'/review?a=' + a.assignmentId}>Review answers</Link>
                  </>
                ) : a.closed ? (
                  <span className="pill gray">closed · deadline passed</span>
                ) : a.requiresSlot ? (
                  a.needsBooking ? (
                    <button className="btn small" onClick={() => setBookingFor(a)}>🗓 Choose your slot</button>
                  ) : a.slotMissed ? (
                    <div style={{ textAlign: 'right' }}>
                      <span className="pill amber">missed slot</span>
                      <div className="muted" style={{ fontSize: 12 }}>Ask your teacher to reschedule you.</div>
                    </div>
                  ) : a.slotUpcoming ? (
                    <div style={{ textAlign: 'right' }}>
                      <span className="pill brand">Slot: {fmtDateTime(a.slotAt)}</span>
                      <div className="muted" style={{ fontSize: 12 }}>Opens {fmtDateTime(a.slotOpenAt)}</div>
                      <button className="btn ghost small" style={{ marginTop: 4 }} onClick={() => setBookingFor(a)}>Change slot</button>
                    </div>
                  ) : (
                    <Link className="btn small" to={'/take-test?a=' + a.assignmentId}>{a.started ? 'Resume test' : 'Start test'}</Link>
                  )
                ) : a.notYetOpen ? (
                  <span className="pill gray">opens {fmtDateTime(a.startsAt)}</span>
                ) : (
                  <Link className="btn small" to={'/take-test?a=' + a.assignmentId}>{a.started ? 'Resume test' : 'Start test'}</Link>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {bookingFor && (
        <SlotBooking
          assignment={bookingFor}
          onClose={() => setBookingFor(null)}
          onBooked={() => { setBookingFor(null); loadAssignments(); }}
        />
      )}

      {showChooser && (
        <Modal title="Choose your institute" onClose={() => chooseOrg('all')}>
          <p className="muted">You're a member of more than one organization. Pick one to view its tests — you can switch anytime from the top bar.</p>
          <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
            {orgs.map((o) => (
              <button key={o.id} className="btn" onClick={() => chooseOrg(o.id)}>{o.name}</button>
            ))}
            <button className="btn ghost" onClick={() => chooseOrg('all')}>Show all organizations together</button>
          </div>
        </Modal>
      )}
    </>
  );
}

// A compact headline number + caption for the standing summary.
function Stat({ big, label }) {
  return (
    <div>
      <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1, color: '#3730a3' }}>{big}</div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{label}</div>
    </div>
  );
}

// Lets a student pick (or change) their time slot for a slot-scheduled test.
function SlotBooking({ assignment, onClose, onBooked }) {
  const [slots, setSlots] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = () => api('/api/my-assignments/' + assignment.assignmentId + '/slots')
    .then((d) => setSlots(d.slots)).catch((e) => setErr(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function book(slotId) {
    setBusy(true); setErr('');
    try {
      await api('/api/my-assignments/' + assignment.assignmentId + '/slot', 'POST', { slotId });
      onBooked();
    } catch (e) { setErr(e.message); setBusy(false); load(); }
  }

  return (
    <Modal title={'Choose your slot — ' + assignment.title} onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>
        Pick a time to sit this test. You can enter from 30&nbsp;min before your slot until 30&nbsp;min after it ends.
      </p>
      {err && <p className="pill amber" style={{ display: 'inline-block' }}>{err}</p>}
      {slots === null ? (
        <p className="muted">Loading…</p>
      ) : slots.length === 0 ? (
        <p className="muted">No slots are available. Please ask your teacher.</p>
      ) : (
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          {slots.map((s) => {
            const disabled = busy || s.past || s.full;
            const seats = s.capacity > 0 ? `${Math.max(0, s.capacity - s.booked)} seat(s) left` : 'Open seating';
            return (
              <button key={s.id} className={'btn' + (s.mine ? '' : ' secondary')} disabled={disabled && !s.mine}
                onClick={() => book(s.id)} style={{ justifyContent: 'space-between', textAlign: 'left', opacity: s.past ? 0.5 : 1 }}>
                <span>
                  <b>{fmtDateTime(s.slotAt)}</b>
                  <span className="muted" style={{ fontSize: 12, display: 'block' }}>
                    {s.past ? 'Passed' : s.full ? 'Full' : seats}{s.mine ? ' · your current slot' : ''}
                  </span>
                </span>
                {s.mine ? <span className="pill green">Booked</span> : !disabled && <span>Select →</span>}
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
