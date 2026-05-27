const statusEl = document.getElementById("status");

function setStatus(msg, isErr) {
  statusEl.textContent = msg;
  statusEl.className = isErr ? "err" : "ok";
}

chrome.storage.local.get(["SA_EMAIL", "SA_KEY", "SLACK_TOKEN"], (s) => {
  if (s.SA_EMAIL)    document.getElementById("sa_email").value    = s.SA_EMAIL;
  if (s.SA_KEY)      document.getElementById("sa_key").value      = s.SA_KEY;
  if (s.SLACK_TOKEN) document.getElementById("slack_token").value = s.SLACK_TOKEN;
});

document.getElementById("save").addEventListener("click", () => {
  const sa_email    = document.getElementById("sa_email").value.trim();
  const sa_key      = document.getElementById("sa_key").value.trim();
  const slack_token = document.getElementById("slack_token").value.trim();

  if (!sa_email || !sa_key || !slack_token) {
    setStatus("All three fields are required.", true);
    return;
  }
  if (!sa_key.includes("BEGIN PRIVATE KEY")) {
    setStatus("Private key doesn't look right — make sure to include the BEGIN/END lines.", true);
    return;
  }

  chrome.storage.local.set({ SA_EMAIL: sa_email, SA_KEY: sa_key, SLACK_TOKEN: slack_token }, () => {
    if (chrome.runtime.lastError) {
      setStatus("Error saving: " + chrome.runtime.lastError.message, true);
      return;
    }
    setStatus("Saved. This setup page won't appear again on this computer.");
  });
});
