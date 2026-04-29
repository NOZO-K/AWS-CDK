const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const uploadBtn = document.getElementById("uploadBtn");
const clearBtn = document.getElementById("clearBtn");
const statusEl = document.getElementById("status");
const selectedList = document.getElementById("selectedList");

/** @type {File[]} */
let selectedFiles = [];

function setStatus(msg) {
  statusEl.textContent = msg || "";
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`;
}

function renderSelected() {
  selectedList.innerHTML = "";
  for (const f of selectedFiles) {
    const li = document.createElement("li");
    li.className = "item";

    const name = document.createElement("div");
    name.className = "item__name";
    name.textContent = f.name;

    const meta = document.createElement("div");
    meta.className = "item__meta";
    meta.textContent = formatBytes(f.size);

    li.appendChild(name);
    li.appendChild(meta);
    selectedList.appendChild(li);
  }

  const has = selectedFiles.length > 0;
  uploadBtn.disabled = !has;
  clearBtn.disabled = !has;
}

function addFiles(fileList) {
  const incoming = Array.from(fileList || []);
  if (incoming.length === 0) return;

  const map = new Map(selectedFiles.map((f) => [f.name, f]));
  for (const f of incoming) map.set(f.name, f);

  selectedFiles = Array.from(map.values());
  renderSelected();
  setStatus(`${incoming.length} file(s) added.`);
}

dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => addFiles(e.target.files));

dropzone.addEventListener("dragenter", (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropzone.classList.add("dropzone--active");
});
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropzone.classList.add("dropzone--active");
});
dropzone.addEventListener("dragleave", (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropzone.classList.remove("dropzone--active");
});
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropzone.classList.remove("dropzone--active");
  addFiles(e.dataTransfer.files);
});

clearBtn.addEventListener("click", () => {
  selectedFiles = [];
  fileInput.value = "";
  renderSelected();
  setStatus("Selection cleared.");
});

uploadBtn.addEventListener("click", async () => {
  if (selectedFiles.length === 0) return;
  uploadBtn.disabled = true;
  clearBtn.disabled = true;
  setStatus("Uploading…");

  const results = [];
  for (const f of selectedFiles) {
    const form = new FormData();
    form.append("file", f, f.name);
    const res = await fetch("/upload", { method: "POST", body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      results.push(`Error ${f.name}: ${err.detail || res.status}`);
      continue;
    }
    const ok = await res.json();
    results.push(`OK ${ok.filename} (${ok.bytes} bytes)`);
  }

  selectedFiles = [];
  fileInput.value = "";
  renderSelected();

  setStatus(results.join(" · "));
});

(async function init() {
  renderSelected();
})();

