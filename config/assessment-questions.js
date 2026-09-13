// config/assessment-questions.js
// Single source of truth for the Online Assessment questionnaire.
// Answer scale is intentionally simple (3 points) and phrased for parents, not clinicians.
// IMPORTANT: this produces a preliminary TRIAGE indicator only, never a diagnosis.
// A real conclusion is always written by a licensed therapist reviewing the submission.

const ANSWER_OPTIONS = [
  { value: 0, label: 'No concern' },
  { value: 1, label: 'Some concern' },
  { value: 2, label: 'Significant concern' }
];

const DOMAINS = [
  {
    id: 'motor',
    label: 'Motor Skills',
    relatedTherapy: 'Physical / Occupational Therapy',
    questions: [
      { id: 'motor_1', text: 'Does your child have difficulty walking, running, or keeping balance compared to children their age?' },
      { id: 'motor_2', text: "Does your child have difficulty with fine motor tasks like holding a pencil, buttoning clothes, or using utensils?" },
      { id: 'motor_3', text: 'Does your child tire quickly or avoid physical activities other children enjoy?' }
    ]
  },
  {
    id: 'speech',
    label: 'Speech & Language',
    relatedTherapy: 'Speech & Language Therapy',
    questions: [
      { id: 'speech_1', text: 'Does your child have difficulty being understood by people outside the family?' },
      { id: 'speech_2', text: "Does your child struggle to follow simple instructions or understand questions?" },
      { id: 'speech_3', text: "Is your child's vocabulary noticeably behind other children their age?" }
    ]
  },
  {
    id: 'behavior',
    label: 'Behavior & Social',
    relatedTherapy: 'Behavior Therapy',
    questions: [
      { id: 'behavior_1', text: 'Does your child have difficulty managing emotions (frequent tantrums, meltdowns) for their age?' },
      { id: 'behavior_2', text: 'Does your child avoid eye contact or have difficulty interacting with other children?' },
      { id: 'behavior_3', text: 'Does your child have difficulty adjusting to changes in routine?' }
    ]
  },
  {
    id: 'sensory',
    label: 'Sensory Processing',
    relatedTherapy: 'Sensory Integration / Occupational Therapy',
    questions: [
      { id: 'sensory_1', text: 'Is your child unusually sensitive — or under-sensitive — to sounds, textures, lights, or touch?' },
      { id: 'sensory_2', text: 'Does your child seek out intense sensory input, like spinning, jumping, or chewing on objects?' },
      { id: 'sensory_3', text: 'Does your child have difficulty with certain food textures or clothing fabrics?' }
    ]
  },
  {
    id: 'hearing',
    label: 'Hearing & Listening',
    relatedTherapy: 'Audio-Verbal Therapy',
    questions: [
      { id: 'hearing_1', text: 'Does your child have a diagnosed hearing loss, hearing aid, or cochlear implant?' },
      { id: 'hearing_2', text: 'Does your child often ask you to repeat things, or not respond when called from another room?' },
      { id: 'hearing_3', text: 'Does your child have difficulty following conversations in noisy environments?' }
    ]
  }
];

// Flag a domain for staff attention if the average answer for that domain is
// "some concern" or higher (>= 1), or if any single question hit "significant concern" (2).
function scoreResponses(responses) {
  const domainResults = DOMAINS.map(domain => {
    const scores = domain.questions.map(q => {
      const val = responses[q.id];
      return typeof val === 'number' ? val : 0;
    });
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const anySignificant = scores.some(s => s === 2);
    return {
      id: domain.id,
      label: domain.label,
      relatedTherapy: domain.relatedTherapy,
      averageScore: Math.round(avg * 100) / 100,
      flagged: avg >= 1 || anySignificant
    };
  });

  const flaggedDomains = domainResults.filter(d => d.flagged);

  let summary;
  if (flaggedDomains.length === 0) {
    summary = "Based on your answers, no significant areas of concern were flagged. Our team will still review your responses and follow up if needed.";
  } else {
    const areas = flaggedDomains.map(d => d.label).join(', ');
    summary = `Based on your answers, your responses suggest it may be worth having our therapists take a closer look at: ${areas}. This is a preliminary indicator only, not a diagnosis — one of our specialists will review your full submission and follow up with next steps.`;
  }

  return { domainResults, flaggedDomains: flaggedDomains.map(d => d.id), summary };
}

module.exports = { ANSWER_OPTIONS, DOMAINS, scoreResponses };
