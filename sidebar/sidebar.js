/**
 * Sidebar UI: per-repo sections for My issues, Pinned issues, My PRs, Others' PRs, Pinned Actions.
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

/** Build list of repos to show: tracked + any repo that has pinned PRs, issues, or workflows */
async function getReposToShow() {
  const [tracked, pinnedPRs, pinnedIssues, pinnedWorkflows] = await Promise.all([
    send('GET_TRACKED_REPOS'),
    send('GET_PINNED_PRS'),
    send('GET_PINNED_ISSUES'),
    send('GET_PINNED_WORKFLOWS'),
  ]);
  const set = new Set(tracked || []);
  Object.keys(pinnedPRs || {}).forEach(k => set.add(k));
  Object.keys(pinnedIssues || {}).forEach(k => set.add(k));
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
  const { unresolved = 0, ciStatus, isPinned, unread = false } = options;
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
  if (unread) badges.push(`<span class="badge unread-badge" title="New commits or comments">Unread</span>`);
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

function renderIssue(issue, repoKey, options = {}) {
  const { isPinned, unread = false } = options;
  const [owner, repo] = repoKey.split('/');
  const href = `https://github.com/${owner}/${repo}/issues/${issue.number}`;
  const labels = (issue.labels || []).slice(0, 3).map(l => l.name);
  const labelBadges = labels.map(name => `<span class="badge neutral">${escapeHtml(name)}</span>`).join(' ');
  const unreadBadge = unread ? '<span class="badge unread-badge" title="New comments">Unread</span> ' : '';
  const pinBtn = isPinned
    ? `<button type="button" class="unpin-issue-btn" data-owner="${owner}" data-repo="${repo}" data-number="${issue.number}">Unpin</button>`
    : '';
  return `<div class="issue-row">` +
    `<a href="${href}" target="_blank" class="pr-row-link">` +
    `<span class="pr-title">#${issue.number} ${escapeHtml(issue.title || '')}</span>` +
    `</a>${pinBtn}` +
    `<div class="pr-meta">${unreadBadge}${formatDays(issue.created_at)}${labelBadges ? ' ' + labelBadges : ''}</div>` +
    `</div>`;
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
  if (data.myIssues && data.myIssues.length > 0) {
    html += '<div class="section-title">My open issues</div>';
    data.myIssues.forEach(issue => {
      html += renderIssue(issue, repoKey, { isPinned: false, unread: data.unreadIssueMap && data.unreadIssueMap[issue.number] });
    });
  }
  if (data.otherIssues && data.otherIssues.length > 0) {
    html += '<div class="section-title">Pinned issues</div>';
    data.otherIssues.forEach(issue => {
      const isPinned = (data.pinnedIssues || []).includes(issue.number);
      html += renderIssue(issue, repoKey, { isPinned, unread: data.unreadIssueMap && data.unreadIssueMap[issue.number] });
    });
  }
  if (data.myPRs && data.myPRs.length > 0) {
    html += '<div class="section-title">My open PRs</div>';
    data.myPRs.forEach(pr => {
      html += renderPR(pr, repoKey, {
        unresolved: data.unresolvedMap && data.unresolvedMap[pr.number],
        ciStatus: data.ciMap && data.ciMap[pr.number],
        isPinned: false,
        unread: data.unreadPRMap && data.unreadPRMap[pr.number],
      });
    });
  }
  const pinnedPRList = (data.otherPRs || []).filter(pr => (data.pinnedPRs || []).includes(pr.number));
  const reviewPRList = (data.otherPRs || []).filter(pr => !(data.pinnedPRs || []).includes(pr.number));
  if (pinnedPRList.length > 0) {
    html += '<div class="section-title">Pinned PRs</div>';
    pinnedPRList.forEach(pr => {
      html += renderPR(pr, repoKey, {
        unresolved: data.unresolvedMap && data.unresolvedMap[pr.number],
        ciStatus: data.ciMap && data.ciMap[pr.number],
        isPinned: true,
        unread: data.unreadPRMap && data.unreadPRMap[pr.number],
      });
    });
  }
  if (reviewPRList.length > 0) {
    html += '<div class="section-title">Review</div>';
    reviewPRList.forEach(pr => {
      html += renderPR(pr, repoKey, {
        unresolved: data.unresolvedMap && data.unresolvedMap[pr.number],
        ciStatus: data.ciMap && data.ciMap[pr.number],
        isPinned: false,
        unread: data.unreadPRMap && data.unreadPRMap[pr.number],
      });
    });
  }
  if (data.workflows && data.workflows.length > 0) {
    html += '<div class="section-title">Pinned Actions</div>';
    data.workflows.forEach(w => {
      const runs = (data.workflowRunsMap && data.workflowRunsMap[w.id]) || [];
      const runsHtml = runs.length > 0
        ? runs.map(r => `<a href="${escapeHtml(r.html_url)}" target="_blank" class="workflow-run-item" title="Started by @${escapeHtml(r.actor)}">Run #${r.run_number}</a> <span class="workflow-run-status workflow-run-status-${escapeHtml(r.status)}">${escapeHtml(r.status)}</span>`).join('<br>')
        : '';
      html += `
        <div class="workflow-row" data-owner="${escapeHtml(owner)}" data-repo="${escapeHtml(repo)}" data-workflow-id="${w.id}" data-name="${escapeHtml(w.name)}" data-path="${escapeHtml(w.path)}">
          <span class="workflow-name">${escapeHtml(w.name)}</span>
          <div class="workflow-path">${escapeHtml(w.path)}</div>
          <div class="workflow-runs">${runsHtml}</div>
        </div>
      `;
    });
  }
  if (!data.myIssues?.length && !data.otherIssues?.length && !data.myPRs?.length && !data.otherPRs?.length && !data.workflows?.length) {
    html += '<div class="section-title" style="color:#57606a;">No issues, PRs or actions</div>';
  }
  html += '</div></div>';
  return html;
}

async function fetchRepoData(repoKey, login, pinnedPRs, pinnedIssues, pinnedWorkflows, lastViewedPRs, lastViewedIssues) {
  const [owner, repo] = repoKey.split('/');
  const [myPRs, myIssues, reviewerPRs] = await Promise.all([
    send('GET_MY_OPEN_PRS', { owner, repo, login }).catch(() => []),
    send('GET_MY_OPEN_ISSUES', { owner, repo, login }).catch(() => []),
    send('GET_PRS_WHERE_I_AM_REVIEWER', { owner, repo, login }).catch(() => []),
  ]);
  const pinnedNumbers = pinnedPRs[repoKey] || [];
  const pinnedIssueNumbers = pinnedIssues[repoKey] || [];
  const otherByNumber = new Map(reviewerPRs.map(p => [p.number, p]));
  await Promise.all(pinnedNumbers.filter(n => !otherByNumber.has(n)).map(async (n) => {
    const pr = await send('GET_PR', { owner, repo, number: n }).catch(() => null);
    if (pr) otherByNumber.set(n, pr);
  }));
  const otherPRs = Array.from(otherByNumber.values());
  const otherIssuesByNumber = new Map();
  await Promise.all(pinnedIssueNumbers.map(async (n) => {
    const issue = await send('GET_ISSUE', { owner, repo, number: n }).catch(() => null);
    if (issue && !issue.pull_request) otherIssuesByNumber.set(n, issue);
  }));
  const otherIssues = Array.from(otherIssuesByNumber.values());
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

  const unreadPRMap = {};
  const lastViewedPR = lastViewedPRs && lastViewedPRs[repoKey];
  await Promise.all(allPRs.map(async (pr) => {
    const lastViewed = lastViewedPR && lastViewedPR[String(pr.number)];
    if (lastViewed == null) return;
    const activity = await send('GET_PR_LAST_ACTIVITY', { owner, repo, number: pr.number, headSha: pr.head?.sha }).catch(() => ({}));
    const { lastCommitAt, lastCommentAt } = activity;
    unreadPRMap[pr.number] = (lastCommitAt != null && lastCommitAt > lastViewed) || (lastCommentAt != null && lastCommentAt > lastViewed);
  }));

  const workflows = pinnedWorkflows[repoKey] || [];
  const workflowRunsMap = {};
  await Promise.all(workflows.map(async (w) => {
    const runs = await send('GET_WORKFLOW_RUNS', { owner, repo, workflowId: w.id }).catch(() => []);
    workflowRunsMap[w.id] = runs || [];
  }));
  const openIssuesOnly = (arr) => arr.filter(i => i.state === 'open');
  const myIssuesOpen = openIssuesOnly(myIssues);
  const otherIssuesOpen = openIssuesOnly(otherIssues);
  const pinnedIssueNumbersStillOpen = pinnedIssueNumbers.filter(n => otherIssuesOpen.some(i => i.number === n));
  for (const num of pinnedIssueNumbers) {
    const issue = otherIssues.find(i => i.number === num);
    if (issue && issue.state !== 'open') {
      await send('REMOVE_PINNED_ISSUE', { owner, repo, issueNumber: num });
    }
  }

  const unreadIssueMap = {};
  const lastViewedIssue = lastViewedIssues && lastViewedIssues[repoKey];
  const allIssues = [...myIssuesOpen, ...otherIssuesOpen];
  await Promise.all(allIssues.map(async (issue) => {
    const lastViewed = lastViewedIssue && lastViewedIssue[String(issue.number)];
    if (lastViewed == null) return;
    const lastCommentAt = await send('GET_ISSUE_LAST_ACTIVITY', { owner, repo, number: issue.number }).catch(() => null);
    unreadIssueMap[issue.number] = lastCommentAt != null && lastCommentAt > lastViewed;
  }));

  return {
    myIssues: myIssuesOpen,
    otherIssues: otherIssuesOpen,
    pinnedIssues: pinnedIssueNumbersStillOpen,
    myPRs: myPRsOpen,
    otherPRs: otherPRsOpen,
    pinnedPRs: pinnedNumbersStillOpen,
    unresolvedMap,
    ciMap,
    unreadPRMap,
    unreadIssueMap,
    workflows,
    workflowRunsMap,
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

function delegateUnpinIssue(e) {
  const btn = e.target.closest('.unpin-issue-btn');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const { owner, repo, number } = btn.dataset;
  send('REMOVE_PINNED_ISSUE', { owner, repo, issueNumber: parseInt(number, 10) }).then(refresh);
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
  if (e.target.closest('a.workflow-run-item')) return;
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
    const [pinnedIssues, lastViewedPRs, lastViewedIssues] = await Promise.all([
      send('GET_PINNED_ISSUES'),
      send('GET_LAST_VIEWED_PRS'),
      send('GET_LAST_VIEWED_ISSUES'),
    ]);
    if (repos.length === 0) {
      reposEl.innerHTML = '<p style="padding:16px;color:#57606a;">Open a GitHub repo, issue, or pull request page: use "Add this repo to sidebar" or "Pin this issue/PR" in the page, or pin a workflow from an Actions page.</p>';
      setLoading(false);
      return;
    }
    const dataByRepo = {};
    await Promise.all(repos.map(async (repoKey) => {
      dataByRepo[repoKey] = await fetchRepoData(repoKey, login, pinnedPRs, pinnedIssues, pinnedWorkflows, lastViewedPRs, lastViewedIssues);
    }));
    reposEl.innerHTML = repos.map(rk => renderRepoSection(rk, dataByRepo[rk])).join('');
    reposEl.addEventListener('click', delegateUnpin);
    reposEl.addEventListener('click', delegateUnpinIssue);
    reposEl.addEventListener('click', delegateWorkflowClick);
    reposEl.addEventListener('click', delegateRemoveRepo);
  } catch (err) {
    showError(err.message || 'Failed to load');
  } finally {
    setLoading(false);
  }
}

/** Update only workflow runs in the current DOM (no full refetch). Used for 1-min auto refresh. */
async function refreshWorkflowRunsOnly() {
  const hasToken = await send('GET_TOKEN').then(r => r && r.token);
  if (!hasToken) return;
  const repos = await getReposToShow();
  const pinnedWorkflows = await send('GET_PINNED_WORKFLOWS');
  if (repos.length === 0) return;
  const runsByRow = {};
  await Promise.all(repos.flatMap(repoKey => {
    const [owner, repo] = repoKey.split('/');
    const workflows = pinnedWorkflows[repoKey] || [];
    return workflows.map(async (w) => {
      const runs = await send('GET_WORKFLOW_RUNS', { owner, repo, workflowId: w.id }).catch(() => []);
      const key = `${repoKey}:${w.id}`;
      runsByRow[key] = runs;
    });
  }));
  reposEl.querySelectorAll('.workflow-row').forEach(row => {
    const { owner, repo, workflowId } = row.dataset;
    if (!owner || !repo || !workflowId) return;
    const key = `${owner}/${repo}:${workflowId}`;
    const runs = runsByRow[key] || [];
    const runsHtml = runs.length > 0
      ? runs.map(r => `<a href="${escapeHtml(r.html_url)}" target="_blank" class="workflow-run-item" title="Started by @${escapeHtml(r.actor)}">Run #${r.run_number}</a> <span class="workflow-run-status workflow-run-status-${escapeHtml(r.status)}">${escapeHtml(r.status)}</span>`).join('<br>')
      : '';
    const runsEl = row.querySelector('.workflow-runs');
    if (runsEl) runsEl.innerHTML = runsHtml;
  });
}

refresh();

const FIVE_MIN_MS = 5 * 60 * 1000;
const ONE_MIN_MS = 60 * 1000;
setInterval(refresh, FIVE_MIN_MS);
setInterval(refreshWorkflowRunsOnly, ONE_MIN_MS);

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.githubToken || changes.pinnedPRs || changes.pinnedIssues || changes.pinnedWorkflows || changes.trackedRepos)) {
    refresh();
  }
});
