const form = document.getElementById('add-form');
const input = document.getElementById('new-domain');
const statusEl = document.getElementById('status');
const blockedList = document.getElementById('blocked-list');
const emptyTemplate = document.getElementById('empty-template');

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

function showStatus(message, type = 'success') {
  statusEl.textContent = message;
  statusEl.className = `status-message ${type}`;
  if (message) {
    setTimeout(() => {
      statusEl.textContent = '';
      statusEl.className = 'status-message';
    }, 2500);
  }
}

async function readBlocklist() {
  const { blockedHosts = [] } = await chrome.storage.local.get('blockedHosts');
  return blockedHosts;
}

async function writeBlocklist(hosts) {
  await chrome.storage.local.set({ blockedHosts: hosts });
}

function renderEmptyState() {
  blockedList.innerHTML = '';
  const node = emptyTemplate.content.cloneNode(true);
  blockedList.appendChild(node);
}

function renderList(hosts) {
  if (!hosts.length) {
    renderEmptyState();
    return;
  }

  blockedList.innerHTML = '';
  for (const host of hosts) {
    const listItem = document.createElement('li');
    listItem.dataset.host = host;

    const span = document.createElement('span');
    span.textContent = host;

    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.type = 'button';
    removeBtn.classList.add('secondary');
    removeBtn.addEventListener('click', () => removeHost(host));

    listItem.append(span, removeBtn);
    blockedList.appendChild(listItem);
  }
}

async function refresh() {
  const hosts = await readBlocklist();
  renderList(hosts);
}

async function addHost(event) {
  event.preventDefault();
  const value = input.value;

  const normalized = normalizeEntry(value);
  if (!normalized) {
    showStatus('Enter a valid domain.', 'error');
    return;
  }

  const hosts = await readBlocklist();
  if (hosts.includes(normalized)) {
    showStatus(`${normalized} is already blocked.`, 'error');
    input.value = '';
    return;
  }

  const nextHosts = [...hosts, normalized];
  await writeBlocklist(nextHosts);
  input.value = '';
  showStatus(`${normalized} added to block list.`);
  renderList(nextHosts);
}

async function removeHost(host) {
  const hosts = await readBlocklist();
  const nextHosts = hosts.filter((item) => item !== host);
  await writeBlocklist(nextHosts);
  showStatus(`${host} removed.`);
  renderList(nextHosts);
}

form.addEventListener('submit', (event) => {
  addHost(event).catch((error) => {
    console.error('Failed to add domain', error);
    showStatus('Unable to add domain.', 'error');
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.blockedHosts) {
    refresh().catch((error) => {
      console.error('Failed to refresh list', error);
    });
  }
});

refresh().catch((error) => {
  console.error('Failed to load block list', error);
  renderEmptyState();
  showStatus('Unable to load block list.', 'error');
});
