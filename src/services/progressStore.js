const crypto = require('crypto');

const jobs = new Map();

function createJob(total) {
  const jobId = crypto.randomUUID();
  jobs.set(jobId, {
    jobId,
    total,
    processed: 0,
    successful: 0,
    failed: 0,
    currentFile: null,
    startTime: Date.now(),
    done: false,
    error: null,
    result: null
  });
  return jobId;
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

function updateJob(jobId, updates) {
  const job = jobs.get(jobId);
  if (!job) return;
  Object.assign(job, updates);
}

function completeJob(jobId, result) {
  updateJob(jobId, { done: true, result });
}

function failJob(jobId, error) {
  updateJob(jobId, { done: true, error });
}

// Jobs are kept around briefly after completion so a client's final poll can
// still read the result, then dropped so this map doesn't grow unbounded.
function pruneOldJobs(maxAgeMs = 30 * 60 * 1000) {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.done && now - job.startTime > maxAgeMs) {
      jobs.delete(id);
    }
  }
}
setInterval(pruneOldJobs, 5 * 60 * 1000).unref();

module.exports = { createJob, getJob, updateJob, completeJob, failJob };
