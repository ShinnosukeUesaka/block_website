const BLOCK_RULE_START = 1;
const ALLOW_RULE_START = 10000;
const REDIRECT_PATH = '/blocked.html';
const ALLOW_ALARM_PREFIX = 'allow:';
const MONITOR_ALARM_PREFIX = 'monitor:';
const DEFAULT_MONITOR_INTERVAL_SECONDS = 60;
const MONITOR_MIN_INTERVAL_SECONDS = 10;

importScripts('prompts.js');

function serializeError(error) {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack
    };
  }

  if (error && typeof error === 'object') {
    try {
      return JSON.parse(JSON.stringify(error));
    } catch (_jsonError) {
      return {
        message: String(error)
      };
    }
  }

  return {
    message: String(error)
  };
}

function stringifyForLogging(value) {
  if (value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return String(value);
  }
}

function logWithContext(level, message, context) {
  const formatted = stringifyForLogging(context);
  if (formatted) {
    console[level](`${message} ${formatted}`);
  } else {
    console[level](message);
  }
}

const monitoringLog = {
  log(message, context) {
    logWithContext('log', `[Monitoring] ${message}`, context);
  },
  warn(message, context) {
    logWithContext('warn', `[Monitoring] ${message}`, context);
  },
  error(message, context) {
    logWithContext('error', `[Monitoring] ${message}`, context);
  }
};

function normalizeHost(host) {
  if (typeof host !== 'string') {
    return '';
  }

  return host.trim().replace(/^www\./, '').replace(/\.$/, '');
}

function normalizeBlockedEntries(rawEntries) {
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  return rawEntries
    .map((entry) => {
      if (!entry || typeof entry.host !== 'string') {
        return null;
      }

      const host = normalizeHost(entry.host);
      if (!host) {
        return null;
      }

      const policy = typeof entry.policy === 'string' ? entry.policy.trim() : '';
      return { host, policy };
    })
    .filter(Boolean);
}

function sanitizeHosts(hosts) {
  if (!Array.isArray(hosts)) {
    return [];
  }

  return hosts
    .map((host) => normalizeHost(host))
    .filter(Boolean);
}

function sanitizeMonitoringInterval(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < MONITOR_MIN_INTERVAL_SECONDS) {
    return DEFAULT_MONITOR_INTERVAL_SECONDS;
  }
  return parsed;
}

function normalizeMonitoringViolations(rawViolations) {
  if (!rawViolations || typeof rawViolations !== 'object') {
    return {};
  }

  return Object.entries(rawViolations).reduce((acc, [host, value]) => {
    const normalizedHost = normalizeHost(host);
    if (!normalizedHost) {
      return acc;
    }

    const message = typeof value?.message === 'string' ? value.message.trim() : '';
    if (!message) {
      return acc;
    }

    const timestamp = Number.isFinite(value?.timestamp) ? value.timestamp : Date.now();
    acc[normalizedHost] = { message, timestamp };
    return acc;
  }, {});
}

function extractHostFromUrl(urlString) {
  if (!urlString) {
    return '';
  }

  try {
    const url = new URL(urlString);
    return normalizeHost(url.hostname);
  } catch (_error) {
    return '';
  }
}

function hostsMatch(targetHost, allowanceHost) {
  if (!targetHost || !allowanceHost) {
    return false;
  }

  if (targetHost === allowanceHost) {
    return true;
  }

  return targetHost.endsWith(`.${allowanceHost}`);
}

async function readStorage(keys) {
  const defaults = {
    blockedEntries: [],
    blockedHosts: [],
    globalPolicy: '',
    allowances: [],
    openaiApiKey: '',
    monitoringIntervalSeconds: DEFAULT_MONITOR_INTERVAL_SECONDS,
    monitoringViolations: {}
  };

  const data = await chrome.storage.local.get(keys ?? defaults);
  const merged = { ...defaults, ...data };

  merged.blockedEntries = normalizeBlockedEntries(merged.blockedEntries);
  merged.blockedHosts = sanitizeHosts(merged.blockedHosts);
  merged.monitoringIntervalSeconds = sanitizeMonitoringInterval(merged.monitoringIntervalSeconds);
  merged.monitoringViolations = normalizeMonitoringViolations(merged.monitoringViolations);

  if (!merged.blockedHosts.length && merged.blockedEntries.length) {
    merged.blockedHosts = merged.blockedEntries.map((entry) => entry.host);
  }

  return merged;
}

function buildBlockRule(host, offset) {
  const redirectUrl = new URL(chrome.runtime.getURL(REDIRECT_PATH));
  redirectUrl.searchParams.set('blocked', host);

  return {
    id: BLOCK_RULE_START + offset,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: {
        url: redirectUrl.href
      }
    },
    condition: {
      urlFilter: `||${host}`,
      resourceTypes: ['main_frame']
    }
  };
}

function buildAllowRule(allowance, offset) {
  return {
    id: ALLOW_RULE_START + offset,
    priority: 10,
    action: { type: 'allow' },
    condition: {
      urlFilter: `||${allowance.host}`,
      resourceTypes: ['main_frame']
    }
  };
}

async function syncBlockRules(blockedHosts) {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const existingBlockRuleIds = rules
    .filter((rule) => rule.id >= BLOCK_RULE_START && rule.id < ALLOW_RULE_START)
    .map((rule) => rule.id);

  const addRules = blockedHosts.map((host, index) => buildBlockRule(host, index));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existingBlockRuleIds,
    addRules
  });
}

function isAllowanceActive(allowance) {
  return allowance.expiresAt > Date.now();
}

async function syncAllowRules(allowances) {
  const activeAllowances = allowances.filter(isAllowanceActive);
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const existingAllowRuleIds = rules
    .filter((rule) => rule.id >= ALLOW_RULE_START)
    .map((rule) => rule.id);

  const addRules = activeAllowances.map((allowance, index) => buildAllowRule(allowance, index));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existingAllowRuleIds,
    addRules
  });
}

async function rescheduleAllowanceAlarms(allowances) {
  const alarms = await chrome.alarms.getAll();
  const clearPromises = alarms
    .filter((alarm) => alarm.name.startsWith(ALLOW_ALARM_PREFIX))
    .map((alarm) => chrome.alarms.clear(alarm.name));

  await Promise.all(clearPromises);

  const activeAllowances = allowances.filter(isAllowanceActive);
  for (const allowance of activeAllowances) {
    await chrome.alarms.create(`${ALLOW_ALARM_PREFIX}${allowance.id}`, {
      when: allowance.expiresAt
    });
  }
}

async function rescheduleMonitoringAlarms(allowances, intervalSeconds) {
  const alarms = await chrome.alarms.getAll();
  const monitorAlarms = alarms.filter((alarm) => alarm.name.startsWith(MONITOR_ALARM_PREFIX));
  if (monitorAlarms.length) {
    await Promise.all(monitorAlarms.map((alarm) => chrome.alarms.clear(alarm.name)));
  }

  const activeAllowances = allowances.filter(isAllowanceActive);
  if (!activeAllowances.length) {
    monitoringLog.log('No active allowances; monitoring alarms cleared.');
    return;
  }

  const sanitizedInterval = sanitizeMonitoringInterval(intervalSeconds);
  if (sanitizedInterval < MONITOR_MIN_INTERVAL_SECONDS) {
    monitoringLog.warn('Interval below minimum; skipping alarm scheduling.', {
      intervalSeconds,
      sanitizedInterval
    });
    return;
  }

  const periodInMinutes = sanitizedInterval / 60;
  monitoringLog.log('Scheduling monitoring alarms.', {
    allowanceCount: activeAllowances.length,
    sanitizedInterval,
    periodInMinutes
  });
  const alarmInfo = {
    when: Date.now() + sanitizedInterval * 1000,
    periodInMinutes
  };

  for (const allowance of activeAllowances) {
    const alarmName = `${MONITOR_ALARM_PREFIX}${allowance.id}`;
    try {
      await chrome.alarms.create(alarmName, alarmInfo);
    } catch (error) {
      monitoringLog.error('Failed to schedule monitoring alarm', {
        error: serializeError(error),
        allowanceId: allowance.id,
        host: allowance.host
      });

      if (periodInMinutes < 1) {
        try {
          await chrome.alarms.create(alarmName, {
            when: alarmInfo.when,
            periodInMinutes: 1
          });
        } catch (fallbackError) {
          monitoringLog.error('Failed to schedule monitoring alarm fallback', {
            error: serializeError(fallbackError),
            allowanceId: allowance.id,
            host: allowance.host
          });
        }
      }
    }
  }
}

async function callOpenAIForMonitoring({ apiKey, screenshotDataUrl, allowance }) {
  monitoringLog.log('Preparing monitoring request payload.', {
    allowanceId: allowance.id,
    host: allowance.host,
    screenshotBytes: screenshotDataUrl?.length || 0
  });
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-5-nano',
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'monitoring_verdict',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              compliant: { type: 'boolean' },
              reason: {
                type: 'string',
                description: 'Short explanation of whether the screenshot matches the stated task.'
              }
            },
            required: ['compliant', 'reason']
          }
        }
      },
      messages: [
        {
          role: 'system',
          content: MONITORING_SYSTEM_PROMPT
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Website host: ${allowance.host}\nStated task: ${allowance.purpose || 'Not provided.'}\nDoes the screenshot show the user working on that task?`
            },
            {
              type: 'image_url',
              image_url: {
                url: screenshotDataUrl
              }
            }
          ]
        }
      ]
    })
  });

  monitoringLog.log('Monitoring response received.', {
    allowanceId: allowance.id,
    host: allowance.host,
    status: response.status,
    ok: response.ok
  });

  if (!response.ok) {
    const errorText = await response.text();
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(errorText);
    } catch (_parseError) {
      parsedBody = errorText;
    }

    monitoringLog.error('Monitoring request returned error response.', {
      allowanceId: allowance.id,
      host: allowance.host,
      status: response.status,
      body: parsedBody
    });
    throw new Error(`OpenAI monitoring request failed: ${errorText}`);
  }

  const data = await response.json();
  const messageContent = data?.choices?.[0]?.message?.content;
  if (!messageContent) {
    throw new Error('OpenAI monitoring response missing content.');
  }

  try {
    return JSON.parse(messageContent);
  } catch (error) {
    monitoringLog.error('Failed to parse monitoring verdict JSON.', {
      allowanceId: allowance.id,
      host: allowance.host,
      messageContent
    });
    throw new Error('Failed to parse monitoring verdict JSON.');
  }
}

async function revokeAllowanceForViolation({ allowance, allowances, reason, violations }) {
  const remaining = allowances.filter((item) => item.id !== allowance.id && isAllowanceActive(item));
  const normalizedHost = normalizeHost(allowance.host);
  const message = reason?.trim()
    ? `Access revoked: ${reason.trim()}`
    : 'Access revoked: Monitoring detected activity that does not match your stated task.';

  const nextViolations = {
    ...violations,
    [normalizedHost]: {
      message,
      timestamp: Date.now()
    }
  };

  await chrome.storage.local.set({
    allowances: remaining,
    monitoringViolations: nextViolations
  });

  await chrome.alarms.clear(`${MONITOR_ALARM_PREFIX}${allowance.id}`);
}

async function redirectTabToBlockedPage(tabId, host, contextReason = 'monitoring revocation') {
  if (typeof tabId !== 'number' || !host) {
    return;
  }

  const normalizedHost = normalizeHost(host);
  const redirectUrl = new URL(chrome.runtime.getURL(REDIRECT_PATH));
  if (normalizedHost) {
    redirectUrl.searchParams.set('blocked', normalizedHost);
  } else {
    redirectUrl.searchParams.set('blocked', String(host));
  }

  try {
    await chrome.tabs.update(tabId, { url: redirectUrl.href });
    monitoringLog.log(`Redirected tab to blocked page after ${contextReason}.`, {
      tabId,
      host: normalizedHost || host,
      reason: contextReason
    });
  } catch (error) {
    monitoringLog.error(`Failed to redirect tab to blocked page after ${contextReason}.`, {
      error: serializeError(error),
      tabId,
      host: normalizedHost || host,
      reason: contextReason
    });
    try {
      await chrome.tabs.reload(tabId);
      monitoringLog.log(`Fallback reload triggered after failed redirect attempt (${contextReason}).`, {
        tabId,
        host: normalizedHost || host,
        reason: contextReason
      });
    } catch (reloadError) {
      monitoringLog.error(`Failed to reload tab after ${contextReason}.`, {
        error: serializeError(reloadError),
        tabId,
        host: normalizedHost || host,
        reason: contextReason
      });
    }
  }
}

async function enforceBlockingForAllowance(allowance) {
  if (!allowance?.host) {
    return;
  }

  const normalizedHost = normalizeHost(allowance.host);
  if (!normalizedHost) {
    return;
  }

  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch (error) {
    console.error('Failed to query tabs after allowance expiry.', {
      error: serializeError(error),
      allowanceId: allowance.id,
      host: normalizedHost
    });
    return;
  }

  const matchingTabs = tabs.filter(
    (tab) => typeof tab.id === 'number' && hostsMatch(extractHostFromUrl(tab.url), normalizedHost)
  );

  if (!matchingTabs.length) {
    return;
  }

  logWithContext('log', 'Redirecting tabs after allowance expiry.', {
    allowanceId: allowance.id,
    host: normalizedHost,
    tabIds: matchingTabs.map((tab) => tab.id)
  });

  await Promise.all(
    matchingTabs.map((tab) => redirectTabToBlockedPage(tab.id, normalizedHost, 'allowance expiry'))
  );
}

async function performMonitoringCheck(alarmName) {
  monitoringLog.log('Alarm triggered.', { alarmName });
  const allowanceId = alarmName.substring(MONITOR_ALARM_PREFIX.length);
  const { allowances, openaiApiKey, monitoringViolations } = await readStorage([
    'allowances',
    'openaiApiKey',
    'monitoringViolations'
  ]);

  const activeAllowances = allowances.filter(isAllowanceActive);
  monitoringLog.log('Active allowances retrieved.', {
    activeCount: activeAllowances.length,
    allowanceId
  });
  const allowance = activeAllowances.find((item) => item.id === allowanceId);

  if (!allowance) {
    if (activeAllowances.length !== allowances.length) {
      await chrome.storage.local.set({ allowances: activeAllowances });
    }
    await chrome.alarms.clear(alarmName);
    monitoringLog.log('Alarm cleared because allowance expired or missing.', {
      alarmName,
      allowanceId
    });
    return;
  }

  if (!openaiApiKey) {
    monitoringLog.warn('Skipping monitoring check due to missing OpenAI API key.', {
      allowanceId,
      host: allowance.host
    });
    return;
  }

  const tabs = await chrome.tabs.query({ active: true });
  monitoringLog.log('Active tabs fetched.', {
    tabCount: tabs.length
  });
  const matchingTab = tabs.find((tab) => hostsMatch(extractHostFromUrl(tab.url), allowance.host));

  if (!matchingTab) {
    monitoringLog.log('No active tab matched allowance host; skipping screenshot.', {
      allowanceId,
      host: allowance.host
    });
    return;
  }

  let screenshot;
  const captureOptions = {
    format: 'jpeg',
    quality: 70
  };
  try {
    monitoringLog.log('Capturing screenshot for allowance.', {
      allowanceId,
      host: allowance.host,
      tabId: matchingTab.id,
      windowId: matchingTab.windowId
    });
    screenshot = await chrome.tabs.captureVisibleTab(matchingTab.windowId, captureOptions);
  } catch (error) {
    monitoringLog.error('Failed to capture monitoring screenshot', {
      error: serializeError(error),
      allowanceId,
      host: allowance.host,
      tabId: matchingTab.id,
      windowId: matchingTab.windowId
    });
    try {
      monitoringLog.log('Retrying screenshot capture without window hint.', {
        allowanceId,
        host: allowance.host
      });
      screenshot = await chrome.tabs.captureVisibleTab(undefined, captureOptions);
    } catch (fallbackError) {
      monitoringLog.error('Fallback screenshot capture failed.', {
        error: serializeError(fallbackError),
        allowanceId,
        host: allowance.host
      });
      return;
    }
  }

  if (!screenshot) {
    monitoringLog.warn('Screenshot capture returned empty data.', {
      allowanceId,
      host: allowance.host
    });
    return;
  }

  monitoringLog.log('Screenshot captured successfully.', {
    allowanceId,
    host: allowance.host,
    dataLength: screenshot.length
  });

  let verdict;
  try {
    monitoringLog.log('Sending screenshot for analysis.', {
      allowanceId,
      host: allowance.host
    });
    verdict = await callOpenAIForMonitoring({ apiKey: openaiApiKey, screenshotDataUrl: screenshot, allowance });
  } catch (error) {
    monitoringLog.error('Monitoring analysis failed', {
      error: serializeError(error),
      allowanceId,
      host: allowance.host
    });
    return;
  }

  if (!verdict || typeof verdict.compliant !== 'boolean') {
    monitoringLog.warn('Received invalid monitoring verdict.', {
      allowanceId,
      host: allowance.host,
      verdict
    });
    return;
  }

  monitoringLog.log('Monitoring verdict received.', {
    allowanceId,
    host: allowance.host,
    compliant: verdict.compliant
  });

  const currentStrikes =
    Number.isFinite(allowance.monitoringStrikes) && allowance.monitoringStrikes > 0
      ? allowance.monitoringStrikes
      : 0;

  if (verdict.compliant) {
    if (currentStrikes > 0) {
      const resetAllowance = { ...allowance, monitoringStrikes: 0 };
      const nextAllowances = allowances.map((item) =>
        item.id === allowance.id ? resetAllowance : item
      );
      await chrome.storage.local.set({ allowances: nextAllowances });
      monitoringLog.log('Monitoring strikes reset after compliant verdict.', {
        allowanceId,
        host: allowance.host
      });
    }
    return;
  }

  const nextStrikes = currentStrikes + 1;

  if (nextStrikes < 2) {
    const updatedAllowance = { ...allowance, monitoringStrikes: nextStrikes };
    const nextAllowances = allowances.map((item) =>
      item.id === allowance.id ? updatedAllowance : item
    );
    await chrome.storage.local.set({ allowances: nextAllowances });
    monitoringLog.warn('First non-compliant verdict recorded; awaiting confirmation.', {
      allowanceId,
      host: allowance.host,
      strikes: nextStrikes,
      reason: verdict.reason
    });
    return;
  }

  await revokeAllowanceForViolation({
    allowance,
    allowances: activeAllowances,
    reason: verdict.reason,
    violations: monitoringViolations
  });
  if (matchingTab?.id) {
    await redirectTabToBlockedPage(matchingTab.id, allowance.host);
  }
  monitoringLog.warn('Allowance revoked due to repeated non-compliant activity.', {
    allowanceId,
    host: allowance.host,
    strikes: nextStrikes,
    reason: verdict.reason
  });
}

async function initialize() {
  const { blockedHosts, allowances, monitoringIntervalSeconds } = await readStorage();
  const activeAllowances = allowances.filter(isAllowanceActive);

  if (activeAllowances.length !== allowances.length) {
    await chrome.storage.local.set({ allowances: activeAllowances });
  }

  await syncBlockRules(blockedHosts);
  await syncAllowRules(activeAllowances);
  await rescheduleAllowanceAlarms(activeAllowances);
  await rescheduleMonitoringAlarms(activeAllowances, monitoringIntervalSeconds);
}

chrome.runtime.onInstalled.addListener(() => {
  initialize().catch((error) => console.error('Failed to initialize on install', error));
});

chrome.runtime.onStartup.addListener(() => {
  initialize().catch((error) => console.error('Failed to initialize on startup', error));
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  if (changes.blockedEntries || changes.blockedHosts) {
    const nextHosts = changes.blockedEntries
      ? normalizeBlockedEntries(changes.blockedEntries.newValue || []).map((entry) => entry.host)
      : sanitizeHosts(changes.blockedHosts.newValue || []);
    syncBlockRules(nextHosts).catch((error) => console.error('Failed to sync block rules on change', error));
  }

  if (changes.allowances) {
    const allowances = (changes.allowances.newValue || []).filter(isAllowanceActive);
    syncAllowRules(allowances).catch((error) => console.error('Failed to sync allow rules on change', error));
    rescheduleAllowanceAlarms(allowances).catch((error) => console.error('Failed to reschedule allowance alarms', error));
  }

  if (changes.allowances || changes.monitoringIntervalSeconds) {
    readStorage(['allowances', 'monitoringIntervalSeconds'])
      .then(({ allowances, monitoringIntervalSeconds }) =>
        rescheduleMonitoringAlarms(allowances.filter(isAllowanceActive), monitoringIntervalSeconds)
      )
      .catch((error) => console.error('Failed to reschedule monitoring alarms', error));
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith(ALLOW_ALARM_PREFIX)) {
    const allowanceId = alarm.name.substring(ALLOW_ALARM_PREFIX.length);
    const { allowances } = await readStorage(['allowances']);
    const expiredAllowance = allowances.find((allowance) => allowance.id === allowanceId);
    const nextAllowances = allowances.filter((allowance) => allowance.id !== allowanceId);

    if (nextAllowances.length !== allowances.length) {
      await chrome.storage.local.set({ allowances: nextAllowances });
    }

    if (expiredAllowance) {
      await enforceBlockingForAllowance(expiredAllowance);
    }

    return;
  }

  if (alarm.name.startsWith(MONITOR_ALARM_PREFIX)) {
    try {
      await performMonitoringCheck(alarm.name);
    } catch (error) {
      console.error('Monitoring check failed', error);
    }
  }
});

async function callOpenAI({ apiKey, prompt }) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-2024-08-06',
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'access_review',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              decision: {
                type: 'string',
                enum: ['approve', 'deny']
              },
              reason: {
                type: 'string',
                description: 'Brief explanation citing relevant policy names when applicable.'
              },
              approved_minutes: {
                type: 'number',
                description: 'Minutes of access to grant if approved.'
              }
            },
            required: ['decision', 'reason']
          }
        }
      },
      messages: [
        {
          role: 'system',
          content: REVIEW_SYSTEM_PROMPT
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed: ${errorText}`);
  }

  const data = await response.json();
  const messageContent = data?.choices?.[0]?.message?.content;

  if (!messageContent) {
    throw new Error('OpenAI response missing content.');
  }

  let parsed;
  try {
    parsed = JSON.parse(messageContent);
  } catch (error) {
    throw new Error('Failed to parse OpenAI response JSON.');
  }

  return parsed;
}

async function processAccessRequest(payload) {
  const { host, purpose, durationMinutes } = payload;
  if (!host || !durationMinutes || !purpose) {
    return { status: 'error', message: 'Incomplete access request.' };
  }

  const {
    blockedEntries,
    globalPolicy,
    openaiApiKey,
    blockedHosts,
    allowances,
    monitoringViolations
  } = await readStorage([
    'blockedEntries',
    'blockedHosts',
    'globalPolicy',
    'openaiApiKey',
    'allowances',
    'monitoringViolations'
  ]);

  if (!openaiApiKey) {
    return {
      status: 'error',
      message: 'No OpenAI API key configured. Add one in the manager before requesting access.'
    };
  }

  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) {
    return {
      status: 'error',
      message: 'Invalid host provided in request.'
    };
  }

  const sitePolicy = blockedEntries.find((entry) => entry.host === normalizedHost)?.policy || '';
  const prompt = createReviewPrompt({
    host: normalizedHost,
    purpose,
    durationMinutes,
    sitePolicy,
    globalPolicy,
    blockedHosts
  });

  let review;
  try {
    review = await callOpenAI({ apiKey: openaiApiKey, prompt });
  } catch (error) {
    console.error('OpenAI review failed', error);
    return {
      status: 'error',
      message: 'AI review failed. Check console for details.'
    };
  }

  const decision = review.decision;
  const reason = review.reason || 'No reason provided.';

  if (decision !== 'approve') {
    return {
      status: 'denied',
      reason
    };
  }

  const approvedMinutes = Math.max(
    1,
    Math.min(durationMinutes, Number.isFinite(review.approved_minutes) ? review.approved_minutes : durationMinutes)
  );

  const now = Date.now();
  const allowance = {
    id: crypto.randomUUID(),
    host: normalizedHost,
    purpose,
    approvedMinutes,
    reason,
    monitoringStrikes: 0,
    createdAt: now,
    expiresAt: now + approvedMinutes * 60 * 1000
  };

  const activeAllowances = allowances.filter(isAllowanceActive).filter((item) => item.host !== normalizedHost);
  activeAllowances.push(allowance);

  const nextViolations = { ...monitoringViolations };
  if (nextViolations[normalizedHost]) {
    delete nextViolations[normalizedHost];
  }

  const storagePayload = { allowances: activeAllowances };
  if (Object.keys(nextViolations).length !== Object.keys(monitoringViolations).length) {
    storagePayload.monitoringViolations = nextViolations;
  }

  await chrome.storage.local.set(storagePayload);
  await syncAllowRules(activeAllowances);
  await rescheduleAllowanceAlarms(activeAllowances);

  return {
    status: 'approved',
    reason,
    approvedMinutes,
    expiresAt: allowance.expiresAt
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'process-unblock-request') {
    processAccessRequest(message.payload)
      .then(sendResponse)
      .catch((error) => {
        console.error('Failed to process access request', error);
        sendResponse({ status: 'error', message: 'Unexpected error processing request.' });
      });
    return true;
  }

  return undefined;
});

(async () => {
  try {
    await initialize();
  } catch (error) {
    console.error('Failed to initialize background script', error);
  }
})();
