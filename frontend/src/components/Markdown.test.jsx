import { performance } from 'node:perf_hooks';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import Markdown from './Markdown.jsx';

describe('Markdown inline formatting', () => {
  it('renders soft-wrapped paragraph lines as normal flowing text', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        source: 'SSRF is triggered by an\nattacker-controlled `local_path` value.',
      })
    );

    expect(html).not.toContain('<br');
    expect(html).toContain('SSRF is triggered by an attacker-controlled ');
    expect(html).toContain('>local_path</code>');
  });

  it('keeps wrapped bullet continuations inside their list items', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        source: '- provider string is\n  checked at `service.go:177`;\n- local path is attacker-controlled',
      })
    );

    expect(html.match(/<ul/g)).toHaveLength(1);
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).not.toContain('<p');
    expect(html).toContain('provider string is checked at ');
    expect(html).toContain('>service.go:177</code>');
  });

  it('keeps wrapped numbered continuations inside their list items', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        source: '1. Configure the integration\n   with a non-empty secret.\n2. Complete the OAuth flow.',
      })
    );

    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).not.toContain('<p');
    expect(html).toContain('Configure the integration with a non-empty secret.');
  });

  it('renders unquoted snake_case identifiers as code without creating underscore emphasis', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        source: 'The file_names list is separate from ignored_file_names in the generated output.',
      })
    );

    expect(html).not.toContain('<em>');
    expect(html.match(/<code/g)).toHaveLength(2);
    expect(html).toContain('>file_names</code>');
    expect(html).toContain('>ignored_file_names</code>');
  });

  it('keeps filename extensions inside generated inline code', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, { source: 'Inspect file_name.py before changing my_file.go.' })
    );

    expect(html.match(/<code/g)).toHaveLength(2);
    expect(html).toContain('>file_name.py</code>');
    expect(html).toContain('>my_file.go</code><span>.</span>');
  });

  it('keeps filename line references inside generated inline code', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        source: 'Review db_connector.go:153 and archive_name.tar.gz:9 before changing the query.',
      })
    );

    expect(html.match(/<code/g)).toHaveLength(2);
    expect(html).toContain('>db_connector.go:153</code>');
    expect(html).toContain('>archive_name.tar.gz:9</code>');
  });

  it('preserves colon punctuation after valid bare tokens', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, { source: 'Check file_name.py: details and plain_name: value.' })
    );

    expect(html.match(/<code/g)).toHaveLength(2);
    expect(html).toContain('>file_name.py</code>');
    expect(html).toContain('>plain_name</code>');
    expect(html).toContain(': details');
    expect(html).toContain(': value');
  });

  it('does not render valid prefixes of malformed filename references as code', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        source:
          'Reject file_name.py_foo, file_name.py:0, file_name.py:12abc, file_name.py:12:3, file_name.pyé, file_name..py, plain_name:12, file_name.py:bad_other.go, plain_name:12abc_other.go, plain_name:１２, plain_name:١٢, foo..other_file.py, é.third_file.go, ◌́.fourth_file.rs, ..fifth_file.ts, édirect_file.go, 𐐀astral_file.go, and \u0301marked_file.go.',
      })
    );

    expect(html).not.toContain('<code');
  });

  it('does not auto-code fragments adjoining Markdown markup', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        source: 'file_name.py**bold** **bold**other_file.go plain_name*em* plain_name[link](/x) code_name`literal`',
      })
    );

    expect(html.match(/<code/g)).toHaveLength(1);
    expect(html).toContain('>literal</code>');
    expect(html).not.toContain('>file_name.py</code>');
    expect(html).not.toContain('>other_file.go</code>');
    expect(html).not.toContain('>plain_name</code>');
    expect(html).not.toContain('>code_name</code>');
  });

  it('preserves surrounding punctuation and React-escapes adjacent text', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, { source: '("file_name.py"), <script>alert(1)</script>' })
    );

    expect(html.match(/<code/g)).toHaveLength(1);
    expect(html).toContain('>file_name.py</code>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('preserves intentional underscore emphasis at word boundaries', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { source: 'This is _intentionally emphasized_ text.' }));

    expect(html).toContain('<em>intentionally emphasized</em>');
  });

  it('renders adversarial multiline text without quadratic inline parsing', () => {
    const sources = [
      Array.from({ length: 400 }, () => '['.repeat(80)).join('\n'),
      Array.from({ length: 400 }, () => '[label]('.repeat(10)).join('\n'),
    ];

    for (const source of sources) {
      const startedAt = performance.now();
      const html = renderToStaticMarkup(createElement(Markdown, { source }));

      expect(html).toContain('[');
      expect(performance.now() - startedAt).toBeLessThan(750);
    }
  });

  it('renders long unformatted text without quadratic inline parsing', () => {
    const source = `${'a'.repeat(16_000)} ${'segment_'.repeat(2_000)}tail.go:0`;
    const startedAt = performance.now();
    const html = renderToStaticMarkup(createElement(Markdown, { source }));

    expect(html).toContain(source);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
