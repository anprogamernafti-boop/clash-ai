import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../www/index.html', import.meta.url), 'utf8');
const quotaStart = html.indexOf('function localUnlimitedQuotaTest()');
const quotaEnd = html.indexOf('\nfunction grantPlan', quotaStart);
const context = {
  APP_QUOTA_UNLIMITED: true,
  TRIAL_TOTAL: 5,
  location: { hostname: 'clash-ai.pages.dev', protocol: 'https:', search: '' }
};
vm.runInNewContext(
  html.slice(quotaStart, quotaEnd) + '\nglobalThis.quota = { quotaState, consumeQuota };',
  context
);

test('does not block app generation after the legacy five free uses', () => {
  const result = context.quota.consumeQuota(JSON.stringify({ used: 5, total: 12 }));
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'app-unlimited');
  assert.equal(result.json, null);
  assert.equal(result.state.unlimitedApp, true);
  assert.ok(result.state.left > 5);
});

test('reports unlimited app usage without implying unlimited AI-provider capacity', () => {
  assert.match(html, /Générations sans plafond dans l’app/);
  assert.match(html, /quotas et limites des services IA restent applicables/);
});
