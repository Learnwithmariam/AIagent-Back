import { KnowledgeDoc, Test } from './types';

// Seed data: only startup / entrepreneurship course materials.
// Real syllabus materials should be uploaded via the admin Knowledge Base panel.
export const SEED_KNOWLEDGE: KnowledgeDoc[] = [
  {
    id: 'kb-startup-1',
    title: 'Lean Startup Methodology: Customer Discovery, MVP & Build-Measure-Learn Feedback Loop',
    subject: 'Startups & Entrepreneurship',
    tags: ['Lean Startup', 'Customer Discovery', 'MVP', 'Build-Measure-Learn', 'Validation'],
    content: `The Lean Startup methodology, pioneered by Eric Ries and grounded in Steve Blank's Customer Development framework, rejects traditional upfront 50-page business plans in favor of validated learning through experimentation.

1. The Build-Measure-Learn Loop:
The core feedback cycle of any innovative venture:
- Ideate: Formulate falsifiable hypotheses regarding the value proposition and growth engine.
- Build: Construct a Minimum Viable Product (MVP) with the minimum effort required to begin learning.
- Measure: Evaluate quantitative customer behaviors using actionable metrics (cohort retention, conversion, net promoter score) rather than vanity metrics (total registered accounts, page views).
- Learn: Decide whether to Pivot (change strategy without changing vision) or Persevere.

2. Problem-Solution Fit vs. Product-Market Fit (PMF):
- Problem-Solution Fit occurs when you have proven that customers face a severe, high-priority pain point and that your proposed solution is compelling enough to elicit commitments (letters of intent, pre-orders, active usage).
- Product-Market Fit (Marc Andreessen) occurs when you are in a good market with a product that can satisfy that market, evidenced by inbound pull, organic referrals, and exponential retention curves.

3. Types of Pivots:
- Zoom-in Pivot: Refocusing on a single compelling feature of the original product.
- Customer Segment Pivot: Realizing the product solves a real problem, but for a completely different demographic or enterprise buyer.
- Value Capture Pivot: Changing revenue architecture (e.g. freemium to enterprise B2B licensing).
- Channel Pivot: Changing distribution mechanisms for improved CAC-to-LTV ratios.`,
    summary: 'Comprehensive pedagogical analysis of Lean Startup principles, Build-Measure-Learn feedback loops, actionable vs. vanity metrics, and validated learning.',
    createdAt: '2026-01-10T08:00:00.000Z',
    lastUpdatedBy: 'Prof. Giorgi Khatiashvili'
  },
  {
    id: 'kb-startup-2',
    title: 'Business Model Canvas & Value Proposition Design for Innovative Ventures',
    subject: 'Innovative Entrepreneurship',
    tags: ['Business Model Canvas', 'Value Proposition', 'Unit Economics', 'CAC', 'LTV'],
    content: `Alexander Osterwalder's Business Model Canvas provides a shared conceptual language to design, test, and iterate commercial venture architectures across 9 essential building blocks:

1. Value Proposition Canvas:
- Customer Profile: Customer Jobs (functional, social, emotional), Pains (frustrations, obstacles, risks), and Gains (required, expected, unexpected).
- Value Map: Products & Services, Pain Relievers, and Gain Creators.
- Resonance: Achieve Fit when Pain Relievers address the top 20% critical pains and Gain Creators unlock 10x superior outcomes.

2. Unit Economics Foundations:
- Customer Acquisition Cost (CAC) = Total Sales & Marketing Expenditure / Number of Acquired Customers.
- Customer Lifetime Value (LTV) = (Average Revenue Per User * Gross Margin %) / Churn Rate.
- Benchmark: Sustainable venture models require LTV:CAC >= 3:1 with CAC Payback Period under 12 months.
- Net Revenue Retention (NRR): High-growth enterprise software requires NRR > 115% via expansion revenue and seat upgrades.

3. Defensibility & Moats (Hamilton Helmer's 7 Powers):
Scale Economies, Network Effects, Counter-Positioning, Switching Costs, Branding, Cornered Resource, and Process Power.`,
    summary: 'Strategic venture architecture: Business Model Canvas 9 blocks, Value Proposition mapping, and foundational unit economics formulas (CAC, LTV, Churn, Payback).',
    createdAt: '2026-01-18T10:30:00.000Z',
    lastUpdatedBy: 'Prof. Giorgi Khatiashvili'
  },
  {
    id: 'kb-startup-3',
    title: 'Venture Capital Financing, Term Sheets, Equity Valuation & Cap Tables',
    subject: 'Entrepreneurship',
    tags: ['Venture Capital', 'SAFE Notes', 'Term Sheets', 'Valuation', 'Dilution'],
    content: `Understanding the lifecycle of startup capitalization from angel/pre-seed to institutional rounds:

1. Early Stage Instruments (Convertible Debt & SAFEs):
- Simple Agreement for Future Equity (SAFE), popularized by Y Combinator: Non-debt instrument converting into preferred equity during the next qualified priced equity financing round.
- Valuation Cap: Sets the maximum effective pre-money valuation at which the investor's SAFE will convert.
- Conversion Price = min(Price Per Share in Priced Round, Valuation Cap / Fully Diluted Pre-Money Capitalization).
- Discount Rate: Typically 15% - 20% applied if the priced round is below the cap.

2. Priced Round Mechanics & The Term Sheet:
- Pre-Money Valuation + Investment Amount = Post-Money Valuation.
- Investor Ownership Percentage = Investment Amount / Post-Money Valuation.
- Option Pool Shuffle: Lead investors typically mandate a 10% - 15% unallocated employee stock option pool (ESOP) carved out of the PRE-money valuation, causing founder dilution prior to new cash injection.
- Liquidation Preferences: 1x Non-Participating preferred vs. Participating preferred (double-dipping).
- Protective Provisions & Board Seats: Governance vetoes on company sale, debt issuance, and executive compensation.`,
    summary: 'Practical guide to venture capital capitalization: SAFE notes, valuation caps, priced round mechanics, option pool dilutive calculations, and term sheet covenants.',
    createdAt: '2026-02-01T12:00:00.000Z',
    lastUpdatedBy: 'Prof. Giorgi Khatiashvili'
  },
  {
    id: 'kb-startup-4',
    title: 'Disruptive Innovation & Crossing the Chasm Go-To-Market Strategy',
    subject: 'Innovative Entrepreneurship',
    tags: ['Disruptive Innovation', 'Crossing the Chasm', 'Market Validation', 'Go-To-Market'],
    content: `Strategic frameworks for launching innovative solutions into established markets:

1. Clayton Christensen's Theory of Disruptive Innovation:
- Low-End Disruption: Incumbents overshoot mainstream market needs by over-engineering products. Disruptors enter at the bottom of the market with simpler, cheaper, "good enough" alternatives (e.g. cloud storage vs. on-premise hardware).
- New-Market Disruption: Targeting non-consumers who previously lacked the money or skill to use the incumbent offering.
- Sustaining Innovation vs. Disruptive Innovation: Incumbents almost always defeat entrants in sustaining battles; entrants triumph when asymmetric incentives make the market unattractive to incumbents.

2. Geoffrey Moore's "Crossing the Chasm":
- The Technology Adoption Life Cycle: Innovators (tech enthusiasts) -> Early Adopters (visionaries) -> THE CHASM -> Early Majority (pragmatists) -> Late Majority (conservatives) -> Laggards (skeptics).
- The Chasm occurs between Early Adopters and Early Majority because pragmatists require verified references from other pragmatists within their industry.
- The D-Day Strategy: Focus 100% of resources on dominating a specific niche beachhead market with a "Whole Product" solution before expanding to adjacent segments.`,
    summary: 'Disruptive innovation dynamics, sustaining vs. low-end disruptions, and Geoffrey Moore’s beachhead strategy for crossing the chasm into pragmatist markets.',
    createdAt: '2026-02-15T09:30:00.000Z',
    lastUpdatedBy: 'Prof. Giorgi Khatiashvili'
  },
];

export const SEED_TESTS: Test[] = [
  {
    id: 'test-sample-startups',
    title: 'სანიმუშო ქვიზი: Lean Startup და Unit Economics',
    description: 'სანიმუშო ტესტი სისტემის შესამოწმებლად. რეალური გამოცდის წინ წაშალეთ ან ჩაანაცვლეთ.',
    subject: 'სტარტაპები და ინოვაციური მეწარმეობა',
    instructions:
      'გამოცდა მიმდინარეობს მონიტორინგის რეჟიმში. ტაბის შეცვლა, ფანჯრის მინიმიზაცია და copy/paste ფიქსირდება და ლექტორს ეგზავნება.',
    durationMinutes: 15,
    passingScore: 60,
    totalPoints: 30,
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2030-01-01T00:00:00.000Z',
    status: 'draft',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'Prof. Giorgi Khatiashvili',
    questions: [
      {
        id: 'q1',
        type: 'mcq',
        prompt: 'რომელია LTV:CAC თანაფარდობის ზოგადად მიღებული ჯანსაღი ნიშნული ვენჩურული სტარტაპისთვის?',
        options: ['1:1', 'მინიმუმ 3:1', '0.5:1', '100:1'],
        correctAnswer: 1,
        points: 10,
      },
      {
        id: 'q2',
        type: 'mcq',
        prompt: 'Build-Measure-Learn ციკლში რა არის MVP-ის მთავარი მიზანი?',
        options: [
          'სრულფასოვანი პროდუქტის გაშვება',
          'მინიმალური ძალისხმევით ვალიდირებული სწავლის დაწყება',
          'ინვესტორებისთვის დემოს მომზადება',
          'კონკურენტების დაბლოკვა',
        ],
        correctAnswer: 1,
        points: 10,
      },
      {
        id: 'q3',
        type: 'short_answer',
        prompt: 'თქვენივე სტარტაპ იდეის მაგალითზე ახსენით, რით განსხვავდება Problem-Solution Fit და Product-Market Fit.',
        rubric:
          'სრული ქულა: (1) PSF — დადასტურებული, მწვავე პრობლემა და გადაწყვეტის მიმართ ვალდებულება (წინასწარი შეკვეთა, LOI, აქტიური გამოყენება). (2) PMF — ბაზრის „pull“, ორგანული რეკომენდაციები, სტაბილური retention. (3) კონკრეტული მაგალითი სტუდენტის საკუთარი იდეიდან.',
        points: 10,
      },
    ],
  },
];
