const crypto = require('node:crypto');

function getDateInTimeZone(date = new Date(), timeZone = 'America/Sao_Paulo') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short'
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    weekday: values.weekday
  };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
}

function getPendingActivities(activities, todayKey) {
  return activities.filter(activity => activity.nextDueDate && activity.nextDueDate <= todayKey);
}

function summarizeActivities(activities, todayKey) {
  const overdue = activities.filter(activity => activity.nextDueDate < todayKey);
  const dueToday = activities.filter(activity => activity.nextDueDate === todayKey);
  return { overdue, dueToday, total: activities.length };
}

module.exports = {
  getDateInTimeZone,
  getPendingActivities,
  hashToken,
  summarizeActivities
};
