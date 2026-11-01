import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuotaResponse } from '../src/quota.mjs';

test('按窗口时长计算剩余比例，不依赖primary或secondary顺序', () => {
  const result = parseQuotaResponse({
    rateLimits: {
      primary: { windowDurationMins: 10080, usedPercent: 35, resetsAt: 2000000000 },
      secondary: { windowDurationMins: 300, usedPercent: 75, resetsAt: 1999990000 },
    },
  }, 1000);
  assert.deepEqual(result, {
    fiveHour: { remainingPercent: 25, resetsAt: 1999990000 },
    weekly: { remainingPercent: 65, resetsAt: 2000000000 },
    fetchedAt: 1000,
  });
});

test('缺失、不合法或不明确的窗口不冒充额度', () => {
  assert.deepEqual(parseQuotaResponse({ rateLimits: { primary: { usedPercent: 10 } } }, 5), {
    fiveHour: null, weekly: null, fetchedAt: 5,
  });
  assert.deepEqual(parseQuotaResponse({ rateLimits: {
    primary: { windowDurationMins: 300, usedPercent: 200, resetsAt: 1 },
    secondary: { windowDurationMins: 10080, usedPercent: 20, resetsAt: null },
  } }, 5), { fiveHour: null, weekly: null, fetchedAt: 5 });
});
