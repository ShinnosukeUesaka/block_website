const domainEl = document.getElementById('blocked-domain');
const globalPolicyEl = document.getElementById('global-policy-text');
const sitePolicyEl = document.getElementById('site-policy-text');
const requestForm = document.getElementById('request-form');
const purposeField = document.getElementById('request-purpose');
const durationField = document.getElementById('request-duration');
const requestStatus = document.getElementById('request-status');
const submitButton = document.getElementById('submit-request');
const manageButton = document.getElementById('manage-btn');
const violationBanner = document.getElementById('violation-banner');
const timeDisplay = document.getElementById('time-display');
const REFRESH_DELAY_MS = 600;

function normalizeHost(host) {
  if (typeof host !== 'string') {
    return '';
  }
  return host.trim().replace(/^www\./, '').replace(/\.$/, '');
}

const searchParams = new URLSearchParams(window.location.search);
const blockedHost = normalizeHost(searchParams.get('blocked')) || extractDomain(document.referrer);
const originalUrl = deriveOriginalUrl();

function deriveOriginalUrl() {
  const referer = document.referrer;
  if (isHttpUrl(referer)) {
    return referer;
  }

  if (blockedHost) {
    return `https://${blockedHost}`;
  }

  return null;
}

function isHttpUrl(candidate) {
  if (!candidate) {
    return false;
  }

  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_error) {
    return false;
  }
}

function extractDomain(urlString) {
  if (!urlString) {
    return null;
  }
  try {
    const url = new URL(urlString);
    return normalizeHost(url.hostname);
  } catch (_error) {
    return null;
  }
}

function setBlockedDomainText(host) {
  domainEl.textContent = host || 'this site';
}

function setStatus(message, type) {
  requestStatus.textContent = message;
  requestStatus.className = `status-line ${type || ''}`.trim();
}

function normalizeBlockedEntries(rawEntries, fallbackHosts = []) {
  if (Array.isArray(rawEntries)) {
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

  if (Array.isArray(fallbackHosts) && fallbackHosts.length) {
    return fallbackHosts
      .map((host) => normalizeHost(host))
      .filter(Boolean)
      .map((host) => ({ host, policy: '' }));
  }

  return [];
}

async function loadPolicyOverview() {
  const {
    blockedEntries = [],
    blockedHosts = [],
    globalPolicy = ''
  } = await chrome.storage.local.get([
    'blockedEntries',
    'blockedHosts',
    'globalPolicy'
  ]);

  const entries = normalizeBlockedEntries(blockedEntries, blockedHosts);
  const match = entries.find((entry) => entry.host === blockedHost);

  globalPolicyEl.textContent = globalPolicy || 'No global policy defined.';
  if (match && match.policy) {
    sitePolicyEl.textContent = match.policy;
  } else {
    sitePolicyEl.textContent = 'No policy recorded for this site.';
  }
}

async function loadViolationMessage(host) {
  if (!host) {
    return;
  }

  const { monitoringViolations = {} } = await chrome.storage.local.get(['monitoringViolations']);
  const entry = monitoringViolations[host];

  if (!entry || !entry.message) {
    return;
  }

  violationBanner.textContent = entry.message;
  violationBanner.classList.remove('hidden');

  const nextViolations = { ...monitoringViolations };
  delete nextViolations[host];

  await chrome.storage.local.set({ monitoringViolations: nextViolations });
}

async function submitRequest(event) {
  event.preventDefault();

  if (!blockedHost) {
    setStatus('Unable to determine blocked host.', 'error');
    return;
  }

  const purpose = purposeField.value.trim();
  const durationMinutes = Number.parseInt(durationField.value, 10);

  if (!purpose) {
    setStatus('Please describe your purpose.', 'error');
    return;
  }

  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    setStatus('Enter a valid duration in minutes.', 'error');
    return;
  }

  setStatus('Submitting for review...', '');
  submitButton.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'process-unblock-request',
      payload: {
        host: blockedHost,
        purpose,
        durationMinutes
      }
    });

    if (!response) {
      throw new Error('No response from background script.');
    }

    if (response.status === 'approved') {
      setStatus(`Approved: ${response.reason}. Redirecting...`, 'success');
      const targetUrl = originalUrl;

      if (targetUrl) {
        setTimeout(() => {
          window.location.assign(targetUrl);
        }, REFRESH_DELAY_MS);
      }
    } else if (response.status === 'denied') {
      setStatus(`Denied: ${response.reason}`, 'error');
    } else if (response.status === 'error') {
      setStatus(response.message || 'Request failed.', 'error');
    } else {
      setStatus('Unexpected response received.', 'error');
    }
  } catch (error) {
    console.error('Failed to process request', error);
    setStatus('Something went wrong sending the request.', 'error');
  } finally {
    submitButton.disabled = false;
  }
}

manageButton.addEventListener('click', () => {
  window.location.href = chrome.runtime.getURL('manager.html');
});

requestForm.addEventListener('submit', (event) => {
  submitRequest(event).catch((error) => {
    console.error('Request submission failed', error);
    setStatus('Unable to submit request.', 'error');
    submitButton.disabled = false;
  });
});

// Time selector functionality
function updateTimeDisplay(minutes) {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours > 0 && remainingMinutes > 0) {
    timeDisplay.textContent = `${hours}h ${remainingMinutes}m`;
  } else if (hours > 0) {
    timeDisplay.textContent = `${hours}h`;
  } else {
    timeDisplay.textContent = `${minutes}m`;
  }
}

function updateActivePreset(selectedMinutes) {
  const presetButtons = document.querySelectorAll('.preset-btn');
  presetButtons.forEach(btn => {
    const minutes = parseInt(btn.dataset.minutes);
    if (minutes === selectedMinutes) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

// Handle preset button clicks
document.querySelectorAll('.preset-btn').forEach(button => {
  button.addEventListener('click', () => {
    const minutes = parseInt(button.dataset.minutes);
    durationField.value = minutes;
    updateTimeDisplay(minutes);
    updateActivePreset(minutes);
  });
});

// Handle slider input
durationField.addEventListener('input', (e) => {
  const minutes = parseInt(e.target.value);
  updateTimeDisplay(minutes);
  updateActivePreset(minutes);
});

// Initialize the time selector
updateTimeDisplay(parseInt(durationField.value));
updateActivePreset(parseInt(durationField.value));

setBlockedDomainText(blockedHost);
loadPolicyOverview().catch((error) => {
  console.error('Failed to load policy overview', error);
  sitePolicyEl.textContent = 'Unable to load policy details.';
});

loadViolationMessage(blockedHost).catch((error) => {
  console.error('Failed to load violation message', error);
});
