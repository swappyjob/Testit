import { useRef, useState } from 'react';
import { Modal, Msg } from '../components.jsx';
import './ketcher-shim.js'; // MUST precede ketcher-react — installs the require() shim
import { Editor } from 'ketcher-react';
import { StandaloneStructServiceProvider } from 'ketcher-standalone';
import 'ketcher-react/dist/index.css';
import { api } from '../api.js';

// Indigo runs entirely in the browser (WASM) — no server round-trip needed.
const structServiceProvider = new StandaloneStructServiceProvider();

// A full chemistry structure editor (Ketcher). The teacher draws a molecule and
// it is rasterised to a PNG and attached as the question's diagram — reusing the
// same image pipeline as the freehand drawing pad, so students render it as-is.
export default function KetcherModal({ onClose, onInsert }) {
  const ketcherRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function insert() {
    const ketcher = ketcherRef.current;
    if (!ketcher) { setMsg('The editor is still loading — try again in a moment.'); return; }
    setBusy(true); setMsg('');
    try {
      const molfile = await ketcher.getMolfile();
      if (!molfile || !/^\s*\d+\s+\d+/m.test(molfile)) { setMsg('Draw a structure first.'); setBusy(false); return; }
      const blob = await ketcher.generateImage(molfile, { outputFormat: 'png', backgroundColor: '255, 255, 255' });
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
      const { url } = await api('/api/upload', 'POST', { dataUrl });
      onInsert(url);
    } catch (e) { setMsg(e.message || 'Could not export the structure.'); setBusy(false); }
  }

  return (
    <Modal title="🧪 Chemistry structure" onClose={onClose} wide>
      <p className="muted" style={{ marginTop: 0 }}>Draw a molecule — use the template palette for benzene rings, functional groups and common structures — then insert it as the question diagram.</p>
      <div style={{ height: 460, border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden', position: 'relative' }}>
        <Editor
          staticResourcesUrl=""
          structServiceProvider={structServiceProvider}
          errorHandler={(e) => setMsg(String(e?.message || e))}
          onInit={(ketcher) => { ketcherRef.current = ketcher; }}
        />
      </div>
      {msg && <Msg text={msg} />}
      <div className="row" style={{ marginTop: 12, gap: 10 }}>
        <button className="btn" onClick={insert} disabled={busy}>{busy ? 'Inserting…' : 'Insert structure'}</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
