const RULE_ID_BASE = 1;
const REDIRECT_PATH = '/blocked.html';

async function readBlocklist() {
  const { blockedHosts = [] } = await chrome.storage.local.get('blockedHosts');
  return blockedHosts;
}

function toRule(host, offset) {
  return {
    id: RULE_ID_BASE + offset,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: {
        extensionPath: REDIRECT_PATH
      }
    },
    condition: {
      urlFilter: `||${host}`,
      resourceTypes: ['main_frame']
    }
  };
}

async function syncRules() {
  const hosts = await readBlocklist();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((rule) => rule.id);
  const addRules = hosts.map((host, index) => toRule(host, index));

  if (removeRuleIds.length || addRules.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  syncRules().catch((error) => console.error('Failed to sync rules on install', error));
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.blockedHosts) {
    syncRules().catch((error) => console.error('Failed to sync rules on change', error));
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') }, () => {
    if (chrome.runtime.lastError) {
      console.error('Failed to open manager page', chrome.runtime.lastError);
    }
  });
});

(async () => {
  try {
    await syncRules();
  } catch (error) {
    console.error('Failed to sync rules on startup', error);
  }
})();
