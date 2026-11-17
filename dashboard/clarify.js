// Moving through a clarify question set: which question is on screen, what each answer is, and which answers
// go to Hermes now. Pure state, no page: app.js draws the card and sends the locks this module hands back.
//
// Hermes takes each answer with clarify.lock and lets it be changed until the last one lands; the lock that
// leaves nothing unanswered ends the whole set. So in a set of two or more, every answer is locked as it is
// given except the one that would finish the set: that one is held here until the review step's Submit.
// Skip is a per-question answer of null, which Hermes reports to the agent as "skipped" for that question.

/** A new flow. *locked* is the answers Hermes already holds (a card reopened after a reload). */
export function startFlow(questions, locked = {}) {
  const answers = {};
  const sent = new Set();
  for (const question of questions) {
    if (Object.prototype.hasOwnProperty.call(locked, question.qid)) {
      answers[question.qid] = locked[question.qid];
      sent.add(question.qid);
    }
  }
  const first = questions.findIndex((question) => !sent.has(question.qid));
  return { questions, answers, sent, index: Math.max(0, first), reviewing: false, returnToReview: false };
}

/** Whether this set ends on a review step (two or more questions) instead of sending its last answer at once. */
export function hasReview(flow) {
  return flow.questions.length > 1;
}

export function currentQuestion(flow) {
  return flow.questions[flow.index];
}

/** The answer already given to the question on screen: a value, null for skipped, undefined for none yet. */
export function currentAnswer(flow) {
  return flow.answers[currentQuestion(flow).qid];
}

/**
 * Records an answer to the question on screen (*value* null = skip) and moves on. Returns the locks to send:
 * [] when the answer is held for Submit, else one {qid, value}.
 */
export function answerCurrent(flow, value) {
  const { qid } = currentQuestion(flow);
  flow.answers[qid] = value;
  const othersOpen = flow.questions.some((question) => question.qid !== qid && !flow.sent.has(question.qid));
  const locks = [];
  if (!hasReview(flow) || othersOpen) {
    flow.sent.add(qid);
    locks.push({ qid, value });
  }
  if (hasReview(flow) && (flow.returnToReview || flow.index === flow.questions.length - 1)) {
    flow.reviewing = true;
    flow.returnToReview = false;
  } else if (flow.index < flow.questions.length - 1) {
    flow.index += 1;
  }
  return locks;
}

/** Back one question from the question on screen. */
export function goBack(flow) {
  if (flow.index > 0) flow.index -= 1;
  flow.reviewing = false;
  flow.returnToReview = false;
}

/** From the review step, reopen question *index*; answering it returns to the review. */
export function changeAnswer(flow, index) {
  if (index < 0 || index >= flow.questions.length) return;
  flow.index = index;
  flow.reviewing = false;
  flow.returnToReview = true;
}

/** Back out of a Change without answering: the review again, with the earlier answer kept. */
export function backToReview(flow) {
  flow.reviewing = true;
  flow.returnToReview = false;
}

/** Submit on the review step: the answers not yet sent (normally the last one), as locks. */
export function submitLocks(flow) {
  const locks = [];
  for (const question of flow.questions) {
    if (flow.sent.has(question.qid)) continue;
    const value = Object.prototype.hasOwnProperty.call(flow.answers, question.qid) ? flow.answers[question.qid] : null;
    flow.answers[question.qid] = value;
    flow.sent.add(question.qid);
    locks.push({ qid: question.qid, value });
  }
  return locks;
}


/** One row per question for the review step and the closed card: {question, status, value}. */
export function answerRows(flow) {
  return flow.questions.map((question) => {
    const value = flow.answers[question.qid];
    if (value === undefined) return { question: question.question, status: "unanswered", value: undefined };
    if (value === null) return { question: question.question, status: "skipped", value: null };
    return { question: question.question, status: "answered", value };
  });
}

/** Where the flow stands, to put back if sending fails. */
export function saveState(flow) {
  return {
    answers: { ...flow.answers },
    sent: new Set(flow.sent),
    index: flow.index,
    reviewing: flow.reviewing,
    returnToReview: flow.returnToReview,
  };
}

export function restoreState(flow, saved) {
  Object.assign(flow, {
    answers: { ...saved.answers },
    sent: new Set(saved.sent),
    index: saved.index,
    reviewing: saved.reviewing,
    returnToReview: saved.returnToReview,
  });
}
