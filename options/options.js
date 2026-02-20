document.getElementById('token').value = '';
browser.storage.local.get('githubToken').then(({ githubToken }) => {
  if (githubToken) document.getElementById('token').value = githubToken;
});

document.getElementById('save').addEventListener('click', async () => {
  const token = document.getElementById('token').value.trim();
  const status = document.getElementById('status');
  if (!token) {
    status.textContent = 'Enter a token.';
    status.className = 'status err';
    return;
  }
  await browser.storage.local.set({ githubToken: token });
  status.textContent = 'Saved.';
  status.className = 'status ok';
});
