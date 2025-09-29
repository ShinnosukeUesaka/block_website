const blockForm = document.getElementById('add-form');
const blockInput = document.getElementById('new-domain');
const blockPolicyInput = document.getElementById('new-policy');
const blockStatusEl = document.getElementById('block-status');
const blockedList = document.getElementById('blocked-list');
const blockedEmptyTemplate = document.getElementById('blocked-empty-template');

const globalPolicyField = document.getElementById('global-policy');
const saveGlobalPolicyButton = document.getElementById('save-global-policy');
const globalPolicyStatus = document.getElementById('global-policy-status');

const apiForm = document.getElementById('api-form');
const apiKeyInput = document.getElementById('api-key');
const apiStatus = document.getElementById('api-status');

const monitorForm = document.getElementById('monitor-form');
const monitorIntervalInput = document.getElementById('monitor-interval');
const monitorStatus = document.getElementById('monitor-status');

const DEFAULT_MONITOR_INTERVAL_SECONDS = 60;

function normalizeEntry(entry) {
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    const host = url.hostname.replace(/^www\./, '').replace(/\.$/, '');
    return host || null;
  } catch (_error) {
    return null;
  }
}

function setStatus(element, message, type) {
  element.textContent = message;
  element.className = `status-message ${type || ''}`.trim();
  if (!message) {
    return;
  }
  setTimeout(() => {
    if (element.textContent === message) {
      element.textContent = '';
      element.className = 'status-message';
    }
  }, 2400);
}

function normalizeHost(host) {
  if (typeof host !== 'string') {
    return '';
  }
  return host.trim().replace(/^www\./, '').replace(/\.$/, '');
}

function sanitizeMonitorInterval(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 10) {
    return null;
  }
  return parsed;
}

function normalizeBlockedEntries(rawEntries, fallbackHosts = []) {
  const result = {
    entries: [],
    shouldPersist: false
  };

  if (Array.isArray(rawEntries)) {
    rawEntries.forEach((entry) => {
      if (!entry || typeof entry.host !== 'string') {
        result.shouldPersist = true;
        return;
      }

      const host = normalizeHost(entry.host);
      if (!host) {
        result.shouldPersist = true;
        return;
      }

      const policy = typeof entry.policy === 'string' ? entry.policy.trim() : '';
      if (host !== entry.host || (entry.policy ?? '') !== policy) {
        result.shouldPersist = true;
      }

      result.entries.push({ host, policy });
    });

    return result;
  }

  if (Array.isArray(fallbackHosts) && fallbackHosts.length) {
    const converted = fallbackHosts
      .map((host) => normalizeHost(host))
      .filter(Boolean)
      .map((host) => ({ host, policy: '' }));

    if (converted.length) {
      result.entries = converted;
      result.shouldPersist = true;
    }
  }

  return result;
}

async function writeBlockedEntries(entries) {
  const sanitized = entries.map((entry) => ({
    host: normalizeHost(entry.host),
    policy: entry.policy ? entry.policy.trim() : ''
  }));

  await chrome.storage.local.set({
    blockedEntries: sanitized,
    blockedHosts: sanitized.map((entry) => entry.host)
  });
}

async function readBlockedEntries() {
  const { blockedEntries = null, blockedHosts = [] } = await chrome.storage.local.get([
    'blockedEntries',
    'blockedHosts'
  ]);

  const { entries, shouldPersist } = normalizeBlockedEntries(blockedEntries, blockedHosts);
  if (shouldPersist) {
    await writeBlockedEntries(entries);
  }
  return entries;
}

function renderBlockedEmpty() {
  blockedList.innerHTML = '';
  const node = blockedEmptyTemplate.content.cloneNode(true);
  blockedList.appendChild(node);
}

function renderBlockedEntries(entries) {
  if (!entries.length) {
    renderBlockedEmpty();
    return;
  }

  blockedList.innerHTML = '';

  entries.forEach((entry) => {
    const item = document.createElement('li');
    item.className = 'row';

    const header = document.createElement('header');
    const title = document.createElement('h3');
    title.textContent = entry.host;

    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.type = 'button';
    remove.className = 'secondary';
    remove.addEventListener('click', () => {
      removeHost(entry.host).catch((error) => {
        console.error('Failed to remove host', error);
        setStatus(blockStatusEl, 'Unable to remove domain.', 'error');
      });
    });

    header.append(title, remove);

    const policyEditor = document.createElement('div');
    policyEditor.className = 'policy-editor';

    const policyField = document.createElement('textarea');
    policyField.value = entry.policy || '';
    policyField.placeholder = 'Describe the guardrails for this site.';
    policyField.setAttribute('aria-label', `Policy for ${entry.host}`);

    const policyActions = document.createElement('div');
    policyActions.className = 'policy-actions';

    const savePolicyButton = document.createElement('button');
    savePolicyButton.textContent = 'Save policy';
    savePolicyButton.type = 'button';
    savePolicyButton.className = 'secondary';
    savePolicyButton.addEventListener('click', () => {
      updateHostPolicy(entry.host, policyField.value).catch((error) => {
        console.error('Failed to update policy', error);
        setStatus(blockStatusEl, 'Unable to save policy.', 'error');
      });
    });

    policyActions.appendChild(savePolicyButton);
    policyEditor.append(policyField, policyActions);

    item.append(header, policyEditor);
    blockedList.appendChild(item);
  });
}

async function addHost(event) {
  event.preventDefault();
  const value = blockInput.value;
  const policyText = blockPolicyInput.value.trim();
  const normalized = normalizeEntry(value);

  if (!normalized) {
    setStatus(blockStatusEl, 'Enter a valid domain.', 'error');
    return;
  }

  const entries = await readBlockedEntries();
  if (entries.some((entry) => entry.host === normalized)) {
    setStatus(blockStatusEl, `${normalized} is already blocked.`, 'error');
    blockInput.value = '';
    blockPolicyInput.value = '';
    return;
  }

  const nextEntries = [...entries, { host: normalized, policy: policyText }];
  await writeBlockedEntries(nextEntries);
  blockInput.value = '';
  blockPolicyInput.value = '';
  setStatus(blockStatusEl, `${normalized} added.`, 'success');
  renderBlockedEntries(nextEntries);
}

async function removeHost(host) {
  const entries = await readBlockedEntries();
  const nextEntries = entries.filter((entry) => entry.host !== host);
  await writeBlockedEntries(nextEntries);
  setStatus(blockStatusEl, `${host} removed.`, 'success');
  renderBlockedEntries(nextEntries);
}

async function updateHostPolicy(host, policyText) {
  const entries = await readBlockedEntries();
  const index = entries.findIndex((entry) => entry.host === host);
  if (index === -1) {
    setStatus(blockStatusEl, 'Domain no longer exists.', 'error');
    renderBlockedEntries(entries);
    return;
  }

  const trimmed = policyText.trim();
  if (entries[index].policy === trimmed) {
    setStatus(blockStatusEl, 'No changes to save.', 'success');
    return;
  }

  entries[index] = { ...entries[index], policy: trimmed };
  await writeBlockedEntries(entries);
  setStatus(blockStatusEl, 'Policy saved.', 'success');
  renderBlockedEntries(entries);
}

async function saveGlobalPolicy() {
  const text = globalPolicyField.value.trim();
  await chrome.storage.local.set({ globalPolicy: text });
  setStatus(globalPolicyStatus, 'Global policy saved.', 'success');
}

async function saveApiKey(event) {
  event.preventDefault();
  const key = apiKeyInput.value.trim();
  await chrome.storage.local.set({ openaiApiKey: key });
  if (key) {
    setStatus(apiStatus, 'API key saved.', 'success');
  } else {
    setStatus(apiStatus, 'API key cleared.', 'success');
  }
}

async function saveMonitorSettings(event) {
  event.preventDefault();
  const sanitized = sanitizeMonitorInterval(monitorIntervalInput.value);
  if (!sanitized) {
    setStatus(monitorStatus, 'Enter a value of at least 10 seconds.', 'error');
    return;
  }

  await chrome.storage.local.set({ monitoringIntervalSeconds: sanitized });
  setStatus(monitorStatus, `Monitoring interval set to ${sanitized} seconds.`, 'success');
}

async function loadState() {
  const {
    blockedEntries = null,
    blockedHosts = [],
    globalPolicy = '',
    openaiApiKey = '',
    monitoringIntervalSeconds = DEFAULT_MONITOR_INTERVAL_SECONDS
  } = await chrome.storage.local.get([
    'blockedEntries',
    'blockedHosts',
    'globalPolicy',
    'openaiApiKey',
    'monitoringIntervalSeconds'
  ]);

  const { entries, shouldPersist } = normalizeBlockedEntries(blockedEntries, blockedHosts);
  if (shouldPersist) {
    await writeBlockedEntries(entries);
  }

  renderBlockedEntries(entries);
  globalPolicyField.value = globalPolicy;
  apiKeyInput.value = openaiApiKey;
  monitorIntervalInput.value = monitoringIntervalSeconds || DEFAULT_MONITOR_INTERVAL_SECONDS;
}

blockForm.addEventListener('submit', (event) => {
  addHost(event).catch((error) => {
    console.error('Failed to add blocked host', error);
    setStatus(blockStatusEl, 'Unable to add domain.', 'error');
  });
});

saveGlobalPolicyButton.addEventListener('click', () => {
  saveGlobalPolicy().catch((error) => {
    console.error('Failed to save global policy', error);
    setStatus(globalPolicyStatus, 'Unable to save policy.', 'error');
  });
});

apiForm.addEventListener('submit', (event) => {
  saveApiKey(event).catch((error) => {
    console.error('Failed to save API key', error);
    setStatus(apiStatus, 'Unable to save key.', 'error');
  });
});

monitorForm.addEventListener('submit', (event) => {
  saveMonitorSettings(event).catch((error) => {
    console.error('Failed to save monitoring settings', error);
    setStatus(monitorStatus, 'Unable to save settings.', 'error');
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  if (changes.blockedEntries || changes.blockedHosts) {
    const newEntries = changes.blockedEntries
      ? normalizeBlockedEntries(changes.blockedEntries.newValue || []).entries
      : normalizeBlockedEntries(null, changes.blockedHosts.newValue || []).entries;
    renderBlockedEntries(newEntries);
  }

  if (changes.globalPolicy) {
    globalPolicyField.value = changes.globalPolicy.newValue || '';
  }

  if (changes.openaiApiKey) {
    apiKeyInput.value = changes.openaiApiKey.newValue || '';
  }

  if (changes.monitoringIntervalSeconds) {
    const next = changes.monitoringIntervalSeconds.newValue;
    monitorIntervalInput.value = next || DEFAULT_MONITOR_INTERVAL_SECONDS;
  }
});

loadState().catch((error) => {
  console.error('Failed to load manager state', error);
  renderBlockedEmpty();
  setStatus(blockStatusEl, 'Unable to load saved data.', 'error');
});
