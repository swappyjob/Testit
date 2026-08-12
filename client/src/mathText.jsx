import katex from 'katex';
import 'katex/dist/katex.min.css';

// Render a LaTeX string to KaTeX HTML. throwOnError:false makes a bad formula
// show up as red text rather than crashing the page.
function renderTeX(tex, display) {
  try {
    return katex.renderToString(tex, { throwOnError: false, displayMode: display, output: 'html' });
  } catch {
    return null;
  }
}

// Split a string into plain-text and math tokens. Math is delimited by $...$
// (inline) or $$...$$ (block). A lone, unmatched $ is treated as literal text.
function tokenize(s) {
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '$') {
      const display = s[i + 1] === '$';
      const delim = display ? '$$' : '$';
      const start = i + delim.length;
      const end = s.indexOf(delim, start);
      if (end !== -1 && end > start) {
        tokens.push({ math: s.slice(start, end), display });
        i = end + delim.length;
        continue;
      }
    }
    // Plain text up to the next '$' (or the end). Guard against zero-width steps.
    let next = s.indexOf('$', i);
    if (next === i) next = i + 1;
    if (next === -1) next = s.length;
    tokens.push({ text: s.slice(i, next) });
    i = next;
  }
  return tokens;
}

// Renders text with embedded LaTeX. Use anywhere a question prompt, option,
// answer, or explanation is shown so students and teachers see the same math.
export function MathText({ text }) {
  if (text == null) return null;
  const str = String(text);
  if (str === '') return null;
  if (!str.includes('$')) return <>{str}</>; // fast path: no math to render
  const tokens = tokenize(str);
  return (
    <>
      {tokens.map((t, i) => {
        if (t.math !== undefined) {
          const html = renderTeX(t.math, t.display);
          if (html) return <span key={i} dangerouslySetInnerHTML={{ __html: html }} />;
          return <span key={i}>{(t.display ? '$$' : '$') + t.math + (t.display ? '$$' : '$')}</span>;
        }
        return <span key={i}>{t.text}</span>;
      })}
    </>
  );
}

export default MathText;
