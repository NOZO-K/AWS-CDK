const tbody = document.getElementById("tbody");
const statusEl = document.getElementById("status");
const deleteSelectedBtn = document.getElementById("deleteSelectedBtn");
const checkAll = document.getElementById("checkAll");

function setStatus(msg) {
  statusEl.textContent = msg || "";
}

function selectedFilenames() {
  return Array.from(tbody.querySelectorAll("input[type=checkbox][data-filename]:checked")).map(
    (el) => el.getAttribute("data-filename"),
  );
}

function updateBulkState() {
  const selected = selectedFilenames();
  deleteSelectedBtn.disabled = selected.length === 0;

  const all = Array.from(tbody.querySelectorAll("input[type=checkbox][data-filename]"));
  const allChecked = all.length > 0 && all.every((el) => el.checked);
  checkAll.checked = allChecked;
  checkAll.indeterminate = selected.length > 0 && !allChecked;
}

async function apiListFiles() {
  const res = await fetch("/files", { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET /files ${res.status}`);
  return await res.json();
}

async function apiDeleteFile(filename) {
  const res = await fetch(`/files/${encodeURIComponent(filename)}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `DELETE /files/${filename} ${res.status}`);
  }
}

function renderRows(files) {
  tbody.innerHTML = "";

  for (const filename of files) {
    const tr = document.createElement("tr");

    const tdCheck = document.createElement("td");
    tdCheck.className = "colCheck";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.setAttribute("data-filename", filename);
    cb.addEventListener("change", updateBulkState);
    tdCheck.appendChild(cb);

    const tdName = document.createElement("td");
    tdName.className = "mono";
    tdName.textContent = filename;

    const tdActions = document.createElement("td");
    tdActions.className = "colActions";
    const del = document.createElement("button");
    del.className = "chip chip--danger";
    del.type = "button";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete ${filename}?`)) return;
      del.disabled = true;
      try {
        await apiDeleteFile(filename);
        setStatus(`Deleted: ${filename}`);
        await refresh();
      } catch (e) {
        setStatus(`Delete failed: ${e.message || e}`);
        del.disabled = false;
      }
    });
    tdActions.appendChild(del);

    tr.appendChild(tdCheck);
    tr.appendChild(tdName);
    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  }

  updateBulkState();
}

async function refresh() {
  setStatus("Loading…");
  try {
    const data = await apiListFiles();
    const files = (data.files || []).filter((f) => f !== ".keep");
    renderRows(files);
    setStatus(`${files.length} file(s).`);
  } catch (e) {
    setStatus(`Failed to load /files: ${e.message || e}`);
  }
}

checkAll.addEventListener("change", () => {
  const all = Array.from(tbody.querySelectorAll("input[type=checkbox][data-filename]"));
  for (const el of all) el.checked = checkAll.checked;
  updateBulkState();
});

deleteSelectedBtn.addEventListener("click", async () => {
  const selected = selectedFilenames();
  if (selected.length === 0) return;
  if (!confirm(`Delete ${selected.length} file(s)?`)) return;

  deleteSelectedBtn.disabled = true;
  checkAll.disabled = true;
  setStatus("Deleting…");

  const errors = [];
  for (const name of selected) {
    try {
      await apiDeleteFile(name);
    } catch (e) {
      errors.push(`${name}: ${e.message || e}`);
    }
  }

  checkAll.disabled = false;
  await refresh();

  if (errors.length) setStatus(`Done with errors: ${errors.join(" · ")}`);
});

refresh();

