import { performance } from 'node:perf_hooks';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import Markdown from './Markdown.jsx';

describe('Markdown inline formatting', () => {
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

  it('preserves intentional underscore emphasis at word boundaries', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { source: 'This is _intentionally emphasized_ text.' }));

    expect(html).toContain('<em>intentionally emphasized</em>');
  });

  it('renders long unformatted text without quadratic inline parsing', () => {
    const source = 'a'.repeat(32_000);
    const startedAt = performance.now();
    const html = renderToStaticMarkup(createElement(Markdown, { source }));

    expect(html).toContain(source);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
