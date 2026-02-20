/**
 * Content script on github.com: inject "Add to sidebar" / "Pin workflow" buttons.
 */

function getRepoFromPath() {
  const match = window.location.pathname.match(/^\/([^/]+)\/([^/]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function isPRPage() {
  return /^\/[^/]+\/[^/]+\/pull\/\d+/.test(window.location.pathname);
}

function getPRNumber() {
  const m = window.location.pathname.match(/\/pull\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function isActionsWorkflowPage() {
  // Match /owner/repo/actions/workflows/<anything> (GitHub uses .yml/.yaml or workflow name slug)
  return /^\/[^/]+\/[^/]+\/actions\/workflows\/[^/]+/.test(window.location.pathname);
}

function getWorkflowPathFromURL() {
  const m = window.location.pathname.match(/\/actions\/workflows\/(.+)$/);
  return m ? decodeURIComponent(m[1]).replace(/\/$/, '') : null;
}

/** Try to find workflow file path from page (e.g. link to .github/workflows/foo.yml) when URL has no .yml */
function getWorkflowPathFromDOM() {
  const link = document.querySelector('a[href*=".github/workflows/"]');
  if (link) {
    const m = link.href.match(/\.github\/workflows\/([^/?#]+\.(?:yml|yaml))/);
    if (m) return m[1];
  }
  return null;
}

function send(type, payload = {}) {
  return browser.runtime.sendMessage({ type, ...payload });
}

function createButton(text, opts = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'gh-sidebar-extension-btn' + (opts.pinned ? ' pinned' : '');
  btn.textContent = text;
  return btn;
}

function addRepoToSidebar(owner, repo) {
  return send('ADD_TRACKED_REPO', { owner, repo });
}

function addPRToSidebar(owner, repo, pullNumber) {
  return send('ADD_PINNED_PR', { owner, repo, pullNumber });
}

function addWorkflowByPath(owner, repo, path) {
  return send('ADD_PINNED_WORKFLOW_BY_PATH', { owner, repo, path });
}

async function getPinnedPRs() {
  const pinned = await send('GET_PINNED_PRS');
  return pinned || {};
}

async function getPinnedWorkflows() {
  const pinned = await send('GET_PINNED_WORKFLOWS');
  return pinned || {};
}

function injectPRButtons() {
  if (!isPRPage()) return;
  const repo = getRepoFromPath();
  const prNum = getPRNumber();
  if (!repo || !prNum) return;

  const existing = document.querySelector('.gh-sidebar-extension-group');
  if (existing) return;

  const group = document.createElement('div');
  group.className = 'gh-sidebar-extension-group';
  group.style.display = 'inline-flex';
  group.style.alignItems = 'center';
  group.style.marginLeft = '8px';
  group.style.flexWrap = 'wrap';
  group.style.gap = '8px';

  const prBtn = createButton('Pin this PR in sidebar');
  const repoBtn = createButton('Add this repo to sidebar');

  getPinnedPRs().then(pinned => {
    const key = `${repo.owner}/${repo.repo}`;
    const list = pinned[key] || [];
    if (list.includes(prNum)) {
      prBtn.textContent = 'Pinned in sidebar';
      prBtn.classList.add('pinned');
      prBtn.disabled = true;
    }
  });

  prBtn.addEventListener('click', async () => {
    await addPRToSidebar(repo.owner, repo.repo, prNum);
    prBtn.textContent = 'Pinned in sidebar';
    prBtn.classList.add('pinned');
    prBtn.disabled = true;
  });

  repoBtn.addEventListener('click', async () => {
    await addRepoToSidebar(repo.owner, repo.repo);
    repoBtn.textContent = 'Added';
    repoBtn.disabled = true;
  });

  group.appendChild(prBtn);
  group.appendChild(repoBtn);

  const toolbarSelectors = [
    '.gh-header-actions',
    '[data-test-selector="pr-toolbar"]',
    '[data-testid="pr-toolbar"]',
    '.gh-header .flex-1.d-flex', // header row that holds title + actions
    '.Layout-main .d-flex.flex-wrap', // main layout button row
    '.pull-request-header .d-flex',
    '.gh-header-title',
  ];
  let target = null;
  for (const sel of toolbarSelectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) {
      target = el;
      break;
    }
  }
  if (target) {
    if (target.classList.contains('gh-header-title')) {
      if (target.parentNode) {
        const wrap = document.createElement('div');
        wrap.style.marginTop = '8px';
        wrap.appendChild(group);
        target.parentNode.insertBefore(wrap, target.nextSibling);
      }
    } else {
      target.appendChild(group);
    }
  }
}

function injectRepoButton() {
  const repo = getRepoFromPath();
  if (!repo || isPRPage() || isActionsWorkflowPage()) return;
  if (window.location.pathname !== `/${repo.owner}/${repo.repo}` && !window.location.pathname.startsWith(`/${repo.owner}/${repo.repo}/`)) return;

  const existing = document.querySelector('.gh-sidebar-extension-repo-btn');
  if (existing) return;

  const btn = createButton('Add this repo to sidebar');
  btn.className += ' gh-sidebar-extension-repo-btn';
  btn.style.marginLeft = '8px';

  const toolbar = document.querySelector('#repository-details-grid .mb-3, .pagehead-actions, [data-test-id="repository-nav"]');
  const fileListToolbar = document.querySelector('.file-navigation');
  const target = toolbar || fileListToolbar || document.querySelector('.UnderlineNav-body');
  if (target) {
    btn.addEventListener('click', async () => {
      await addRepoToSidebar(repo.owner, repo.repo);
      btn.textContent = 'Added';
      btn.disabled = true;
    });
    target.appendChild(btn);
  }
}

function injectWorkflowButton() {
  if (!isActionsWorkflowPage()) return;
  const repo = getRepoFromPath();
  let path = getWorkflowPathFromURL();
  if (!path) path = getWorkflowPathFromDOM();
  if (!repo || !path) return;

  const existing = document.querySelector('.gh-sidebar-extension-workflow-btn');
  if (existing) return;

  const btn = createButton('Pin this workflow in sidebar');
  btn.className += ' gh-sidebar-extension-workflow-btn';

  getPinnedWorkflows().then(pinned => {
    const key = `${repo.owner}/${repo.repo}`;
    const list = pinned[key] || [];
    if (list.some(w => w.path === path || w.path.endsWith('/' + path))) {
      btn.textContent = 'Pinned in sidebar';
      btn.classList.add('pinned');
      btn.disabled = true;
    }
  });

  btn.addEventListener('click', async () => {
    try {
      await addWorkflowByPath(repo.owner, repo.repo, path);
      btn.textContent = 'Pinned in sidebar';
      btn.classList.add('pinned');
      btn.disabled = true;
    } catch (e) {
      btn.textContent = 'Failed – try again';
    }
  });

  // Multiple selectors for GitHub's varying DOM; ensure button is visible
  const selectors = [
    '.pagehead-actions',
    '.ActionsWorkflowHeader',
    '[data-testid="workflow-header"]',
    '.subnav',
    '.mb-3',
    'main .d-flex', // header row in main
    '[data-testid="workflow-run-list"]', // workflow run list page header area
    '.Layout-main .clearfix',
    '.repository-content .d-flex.flex-wrap',
    'h1',
  ];
  let target = null;
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) {
      target = el;
      break;
    }
  }
  if (target) {
    const isHeading = target.tagName === 'H1';
    if (isHeading && target.parentNode) {
      const wrap = document.createElement('div');
      wrap.className = 'gh-sidebar-extension-workflow-wrap';
      wrap.style.marginBottom = '12px';
      wrap.appendChild(btn);
      target.parentNode.insertBefore(wrap, target.nextSibling);
    } else {
      target.appendChild(btn);
    }
  }
}

function run() {
  injectPRButtons();
  injectRepoButton();
  injectWorkflowButton();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', run);
} else {
  run();
}

const observer = new MutationObserver(() => {
  if (!document.querySelector('.gh-sidebar-extension-group') && isPRPage()) injectPRButtons();
  if (!document.querySelector('.gh-sidebar-extension-repo-btn') && !isPRPage() && !isActionsWorkflowPage()) injectRepoButton();
  if (!document.querySelector('.gh-sidebar-extension-workflow-btn') && isActionsWorkflowPage()) injectWorkflowButton();
});
observer.observe(document.body, { childList: true, subtree: true });

// Retry workflow button after a delay (GitHub may render workflow page content lazily)
if (isActionsWorkflowPage()) {
  setTimeout(() => {
    if (!document.querySelector('.gh-sidebar-extension-workflow-btn')) injectWorkflowButton();
  }, 1500);
  setTimeout(() => {
    if (!document.querySelector('.gh-sidebar-extension-workflow-btn')) injectWorkflowButton();
  }, 4000);
}
