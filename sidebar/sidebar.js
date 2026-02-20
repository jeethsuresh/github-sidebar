/**
 * Sidebar UI: per-repo sections for My PRs, Others' PRs, Pinned Actions.
 */

const $ = id => document.getElementById(id);
const openOptions = $('open-options');
const goOptions = $('go-options');
const tokenWarning = $('token-warning');
const content = $('content');
const loading = $('loading');
const errorEl = $('error');
const reposEl = $('repos');

openOptions.href = goOptions.href = browser.runtime.getURL('options/options.html');
openOptions.target = '_blank';
goOptions.target = '_blank';

$('refresh-btn').addEventListener('click', () => refresh());

function showTokenWarning() {
  tokenWarning.classList.remove('hidden');
  content.classList.add('hidden');
  loading.classList.add('hidden');
  errorEl.classList.add('hidden');
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
  loading.classList.add('hidden');
}

function hideError() {
  errorEl.classList.add('hidden');
}

function setLoading(on) {
  if (on) loading.classList.remove('hidden');
  else loading.classList.add('hidden');
}

async function send(type, payload = {}) {
  return browser.runtime.sendMessage({ type, ...payload });
}

/** Parse workflow_dispatch inputs from YAML string (minimal parser for our needs) */
function parseWorkflowInputs(yaml) {
  const inputs = {};
  const match = yaml.match(/workflow_dispatch:[\s\S]*?(?=\n\w|\n\n|$)/);
  if (!match) return inputs;
  const block = match[0];
  const inputsMatch = block.match(/inputs:[\s\S]*?(?=\n\s*\n|\n  \w|\n  [^\s]|$)/);
  if (!inputsMatch) return inputs;
  const inputBlock = inputsMatch[0];
  let name, desc, required, defaultVal, type;
  const lines = inputBlock.split('\n');
  for (const line of lines) {
    const indent = (line.match(/^\s*/) || [])[0].length;
    const keyMatch = line.match(/^\s*(\w+):\s*(.*)$/);
    if (!keyMatch) continue;
    const [, key, rest] = keyMatch;
    const val = rest.replace(/^['"]|['"]$/g, '').trim();
    if (indent === 6) {
      if (name) inputs[name] = { description: desc, required: required !== false, default: defaultVal, type: type || 'string' };
      name = key;
      desc = undefined;
      required = true;
      defaultVal = undefined;
      type = 'string';
    }
    if (indent >= 8 && name) {
      if (key === 'description') desc = val;
      else if (key === 'required') required = val !== 'false' && val !== 'false';
      else if (key === 'default') defaultVal = val;
      else if (key === 'type') type = val;
    }
  }
  if (name) inputs[name] = { description: desc, required: required !== false, default: defaultVal, type: type || 'string' };
  return inputs;
}

/** Build list of repos to show: tracked + any repo that has pinned PRs or workflows */
async function getReposToShow() {
  const [tracked, pinnedPRs, pinnedWorkflows] = await Promise.all([
    send('GET_TRACKED_REPOS'),
    send('GET_PINNED_PRS'),
    send('GET_PINNED_WORKFLOWS'),
  ]);
  const set = new Set(tracked || []);
  Object.keys(pinnedPRs || {}).forEach(k => set.add(k));
  Object.keys(pinnedWorkflows || {}).forEach(k => set.add(k));
  return Array.from(set).sort();
}

function formatDays(createdAt) {
  const days = Math.floor((Date.now() - new Date(createdAt)) / (24 * 60 * 60 * 1000));
  if (days === 0) return 'Today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

function getMergeableLabel(mergeableState, isDraft) {
  if (isDraft) return { class: 'neutral', title: 'Draft PR', text: 'Draft' };
  if (mergeableState === 'clean') return { class: 'success', title: 'No conflicts with base branch', text: 'Ready to merge' };
  if (mergeableState === 'dirty' || mergeableState === 'blocked' || mergeableState === 'unstable') return { class: 'danger', title: 'Has conflicts or checks failing', text: 'Not mergeable' };
  if (mergeableState === 'behind') return { class: 'neutral', title: 'Branch is behind base', text: 'Update branch' };
  if (mergeableState === 'unknown' || mergeableState === '') return { class: 'neutral', title: 'Mergeability is being computed', text: 'Checking…' };
  return { class: 'neutral', title: `Merge state: ${mergeableState}`, text: mergeableState };
}

const CI_CHECK_SVG = '<svg class="ci-icon ci-success" aria-hidden="true" height="16" viewBox="0 0 16 16" width="16"><path fill="currentColor" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>';
const CI_X_SVG = '<svg class="ci-icon ci-failure" aria-hidden="true" height="16" viewBox="0 0 16 16" width="16"><path fill="currentColor" d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>';
const CI_PENDING_SVG = '<svg class="ci-icon ci-pending" aria-hidden="true" height="16" viewBox="0 0 16 16" width="16"><path fill="currentColor" d="M8 4a.75.75 0 0 1 .75.75v2.5h2.5a.75.75 0 0 1 0 1.5h-3.25A.75.75 0 0 1 8 8V4.75A.75.75 0 0 1 8 4Z"/><path fill="currentColor" d="M8 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-1.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"/></svg>';

function renderPR(pr, repoKey, options = {}) {
  const { unresolved = 0, ciStatus, isPinned } = options;
  const [owner, repo] = repoKey.split('/');
  const href = `https://github.com/${owner}/${repo}/pull/${pr.number}`;
  const additions = pr.additions ?? 0;
  const deletions = pr.deletions ?? 0;
  const sizeStr = `+${additions} / -${deletions}`;
  const mergeableState = (pr.mergeable_state || '').toLowerCase();
  const mergeableLabel = getMergeableLabel(mergeableState, pr.draft);
  const ci = typeof ciStatus === 'object' && ciStatus !== null ? ciStatus : { status: ciStatus };
  const ciStatusVal = ci.status;
  const failedJobNames = ci.failedJobNames || [];
  const failedCount = failedJobNames.length;
  const badges = [];
  if (unresolved > 0) badges.push(`<span class="badge danger">${unresolved} unresolved</span>`);
  if (ciStatusVal === 'success') badges.push(`<span class="badge success ci-badge" title="CI passed">${CI_CHECK_SVG}</span>`);
  else if (ciStatusVal === 'pending') badges.push(`<span class="badge neutral ci-badge" title="CI pending">${CI_PENDING_SVG}</span>`);
  else if (ciStatusVal === 'failure') {
    const title = failedCount > 0 ? `Failing: ${failedJobNames.join(', ')}` : 'CI failing';
    const countPart = failedCount > 0 ? ` <span class="ci-fail-count">${failedCount}</span>` : '';
    badges.push(`<span class="badge danger ci-badge" title="${escapeHtml(title)}">${CI_X_SVG}${countPart}</span>`);
  }
  if (mergeableLabel) badges.push(`<span class="badge ${mergeableLabel.class}" title="${escapeHtml(mergeableLabel.title)}">${escapeHtml(mergeableLabel.text)}</span>`);

  const meta = [
    sizeStr,
    formatDays(pr.created_at),
    ...badges,
  ].join(' ');
  const pinBtn = isPinned
    ? `<button type="button" class="unpin-btn" data-owner="${owner}" data-repo="${repo}" data-number="${pr.number}">Unpin</button>`
    : '';
  return `<div class="pr-row">` +
    `<a href="${href}" target="_blank" class="pr-row-link">` +
    `<span class="pr-title">#${pr.number} ${escapeHtml(pr.title || '')}</span>` +
    `</a>${pinBtn}` +
    `<div class="pr-meta">${meta}</div>` +
    `</div>`;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function renderRepoSection(repoKey, data) {
  const [owner, repo] = repoKey.split('/');
  const repoUrl = `https://github.com/${owner}/${repo}`;
  let html = `
    <div class="repo-section" data-repo="${escapeHtml(repoKey)}">
      <div class="repo-section-header">
        <a href="${repoUrl}" target="_blank">${escapeHtml(repoKey)}</a>
        <button type="button" class="remove-repo-btn" data-repo="${escapeHtml(repoKey)}" title="Remove repo from sidebar">×</button>
      </div>
      <div class="repo-section-body">
  `;
  if (data.myPRs && data.myPRs.length > 0) {
    html += '<div class="section-title">My open PRs</div>';
    data.myPRs.forEach(pr => {
      html += renderPR(pr, repoKey, {
        unresolved: data.unresolvedMap && data.unresolvedMap[pr.number],
        ciStatus: data.ciMap && data.ciMap[pr.number],
        isPinned: false,
      });
    });
  }
  if (data.otherPRs && data.otherPRs.length > 0) {
    html += '<div class="section-title">Review / Pinned</div>';
    data.otherPRs.forEach(pr => {
      const isPinned = (data.pinnedPRs || []).includes(pr.number);
      html += renderPR(pr, repoKey, {
        unresolved: data.unresolvedMap && data.unresolvedMap[pr.number],
        ciStatus: data.ciMap && data.ciMap[pr.number],
        isPinned,
      });
    });
  }
  if (data.workflows && data.workflows.length > 0) {
    html += '<div class="section-title">Pinned Actions</div>';
    data.workflows.forEach(w => {
      html += `
        <div class="workflow-row" data-owner="${escapeHtml(owner)}" data-repo="${escapeHtml(repo)}" data-workflow-id="${w.id}" data-name="${escapeHtml(w.name)}" data-path="${escapeHtml(w.path)}">
          <span class="workflow-name">${escapeHtml(w.name)}</span>
          <div class="workflow-path">${escapeHtml(w.path)}</div>
        </div>
      `;
    });
  }
  if (!data.myPRs?.length && !data.otherPRs?.length && !data.workflows?.length) {
    html += '<div class="section-title" style="color:#57606a;">No PRs or actions</div>';
  }
  html += '</div></div>';
  return html;
}

async function fetchRepoData(repoKey, login, pinnedPRs, pinnedWorkflows) {
  const [owner, repo] = repoKey.split('/');
  const myPRs = await send('GET_MY_OPEN_PRS', { owner, repo, login }).catch(() => []);
  const reviewerPRs = await send('GET_PRS_WHERE_I_AM_REVIEWER', { owner, repo, login }).catch(() => []);
  const pinnedNumbers = pinnedPRs[repoKey] || [];
  const otherByNumber = new Map(reviewerPRs.map(p => [p.number, p]));
  await Promise.all(pinnedNumbers.filter(n => !otherByNumber.has(n)).map(async (n) => {
    const pr = await send('GET_PR', { owner, repo, number: n }).catch(() => null);
    if (pr) otherByNumber.set(n, pr);
  }));
  const otherPRs = Array.from(otherByNumber.values());
  let allPRs = [...myPRs, ...otherPRs];
  // Fetch full PR for mergeable_state and additions/deletions (list API does not include them)
  allPRs = await Promise.all(allPRs.map(pr =>
    send('GET_PR', { owner, repo, number: pr.number }).then(full => {
      if (!full) return pr;
      return {
        ...pr,
        ...full,
        mergeable: full.mergeable,
        mergeable_state: full.mergeable_state ?? pr.mergeable_state,
        additions: full.additions ?? pr.additions ?? 0,
        deletions: full.deletions ?? pr.deletions ?? 0,
      };
    }).catch(() => pr)
  ));
  // Unpin and drop closed/merged PRs so they are removed from the sidebar
  for (const num of pinnedNumbers) {
    const pr = allPRs.find(p => p.number === num);
    if (pr && pr.state !== 'open') {
      await send('REMOVE_PINNED_PR', { owner, repo, pullNumber: num });
    }
  }
  allPRs = allPRs.filter(pr => pr.state === 'open');
  const myPRsOpen = allPRs.filter(pr => pr.user && pr.user.login === login);
  const otherPRsOpen = allPRs.filter(pr => (pr.user && pr.user.login) !== login);
  const pinnedNumbersStillOpen = pinnedNumbers.filter(n => otherPRsOpen.some(pr => pr.number === n));
  const unresolvedMap = {};
  const ciMap = {};
  await Promise.all(allPRs.map(async (pr) => {
    const [unresolved, status] = await Promise.all([
      send('GET_UNRESOLVED_REVIEW_COUNT', { owner, repo, prNumber: pr.number }).catch(() => 0),
      pr.head?.sha ? send('GET_COMMIT_STATUS', { owner, repo, ref: pr.head.sha }).catch(() => null) : Promise.resolve(null),
    ]);
    unresolvedMap[pr.number] = unresolved;
    if (status) {
      const checkRuns = status.checkRuns || [];
      const failedJobs = (checkRuns || []).filter(c => c.conclusion === 'failure').map(c => c.name || 'Job');
      const passed = (c) => c.conclusion === 'success' || c.conclusion === 'neutral' || c.conclusion === 'skipped';
      const allPassed = checkRuns.length > 0 && checkRuns.every(passed);
      const anyFailed = failedJobs.length > 0;
      const pending = checkRuns.some(c => c.status === 'in_progress' || c.conclusion === null);
      if (anyFailed) ciMap[pr.number] = { status: 'failure', failedJobNames: failedJobs };
      else if (pending || checkRuns.length === 0) ciMap[pr.number] = { status: status.status?.state === 'success' ? 'success' : 'pending' };
      else ciMap[pr.number] = allPassed ? { status: 'success' } : { status: 'pending' };
    }
  }));
  const workflows = pinnedWorkflows[repoKey] || [];
  return {
    myPRs: myPRsOpen,
    otherPRs: otherPRsOpen,
    pinnedPRs: pinnedNumbersStillOpen,
    unresolvedMap,
    ciMap,
    workflows,
  };
}

function openWorkflowModal(owner, repo, workflowId, name, path) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        Run: ${escapeHtml(name)}
        <button type="button" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body">
        <label>Ref (branch or tag)</label>
        <input type="text" id="wf-ref" value="main" placeholder="main">
        <div id="wf-inputs"></div>
      </div>
      <div class="modal-footer">
        <button type="button" class="cancel">Cancel</button>
        <button type="button" class="primary run-btn">Run</button>
      </div>
    </div>
  `;
  const refInput = overlay.querySelector('#wf-ref');
  const inputsContainer = overlay.querySelector('#wf-inputs');
  const close = () => overlay.remove();

  overlay.querySelector('.modal-header button').addEventListener('click', close);
  overlay.querySelector('.cancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  getWorkflowFile(owner, repo, path).then(raw => {
    const inputs = parseWorkflowInputs(raw);
    Object.entries(inputs).forEach(([inputName, spec]) => {
      const label = document.createElement('label');
      label.textContent = inputName + (spec.required ? ' *' : '') + (spec.description ? ` — ${spec.description}` : '');
      const input = document.createElement('input');
      input.type = spec.type === 'boolean' ? 'checkbox' : (spec.type === 'number' ? 'number' : 'text');
      input.id = `wf-in-${inputName}`;
      input.name = inputName;
      if (spec.type !== 'boolean' && spec.default !== undefined && spec.default !== '') input.value = spec.default;
      if (spec.type === 'boolean') input.checked = spec.default === 'true' || spec.default === true;
      inputsContainer.appendChild(label);
      inputsContainer.appendChild(input);
    });
  }).catch(() => {});

  overlay.querySelector('.run-btn').addEventListener('click', async () => {
    const ref = refInput.value.trim() || 'main';
    const inputEls = inputsContainer.querySelectorAll('[id^="wf-in-"]');
    const inputs = {};
    inputEls.forEach(el => {
      const name = el.name;
      if (el.type === 'checkbox') inputs[name] = el.checked ? 'true' : 'false';
      else if (el.value) inputs[name] = el.value;
    });
    try {
      await send('DISPATCH_WORKFLOW', { owner, repo, workflowId, ref, inputs });
      close();
    } catch (e) {
      alert('Dispatch failed: ' + e.message);
    }
  });

  document.body.appendChild(overlay);
}

async function getWorkflowFile(owner, repo, path) {
  return send('GET_WORKFLOW_FILE', { owner, repo, path });
}

function delegateUnpin(e) {
  const btn = e.target.closest('.unpin-btn');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const { owner, repo, number } = btn.dataset;
  send('REMOVE_PINNED_PR', { owner, repo, pullNumber: parseInt(number, 10) }).then(refresh);
}

function delegateRemoveRepo(e) {
  const btn = e.target.closest('.remove-repo-btn');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const repoKey = btn.dataset.repo;
  send('REMOVE_REPO_FROM_SIDEBAR', { repoKey }).then(refresh);
}

function delegateWorkflowClick(e) {
  const row = e.target.closest('.workflow-row');
  if (!row) return;
  const { owner, repo, workflowId, name, path } = row.dataset;
  openWorkflowModal(owner, repo, workflowId, name, path);
}

async function refresh() {
  const hasToken = await send('GET_TOKEN').then(r => r && r.token);
  if (!hasToken) {
    showTokenWarning();
    return;
  }
  tokenWarning.classList.add('hidden');
  content.classList.remove('hidden');
  setLoading(true);
  hideError();
  try {
    const login = await send('GET_AUTH_USER');
    const repos = await getReposToShow();
    const [pinnedPRs, pinnedWorkflows] = await Promise.all([
      send('GET_PINNED_PRS'),
      send('GET_PINNED_WORKFLOWS'),
    ]);
    if (repos.length === 0) {
      reposEl.innerHTML = '<p style="padding:16px;color:#57606a;">Open a GitHub repo or a pull request page: open a GitHub repo and use “Add this repo to sidebar” in the page, or pin a PR or workflow from a PR/Actions page.</p>';
      setLoading(false);
      return;
    }
    const dataByRepo = {};
    await Promise.all(repos.map(async (repoKey) => {
      dataByRepo[repoKey] = await fetchRepoData(repoKey, login, pinnedPRs, pinnedWorkflows);
    }));
    reposEl.innerHTML = repos.map(rk => renderRepoSection(rk, dataByRepo[rk])).join('');
    reposEl.addEventListener('click', delegateUnpin);
    reposEl.addEventListener('click', delegateWorkflowClick);
    reposEl.addEventListener('click', delegateRemoveRepo);
  } catch (err) {
    showError(err.message || 'Failed to load');
  } finally {
    setLoading(false);
  }
}

refresh();

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.githubToken || changes.pinnedPRs || changes.pinnedWorkflows || changes.trackedRepos)) {
    refresh();
  }
});
