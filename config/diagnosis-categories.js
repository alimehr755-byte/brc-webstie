// config/diagnosis-categories.js
// Groups the free-text diagnosis field into broad categories for classification/reporting.
// Keyword matching, not clinical logic — just enough to let staff filter and count patients
// by the kind of need they present with.

const CATEGORY_KEYWORDS = [
  { category: 'Autism Spectrum', keywords: ['autism', 'asd', 'spectrum'] },
  { category: 'Cerebral Palsy', keywords: ['cerebral palsy', 'cp'] },
  { category: 'Speech / Language Delay', keywords: ['speech delay', 'language delay', 'speech disorder', 'articulation', 'stutter'] },
  { category: 'Hearing Loss / Cochlear Implant', keywords: ['hearing loss', 'cochlear', 'deaf', 'hearing impair'] },
  { category: 'Down Syndrome', keywords: ['down syndrome', 'trisomy 21'] },
  { category: 'Developmental Delay', keywords: ['developmental delay', 'global delay', 'milestone delay'] },
  { category: 'Physical / Orthopedic', keywords: ['amputation', 'orthotic', 'prosthetic', 'limb', 'clubfoot', 'scoliosis', 'muscular dystrophy'] },
  { category: 'ADHD / Behavioral', keywords: ['adhd', 'behavior', 'behaviour', 'attention deficit'] },
  { category: 'Sensory Processing', keywords: ['sensory processing', 'spd'] }
];

function classifyDiagnosis(diagnosisText) {
  if (!diagnosisText || !diagnosisText.trim()) return 'Not Specified';
  const lower = diagnosisText.toLowerCase();
  for (const { category, keywords } of CATEGORY_KEYWORDS) {
    if (keywords.some(k => lower.includes(k))) return category;
  }
  return 'Other';
}

module.exports = { classifyDiagnosis };
