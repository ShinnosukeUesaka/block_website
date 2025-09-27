function extractDomain(urlString) {
  if (!urlString) {
    return null;
  }
  try {
    const url = new URL(urlString);
    return url.hostname;
  } catch (_error) {
    return null;
  }
}

function setBlockedDomainText() {
  const domainEl = document.getElementById('blocked-domain');
  const referrerDomain = extractDomain(document.referrer);

  if (referrerDomain) {
    domainEl.textContent = referrerDomain;
  } else {
    domainEl.textContent = 'A blocked site';
  }
}

function navigateToManager() {
  const nextUrl = chrome.runtime.getURL('manager.html');
  window.location.href = nextUrl;
}

document.getElementById('manage-btn').addEventListener('click', () => {
  navigateToManager();
});

setBlockedDomainText();
