// Queue list order: scheduled posts first, soonest scheduled time at
// the very top; every other status below, newest first (by scheduled
// time, falling back to creation time). Pure and dependency-free so
// Queue.jsx and the regression tests share the exact same ordering.
export function queueOrder(posts) {
  const timeOf = (p) => new Date(p.scheduleTime || p.createdAt || 0).getTime() || 0
  const list = [...(posts || [])]
  const scheduled = list
    .filter((p) => p.status === 'scheduled')
    .sort((a, b) => timeOf(a) - timeOf(b))
  const rest = list
    .filter((p) => p.status !== 'scheduled')
    .sort((a, b) => timeOf(b) - timeOf(a))
  return [...scheduled, ...rest]
}
