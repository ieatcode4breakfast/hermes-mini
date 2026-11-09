// The Hermes scheduler can wrap a job result in a "Cronjob Response" header and a
// "To stop or manage this job" footer (cron.wrap_response). The app shows the result only: the job
// id and the management hint are machinery, not something a person should read in a bubble.
const HEADER = "Cronjob Response: ";
const RULE = "-------------";
const FOOTER = "To stop or manage this job, send me a new message";
const JOB_ID = /\(job[ _]?id: /i; // the inbox's markdown stripping turns job_id into jobid

// Tolerant of the raw multi-line wrapper and the inbox's flattened one-line preview. Anything that
// does not carry the full shape is returned unchanged, so an ordinary message is never trimmed.
export function stripCronWrapper(text) {
  const value = String(text == null ? "" : text);
  if (!value.startsWith(HEADER)) return value;
  const rule = value.indexOf(RULE);
  if (rule < 0) return value;
  const footer = value.lastIndexOf(FOOTER);
  if (footer < rule + RULE.length) return value;
  if (!JOB_ID.test(value.slice(0, rule))) return value;
  const body = value.slice(rule + RULE.length, footer).trim();
  return body || value;
}
