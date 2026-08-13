import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RuntimeSettingsFields } from './Settings.jsx';

describe('runtime settings fields', () => {
  it('renders available fields and warns when the backend omits newer settings', () => {
    const html = renderToStaticMarkup(
      <RuntimeSettingsFields
        data={{
          settings: {
            workerCount: {
              value: 2,
              source: 'default',
              valid: true,
              envKey: 'ENGINE_WORKER_COUNT',
              type: 'integer',
              min: 0,
              max: 128,
              recommendedMax: 10,
              apply: 'live',
            },
          },
        }}
        draft={{ workerCount: '2' }}
        issues={{}}
        saving={false}
        onChange={() => {}}
      />
    );

    expect(html).toContain('Some settings are unavailable from the running backend');
    expect(html).toContain('Restart the backend to load the current settings schema.');
    expect(html).toContain('id="setting-workerCount"');
    expect(html).not.toContain('id="setting-ignoreLowStorage"');
  });

  it('renders failed-scan recovery as a default-off live checkbox', () => {
    const html = renderToStaticMarkup(
      <RuntimeSettingsFields
        data={{
          settings: {
            autoResumeFailedScans: {
              value: false,
              source: 'default',
              valid: true,
              envKey: 'BACKEND_AUTO_RESUME_FAILED_SCANS',
              type: 'boolean',
              defaultValue: false,
              apply: 'live',
            },
          },
        }}
        draft={{ autoResumeFailedScans: false }}
        issues={{}}
        saving={false}
        onChange={() => {}}
      />
    );

    expect(html).toContain('Auto-resume failed scans');
    expect(html).toContain('remained failed for about one second');
    expect(html).toContain('checking twice per second');
    expect(html).toContain('A scan that keeps failing is retried on later checks.');
    expect(html).toContain('id="setting-autoResumeFailedScans"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('Failed scans wait for a manual resume.');
    expect(html).toContain('BACKEND_AUTO_RESUME_FAILED_SCANS');
    expect(html).toContain('Default disabled');
  });

  it('explains the total attempt count when cyber-block retries are enabled', () => {
    const html = renderToStaticMarkup(
      <RuntimeSettingsFields
        data={{
          settings: {
            cyberSafetyRetryCount: {
              value: 3,
              source: 'runtime_config',
              valid: true,
              envKey: 'ENGINE_CYBER_SAFETY_RETRY_COUNT',
              type: 'integer',
              min: 0,
              max: 10,
              recommendedMax: 3,
              apply: 'live',
            },
          },
        }}
        draft={{ cyberSafetyRetryCount: '3' }}
        issues={{}}
        saving={false}
        onChange={() => {}}
      />
    );

    expect(html).toContain('id="setting-cyberSafetyRetryCount"');
    expect(html).toContain('up to 4 total attempts');
    expect(html).toContain('ENGINE_CYBER_SAFETY_RETRY_COUNT');
  });
});
