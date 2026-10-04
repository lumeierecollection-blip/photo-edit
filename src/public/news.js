// Church News UI. Kept separate from the other tools; shares only the page
// shell, sign-in, and the escapeHtml helper.
(function () {
  const $ = id => document.getElementById(id);

  const STAGES = {
    queued: 'Waiting to start…',
    starting: 'Starting…',
    'extracting-audio': 'Reading the sound from the video…',
    'downloading-model': 'Downloading the speech model (first time only)…',
    transcribing: 'Writing down what is said…',
    'finding-posters': 'Finding the posters needed…',
    'downloading-browser': 'Downloading the studio renderer (first time only)…',
    'preparing-studio': 'Preparing the news studio…',
    rendering: 'Making the news video…',
    finishing: 'Finishing the video file…'
  };
  const JOB_NAMES = { transcribe: 'Transcription', preview: 'Preview', render: 'News video' };

  let projectId = null;
  let project = null;
  let posters = [];
  let pollTimer = null;
  let saveTimer = null;
  let lastJobKey = null;

  // ------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------

  async function api(url, { method = 'GET', body } = {}) {
    const res = await fetch(url, body === undefined ? { method } : {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      location.reload();
      throw new Error('Signed out.');
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  }

  function clock(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 MB';
    return `${(bytes / 1024 / 1024).toFixed(bytes > 1024 * 1024 * 100 ? 0 : 1)} MB`;
  }

  function projectUrl(path = '') {
    return `/api/news/projects/${projectId}${path}`;
  }

  // ------------------------------------------------------------------------
  // List view
  // ------------------------------------------------------------------------

  async function showList() {
    projectId = null;
    project = null;
    stopPolling();
    $('n-project-view').classList.add('hidden');
    $('n-list-view').classList.remove('hidden');
    $('n-player').removeAttribute('src');

    try {
      const status = await api('/api/news/status');
      $('n-ffmpeg-warning').classList.toggle('hidden', status.ffmpeg);
      const note = $('n-model-note');
      note.classList.toggle('hidden', status.modelDownloaded);
      note.textContent = 'The first video downloads the speech model once (about 140 MB). After that, transcription works without internet.';
    } catch (_) { /* shown elsewhere */ }

    try {
      const { projects } = await api('/api/news/projects');
      $('n-projects').innerHTML = projects.length ? projects.map(p => {
        const job = p.lastJob;
        const busy = job && !job.done;
        const badge = busy
          ? `<span class="text-xs text-rose-700">${escapeHtml(JOB_NAMES[job.type] || 'Working')}…</span>`
          : job && job.error && job.stage !== 'cancelled'
            ? '<span class="text-xs text-amber-700">Needs attention</span>'
            : '';
        return `<a href="#news/${p.id}" class="flex items-center justify-between gap-3 py-3 hover:bg-gray-50 -mx-2 px-2 rounded">
          <span class="min-w-0"><span class="block font-medium text-gray-900 truncate">${escapeHtml(p.name)}</span>
          <span class="block text-xs text-gray-500">${new Date(p.createdAt).toLocaleString()} · ${clock(p.durationSeconds)}</span></span>
          ${badge}</a>`;
      }).join('') : '<p class="text-gray-500 py-2">No news videos yet.</p>';
    } catch (err) {
      $('n-projects').innerHTML = `<p class="text-red-700 py-2">${escapeHtml(err.message)}</p>`;
    }
  }

  function uploadFile(file) {
    if (!file) return;
    $('n-upload').classList.remove('hidden');
    $('n-upload-name').textContent = `Uploading ${file.name} (${formatBytes(file.size)})`;
    $('n-upload-bar').style.width = '0%';
    $('n-upload-percent').textContent = '0%';
    $('n-file').disabled = true;

    const form = new FormData();
    form.append('video', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/news/projects');
    xhr.upload.onprogress = e => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      $('n-upload-bar').style.width = `${pct}%`;
      $('n-upload-percent').textContent = pct === 100 ? 'Checking video…' : `${pct}%`;
    };
    xhr.onload = () => {
      $('n-file').disabled = false;
      $('n-file').value = '';
      $('n-upload').classList.add('hidden');
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (_) { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && data.project) {
        location.hash = `#news/${data.project.id}`;
      } else {
        alert(data.error || `Upload failed (${xhr.status}).`);
      }
    };
    xhr.onerror = () => {
      $('n-file').disabled = false;
      $('n-upload').classList.add('hidden');
      alert('The upload was interrupted. Please try again.');
    };
    xhr.send(form);
  }

  // ------------------------------------------------------------------------
  // Google Drive import
  // ------------------------------------------------------------------------

  let driveVideos = [];
  let driveImportId = null;

  async function findDriveVideos() {
    const msg = $('n-drive-msg');
    msg.textContent = 'Looking in Google Drive…';
    $('n-drive-videos').innerHTML = '';
    try {
      const data = await api('/api/news/drive/list', { method: 'POST', body: { folderUrl: $('n-drive-url').value } });
      driveVideos = data.videos;
      msg.textContent = driveVideos.length ? `${driveVideos.length} video(s) in "${data.folderName}". Choose one:` : `No videos found in "${data.folderName}".`;
      $('n-drive-videos').innerHTML = driveVideos.map((v, i) =>
        `<button type="button" data-i="${i}" class="n-drive-pick w-full text-left py-2 hover:bg-gray-50 flex justify-between gap-3"><span class="truncate">${escapeHtml(v.name)}</span><span class="text-xs text-gray-500 flex-shrink-0">${v.size ? formatBytes(v.size) : ''}</span></button>`).join('');
    } catch (err) {
      msg.textContent = err.message;
    }
  }

  async function importDriveVideo(video) {
    $('n-drive-videos').innerHTML = '';
    $('n-drive-progress').classList.remove('hidden');
    $('n-drive-pname').textContent = `Downloading ${video.name}`;
    $('n-drive-bar').style.width = '0%';
    $('n-drive-ppct').textContent = '0%';
    try {
      const { importId } = await api('/api/news/drive/import', { method: 'POST', body: { fileId: video.id, name: video.name, size: video.size, md5Checksum: video.md5Checksum } });
      driveImportId = importId;
      for (;;) {
        await new Promise(r => setTimeout(r, 1500));
        const s = await api(`/api/news/drive/import/${importId}`);
        const pct = s.total ? Math.round((s.received / s.total) * 100) : 0;
        $('n-drive-bar').style.width = `${pct}%`;
        $('n-drive-ppct').textContent = s.stage === 'checking' ? 'Checking video…' : `${pct}%`;
        if (s.stage === 'done') { location.hash = `#news/${s.projectId}`; break; }
        if (s.stage === 'error' || s.stage === 'cancelled') { $('n-drive-msg').textContent = s.error; break; }
      }
    } catch (err) {
      $('n-drive-msg').textContent = err.message;
    }
    driveImportId = null;
    $('n-drive-progress').classList.add('hidden');
  }

  function describeBackground(bg) {
    if (!bg || !bg.images.length) return 'No pictures yet — the studio wall shows plain lights.';
    const posters = bg.images.filter(i => i.kind === 'poster').length;
    return `${bg.images.length - posters} photo(s) and ${posters} poster(s) from "${bg.folderName}".`;
  }

  async function getBackgroundPictures() {
    const msg = $('n-bg-msg');
    const id = projectId;
    msg.textContent = 'Starting…';
    try {
      await api(projectUrl('/background/drive'), { method: 'POST', body: { folderUrl: $('n-bg-url').value } });
      for (;;) {
        await new Promise(r => setTimeout(r, 1500));
        if (projectId !== id) return;
        const { import: imp, background } = await api(projectUrl('/background'));
        if (imp && imp.stage === 'error') { msg.textContent = imp.error; return; }
        if (imp && imp.stage === 'done') { msg.textContent = `Done: ${describeBackground(background)} Make a new preview to see them.`; return; }
        msg.textContent = imp && imp.total ? `Downloading picture ${imp.done + 1} of ${imp.total}…` : 'Looking in Google Drive…';
      }
    } catch (err) {
      msg.textContent = err.message;
    }
  }

  $('n-bg-get').addEventListener('click', getBackgroundPictures);
  $('n-drive-list').addEventListener('click', findDriveVideos);
  $('n-drive-url').addEventListener('keydown', e => { if (e.key === 'Enter') findDriveVideos(); });
  $('n-drive-videos').addEventListener('click', e => {
    const b = e.target.closest('.n-drive-pick');
    if (b) importDriveVideo(driveVideos[Number(b.dataset.i)]);
  });
  $('n-drive-cancel').addEventListener('click', () => {
    if (driveImportId) api(`/api/news/drive/import/${driveImportId}/cancel`, { method: 'POST' }).catch(() => {});
  });

  // ------------------------------------------------------------------------
  // Project view
  // ------------------------------------------------------------------------

  async function showProject(id) {
    const switching = projectId !== id;
    projectId = id;
    $('n-list-view').classList.add('hidden');
    $('n-project-view').classList.remove('hidden');
    if (switching) {
      lastJobKey = null;
      $('n-player').src = projectUrl('/source');
      $('n-transcript').innerHTML = '';
      $('n-posters').innerHTML = '';
    }
    await refresh({ full: true });
  }

  async function refresh({ full = false } = {}) {
    if (!projectId) return;
    const id = projectId;
    let data;
    try {
      data = await api(projectUrl());
    } catch (err) {
      if (id !== projectId) return;
      stopPolling();
      alert(err.message);
      location.hash = '#news';
      return;
    }
    if (id !== projectId) return;
    const previous = project;
    project = data;

    $('n-title').textContent = data.name;
    $('n-meta').textContent = `${clock(data.durationSeconds)} long · ${data.width}×${data.height} · added ${new Date(data.createdAt).toLocaleString()}`;
    $('n-no-audio').classList.toggle('hidden', data.hasAudio !== false);

    renderJob(data.job);

    const transcriptChanged = full || !previous || JSON.stringify(previous.transcript && previous.transcript.createdAt) !== JSON.stringify(data.transcript && data.transcript.createdAt);
    const postersChanged = full || !previous || (previous.posters && previous.posters.detectedAt) !== (data.posters && data.posters.detectedAt);
    if (transcriptChanged) renderTranscript(data.transcript);
    if (postersChanged && !saveTimer) {
      posters = data.posters ? data.posters.posters : [];
      renderPosters(data.posters);
    }
    // A finished transcription pre-fills the headlines on the server.
    const transcriptionJustFinished = previous && previous.job && !previous.job.done
      && previous.job.type === 'transcribe' && data.job && data.job.done;
    if (full || (transcriptionJustFinished && !studioTimer)) fillStudioForm(data.studio);
    renderOutputs(data);

    const busy = data.job && !data.job.done;
    if (busy) startPolling();
    else stopPolling();
  }

  function startPolling() {
    if (!pollTimer) pollTimer = setInterval(() => refresh(), 1500);
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function renderJob(job) {
    const box = $('n-job');
    const errorBox = $('n-job-error');
    if (!job) {
      box.classList.add('hidden');
      errorBox.classList.add('hidden');
      return;
    }
    const busy = !job.done;
    box.classList.toggle('hidden', !busy);
    errorBox.classList.toggle('hidden', !(job.done && job.error && job.stage !== 'cancelled'));

    if (busy) {
      const d = job.detail || {};
      let label = STAGES[job.stage] || 'Working…';
      let detail = '';
      let fraction = job.fraction || 0;
      if (job.stage === 'downloading-model' && d.totalBytes) {
        fraction = d.loadedBytes / d.totalBytes;
        detail = `${formatBytes(d.loadedBytes)} of ${formatBytes(d.totalBytes)}. If the internet drops, it continues where it stopped.`;
      } else if (job.stage === 'transcribing' && d.blocks) {
        detail = `Part ${d.block} of ${d.blocks}`;
        if (d.elapsedSeconds > 20 && fraction > 0.05) {
          const left = d.elapsedSeconds / fraction * (1 - fraction);
          detail += ` · about ${Math.max(1, Math.round(left / 60))} min left`;
        }
      } else if (job.stage === 'rendering' && d.totalFrames) {
        detail = `Frame ${d.renderedFrames || 0} of ${d.totalFrames}`;
      } else if (job.stage === 'queued') {
        detail = 'Another job is running; this starts when it finishes.';
      }
      $('n-job-label').textContent = `${JOB_NAMES[job.type] || ''}: ${label}`;
      $('n-job-bar').style.width = `${Math.round(Math.min(1, fraction) * 100)}%`;
      $('n-job-detail').textContent = detail;
    } else if (job.error && job.stage !== 'cancelled') {
      $('n-job-error-title').textContent = `${JOB_NAMES[job.type] || 'The job'} did not finish.`;
      $('n-job-error-text').textContent = job.error;
      $('n-retry-btn').dataset.type = job.type;
    }

    ['n-preview-btn', 'n-render-btn'].forEach(b => { $(b).disabled = busy; $(b).classList.toggle('opacity-50', busy); });
  }

  // ------------------------------------------------------------------------
  // Transcript
  // ------------------------------------------------------------------------

  function renderTranscript(transcript) {
    const box = $('n-transcript');
    const hasText = transcript && transcript.segments && transcript.segments.length;
    ['n-txt-download', 'n-srt-download'].forEach(a => $(a).classList.toggle('hidden', !hasText));
    $('n-txt-download').href = projectUrl('/export/transcript.txt');
    $('n-srt-download').href = projectUrl('/export/transcript.srt');
    if (!transcript) {
      box.innerHTML = `<p class="text-gray-500">${project && project.hasAudio === false ? 'No sound track.' : 'The transcript appears here when it is ready.'}</p>`;
      return;
    }
    if (!hasText) {
      box.innerHTML = '<p class="text-gray-500">No speech was found in this video.</p>';
      return;
    }
    box.innerHTML = transcript.segments.map(s => `<p><button type="button" class="n-seek font-mono text-xs text-rose-700 hover:underline mr-2" data-t="${s.start}">${clock(s.start)}</button>${escapeHtml(s.text)}</p>`).join('');
  }

  function seek(seconds) {
    const player = $('n-player');
    player.currentTime = Math.max(0, Number(seconds) - 0.5);
    player.play().catch(() => {});
    player.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ------------------------------------------------------------------------
  // Posters
  // ------------------------------------------------------------------------

  function renderPosters(data) {
    const empty = $('n-posters-empty');
    $('n-poster-count').textContent = posters.length ? `(${posters.length})` : '';
    $('n-posters-download').href = projectUrl('/export/posters.txt');
    $('n-posters-download').classList.toggle('hidden', !posters.length);
    $('n-redetect').classList.toggle('hidden', !(project && project.transcript));

    if (!posters.length) {
      empty.classList.remove('hidden');
      empty.textContent = !project || !project.transcript
        ? 'The poster list appears here once the video has been transcribed.'
        : 'No announcements with a date, time, place or sign-up were found. Use "+ Add poster" if one is needed.';
    } else {
      empty.classList.add('hidden');
    }

    $('n-posters').innerHTML = posters.map((p, i) => posterCard(p, i)).join('');

    const other = (data && data.otherAnnouncements) || [];
    $('n-other-wrap').classList.toggle('hidden', !other.length);
    $('n-other').innerHTML = other.map(o => `<li class="bg-gray-50 border border-gray-200 rounded-lg p-3">
      <button type="button" class="n-seek font-mono text-xs text-rose-700 hover:underline mr-2" data-t="${o.start}">${clock(o.start)}</button>${escapeHtml(o.quote)}</li>`).join('');
  }

  function posterCard(p, i) {
    const badge = p.confidence === 'high'
      ? '<span class="text-[11px] font-semibold uppercase tracking-wider text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">Clear</span>'
      : p.confidence === 'medium'
        ? '<span class="text-[11px] font-semibold uppercase tracking-wider text-amber-700 bg-amber-50 px-2 py-0.5 rounded">Check details</span>'
        : '<span class="text-[11px] font-semibold uppercase tracking-wider text-gray-600 bg-gray-100 px-2 py-0.5 rounded">Added by you</span>';
    const checks = (p.checks || []).map(c => `<li>${escapeHtml(c)}</li>`).join('');
    return `<div class="border ${p.done ? 'border-emerald-200 bg-emerald-50/40' : 'border-gray-200'} rounded-xl p-4" data-i="${i}">
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-xs font-semibold text-gray-400">POSTER ${i + 1}</span>${badge}
          ${p.start != null ? `<button type="button" class="n-seek text-xs text-rose-700 hover:underline" data-t="${p.start}">▶ said at ${clock(p.start)}</button>` : ''}
        </div>
        <div class="flex items-center gap-3 flex-shrink-0">
          <label class="flex items-center text-xs text-gray-700"><input type="checkbox" class="n-p-done rounded border-gray-300 w-4 h-4 mr-1" ${p.done ? 'checked' : ''}>Poster made</label>
          <button type="button" class="n-p-remove text-xs text-gray-400 hover:text-red-700" title="Remove this poster">Remove</button>
        </div>
      </div>
      <div class="grid gap-3 sm:grid-cols-5 mt-3">
        <div class="sm:col-span-2">
          <label class="block text-xs font-medium text-gray-600 mb-1">Poster headline</label>
          <input type="text" class="n-p-headline w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-semibold" value="${escapeHtml(p.posterText.headline)}">
          <label class="block text-xs font-medium text-gray-600 mb-1 mt-3">Notes for the designer</label>
          <textarea class="n-p-notes w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" rows="2" placeholder="Optional">${escapeHtml(p.notes || '')}</textarea>
        </div>
        <div class="sm:col-span-3">
          <label class="block text-xs font-medium text-gray-600 mb-1">Details on the poster (one per line)</label>
          <textarea class="n-p-lines w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" rows="5">${escapeHtml(p.posterText.lines.join('\n'))}</textarea>
        </div>
      </div>
      ${checks ? `<ul class="mt-2 text-xs text-amber-800 list-disc ml-5">${checks}</ul>` : ''}
      ${p.quote ? `<p class="mt-3 text-xs text-gray-500 italic">“${escapeHtml(p.quote)}”</p>` : ''}
    </div>`;
  }

  function readPosterCards() {
    document.querySelectorAll('#n-posters [data-i]').forEach(card => {
      const p = posters[Number(card.dataset.i)];
      if (!p) return;
      p.posterText = {
        headline: card.querySelector('.n-p-headline').value,
        lines: card.querySelector('.n-p-lines').value.split('\n').map(l => l.trim()).filter(Boolean)
      };
      p.title = p.posterText.headline;
      p.notes = card.querySelector('.n-p-notes').value;
      p.done = card.querySelector('.n-p-done').checked;
    });
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePosters, 800);
  }

  async function savePosters() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!projectId) return;
    readPosterCards();
    try {
      await api(projectUrl('/posters'), { method: 'PUT', body: { posters } });
    } catch (err) {
      alert(`Could not save the posters: ${err.message}`);
    }
  }

  // ------------------------------------------------------------------------
  // Studio
  // ------------------------------------------------------------------------

  // ---- Main headlines ----------------------------------------------------

  let headlines = [];

  function parseClock(text) {
    const parts = String(text || '').trim().split(':').map(Number);
    if (!parts.length || parts.some(n => !Number.isFinite(n) || n < 0)) return null;
    return parts.reduce((total, n) => total * 60 + n, 0);
  }

  /** What was being said at a moment, so a new headline can be checked. */
  function spokenAt(seconds) {
    const segs = (project && project.transcript && project.transcript.segments) || [];
    const hit = segs.filter(s => s.end >= seconds - 1 && s.start <= seconds + 6).slice(0, 2);
    return hit.length ? hit.map(s => s.text).join(' ') : null;
  }

  function renderHeadlines() {
    headlines.sort((a, b) => a.start - b.start);
    $('n-headlines').innerHTML = headlines.length ? headlines.map((h, i) => `
      <div class="border ${h.confirmed ? 'border-emerald-200 bg-emerald-50/40' : 'border-gray-200'} rounded-lg p-3" data-h="${i}">
        <div class="flex items-center gap-2">
          <button type="button" class="n-seek flex-shrink-0 w-8 h-8 rounded-full bg-rose-50 text-rose-700 hover:bg-rose-100 text-xs" data-t="${h.start}" title="Play from here">▶</button>
          <input type="text" class="n-h-time w-16 px-2 py-1.5 border border-gray-300 rounded-lg text-sm font-mono text-center" value="${clock(h.start)}" title="When this headline appears (minutes:seconds)">
          <input type="text" class="n-h-text flex-1 min-w-0 px-3 py-1.5 border border-gray-300 rounded-lg text-sm font-semibold" maxlength="90" value="${escapeHtml(h.text)}" placeholder="Type the headline">
          <label class="flex items-center text-xs text-gray-700 flex-shrink-0"><input type="checkbox" class="n-h-ok rounded border-gray-300 w-4 h-4 mr-1" ${h.confirmed ? 'checked' : ''}>Checked</label>
          <button type="button" class="n-h-remove text-xs text-gray-400 hover:text-red-700 flex-shrink-0" title="Remove">✕</button>
        </div>
        ${h.quote ? `<p class="text-xs text-gray-500 italic mt-2 ml-10">Said: “${escapeHtml(h.quote)}”</p>` : ''}
      </div>`).join('') : '<p class="text-sm text-gray-500">No main headlines yet. They are suggested once the video is transcribed, or add your own.</p>';
    const unchecked = headlines.filter(h => !h.confirmed).length;
    $('n-h-note').classList.toggle('hidden', !(project && project.studio && project.studio.headlinesSuggested && unchecked));
  }

  function readHeadlines() {
    document.querySelectorAll('#n-headlines [data-h]').forEach(row => {
      const h = headlines[Number(row.dataset.h)];
      if (!h) return;
      const t = parseClock(row.querySelector('.n-h-time').value);
      if (t !== null) h.start = t;
      h.text = row.querySelector('.n-h-text').value;
      h.confirmed = row.querySelector('.n-h-ok').checked;
    });
  }

  // ---- Studio form ---------------------------------------------------------

  let studioTimer = null;

  function scheduleStudioSave() {
    clearTimeout(studioTimer);
    $('n-studio-saved').textContent = '';
    studioTimer = setTimeout(saveStudio, 900);
  }

  async function saveStudio() {
    clearTimeout(studioTimer);
    studioTimer = null;
    if (!projectId) return;
    try {
      const { studio } = await api(projectUrl('/studio'), { method: 'PUT', body: readStudioForm() });
      if (project) project.studio = studio;
      $('n-studio-saved').textContent = 'All changes saved';
    } catch (err) {
      $('n-studio-saved').textContent = `Not saved: ${err.message}`;
    }
  }

  function selectedFormat() {
    const checked = document.querySelector('input[name="n-s-format"]:checked');
    return checked ? checked.value : 'portrait';
  }

  function showFormat() {
    const format = selectedFormat();
    document.querySelectorAll('.n-format-card').forEach(card => {
      const on = card.querySelector('input').checked;
      card.classList.toggle('border-rose-600', on);
      card.classList.toggle('bg-rose-50', on);
      card.classList.toggle('text-rose-800', on);
      card.classList.toggle('border-gray-200', !on);
    });
    const wide = format === 'landscape';
    ['n-preview-img', 'n-output'].forEach(id => {
      $(id).classList.toggle('max-w-xs', !wide);
      $(id).classList.toggle('max-w-full', wide);
    });
    $('n-preview-wrap').parentElement.classList.toggle('sm:grid-cols-2', !wide);
  }

  function fillStudioForm(s) {
    if (!s) return;
    const format = document.querySelector(`input[name="n-s-format"][value="${s.format === 'landscape' ? 'landscape' : 'portrait'}"]`);
    if (format) format.checked = true;
    showFormat();
    headlines = (s.mainHeadlines || []).map(h => ({ ...h }));
    renderHeadlines();
    $('n-s-namemode').value = s.nameMode === 'start' ? 'start' : 'always';
    $('n-studio-saved').textContent = '';
    $('n-s-name').value = s.name || '';
    $('n-s-role').value = s.role || '';
    $('n-s-network').value = s.network || '';
    $('n-s-logo').checked = s.useLogo !== false;
    $('n-s-headline').value = s.headline || '';
    $('n-s-ticker').value = (s.tickerHeadlines || []).join('\n');
    $('n-s-ticker-label').value = s.tickerLabel || '';
    $('n-s-key').value = s.keyThreshold;
    $('n-s-zoom').value = s.anchorZoom;
    $('n-s-x').value = s.anchorOffsetX;
    $('n-s-y').value = s.anchorOffsetY;
    $('n-s-live').checked = Boolean(s.showLive);
    $('n-s-clock').value = s.clock || '';
    updateSliderLabels();
  }

  function readStudioForm() {
    readHeadlines();
    return {
      format: selectedFormat(),
      mainHeadlines: headlines.filter(h => h.text.trim()),
      nameMode: $('n-s-namemode').value,
      name: $('n-s-name').value.trim(),
      role: $('n-s-role').value.trim(),
      network: $('n-s-network').value.trim(),
      useLogo: $('n-s-logo').checked,
      headline: $('n-s-headline').value.trim(),
      tickerHeadlines: $('n-s-ticker').value.split('\n').map(l => l.trim()).filter(Boolean),
      tickerLabel: $('n-s-ticker-label').value.trim(),
      keyThreshold: Number($('n-s-key').value),
      anchorZoom: Number($('n-s-zoom').value),
      anchorOffsetX: Number($('n-s-x').value),
      anchorOffsetY: Number($('n-s-y').value),
      showLive: $('n-s-live').checked,
      clock: $('n-s-clock').value.trim()
    };
  }

  function updateSliderLabels() {
    $('n-s-key-value').textContent = $('n-s-key').value;
    $('n-s-zoom-value').textContent = `${Math.round(Number($('n-s-zoom').value) * 100)}%`;
    $('n-s-clock').classList.toggle('hidden', !$('n-s-live').checked);
  }

  // Reloads the preview image and finished video whenever a job finishes (or
  // the project is first opened), never while one is still being written.
  function renderOutputs(data) {
    $('n-preview-wrap').classList.toggle('hidden', !data.hasPreview);
    $('n-output-wrap').classList.toggle('hidden', !data.hasVideo);
    $('n-output-download').href = `${projectUrl('/news.mp4')}?download=1`;

    const job = data.job;
    const key = job && job.done ? `${job.type}:${job.finishedAt}` : (job ? lastJobKey : 'none');
    if (key === lastJobKey) return;
    lastJobKey = key;
    const t = Date.now();
    if (data.hasPreview) $('n-preview-img').src = `${projectUrl('/preview.jpg')}?t=${t}`;
    if (data.hasVideo) $('n-output').src = `${projectUrl('/news.mp4')}?t=${t}`;
    else $('n-output').removeAttribute('src');
  }

  async function startStudioJob(type) {
    clearTimeout(studioTimer);
    studioTimer = null;
    readHeadlines();
    const unchecked = headlines.filter(h => h.text.trim() && !h.confirmed).length;
    if (type === 'render' && unchecked && !confirm(`${unchecked} main headline${unchecked === 1 ? ' has' : 's have'} not been ticked as checked yet. Make the news video anyway?`)) return;
    try {
      await api(projectUrl(`/${type}`), { method: 'POST', body: readStudioForm() });
      await refresh();
      startPolling();
    } catch (err) {
      alert(err.message);
    }
  }

  // ------------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------------

  $('n-file').addEventListener('change', e => uploadFile(e.target.files[0]));
  const drop = $('n-drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('border-rose-500', 'bg-rose-50'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('border-rose-500', 'bg-rose-50'); }));
  drop.addEventListener('drop', e => uploadFile(e.dataTransfer.files[0]));

  $('n-project-view').addEventListener('click', e => {
    const seekBtn = e.target.closest('.n-seek');
    if (seekBtn) return seek(seekBtn.dataset.t);
    const remove = e.target.closest('.n-p-remove');
    if (remove) {
      const i = Number(remove.closest('[data-i]').dataset.i);
      if (!confirm(`Remove poster "${posters[i].posterText.headline}"?`)) return;
      readPosterCards();
      posters.splice(i, 1);
      renderPosters(project && project.posters);
      savePosters();
    }
  });
  $('n-posters').addEventListener('input', scheduleSave);
  $('n-posters').addEventListener('change', e => {
    if (e.target.classList.contains('n-p-done')) {
      readPosterCards();
      renderPosters(project && project.posters);
      savePosters();
    }
  });

  $('n-add-poster').addEventListener('click', () => {
    readPosterCards();
    posters.push({ id: `m${Date.now()}`, title: 'New poster', confidence: 'manual', checks: [], posterText: { headline: 'NEW POSTER', lines: ['Date · Time', 'Venue', 'Contact'] }, quote: null, start: null, done: false });
    renderPosters(project && project.posters);
    savePosters();
    const cards = document.querySelectorAll('#n-posters [data-i]');
    const last = cards[cards.length - 1];
    if (last) { last.scrollIntoView({ behavior: 'smooth', block: 'center' }); last.querySelector('.n-p-headline').select(); }
  });

  $('n-redetect').addEventListener('click', async () => {
    if (!confirm('Find the posters again from the transcript? Your edits to the poster list will be replaced.')) return;
    try {
      const data = await api(projectUrl('/posters/detect'), { method: 'POST' });
      posters = data.posters;
      project.posters = data;
      renderPosters(data);
    } catch (err) {
      alert(err.message);
    }
  });

  $('n-cancel-btn').addEventListener('click', async () => {
    try {
      await api(projectUrl('/cancel'), { method: 'POST' });
      await refresh();
    } catch (err) {
      alert(err.message);
    }
  });

  $('n-retry-btn').addEventListener('click', e => {
    const type = e.target.dataset.type;
    if (type === 'transcribe') {
      api(projectUrl('/transcribe'), { method: 'POST' }).then(() => refresh()).catch(err => alert(err.message));
    } else {
      startStudioJob(type || 'preview');
    }
  });

  $('n-rename-btn').addEventListener('click', async () => {
    const name = prompt('New name for this news video:', project ? project.name : '');
    if (!name || !name.trim()) return;
    try {
      await api(projectUrl(), { method: 'PATCH', body: { name: name.trim() } });
      await refresh();
    } catch (err) {
      alert(err.message);
    }
  });

  $('n-delete-btn').addEventListener('click', async () => {
    if (!confirm(`Delete "${project ? project.name : 'this news video'}" from this computer? The uploaded video, transcript, posters and rendered video will be removed.`)) return;
    try {
      await api(projectUrl(), { method: 'DELETE' });
      location.hash = '#news';
    } catch (err) {
      alert(err.message);
    }
  });

  ['n-s-key', 'n-s-zoom', 'n-s-live'].forEach(id => $(id).addEventListener('input', updateSliderLabels));
  $('n-s-fill').addEventListener('click', () => {
    readPosterCards();
    $('n-s-ticker').value = posters.map(p => {
      const [first] = p.posterText.lines;
      return [p.posterText.headline, first].filter(Boolean).join(' · ');
    }).join('\n');
    scheduleStudioSave();
  });

  // Every studio change saves itself shortly after typing stops.
  $('n-studio-form').addEventListener('input', scheduleStudioSave);
  $('n-studio-form').addEventListener('change', e => {
    if (e.target.name === 'n-s-format') showFormat();
    scheduleStudioSave();
  });

  $('n-headlines').addEventListener('change', e => {
    // A new time re-sorts the list; a tick recolours the row.
    if (e.target.classList.contains('n-h-time') || e.target.classList.contains('n-h-ok')) {
      readHeadlines();
      renderHeadlines();
    }
  });
  $('n-headlines').addEventListener('click', e => {
    const remove = e.target.closest('.n-h-remove');
    if (!remove) return;
    readHeadlines();
    headlines.splice(Number(remove.closest('[data-h]').dataset.h), 1);
    renderHeadlines();
    scheduleStudioSave();
  });

  $('n-h-add').addEventListener('click', () => {
    readHeadlines();
    const at = Math.floor($('n-player').currentTime || 0);
    headlines.push({ text: '', start: at, quote: spokenAt(at), confirmed: false });
    renderHeadlines();
    const row = [...document.querySelectorAll('#n-headlines [data-h]')].find(r => headlines[Number(r.dataset.h)].start === at && !headlines[Number(r.dataset.h)].text);
    if (row) row.querySelector('.n-h-text').focus();
  });

  $('n-h-suggest').addEventListener('click', async () => {
    readHeadlines();
    if (headlines.some(h => h.text.trim()) && !confirm('Replace the main headlines with new suggestions from the posters?')) return;
    try {
      await savePosters();
      const suggested = await api(projectUrl('/headlines/suggest'), { method: 'POST' });
      headlines = suggested.mainHeadlines.map(h => ({ ...h, confirmed: false }));
      if (project && project.studio) project.studio.headlinesSuggested = true;
      renderHeadlines();
      if (!$('n-s-ticker').value.trim()) $('n-s-ticker').value = suggested.tickerHeadlines.join('\n');
      await api(projectUrl('/studio'), { method: 'PUT', body: { ...readStudioForm(), headlinesSuggested: true } });
      $('n-studio-saved').textContent = 'All changes saved';
    } catch (err) {
      alert(err.message);
    }
  });
  $('n-preview-btn').addEventListener('click', () => startStudioJob('preview'));
  $('n-render-btn').addEventListener('click', () => startStudioJob('render'));

  window.addEventListener('beforeunload', () => {
    if (saveTimer) savePosters();
    if (studioTimer) saveStudio();
  });

  window.ChurchNews = {
    onOpen(id) {
      if (saveTimer) savePosters();
      if (studioTimer) saveStudio();
      if (id && /^[0-9a-f]{32}$/.test(id)) showProject(id);
      else showList();
    }
  };

  // The router may have run before this script loaded.
  const [tool, sub] = location.hash.replace('#', '').split('/');
  if (tool === 'news' && !document.getElementById('app-view').classList.contains('hidden')) window.ChurchNews.onOpen(sub || null);
})();
