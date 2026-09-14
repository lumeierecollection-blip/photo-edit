const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '../uploads/history.json');

function getHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error reading job history:', err);
  }
  return [];
}

function addJobRecord(record) {
  try {
    const history = getHistory();
    const newRecord = {
      id: Date.now().toString(),
      date: new Date().toISOString(),
      ...record
    };
    history.unshift(newRecord);
    // Keep last 50 jobs
    const trimmed = history.slice(0, 50);
    const dir = path.dirname(HISTORY_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
    return newRecord;
  } catch (err) {
    console.error('Error saving job history:', err);
  }
}

function getJobById(jobId) {
  const history = getHistory();
  return history.find(j => j.id === jobId) || null;
}

module.exports = {
  getHistory,
  addJobRecord,
  getJobById
};
