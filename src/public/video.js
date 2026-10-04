// Video Converter UI. Kept separate from the Photo Watermarker script; shares
// only the page shell, sign-in, and the escapeHtml helper.
(function () {
  const $ = id => document.getElementById(id);
  const JOB_KEY = 'videoConverterJobId';
  const STEPS = ['v-step-input', 'v-step-ready', 'v-step-processing', 'v-step-complete'];

  const STATUS = {
    waiting: { label: 'Waiting', icon: '○', cls: 'text-gray-400' },
    downloading: { label: 'Downloading', icon: '⟳', cls: 'text-blue-600' },
    'waiting-for-limit': { label: 'Waiting for Google limit (retries hourly)', icon: '◷', cls: 'text-amber-600' },
    analyzing: { label: 'Analyzing', icon: '⟳', cls: 'text-blue-600' },
    remuxing: { label: 'Remuxing', icon: '⟳', cls: 'text-blue-600' },
    'queued-for-conversion': { label: 'Waiting to convert', icon: '⟳', cls: 'text-blue-600' },
    converting: { label: 'Converting', icon: '⟳', cls: 'text-blue-600' },
    validating: { label: 'Checking', icon: '⟳', cls: 'text-blue-600' },
    uploading: { label: 'Uploading', icon: '⟳', cls: 'text-blue-600' },
    complete: { label: 'Complete', icon: '✓', cls: 'text-emerald-600' },
    failed: { label: 'Failed', icon: '✕', cls: 'text-red-600' },
    skipped: { label: 'Skipped', icon: '–', cls: 'text-gray-500' },
    cancelled: { label: 'Cancelled', icon: '–', cls: 'text-gray-500' }
  };

  let scan = null; // last /scan response
  let pollTimer = null;
  let lastResult = null;

  const store = {
    get() { try { return localStorage.getItem(JOB_KEY); } catch (_) { return null; } },
    set(v) { try { localStorage.setItem(JOB_KEY, v); } catch (_) { /* private mode */ } },
    clear() { try { localStorage.removeItem(JOB_KEY); } catch (_) { /* private mode */ } }
  };

  function show(step) {
    STEPS.forEach(id => $(id).classList.toggle('hidden', id !== step));
  }

  function formatBytes(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
  }

  function formatTime(seconds) {
    if (seconds == null) return '—';
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${String(m).padStart(2, '0')}:${sec}`;
  }

  async function api(url, body) {
    const res = await fetch(url, body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
    return data;
  }

  // ---- Step 1: scan -------------------------------------------------------

  $('v-scan-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('v-scan-btn');
    btn.disabled = true;
    btn.textContent = 'Looking for videos…';
    try {
      scan = await api('/api/video/scan', {
        folderUrl: $('v-folder-url').value,
        includeSubfolders: $('v-include-subfolders').checked
      });
      renderReady();
      show('v-step-ready');
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Find Videos';
    }
  });

  function renderReady() {
    $('v-folder-title').textContent = scan.folderName;
    $('v-video-count').textContent = scan.videoCount;
    $('v-video-size').textContent = scan.totalBytes ? `(${formatBytes(scan.totalBytes)} total)` : '';
    $('v-ignored').textContent = scan.ignoredCount ? `${scan.ignoredCount} other file(s) in the folder are not videos and will be ignored.` : '';
    $('v-video-list').innerHTML = scan.videos.map(v =>
      `<li><label class="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" class="v-pick rounded border-gray-300 w-4 h-4" value="${escapeHtml(v.id)}" checked>
        ${escapeHtml(v.name)} <span class="text-gray-400">${formatBytes(v.size)}</span>
      </label></li>`).join('');
    updateSelectionCount();
    $('v-output-name').textContent = scan.outputFolderName;
    $('v-duplicate-choice').classList.add('hidden');
    $('v-ready-actions').classList.remove('hidden');
    $('v-convert-btn').disabled = scan.videoCount === 0;
    $('v-convert-btn').classList.toggle('opacity-50', scan.videoCount === 0);
  }

  // Untick videos in "Show videos" to convert only some of them.
  function selectedIds() {
    return [...document.querySelectorAll('.v-pick')].filter(b => b.checked).map(b => b.value);
  }

  function updateSelectionCount() {
    const picked = selectedIds().length;
    const total = scan ? scan.videoCount : 0;
    $('v-video-count').textContent = picked === total ? total : `${picked} of ${total}`;
    $('v-convert-btn').disabled = picked === 0;
    $('v-convert-btn').classList.toggle('opacity-50', picked === 0);
  }

  $('v-video-list').addEventListener('change', updateSelectionCount);

  $('v-reset-btn').addEventListener('click', () => {
    scan = null;
    show('v-step-input');
  });

  // ---- Step 2: start (with duplicate-folder protection) -------------------

  $('v-convert-btn').addEventListener('click', () => {
    if (scan && scan.existingOutputFolders && scan.existingOutputFolders.length) {
      $('v-existing-name').textContent = scan.existingOutputFolders[0].name;
      $('v-duplicate-choice').classList.remove('hidden');
      $('v-ready-actions').classList.add('hidden');
      return;
    }
    start({ outputMode: 'new' });
  });
  $('v-choice-new').addEventListener('click', () => start({ outputMode: 'new' }));
  $('v-choice-existing').addEventListener('click', () => start({ outputMode: 'existing' }));
  $('v-choice-cancel').addEventListener('click', () => {
    $('v-duplicate-choice').classList.add('hidden');
    $('v-ready-actions').classList.remove('hidden');
  });

  // Guards against a second click while the first request is in flight: each
  // click would otherwise create its own output folder and its own job.
  let starting = false;
  const startButtons = () => [$('v-convert-btn'), $('v-choice-new'), $('v-choice-existing')];

  async function start(options) {
    if (starting) return;
    starting = true;
    startButtons().forEach(b => { b.disabled = true; b.classList.add('opacity-50'); });
    const convertBtn = $('v-convert-btn');
    const originalLabel = convertBtn.textContent;
    convertBtn.textContent = 'Starting…';

    const picked = selectedIds();
    const body = {
      folderUrl: $('v-folder-url').value,
      includeSubfolders: $('v-include-subfolders').checked,
      ...(scan && picked.length < scan.videoCount ? { fileIds: picked } : {}),
      ...options
    };
    try {
      const data = await api('/api/video/convert', body);
      store.set(data.jobId);
      beginPolling(data.jobId);
    } catch (err) {
      if (err.status === 409 && err.data && err.data.needsChoice) {
        scan.existingOutputFolders = err.data.existingOutputFolders;
        starting = false;
        startButtons().forEach(b => { b.disabled = false; b.classList.remove('opacity-50'); });
        convertBtn.textContent = originalLabel;
        $('v-convert-btn').click();
        return;
      }
      alert(err.message);
    } finally {
      starting = false;
      startButtons().forEach(b => { b.disabled = false; b.classList.remove('opacity-50'); });
      convertBtn.textContent = originalLabel;
    }
  }

  // ---- Step 3: progress ---------------------------------------------------

  function beginPolling(jobId) {
    clearTimeout(pollTimer);
    $('v-count').textContent = '0 / 0';
    $('v-progress-bar').style.width = '0%';
    $('v-file-list').innerHTML = '';
    $('v-cancel-btn').disabled = false;
    $('v-cancel-btn').textContent = 'Stop converting';
    show('v-step-processing');

    const poll = async () => {
      try {
        const job = await api(`/api/video/jobs/${encodeURIComponent(jobId)}`);
        renderProgress(job);
        if (job.done) {
          pollTimer = null;
          store.clear();
          renderComplete(job);
          show('v-step-complete');
          return;
        }
        pollTimer = setTimeout(poll, 1000);
      } catch (err) {
        if (err.status === 404) {
          // The server restarted or the job expired.
          pollTimer = null;
          store.clear();
          alert('This conversion is no longer being tracked (the server may have restarted). Any videos already uploaded are in the output folder; you can run the folder again and choose "Reprocess" to finish the rest.');
          show('v-step-input');
          return;
        }
        pollTimer = setTimeout(poll, 3000); // temporary network hiccup: keep trying
      }
    };
    poll();
  }

  function renderProgress(job) {
    $('v-count').textContent = `${job.processed} / ${job.total}`;
    $('v-progress-bar').style.width = `${job.overallPercent}%`;
    const current = job.current;
    $('v-current').textContent = current ? current.name : (job.done ? 'Finishing…' : 'Preparing…');
    $('v-current-status').textContent = current ? `${(STATUS[current.status] || STATUS.waiting).label}…` : (job.cancelling ? 'Stopping…' : '—');
    $('v-current-progress').textContent = current ? `${current.progress || 0}%` : '—';
    const waiting = job.files.find(f => f.status === 'waiting-for-limit');
    $('v-elapsed').textContent = `Elapsed ${formatTime(job.elapsedMs / 1000)}` +
      (job.active.length > 1 ? ` • ${job.active.length} videos in progress` : '') +
      (waiting ? ` • ${waiting.reason} You can leave this running.` : '');
    $('v-file-list').innerHTML = job.files.map(f => {
      const s = STATUS[f.status] || STATUS.waiting;
      const busy = s.icon === '⟳';
      return `<li class="flex justify-between gap-3">
        <span class="truncate"><span class="${s.cls} inline-block w-4 ${busy ? 'animate-spin' : ''}">${s.icon}</span> ${escapeHtml(f.name)}</span>
        <span class="${s.cls} whitespace-nowrap">${s.label}${busy && f.progress ? ` ${f.progress}%` : ''}</span>
      </li>`;
    }).join('');
  }

  $('v-cancel-btn').addEventListener('click', async () => {
    const jobId = store.get();
    if (!jobId || !confirm('Stop converting? Videos already uploaded stay in the output folder.')) return;
    $('v-cancel-btn').disabled = true;
    $('v-cancel-btn').textContent = 'Stopping…';
    try {
      await api(`/api/video/jobs/${encodeURIComponent(jobId)}/cancel`, {});
    } catch (err) {
      alert(err.message);
    }
  });

  // ---- Step 4: result -----------------------------------------------------

  function renderComplete(job) {
    lastResult = job;
    const problems = job.failed > 0 || job.error;
    $('v-complete-icon').textContent = problems ? '!' : '✓';
    $('v-complete-icon').className = `w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-3 text-2xl font-bold ${problems ? 'bg-amber-50 text-amber-600' : 'bg-emerald-50 text-emerald-600'}`;
    $('v-complete-title').textContent = job.error ? 'Conversion Stopped' : (job.cancelled ? 'Conversion Cancelled' : 'Conversion Complete');
    $('v-complete-summary').textContent = job.error
      ? job.error
      : `${job.total} videos processed.${job.flagged ? ` ${job.flagged} converted with notes to review (see the detailed report).` : ''}`;
    $('v-sum-total').textContent = job.total;
    $('v-sum-ok').textContent = job.successful;
    $('v-sum-failed').textContent = job.failed;
    $('v-sum-skipped').textContent = job.skipped + job.cancelled;
    $('v-output-folder-name').textContent = job.outputFolderName;
    $('v-output-folder-link').href = job.outputFolderLink;

    const failed = job.files.filter(f => f.status === 'failed');
    $('v-failed-container').classList.toggle('hidden', failed.length === 0);
    $('v-failed-list').innerHTML = failed.map(f => `
      <div class="bg-white rounded border border-red-100 p-3">
        <p class="font-semibold text-gray-900">${escapeHtml(f.name)}</p>
        <p class="text-xs text-gray-700 mt-1"><strong>Stage:</strong> ${escapeHtml(f.error.stage)} &nbsp; <strong>Reason:</strong> ${escapeHtml(f.error.category)}</p>
        <p class="text-xs text-gray-700 mt-1"><strong>What to do:</strong> ${escapeHtml(f.error.recommendedAction)}</p>
        <details class="mt-1"><summary class="text-xs text-gray-500 cursor-pointer">Technical details</summary>
          <pre class="text-[11px] text-gray-600 whitespace-pre-wrap break-all mt-1">${escapeHtml(f.error.message)}${f.error.technical ? '\n\n' + escapeHtml(f.error.technical) : ''}</pre>
        </details>
      </div>`).join('');

    $('v-report').innerHTML = job.files.map(renderReportItem).join('');
  }

  function row(label, src, out) {
    const changed = out !== undefined && String(src) !== String(out);
    return `<tr><td class="pr-3 text-gray-500">${label}</td><td class="pr-3">${escapeHtml(src)}</td>${out !== undefined ? `<td class="${changed ? 'text-amber-700 font-medium' : ''}">${escapeHtml(out)}</td>` : ''}</tr>`;
  }

  function renderReportItem(f) {
    const s = STATUS[f.status] || STATUS.waiting;
    const src = f.sourceSummary;
    const out = f.outputSummary;
    const strategy = { remux: 'Remuxed (no re-encoding)', 'remux-video': 'Video copied, audio converted', encode: 'Re-encoded' }[f.strategy] || '';
    let table = '';
    if (src) {
      const audio = x => (x.audioCodecs.length ? x.audioCodecs.join(', ').toUpperCase() : 'none');
      const fps = x => (x.fps ? `${x.fps} fps` : '—');
      table = `<table class="text-xs mt-2"><thead><tr><th></th><th class="text-left pr-3 text-gray-500 font-medium">Source</th>${out ? '<th class="text-left text-gray-500 font-medium">Output</th>' : ''}</tr></thead><tbody>
        ${row('Resolution', src.resolution, out ? out.resolution : undefined)}
        ${row('Orientation', src.orientation, out ? out.orientation : undefined)}
        ${row('Frame rate', fps(src), out ? fps(out) : undefined)}
        ${row('Duration', formatTime(src.duration), out ? formatTime(out.duration) : undefined)}
        ${row('Video', (src.videoCodec || '').toUpperCase() + (src.hdr ? ` (${src.hdr})` : ''), out ? (out.videoCodec || '').toUpperCase() : undefined)}
        ${row('Audio', audio(src), out ? audio(out) : undefined)}
        ${row('File size', formatBytes(src.size), out ? formatBytes(out.size) : undefined)}
      </tbody></table>`;
    }
    const list = (items, cls) => (items && items.length ? `<ul class="text-xs ${cls} mt-1 list-disc ml-4">${items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : '');
    return `<div class="border border-gray-200 rounded-lg p-3">
      <div class="flex justify-between gap-2">
        <span class="font-medium text-gray-900 truncate"><span class="${s.cls}">${s.icon}</span> ${escapeHtml(f.name)}${f.outputName && f.status === 'complete' ? ` → ${escapeHtml(f.outputName)}` : ''}</span>
        <span class="text-xs ${s.cls} whitespace-nowrap">${s.label}${f.flagged ? ' (review notes)' : ''}</span>
      </div>
      ${strategy ? `<p class="text-xs text-gray-600 mt-1">${escapeHtml(strategy)}${f.planDescription ? ` — ${escapeHtml(f.planDescription)}` : ''}</p>` : ''}
      ${f.reason ? `<p class="text-xs text-gray-600 mt-1">${escapeHtml(f.reason)}</p>` : ''}
      ${table}
      ${list(f.warnings, 'text-amber-700')}
      ${list(f.notes, 'text-gray-600')}
    </div>`;
  }

  $('v-retry-btn').addEventListener('click', async () => {
    if (!lastResult) return;
    const fileIds = lastResult.files.filter(f => f.status === 'failed').map(f => f.sourceId);
    const btn = $('v-retry-btn');
    btn.disabled = true;
    try {
      const data = await api('/api/video/convert', {
        folderUrl: $('v-folder-url').value || `https://drive.google.com/drive/folders/${lastResult.sourceFolderId}`,
        includeSubfolders: $('v-include-subfolders').checked,
        fileIds,
        outputFolderId: lastResult.outputFolderId
      });
      store.set(data.jobId);
      beginPolling(data.jobId);
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('v-another-btn').addEventListener('click', () => {
    scan = null;
    lastResult = null;
    $('v-folder-url').value = '';
    show('v-step-input');
  });

  // ---- Entry point --------------------------------------------------------

  let engineChecked = false;
  window.VideoConverter = {
    onOpen() {
      if (!engineChecked) {
        engineChecked = true;
        api('/api/video/engine').then(e => $('v-engine-warning').classList.toggle('hidden', e.available)).catch(() => {});
      }
      // Resume watching a conversion that was running when the page was closed.
      const jobId = store.get();
      if (jobId && !pollTimer) beginPolling(jobId);
    }
  };
  if (location.hash === '#video' && !$('app-view').classList.contains('hidden')) window.VideoConverter.onOpen();
})();
