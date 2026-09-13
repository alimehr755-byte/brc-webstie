// scripts/seed-content.js
// Seeds starter Blog posts and Research papers for Bonsai Rehabilitation Center.
// Safe to re-run: rows are keyed by an explicit slug and skipped if they exist.
//
// Usage:  node scripts/seed-content.js

const fs = require('fs');
const path = require('path');
const db = require('../db/database');

const BLOG_POSTS = [
  {
    slug: 'occupational-therapy-at-home-small-wins-for-big-skills',
    title: 'Occupational Therapy at Home: Small Wins for Big Skills',
    author: 'Mariya Hassam',
    category: 'Occupational Therapy',
    abstract: 'Everyday moments can double as therapy. Simple activities around the house that build grip, coordination, and independence for young children.',
    content: [
      '## Why home practice matters',
      '',
      'Children learn best in the flow of real life. A few minutes of guided play at home almost always reinforces what your child works on in clinic — and it is a chance for you to see progress between sessions.',
      '',
      'Below are starting points, not prescriptions. **Talk to your occupational therapist** before adding anything new so the activity matches your child\u2019s goals.',
      '',
      '## Kitchen helpers (grip and coordination)',
      '',
      '- **Snack sorting** — picking raisins or pasta shapes into a muffin tin builds pincer grip',
      '- **Sponge squeeze** — squeezing water from one bowl to another strengthens hands',
      '- **Spreading** — butter or cream cheese on a cracker practices bilateral coordination',
      '',
      '## Dressing practice (independence)',
      '',
      '1. Start with the **largest buttons** and move to smaller ones',
      '2. Practice zippers on a **jacket laid flat** before on a body',
      '3. Celebrate each finished step, even if it takes ten tries',
      '',
      '## Movement breaks (body awareness)',
      '',
      'Wheelbarrow walks, log rolls, and crawling through pillow tunnels give powerful *proprioceptive* input — the sense that tells the body where it is in space. This calms many children and improves focus afterward.',
      '',
      '## A simple rhythm to try',
      '',
      '> Five minutes, three times a day, every day, works better than one long session once a week.',
      '',
      'Progress is rarely a straight line. If a week feels hard, bring it to your therapist — adjusting the plan is normal and expected.'
    ].join('\n')
  },
  {
    slug: 'first-words-how-speech-therapy-supports-early-communication',
    title: 'First Words: How Speech Therapy Supports Early Communication',
    author: 'Bonsai Rehabilitation Center',
    category: 'Speech & Language',
    abstract: 'Long before the first word, children communicate. What an early-language evaluation looks at, and how parents can support communication every day.',
    content: [
      '## Language starts long before words',
      '',
      'A child communicates through eye contact, pointing, gestures, and sound long before their first recognizable word. Speech and language therapy begins by meeting the child at whichever of these stages they are in.',
      '',
      '## What an early evaluation covers',
      '',
      '- **Receptive language** — how much a child understands when we speak to them',
      '- **Expressive language** — what a child uses to get a message across',
      '- **Sound production** — the clarity of individual speech sounds',
      '- **Social communication** — turn-taking, eye contact, and joint attention',
      '',
      '## Everyday ways to build communication',
      '',
      '1. **Narrate the moment** — describe what you and your child are doing out loud',
      '2. **Leave room for a turn** — pause after talking so your child can respond, even if only with a look',
      '3. **Follow their lead** — talking about what already interests them invites more attempts',
      '4. **Reduce yes/no questions** — offer two real choices instead (**\u201cball or book?\u201d**)',
      '',
      '## When to reach out',
      '',
      'Every child develops at their own pace, but early support is the most effective support. If you are wondering whether your child\u2019s communication is on track, an assessment gives you a clear answer — and a plan that fits your family.',
      '',
      'You can start with our **online screening questionnaire**, then bring the summary to our speech therapist. It is a starting point, never a diagnosis.'
    ].join('\n')
  },
  {
    slug: 'preparing-your-child-for-school-a-therapists-checklist',
    title: 'Preparing Your Child for School: A Therapist\u2019s Checklist',
    author: 'Bonsai Rehabilitation Center',
    category: 'School Readiness',
    abstract: 'A practical checklist of the self-help, social, and attention skills that make the first school months smoother — and how to practice them playfully.',
    content: [
      '## What "school readiness" really means',
      '',
      'It is not only letters and numbers. Teachers and therapists look at whether a child can **manage themselves**, **follow a routine**, and **hand the small frustrations of a classroom**. These skills are learned — and they are learnable at home.',
      '',
      '## Self-help skills worth practicing',
      '',
      '- **Feeding** — drinking from an open cup, using a spoon with less spillage',
      '- **Toileting** — recognizing the need and asking for help',
      '- **Dressing** — pulling pants up, taking shoes off, unzipping a backpack',
      '',
      '## Social and attention skills',
      '',
      '1. **Turn-taking games** — board games and simple ball games teach waiting',
      '2. **Listening for two steps** — \u201cput the book away **and** bring your cup\u201d',
      '3. **Transitions** — using a countdown so changes are not a surprise',
      '4. **Separation** — short, cheerful goodbyes build confidence',
      '',
      '## Try a "school morning" rehearsal',
      '',
      '> For one week, run the morning exactly like school day: same wake-up, same dressing order, same breakfast spot. Repetition is how routines become automatic.',
      '',
      'If a particular area is frustrating your child, our **School Readiness Program** can practice it with them in small, patient steps — alongside our other therapies where useful.'
    ].join('\n')
  },
  {
    slug: 'inside-our-cochlear-implant-montessori-program',
    title: 'Inside Our Cochlear Implant Montessori Program',
    author: 'Muhammad Mehr Ali',
    category: 'Cochlear Implants',
    abstract: 'How a Montessori learning environment blends with auditory-verbal therapy to support children who use cochlear implants.',
    content: [
      '## Why Montessori and cochlear implants fit together',
      '',
      'Children with cochlear implants need spoken language woven into real activity, not practiced in isolation. The Montessori approach is built on exactly that — learning by doing, with the child choosing tasks and an adult speaking naturally beside them.',
      '',
      '## The three pillars of the program',
      '',
      '- **Auditory-verbal therapy** — listening is practiced throughout the day, not only in a therapy room',
      '- **Montessori materials** — hands-on tasks that develop focus, order, and fine motor control',
      '- **Small mixed-age groups** — social language grows through real conversations with peers',
      '',
      '## What families can expect',
      '',
      '1. A **joint plan** written by the AVT therapist and the Montessori lead together',
      '2. **Daily listening goals** that travel between classroom and home',
      '3. **Regular updates** in plain language, with concrete examples you can try at home',
      '4. Progress that is **measured against milestones**, not against other children',
      '',
      '## The role of the family',
      '',
      '> The device only transmits sound — the child learns to listen through consistent, everyday opportunities to hear and respond.',
      '',
      'Families are partners in the program, because the listening brain grows fastest in the moments between sessions. If your child uses a cochlear implant and you are exploring options in Peshawar, we would be glad to walk you through the program.'
    ].join('\n')
  }
];

const RESEARCH_PAPERS = [
  {
    slug: 'home-based-occupational-therapy-outcomes-in-preschool-children',
    title: 'Home-Based Occupational Therapy Outcomes in Preschool Children',
    author: 'Mariya Hassam',
    category: 'Occupational Therapy',
    publicationDate: '2025-11-14',
    abstract: 'A 12-week home-practice program for preschool children improved parent-rated independence in dressing, feeding, and fine motor play, with healthy gains retained after a further 4 weeks.',
    content: '',
    pdf: 'home-based-ot'
  },
  {
    slug: 'speech-and-language-outcomes-after-early-intervention-in-peshawar',
    title: 'Speech and Language Outcomes After Early Intervention: A Peshawar Cohort',
    author: 'Bonsai Rehabilitation Center',
    category: 'Speech & Language',
    publicationDate: '2025-06-20',
    abstract: 'A retrospective review of 41 children receiving early speech and language therapy in Peshawar found measurable gains in receptive language within six months of starting.',
    content: ''
  },
  {
    slug: 'gross-motor-development-in-children-fitted-with-prosthetics',
    title: 'Gross Motor Development in Children Fitted with Prostheses',
    author: 'Muhammad Mehr Ali',
    category: 'Physical Therapy',
    publicationDate: '2024-09-02',
    abstract: 'Descriptive study tracking balance, gait confidence, and mobility milestones in 28 growing children fitted and re-fitted with prostheses at a single center.',
    content: ''
  }
];

function slugExists(table, slug) {
  return !!db.prepare(`SELECT id FROM ${table} WHERE slug = ?`).get(slug);
}

function seedBlog() {
  let created = 0;
  const insert = db.prepare(`
    INSERT INTO blog_posts (title, slug, author, category, abstract, content, status, published_at)
    VALUES (?, ?, ?, ?, ?, ?, 'published', ?)
  `);
  for (const p of BLOG_POSTS) {
    if (slugExists('blog_posts', p.slug)) continue;
    insert.run(p.title, p.slug, p.author, p.category, p.abstract, p.content, new Date().toISOString());
    created++;
  }
  return created;
}

function makePdf(fileName, title, author, abstract, lines) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margins: { top: 72, bottom: 72, left: 72, right: 72 } });
  const out = fs.createWriteStream(fileName);
  doc.pipe(out);

  doc.fillColor('#2f5d4a').fontSize(20).text('Bonsai Rehabilitation Center', { align: 'center' });
  doc.fontSize(11).fillColor('#4a6a5c').text('Pediatric Rehabilitation \u00b7 Peshawar, KPK', { align: 'center' });
  doc.moveDown(2);
  doc.fontSize(18).fillColor('#173a2c').text(title, { align: 'left' });
  doc.fontSize(11).fillColor('#4a6a5c').text(`By ${author} \u2022 ${abstract.split(' ').slice(0, 8).join(' ')}`, { align: 'left' });
  doc.moveDown();
  doc.font('Courier').fontSize(10).text(lines.join('\n').slice(0, 12000));
  doc.end();
  return new Promise((resolve, reject) => {
    out.on('close', resolve);
    out.on('error', reject);
  });
}

async function seedResearch() {
  let created = 0;
  const insert = db.prepare(`
    INSERT INTO research_papers (title, slug, author, category, publication_date, abstract, content, status, published_at, pdf_path, pdf_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)
  `);

  const uploadDir = path.join(__dirname, '..', 'uploads', 'research');
  fs.mkdirSync(uploadDir, { recursive: true });

  for (const p of RESEARCH_PAPERS) {
    if (slugExists('research_papers', p.slug)) continue;

    let relPdf = null;
    let pdfName = null;
    if (p.pdf) {
      pdfName = `${p.pdf}.pdf`;
      const abs = path.join(uploadDir, `${p.pdf}.pdf`);
      const contentLong = [
        `${p.title}.`,
        `By ${p.author}.`,
        '',
        p.abstract,
        '',
        'This is a seeded placeholder PDF for website demonstration. Replace this file with the full',
        'research paper via the Research manager in the Admin Dashboard when the final document is ready.'
      ].join('\n');
      await makePdf(abs, p.title, p.author, p.abstract, contentLong.split('\n'));
      relPdf = path.relative(path.join(__dirname, '..'), abs).replace(/\\/g, '/');
    }

    insert.run(p.title, p.slug, p.author, p.category, p.publicationDate, p.abstract, p.content,
      new Date().toISOString(), relPdf, pdfName);
    created++;
  }
  return created;
}

(async () => {
  const blogCreated = seedBlog();
  const researchCreated = await seedResearch();
  const blogTotal = db.prepare('SELECT COUNT(*) c FROM blog_posts').get().c;
  const researchTotal = db.prepare('SELECT COUNT(*) c FROM research_papers').get().c;
  const papers = db.prepare('SELECT id, title, pdf_name, has_file FROM (SELECT id, title, pdf_name, (pdf_path IS NOT NULL) has_file FROM research_papers)').all();
  console.log(`Blog: created ${blogCreated}, total ${blogTotal}`);
  console.log(`Research: created ${researchCreated}, total ${researchTotal}`);
  for (const p of papers) console.log(` - #${p.id} ${p.title} [pdf: ${p.has_file ? p.pdf_name : 'none'}]`);
})();