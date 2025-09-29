const siteListEl = document.getElementById('site-list');
const emptyTemplate = document.getElementById('empty-template');
const openManagerButton = document.getElementById('open-manager');

let blockedEntriesState = [];
let allowancesState = [];
let tickerId = null;

async function reblockAllowance(allowance, triggerButton) {
  if (!allowance || !allowance.id) {
    return;
  }

  if (triggerButton) {
    triggerButton.disabled = true;
    triggerButton.textContent = 'Reblocking...';
  }

  try {
    const { allowances = [] } = await chrome.storage.local.get(['allowances']);
    const normalized = normalizeAllowances(allowances);
    const nextAllowances = normalized.filter((item) => item.id !== allowance.id);

    if (nextAllowances.length === normalized.length) {
      if (triggerButton) {
        triggerButton.disabled = false;
        triggerButton.textContent = 'Reblock now';
      }
      return;
    }

    await chrome.storage.local.set({ allowances: nextAllowances });
    allowancesState = allowancesState.filter((item) => item.id !== allowance.id);
    renderList();
    if (triggerButton) {
      triggerButton.textContent = 'Reblocked';
    }
  } catch (error) {
    console.error('Failed to reblock allowance', allowance.host, error);
    if (triggerButton) {
      triggerButton.disabled = false;
      triggerButton.textContent = 'Reblock now';
    }
  }
}

function normalizeHost(host) {
  if (typeof host !== 'string') {
    return '';
  }

  return host.trim().replace(/^www\./, '').replace(/\.$/, '');
}

function normalizeBlockedEntries(rawEntries, fallbackHosts = []) {
  if (!Array.isArray(rawEntries)) {
    if (Array.isArray(fallbackHosts) && fallbackHosts.length) {
      return fallbackHosts
        .map((host) => normalizeHost(host))
        .filter(Boolean)
        .map((host) => ({ host, policy: '' }));
    }
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
      return {
        host,
        policy: typeof entry.policy === 'string' ? entry.policy.trim() : ''
      };
    })
    .filter(Boolean);
}

function normalizeAllowances(rawAllowances) {
  if (!Array.isArray(rawAllowances)) {
    return [];
  }

  return rawAllowances
    .map((item) => {
      if (!item || typeof item.host !== 'string' || !Number.isFinite(item.expiresAt)) {
        return null;
      }
      const host = normalizeHost(item.host);
      if (!host) {
        return null;
      }
      return {
        ...item,
        host,
        expiresAt: Number(item.expiresAt)
      };
    })
    .filter(Boolean);
}

function isAllowanceActive(allowance) {
  return allowance.expiresAt > Date.now();
}

function formatRemainingTime(ms) {
  if (ms <= 0) {
    return 'ending now';
  }

  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    return remMinutes
      ? `${hours}h ${remMinutes}m remaining`
      : `${hours}h remaining`;
  }

  if (minutes > 0) {
    return seconds ? `${minutes}m ${seconds}s remaining` : `${minutes}m remaining`;
  }

  return `${seconds}s remaining`;
}

function renderList() {
  if (tickerId) {
    window.clearTimeout(tickerId);
  }

  const now = Date.now();
  const activeAllowances = allowancesState.filter((allowance) => allowance.expiresAt > now);

  const allowanceByHost = new Map();
  activeAllowances.forEach((allowance) => {
    const existing = allowanceByHost.get(allowance.host);
    if (!existing || allowance.expiresAt > existing.expiresAt) {
      allowanceByHost.set(allowance.host, allowance);
    }
  });

  const rows = [];
  blockedEntriesState.forEach((entry) => {
    const allowance = allowanceByHost.get(entry.host);
    if (allowance) {
      allowanceByHost.delete(entry.host);
    }
    rows.push({ host: entry.host, allowance: allowance ?? null });
  });

  allowanceByHost.forEach((allowance, host) => {
    rows.push({ host, allowance });
  });

  siteListEl.innerHTML = '';

  if (!rows.length) {
    const node = emptyTemplate.content.cloneNode(true);
    siteListEl.appendChild(node);
    scheduleNextRender();
    return;
  }

  rows
    .sort((a, b) => {
      if (Boolean(a.allowance) === Boolean(b.allowance)) {
        return a.host.localeCompare(b.host);
      }
      return a.allowance ? -1 : 1;
    })
    .forEach(({ host, allowance }) => {
      const item = document.createElement('li');
      item.className = `site-row ${allowance ? 'allowed' : 'blocked'}`;

      const title = document.createElement('div');
      title.className = 'site-name';
      title.textContent = host;

      const status = document.createElement('div');
      status.className = 'site-status';
      if (allowance) {
        const remainingMs = allowance.expiresAt - Date.now();
        const remainingText = formatRemainingTime(remainingMs);
        status.textContent = `Unblocked • ${remainingText}`;
      } else {
        status.textContent = 'Blocked';
      }

      item.append(title, status);

      if (allowance) {
        const actions = document.createElement('div');
        actions.className = 'site-actions';

        const reblockButton = document.createElement('button');
        reblockButton.type = 'button';
        reblockButton.className = 'action-button';
        reblockButton.textContent = 'Reblock now';
        reblockButton.addEventListener('click', () => {
          reblockAllowance(allowance, reblockButton).catch((error) => {
            console.error('Reblock handler failed', error);
            reblockButton.disabled = false;
            reblockButton.textContent = 'Reblock now';
          });
        });

        actions.appendChild(reblockButton);
        item.appendChild(actions);
      }

      siteListEl.appendChild(item);
    });

  scheduleNextRender();
}

function scheduleNextRender() {
  // Refresh countdowns roughly once a second while popup stays open.
  tickerId = window.setTimeout(renderList, 1000);
}

async function loadState() {
  try {
    const {
      blockedEntries = null,
      blockedHosts = [],
      allowances = []
    } = await chrome.storage.local.get(['blockedEntries', 'blockedHosts', 'allowances']);

    blockedEntriesState = normalizeBlockedEntries(blockedEntries, blockedHosts);
    allowancesState = normalizeAllowances(allowances).filter(isAllowanceActive);

    renderList();
  } catch (error) {
    console.error('Failed to load popup state', error);
    siteListEl.innerHTML = '';
    const fallback = document.createElement('li');
    fallback.className = 'empty';
    fallback.textContent = 'Unable to load current status.';
    siteListEl.appendChild(fallback);
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  let shouldRender = false;

  if (changes.blockedEntries || changes.blockedHosts) {
    const entries = changes.blockedEntries
      ? normalizeBlockedEntries(changes.blockedEntries.newValue || [])
      : normalizeBlockedEntries(null, changes.blockedHosts.newValue || []);
    blockedEntriesState = entries;
    shouldRender = true;
  }

  if (changes.allowances) {
    allowancesState = normalizeAllowances(changes.allowances.newValue || []).filter(isAllowanceActive);
    shouldRender = true;
  }

  if (shouldRender) {
    renderList();
  }
});

openManagerButton.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') }, () => {
    if (chrome.runtime.lastError) {
      console.error('Failed to open manager', chrome.runtime.lastError);
    }
  });
});

loadState().catch((error) => {
  console.error('Initial popup load failed', error);
});
