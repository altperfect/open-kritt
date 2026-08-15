// A small, dependency-free Markdown renderer that produces React elements
// (so content is escaped — safe for untrusted report/PoC text). Supports the
// subset that security reports use: headings, paragraphs, bullet/ordered lists,
// fenced + inline code, bold/italic, links, blockquotes, and horizontal rules.

const HR_RE = /^\s*(?:---+|\*\*\*+|___+)\s*$/;
const BLOCK_START_RE = /^(?:#{1,6}\s|```|\s*>|\s*[-*+]\s+|\s*\d+\.\s+)|^\s*(?:---+|\*\*\*+|___+)\s*$/;

// Parse markdown into an array of block tokens. Exported for testing.
export function parseMarkdownBlocks(md) {
  const lines = String(md ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const lang = fence[1].trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: 'code', lang, text: buf.join('\n') });
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', text: buf.join('\n') });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const itemParts = [lines[i].replace(/^\s*[-*+]\s+/, '')];
        i++;
        while (i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i])) {
          itemParts.push(lines[i].trim());
          i++;
        }
        items.push(itemParts.join(' '));
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const itemParts = [lines[i].replace(/^\s*\d+\.\s+/, '')];
        i++;
        while (i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i])) {
          itemParts.push(lines[i].trim());
          i++;
        }
        items.push(itemParts.join(' '));
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !BLOCK_START_RE.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'p', text: buf.join('\n') });
  }
  return blocks;
}

const codeStyle = {
  fontFamily: "'Geist Mono', ui-monospace, monospace",
  fontSize: '0.86em',
  background: 'var(--surface-2)',
  border: '1px solid var(--border-2)',
  borderRadius: 4,
  padding: '1px 5px',
};
const linkStyle = { color: 'var(--accent)', textDecoration: 'underline' };
const PLAIN_TEXT_CANDIDATE_RE = /\S+/gu;
const SNAKE_CASE_IDENTIFIER_RE = /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/;
const SNAKE_CASE_FILENAME_RE = /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+(?:\.[A-Za-z0-9]+)+(?::[1-9][0-9]*)?$/;
const LEADING_TOKEN_WRAPPERS = new Set(['(', '[', '{', "'", '"', '“', '‘']);
const TRAILING_TOKEN_WRAPPERS = new Set([')', ']', '}', "'", '"', '”', '’']);
const TRAILING_SENTENCE_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?']);

function plainCodeBounds(candidate) {
  let start = 0;
  let end = candidate.length;
  while (start < end && LEADING_TOKEN_WRAPPERS.has(candidate[start])) start++;

  const trimTrailingWrappers = () => {
    while (end > start && TRAILING_TOKEN_WRAPPERS.has(candidate[end - 1])) end--;
  };
  trimTrailingWrappers();
  if (end > start && TRAILING_SENTENCE_PUNCTUATION.has(candidate[end - 1])) end--;
  trimTrailingWrappers();

  const core = candidate.slice(start, end);
  if (!SNAKE_CASE_IDENTIFIER_RE.test(core) && !SNAKE_CASE_FILENAME_RE.test(core)) return null;
  return { start, end };
}

function plainCodeRanges(value) {
  const ranges = [];
  for (const match of value.matchAll(PLAIN_TEXT_CANDIDATE_RE)) {
    const bounds = plainCodeBounds(match[0]);
    if (!bounds) continue;
    ranges.push({ start: match.index + bounds.start, end: match.index + bounds.end });
  }
  return ranges;
}

// Render inline markdown (code, bold, italic, links) within a text string.
function inline(text) {
  const out = [];
  const autoCodeRanges = plainCodeRanges(text);
  let autoCodeRangeIndex = 0;
  let key = 0;

  const pushPlain = (start, end) => {
    let last = start;
    while (autoCodeRangeIndex < autoCodeRanges.length && autoCodeRanges[autoCodeRangeIndex].end <= start) {
      autoCodeRangeIndex++;
    }
    while (autoCodeRangeIndex < autoCodeRanges.length) {
      const range = autoCodeRanges[autoCodeRangeIndex];
      if (range.start >= end) break;
      autoCodeRangeIndex++;
      if (range.start < start || range.end > end) continue;

      if (range.start > last) out.push(<span key={key++}>{text.slice(last, range.start)}</span>);
      out.push(
        <code key={key++} style={codeStyle}>
          {text.slice(range.start, range.end)}
        </code>
      );
      last = range.end;
    }
    if (last < end) out.push(<span key={key++}>{text.slice(last, end)}</span>);
  };

  const pushFormatted = (start, end) => {
    const part = text.slice(start, end);
    const re = /(\*\*[^*]+\*\*|\[[^\][\r\n]+\]\([^)[\r\n]+\)|\*[^*\s][^*]*\*|(?<!\w)_[^_\s](?:[^_]*?[^_\s])?_(?!\w))/g;
    let last = 0;
    let m;
    while ((m = re.exec(part))) {
      if (m.index > last) pushPlain(start + last, start + m.index);
      const tok = m[0];
      if (tok.startsWith('**')) out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
      else if (tok.startsWith('[')) {
        const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        const href = lm[2];
        const isSafe = /^(?:https?:\/\/|#|\/)/.test(href);
        out.push(
          <a key={key++} href={isSafe ? href : ''} target="_blank" rel="noreferrer" style={linkStyle}>
            {lm[1]}
          </a>
        );
      } else out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
      last = m.index + tok.length;
    }
    if (last < part.length) pushPlain(start + last, end);
  };

  let last = 0;
  for (const match of text.matchAll(/`[^`]+`/g)) {
    if (match.index > last) pushFormatted(last, match.index);
    out.push(
      <code key={key++} style={codeStyle}>
        {match[0].slice(1, -1)}
      </code>
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) pushFormatted(last, text.length);
  return out;
}

const HEADING_SIZE = { 1: 22, 2: 18, 3: 15.5, 4: 14, 5: 13, 6: 12.5 };

function renderBlock(block, i) {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${block.level}`;
      return (
        <Tag
          key={i}
          style={{
            fontSize: HEADING_SIZE[block.level],
            fontWeight: 600,
            lineHeight: 1.3,
            margin: i === 0 ? '0 0 12px' : '24px 0 12px',
            color: 'var(--text)',
          }}
        >
          {inline(block.text)}
        </Tag>
      );
    }
    case 'code':
      return (
        <pre
          key={i}
          style={{
            background: 'var(--code-bg)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '12px 14px',
            overflowX: 'auto',
            margin: '0 0 16px',
            fontSize: 12.5,
            lineHeight: 1.55,
          }}
        >
          <code style={{ fontFamily: "'Geist Mono', ui-monospace, monospace", color: 'var(--text)' }}>
            {block.text}
          </code>
        </pre>
      );
    case 'ul':
      return (
        <ul key={i} style={{ margin: '0 0 16px', paddingLeft: 22, lineHeight: 1.6 }}>
          {block.items.map((it, j) => (
            <li key={j} style={{ marginBottom: 4 }}>
              {inline(it)}
            </li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol key={i} style={{ margin: '0 0 16px', paddingLeft: 22, lineHeight: 1.6 }}>
          {block.items.map((it, j) => (
            <li key={j} style={{ marginBottom: 4 }}>
              {inline(it)}
            </li>
          ))}
        </ol>
      );
    case 'quote':
      return (
        <blockquote
          key={i}
          style={{
            margin: '0 0 16px',
            padding: '4px 14px',
            borderLeft: '3px solid var(--border)',
            color: 'var(--text-2)',
          }}
        >
          {block.text.split('\n').map((l, j) => (
            <div key={j}>{inline(l)}</div>
          ))}
        </blockquote>
      );
    case 'hr':
      return <hr key={i} style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '20px 0' }} />;
    default:
      return (
        <p key={i} style={{ margin: '0 0 14px', lineHeight: 1.65, color: 'var(--text)' }}>
          {inline(block.text.replace(/\n/g, ' '))}
        </p>
      );
  }
}

export default function Markdown({ source, style }) {
  const blocks = parseMarkdownBlocks(source);
  return (
    <div style={{ fontSize: 13.5, color: 'var(--text)', ...style }}>
      {blocks.length ? (
        blocks.map(renderBlock)
      ) : (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>Nothing to display.</div>
      )}
    </div>
  );
}
