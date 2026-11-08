const Database = require('better-sqlite3');
const db = new Database('db/brc.db');

// Illustrative normative joint-angle bands (degrees) by joint/plane/side and age/sex.
// Sources: Perry & Burnfield, Whittle, Winter (representative; replace with clinic data).
const rows = [
  // joint, plane, side, age_min, age_max, sex, metric, p5, p50, p95, source
  ['knee','sagittal','L',0,999,'all','knee_flex',30,60,90,'representative'],
  ['knee','sagittal','R',0,999,'all','knee_flex',30,60,90,'representative'],
  ['knee','frontal','L',0,999,'all','knee_valgus',-5,0,10,'representative'],
  ['knee','frontal','R',0,999,'all','knee_valgus',-5,0,10,'representative'],
  ['hip','sagittal','L',0,999,'all','hip_flex',-10,30,50,'representative'],
  ['hip','sagittal','R',0,999,'all','hip_flex',-10,30,50,'representative'],
  ['hip','frontal','L',0,999,'all','hip_ab_abd',-10,0,15,'representative'],
  ['hip','frontal','R',0,999,'all','hip_ab_abd',-10,0,15,'representative'],
  ['ankle','sagittal','L',0,999,'all','ankle_angle',-20,0,30,'representative'],
  ['ankle','sagittal','R',0,999,'all','ankle_angle',-20,0,30,'representative'],
  ['pelvis','sagittal','L',0,999,'all','pelvic_obliquity_mean',-5,0,10,'representative'],
  ['pelvis','frontal','L',0,999,'all','pelvic_obliquity_mean',-5,0,10,'representative'],
  ['spine','sagittal','L',0,999,'all','lateral_trunk_lean_max',-10,0,15,'representative'],
];

const insert = db.prepare(
  `INSERT OR IGNORE INTO research_normative_bands (joint, plane, side, age_min, age_max, sex, metric, p5, p50, p95, source)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
let n = 0;
for (const row of rows) { insert.run(...row); n++; }
console.log(`seeded ${n} normative bands`);
db.close();
