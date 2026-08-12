// Verifies the math + drawing feature end to end at the data layer:
// LaTeX typed into prompts/options is stored verbatim, and a PNG produced by the
// drawing pad uploads through /api/upload and attaches as the question image.
const BASE = process.env.TEST_BASE || 'http://localhost:3000';
function makeJar() {
  const jar = {};
  return {
    header: () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
    absorb: (res) => {
      for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const [pair] = c.split(';'); const i = pair.indexOf('=');
        jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      }
    },
  };
}
async function call(jar, path, method = 'GET', body, expectOk = true) {
  const headers = { cookie: jar.header() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body && JSON.stringify(body) });
  jar.absorb(res);
  let data = {}; try { data = await res.json(); } catch {}
  if (expectOk && !res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.error || 'error'}`);
  return { status: res.status, data };
}
const ok = (l) => console.log('  ✓ ' + l);
const rand = Math.floor(Math.random() * 1e6);
// A 1x1 transparent PNG — stands in for a canvas drawing export.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const teacher = makeJar();
await call(teacher, '/api/register-teacher', 'POST', { name: 'T', email: `t${rand}@x.com`, password: 'secret123' });

// A drawing uploads and returns a safe /uploads/ URL.
const { url } = (await call(teacher, '/api/upload', 'POST', { dataUrl: PNG })).data;
if (!/^\/uploads\/[\w.-]+\.png$/.test(url)) throw new Error('drawing upload should return an /uploads/*.png URL, got: ' + url);
ok('a drawn PNG uploads via /api/upload and returns an /uploads/ URL');

// Create a test whose prompt and options contain LaTeX, and whose question uses
// the drawn image.
const prompt = 'Evaluate $\\int_{0}^{1} x^2\\,dx$';
const optA = '$\\frac{1}{3}$', optB = '$x^3$';
const { id: testId } = (await call(teacher, '/api/tests', 'POST', {
  title: `Math ${rand}`,
  questions: [{ type: 'mcq', prompt, options: [optA, optB], correct: 0, points: 2, image: url }],
})).data;
ok('a test with LaTeX prompt/options and a drawn image is created');

// Fetch it back and confirm nothing was mangled.
const { questions } = (await call(teacher, '/api/tests/' + testId)).data;
const q = questions[0];
if (q.prompt !== prompt) throw new Error('LaTeX prompt was altered: ' + q.prompt);
if (q.options[0] !== optA || q.options[1] !== optB) throw new Error('LaTeX options were altered: ' + JSON.stringify(q.options));
if (q.image_url !== url) throw new Error('drawn image was not attached: ' + q.image_url);
ok('LaTeX in the prompt and options round-trips unchanged');
ok('the drawn image stays attached to the question');

// Uploads reject non-images (so the drawing pipeline can't be abused).
if ((await call(teacher, '/api/upload', 'POST', { dataUrl: 'data:text/plain;base64,aGVsbG8=' }, false)).status !== 400)
  throw new Error('non-image upload should be rejected with 400');
ok('non-image uploads are rejected (400)');

console.log('\n✅ MATHDRAW-TEST: ALL CHECKS PASSED\n');
