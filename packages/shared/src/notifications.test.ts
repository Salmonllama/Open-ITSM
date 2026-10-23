import { describe, expect, it } from 'vitest';
import { shouldPostLowStock, webhookUrlProblem } from './notifications.js';

describe('webhookUrlProblem', () => {
  it('accepts Slack and Teams workflow URLs', () => {
    expect(webhookUrlProblem('slack', 'https://hooks.slack.com/services/T0/B0/abc')).toBeNull();
    expect(
      webhookUrlProblem(
        'teams',
        'https://default0a1b.2c.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/x/triggers/manual/paths/invoke?sig=y',
      ),
    ).toBeNull(); // Microsoft's URLs often spell out :443
    expect(
      webhookUrlProblem('slack', 'https://hooks.slack.com:8443/services/T0/B0/abc'),
    ).not.toBeNull();
    expect(
      webhookUrlProblem(
        'teams',
        'https://default0a1b.2c.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/x/triggers/manual/paths/invoke?sig=y',
      ),
    ).toBeNull();
  });

  it('refuses other hosts, plain http and retired Teams webhooks', () => {
    expect(webhookUrlProblem('slack', 'http://hooks.slack.com/services/T0/B0/abc')).not.toBeNull();
    expect(
      webhookUrlProblem('slack', 'https://hooks.slack.com.evil.test/services/x'),
    ).not.toBeNull();
    expect(webhookUrlProblem('teams', 'https://10.0.0.5/hook')).not.toBeNull();
    expect(webhookUrlProblem('teams', 'https://evilpowerplatform.com/x')).not.toBeNull();
    expect(webhookUrlProblem('teams', 'https://contoso.webhook.office.com/webhookb2/x')).toMatch(
      /retired/,
    );
    expect(webhookUrlProblem('teams', 'https://prod-1.westus.logic.azure.com/workflows/x')).toMatch(
      /retired/,
    );
    expect(webhookUrlProblem('slack', 'not a url')).not.toBeNull();
  });
});

describe('shouldPostLowStock', () => {
  it('posts once on the drop to the threshold in first mode', () => {
    expect(shouldPostLowStock('first', { before: 6, after: 5, threshold: 5 })).toBe(true);
    expect(shouldPostLowStock('first', { before: 5, after: 4, threshold: 5 })).toBe(false);
    expect(shouldPostLowStock('first', { before: 9, after: 2, threshold: 5 })).toBe(true);
  });

  it('posts on every drop while low in every mode', () => {
    expect(shouldPostLowStock('every', { before: 5, after: 4, threshold: 5 })).toBe(true);
    expect(shouldPostLowStock('every', { before: 6, after: 5, threshold: 5 })).toBe(true);
  });

  it('never posts for a rise, above the threshold or with a threshold of 0', () => {
    expect(shouldPostLowStock('every', { before: 2, after: 3, threshold: 5 })).toBe(false);
    expect(shouldPostLowStock('every', { before: 9, after: 8, threshold: 5 })).toBe(false);
    expect(shouldPostLowStock('every', { before: 1, after: 0, threshold: 0 })).toBe(false);
  });
});
