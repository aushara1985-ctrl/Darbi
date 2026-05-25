// ══════ Career-family taxonomy for job search ══════════════════════════════
// Each family knows: how to detect itself (hits), what titles to TARGET per
// seniority band, what titles to AVOID per seniority band, and what keywords
// to send to upstream job providers. This is the single source of truth for
// family-aware job matching — DO NOT scatter family rules elsewhere.
//
// Seniority bands (5 total):
//   fresh_grad        — student/intern/no full-time experience
//   junior            — 0-2 years
//   mid               — 3-6 years
//   senior            — 7+ years, individual contributor
//   senior_leadership — head/director/VP/manager-of-managers
//
// "avoid" entries are case-insensitive substring/regex tokens — used to
// down-rank or filter jobs that don't match the user's seniority band.

const FAMILIES = {
  // ─── Customer Success — distinct from customer_service (CSM/retention/CX) ─
  customer_success: {
    ar: 'نجاح العملاء',
    en: 'Customer Success',
    hits: ['customer success', 'csm', 'cs manager', 'نجاح العملاء', 'customer experience', 'cx', 'client success', 'retention manager', 'account management'],
    titles: {
      fresh_grad: ['Customer Success Associate', 'Onboarding Specialist', 'Customer Success Coordinator'],
      junior:     ['Customer Success Associate', 'Onboarding Specialist', 'Customer Success Coordinator', 'Junior Customer Success Manager'],
      mid:        ['Customer Success Manager', 'Senior Customer Success Manager', 'Customer Success Lead'],
      senior:     ['Senior Customer Success Manager', 'Customer Success Lead', 'CS Operations Lead', 'Enterprise CSM'],
      senior_leadership: ['Head of Customer Success', 'Director of Customer Success', 'VP Customer Success', 'CS Operations Lead', 'Director of Customer Success (smaller SaaS)'],
    },
    avoid: {
      fresh_grad:        ['vp', 'chief', 'head of', 'director', 'senior'],
      junior:            ['vp', 'chief', 'head of', 'director'],
      mid:               ['vp', 'chief'],
      senior:            ['junior', 'trainee', 'intern', 'associate'],
      senior_leadership: ['junior', 'trainee', 'assistant', 'intern', 'associate', 'call center', 'agent', 'representative', 'specialist', 'coordinator'],
    },
    searchKeywords: ['customer success', 'CSM', 'customer success manager', 'retention manager', 'CX manager'],
  },

  // ─── Customer Service — call center, support reps, helpdesk ──────────────
  customer_service: {
    ar: 'خدمة العملاء',
    en: 'Customer Service',
    hits: ['customer service', 'customer support', 'call center', 'كول سنتر', 'خدمة عملاء', 'خدمه عملاء', 'دعم العملاء', 'customer care', 'help desk', 'helpdesk', 'client services'],
    titles: {
      fresh_grad: ['Customer Service Representative', 'Customer Support Agent', 'Call Center Agent'],
      junior:     ['Customer Service Representative', 'Customer Support Agent', 'Customer Service Specialist'],
      mid:        ['Senior Customer Service Representative', 'Customer Support Team Lead', 'Customer Service Supervisor'],
      senior:     ['Customer Service Manager', 'Call Center Manager', 'Customer Support Manager'],
      senior_leadership: ['Head of Customer Service', 'Director of Customer Service', 'VP Customer Service'],
    },
    avoid: {
      fresh_grad:        ['vp', 'chief', 'head of', 'director', 'manager'],
      junior:            ['vp', 'chief', 'head of', 'director', 'manager'],
      senior_leadership: ['junior', 'trainee', 'agent', 'representative'],
    },
    searchKeywords: ['customer service', 'customer support', 'call center', 'customer care', 'helpdesk'],
  },

  // ─── Sales — SDR/AE/Sales Manager ────────────────────────────────────────
  sales: {
    ar: 'المبيعات',
    en: 'Sales',
    hits: ['sales', 'مبيعات', 'مندوب مبيعات', 'sdr', 'sales development', 'account executive', 'business development', 'تطوير الأعمال', 'bdr', 'sales executive'],
    titles: {
      fresh_grad: ['Sales Development Representative (SDR)', 'Junior Sales Executive', 'Inside Sales Representative'],
      junior:     ['Sales Development Representative (SDR)', 'Junior Sales Executive', 'Inside Sales Representative', 'Account Manager (Junior)'],
      mid:        ['Account Executive', 'Senior Account Executive', 'Account Manager', 'Business Development Manager'],
      senior:     ['Senior Account Executive (Enterprise)', 'Sales Manager', 'Strategic Account Manager', 'Sales Operations Lead'],
      senior_leadership: ['Head of Sales', 'Director of Sales', 'VP Sales', 'Chief Revenue Officer (CRO)', 'Sales Operations Lead'],
    },
    avoid: {
      fresh_grad:        ['vp', 'chief', 'head of', 'director', 'senior'],
      junior:            ['vp', 'chief', 'head of', 'director'],
      senior_leadership: ['junior', 'trainee', 'sdr', 'intern', 'associate', 'representative'],
    },
    searchKeywords: ['sales', 'account executive', 'sales manager', 'business development', 'sales executive'],
  },

  // ─── Marketing — broad: digital, content, growth, brand ──────────────────
  marketing: {
    ar: 'التسويق',
    en: 'Marketing',
    hits: ['marketing', 'تسويق', 'social media', 'content', 'حملات', 'seo', 'إعلانات', 'digital marketing', 'رقمي', 'محتوى', 'growth', 'brand', 'العلامة التجارية', 'performance marketing'],
    titles: {
      fresh_grad: ['Marketing Coordinator', 'Marketing Assistant', 'Junior Marketing Specialist', 'Social Media Coordinator'],
      junior:     ['Marketing Coordinator', 'Marketing Specialist', 'Social Media Specialist', 'Content Specialist'],
      mid:        ['Marketing Manager', 'Senior Marketing Specialist', 'Brand Manager', 'Growth Manager', 'Performance Marketing Manager'],
      senior:     ['Senior Marketing Manager', 'Growth Lead', 'Performance Marketing Lead', 'Brand Lead'],
      senior_leadership: ['Head of Marketing', 'Director of Marketing', 'VP Marketing', 'CMO', 'Head of Growth'],
    },
    avoid: {
      fresh_grad:        ['vp', 'chief', 'cmo', 'head of', 'director', 'senior', 'lead'],
      junior:            ['vp', 'chief', 'cmo', 'head of', 'director'],
      senior_leadership: ['junior', 'trainee', 'intern', 'coordinator', 'assistant'],
    },
    searchKeywords: ['marketing', 'digital marketing', 'marketing manager', 'growth', 'brand manager'],
  },

  // ─── HR / Talent / People ───────────────────────────────────────────────
  hr: {
    ar: 'الموارد البشرية',
    en: 'Human Resources',
    hits: ['hr', 'human resources', 'موارد بشرية', 'موارد بشريه', 'recruitment', 'توظيف', 'talent', 'استقطاب', 'تنمية بشرية', 'people operations', 'people ops', 'l&d', 'learning and development'],
    titles: {
      fresh_grad: ['HR Coordinator', 'HR Assistant', 'Recruitment Coordinator', 'People Operations Coordinator'],
      junior:     ['HR Specialist', 'Recruitment Specialist', 'HR Coordinator', 'People Operations Associate'],
      mid:        ['HR Business Partner', 'Senior HR Specialist', 'Talent Acquisition Manager', 'People Operations Manager'],
      senior:     ['Senior HR Business Partner', 'Head of Talent', 'Senior People Manager'],
      senior_leadership: ['Head of HR', 'Director of HR', 'VP People', 'CHRO', 'Head of People'],
    },
    avoid: {
      fresh_grad:        ['vp', 'chief', 'chro', 'head of', 'director', 'senior', 'business partner'],
      junior:            ['vp', 'chief', 'chro', 'head of', 'director'],
      senior_leadership: ['junior', 'trainee', 'intern', 'coordinator', 'assistant'],
    },
    searchKeywords: ['HR', 'human resources', 'talent acquisition', 'recruitment', 'people operations'],
  },

  // ─── Finance — corporate finance, FP&A, treasury, audit ─────────────────
  finance: {
    ar: 'المالية',
    en: 'Finance',
    hits: ['finance', 'مالية', 'fp&a', 'treasury', 'investor relations', 'العلاقات الاستثمارية', 'corporate finance', 'financial analyst', 'محلل مالي'],
    titles: {
      fresh_grad: ['Junior Financial Analyst', 'Finance Associate', 'Finance Trainee'],
      junior:     ['Financial Analyst', 'Junior FP&A Analyst', 'Finance Associate'],
      mid:        ['Senior Financial Analyst', 'FP&A Manager', 'Finance Manager', 'Treasury Analyst'],
      senior:     ['Senior Finance Manager', 'FP&A Lead', 'Senior Treasury Manager', 'Controller'],
      senior_leadership: ['Head of Finance', 'Director of Finance', 'VP Finance', 'CFO', 'Finance Director'],
    },
    avoid: {
      fresh_grad:        ['vp', 'chief', 'cfo', 'head of', 'director', 'senior', 'lead', 'manager'],
      junior:            ['vp', 'chief', 'cfo', 'head of', 'director', 'manager'],
      senior_leadership: ['junior', 'trainee', 'intern', 'analyst', 'associate'],
    },
    searchKeywords: ['finance', 'financial analyst', 'FP&A', 'finance manager', 'treasury'],
  },

  // ─── Accounting — bookkeeping, payroll, tax, audit ──────────────────────
  accounting: {
    ar: 'المحاسبة',
    en: 'Accounting',
    hits: ['accounting', 'محاسبة', 'محاسبه', 'محاسب', 'audit', 'تدقيق', 'bookkeep', 'payroll', 'الرواتب', 'tax', 'الضرائب', 'general ledger'],
    titles: {
      fresh_grad: ['Junior Accountant', 'Accounting Trainee', 'Accounts Assistant'],
      junior:     ['Junior Accountant', 'Accountant', 'Accounts Payable Specialist', 'Accounts Receivable Specialist'],
      mid:        ['Senior Accountant', 'Accounting Supervisor', 'Tax Specialist', 'Audit Senior'],
      senior:     ['Senior Accountant', 'Accounting Manager', 'Audit Manager', 'Tax Manager'],
      senior_leadership: ['Head of Accounting', 'Director of Accounting', 'Chief Accountant', 'Controller', 'Finance Controller'],
    },
    avoid: {
      fresh_grad:        ['vp', 'chief', 'head of', 'director', 'senior', 'manager', 'controller'],
      junior:            ['vp', 'chief', 'head of', 'director', 'manager', 'controller'],
      senior_leadership: ['junior', 'trainee', 'intern', 'assistant', 'specialist'],
    },
    searchKeywords: ['accountant', 'accounting', 'audit', 'tax accountant', 'bookkeeping'],
  },

  // ─── Operations — business ops, supply chain, ops manager ───────────────
  operations: {
    ar: 'العمليات',
    en: 'Operations',
    hits: ['operations', 'العمليات', 'business operations', 'ops manager', 'supply chain', 'سلسلة الإمداد', 'logistics ops', 'process improvement'],
    titles: {
      fresh_grad: ['Operations Coordinator', 'Operations Associate', 'Operations Analyst (Junior)'],
      junior:     ['Operations Analyst', 'Operations Coordinator', 'Operations Specialist'],
      mid:        ['Operations Manager', 'Senior Operations Analyst', 'Process Improvement Manager'],
      senior:     ['Senior Operations Manager', 'Operations Lead', 'Head of Business Operations (smaller team)'],
      senior_leadership: ['Head of Operations', 'Director of Operations', 'VP Operations', 'COO'],
    },
    avoid: {
      fresh_grad:        ['vp', 'chief', 'coo', 'head of', 'director', 'senior'],
      junior:            ['vp', 'chief', 'coo', 'head of', 'director'],
      senior_leadership: ['junior', 'trainee', 'intern', 'coordinator', 'associate', 'analyst'],
    },
    searchKeywords: ['operations', 'operations manager', 'business operations', 'process improvement'],
  },

  // ─── Admin / Office / EA — back office support ──────────────────────────
  admin_office: {
    ar: 'العمل المكتبي',
    en: 'Administration & Office',
    hits: ['admin', 'office', 'إداري', 'مكتبي', 'coordinator', 'منسق', 'executive assistant', 'سكرتير', 'data entry', 'تنسيق', 'receptionist', 'استقبال'],
    titles: {
      fresh_grad: ['Office Coordinator', 'Administrative Assistant', 'Office Assistant', 'Receptionist'],
      junior:     ['Administrative Assistant', 'Office Coordinator', 'Executive Assistant (Junior)', 'Data Entry Specialist'],
      mid:        ['Executive Assistant', 'Office Manager', 'Senior Administrative Assistant'],
      senior:     ['Senior Executive Assistant', 'Office Manager', 'Administrative Manager'],
      senior_leadership: ['Head of Administration', 'Director of Administration', 'Chief of Staff'],
    },
    avoid: {
      fresh_grad:        ['vp', 'chief', 'head of', 'director', 'senior', 'manager'],
      senior_leadership: ['junior', 'trainee', 'intern', 'assistant', 'coordinator', 'data entry'],
    },
    searchKeywords: ['administrative', 'office coordinator', 'executive assistant', 'office manager'],
  },

  // ─── IT / Help Desk / Sys Admin / Cyber ─────────────────────────────────
  it_cyber: {
    ar: 'تقنية المعلومات / الأمن السيبراني',
    en: 'IT / Cybersecurity',
    hits: ['it ', 'تقنية المعلومات', 'cybersecurity', 'امن سيبراني', 'الأمن السيبراني', 'helpdesk', 'help desk', 'soc', 'شبكات', 'networking', 'it support', 'sysadmin', 'system administrator', 'الدعم الفني'],
    titles: {
      fresh_grad: ['IT Support Specialist', 'Junior IT Support', 'Help Desk Analyst', 'SOC Analyst (Junior)'],
      junior:     ['IT Support Specialist', 'Help Desk Analyst', 'Network Support Specialist', 'SOC Analyst'],
      mid:        ['System Administrator', 'Senior IT Support', 'Network Administrator', 'Cybersecurity Analyst', 'SOC Analyst II'],
      senior:     ['Senior System Administrator', 'Senior Network Engineer', 'Senior Cybersecurity Analyst', 'Security Engineer'],
      senior_leadership: ['Head of IT', 'IT Director', 'Head of Cybersecurity', 'CISO'],
    },
    avoid: {
      fresh_grad:        ['vp', 'chief', 'ciso', 'head of', 'director', 'senior'],
      junior:            ['vp', 'chief', 'ciso', 'head of', 'director'],
      senior_leadership: ['junior', 'trainee', 'intern', 'specialist', 'help desk'],
    },
    searchKeywords: ['IT support', 'system administrator', 'cybersecurity analyst', 'network engineer', 'help desk'],
  },

  // ─── Software Engineering — backend, frontend, fullstack, mobile ────────
  software: {
    ar: 'هندسة البرمجيات',
    en: 'Software Engineering',
    hits: ['software engineer', 'مهندس برمجيات', 'مطور', 'developer', 'backend', 'frontend', 'fullstack', 'full stack', 'mobile developer', 'react', 'node', 'python developer', 'java developer', 'تطوير برمجي'],
    titles: {
      fresh_grad: ['Junior Software Engineer', 'Associate Software Engineer', 'Software Engineering Intern', 'Junior Developer'],
      junior:     ['Junior Software Engineer', 'Software Engineer I', 'Associate Software Engineer'],
      mid:        ['Software Engineer', 'Software Engineer II', 'Senior Software Engineer', 'Full Stack Engineer'],
      senior:     ['Senior Software Engineer', 'Staff Engineer', 'Tech Lead', 'Principal Engineer'],
      senior_leadership: ['Engineering Manager', 'Head of Engineering', 'Director of Engineering', 'VP Engineering', 'CTO'],
    },
    avoid: {
      fresh_grad:        ['vp', 'chief', 'cto', 'head of', 'director', 'senior', 'staff', 'principal', 'lead'],
      junior:            ['vp', 'chief', 'cto', 'head of', 'director', 'staff', 'principal'],
      senior_leadership: ['junior', 'trainee', 'intern', 'associate'],
    },
    searchKeywords: ['software engineer', 'backend engineer', 'frontend engineer', 'full stack developer', 'developer'],
  },

  // ─── Data — analytics, BI, data science, ML ─────────────────────────────
  data: {
    ar: 'البيانات',
    en: 'Data',
    hits: ['data analyst', 'data scientist', 'data engineer', 'business intelligence', 'bi analyst', 'محلل بيانات', 'البيانات', 'machine learning', 'تعلم الآلة', 'ml engineer', 'analytics'],
    titles: {
      fresh_grad: ['Junior Data Analyst', 'Data Analyst Intern', 'Associate Data Analyst'],
      junior:     ['Data Analyst', 'BI Analyst (Junior)', 'Junior Data Engineer'],
      mid:        ['Senior Data Analyst', 'Data Engineer', 'BI Analyst', 'Analytics Engineer'],
      senior:     ['Senior Data Engineer', 'Senior Data Scientist', 'Analytics Lead', 'Staff Data Scientist'],
      senior_leadership: ['Head of Data', 'Director of Data', 'VP Data', 'Chief Data Officer'],
    },
    avoid: {
      fresh_grad:        ['vp', 'chief', 'head of', 'director', 'senior', 'staff', 'lead'],
      junior:            ['vp', 'chief', 'head of', 'director', 'staff'],
      senior_leadership: ['junior', 'trainee', 'intern', 'associate'],
    },
    searchKeywords: ['data analyst', 'data engineer', 'data scientist', 'BI analyst', 'analytics'],
  },

  // ─── Product Management ─────────────────────────────────────────────────
  product: {
    ar: 'إدارة المنتجات',
    en: 'Product Management',
    hits: ['product manager', 'pm', 'product owner', 'مدير منتج', 'product management', 'إدارة المنتجات'],
    titles: {
      fresh_grad: ['Associate Product Manager (APM)', 'Junior Product Manager', 'Product Analyst'],
      junior:     ['Associate Product Manager', 'Product Manager (Junior)', 'Product Analyst'],
      mid:        ['Product Manager', 'Senior Product Manager', 'Product Owner'],
      senior:     ['Senior Product Manager', 'Group Product Manager', 'Principal Product Manager', 'Lead Product Manager'],
      senior_leadership: ['Head of Product', 'Director of Product', 'VP Product', 'CPO', 'Chief Product Officer'],
    },
    avoid: {
      fresh_grad:        ['vp', 'chief', 'cpo', 'head of', 'director', 'senior', 'principal'],
      junior:            ['vp', 'chief', 'cpo', 'head of', 'director'],
      senior_leadership: ['junior', 'trainee', 'intern', 'associate', 'analyst'],
    },
    searchKeywords: ['product manager', 'product owner', 'senior product manager', 'product management'],
  },

  // ─── Design — UX/UI, graphic, brand, product design ─────────────────────
  design: {
    ar: 'التصميم',
    en: 'Design',
    hits: ['design', 'تصميم', 'graphic', 'ui', 'ux', 'مصمم', 'figma', 'adobe', 'بصري', 'product design', 'visual design'],
    titles: {
      fresh_grad: ['Junior Designer', 'Junior UI/UX Designer', 'Graphic Design Intern', 'Junior Visual Designer'],
      junior:     ['UI/UX Designer (Junior)', 'Graphic Designer', 'Visual Designer'],
      mid:        ['Senior UI/UX Designer', 'Senior Graphic Designer', 'Product Designer'],
      senior:     ['Lead Product Designer', 'Senior Product Designer', 'Design Lead'],
      senior_leadership: ['Head of Design', 'Director of Design', 'VP Design', 'Chief Design Officer'],
    },
    avoid: {
      fresh_grad:        ['vp', 'chief', 'head of', 'director', 'senior', 'lead'],
      junior:            ['vp', 'chief', 'head of', 'director', 'lead'],
      senior_leadership: ['junior', 'trainee', 'intern'],
    },
    searchKeywords: ['UI designer', 'UX designer', 'product designer', 'graphic designer', 'visual designer'],
  },

  // ─── Hospitality — F&B, hotels, events ──────────────────────────────────
  hospitality: {
    ar: 'الضيافة والمطاعم',
    en: 'Hospitality',
    hits: ['hospitality', 'hotel', 'فندق', 'الضيافة', 'restaurant', 'مطعم', 'f&b', 'مأكولات', 'باريستا', 'barista', 'waiter', 'نادل', 'concierge', 'event manager'],
    titles: {
      fresh_grad: ['Barista', 'Waiter / Server', 'Front Desk Agent', 'Banquet Server'],
      junior:     ['Barista', 'Senior Server', 'Front Desk Agent', 'Guest Services Associate'],
      mid:        ['Shift Supervisor', 'Restaurant Supervisor', 'Front Office Supervisor'],
      senior:     ['Restaurant Manager', 'Front Office Manager', 'F&B Manager', 'Events Manager'],
      senior_leadership: ['General Manager (Hotel)', 'Director of F&B', 'Director of Operations (Hospitality)'],
    },
    avoid: {
      fresh_grad:        ['director', 'general manager', 'head of', 'manager'],
      senior_leadership: ['barista', 'waiter', 'server', 'agent'],
    },
    searchKeywords: ['hospitality', 'F&B', 'restaurant manager', 'hotel front office', 'barista'],
  },

  // ─── Retail — cashier, store manager, retail buyer ──────────────────────
  retail: {
    ar: 'التجزئة',
    en: 'Retail',
    hits: ['retail', 'تجزئة', 'cashier', 'كاشير', 'store manager', 'sales associate', 'merchandising', 'مبيعات تجزئة', 'visual merchandising'],
    titles: {
      fresh_grad: ['Cashier', 'Sales Associate', 'Retail Assistant'],
      junior:     ['Sales Associate', 'Cashier', 'Retail Sales Specialist'],
      mid:        ['Store Supervisor', 'Assistant Store Manager', 'Senior Sales Associate'],
      senior:     ['Store Manager', 'Area Manager', 'Retail Operations Manager'],
      senior_leadership: ['Regional Retail Manager', 'Director of Retail Operations', 'Head of Retail'],
    },
    avoid: {
      fresh_grad:        ['vp', 'director', 'head of', 'manager', 'senior'],
      senior_leadership: ['cashier', 'associate', 'assistant'],
    },
    searchKeywords: ['retail', 'store manager', 'sales associate', 'cashier'],
  },

  // ─── Logistics — supply chain, warehouse, transport ─────────────────────
  logistics: {
    ar: 'الخدمات اللوجستية',
    en: 'Logistics',
    hits: ['logistics', 'لوجستيات', 'warehouse', 'مستودع', 'supply chain', 'سلسلة الإمداد', 'shipping', 'الشحن', 'fleet', 'distribution', 'last mile', 'الميل الأخير'],
    titles: {
      fresh_grad: ['Logistics Coordinator (Junior)', 'Warehouse Associate', 'Junior Supply Chain Analyst'],
      junior:     ['Logistics Coordinator', 'Warehouse Associate', 'Supply Chain Analyst'],
      mid:        ['Senior Logistics Coordinator', 'Warehouse Supervisor', 'Supply Chain Manager'],
      senior:     ['Logistics Manager', 'Senior Supply Chain Manager', 'Warehouse Manager'],
      senior_leadership: ['Head of Logistics', 'Director of Supply Chain', 'VP Operations (Logistics)'],
    },
    avoid: {
      fresh_grad:        ['vp', 'head of', 'director', 'manager', 'senior'],
      senior_leadership: ['junior', 'trainee', 'associate', 'coordinator'],
    },
    searchKeywords: ['logistics', 'supply chain', 'warehouse manager', 'logistics coordinator'],
  },

  // ─── Healthcare Admin — non-clinical hospital ops ───────────────────────
  healthcare_admin: {
    ar: 'الإدارة الصحية',
    en: 'Healthcare Administration',
    hits: ['healthcare admin', 'hospital admin', 'الإدارة الصحية', 'patient services', 'خدمات المرضى', 'medical records', 'السجلات الطبية', 'health insurance coordinator', 'medical receptionist'],
    titles: {
      fresh_grad: ['Medical Receptionist', 'Patient Services Coordinator', 'Junior Healthcare Admin'],
      junior:     ['Patient Services Coordinator', 'Medical Records Specialist', 'Healthcare Administrator'],
      mid:        ['Senior Patient Services Coordinator', 'Healthcare Operations Specialist', 'Clinic Administrator'],
      senior:     ['Healthcare Operations Manager', 'Clinic Manager', 'Senior Healthcare Administrator'],
      senior_leadership: ['Director of Healthcare Operations', 'Hospital Administrator', 'Head of Patient Services'],
    },
    avoid: {
      fresh_grad:        ['vp', 'head of', 'director', 'manager', 'senior'],
      senior_leadership: ['junior', 'trainee', 'receptionist'],
    },
    searchKeywords: ['healthcare administrator', 'patient services', 'hospital administrator', 'medical records'],
  },

  // ─── Education — teachers, training coordinators, edu admin ─────────────
  education: {
    ar: 'التعليم',
    en: 'Education',
    hits: ['teacher', 'مدرس', 'معلم', 'instructor', 'lecturer', 'professor', 'تعليم', 'education', 'training coordinator', 'منسق تدريب', 'academic advisor'],
    titles: {
      fresh_grad: ['Teaching Assistant', 'Junior Instructor', 'Education Coordinator'],
      junior:     ['Teacher', 'Instructor', 'Training Coordinator', 'Academic Advisor'],
      mid:        ['Senior Teacher', 'Lead Instructor', 'Training Manager', 'Senior Academic Advisor'],
      senior:     ['Department Head', 'Senior Training Manager', 'Curriculum Lead'],
      senior_leadership: ['Principal', 'School Director', 'Head of Academics', 'Director of Education'],
    },
    avoid: {
      fresh_grad:        ['vp', 'head of', 'director', 'principal', 'senior'],
      senior_leadership: ['junior', 'assistant', 'trainee'],
    },
    searchKeywords: ['teacher', 'instructor', 'training coordinator', 'academic advisor'],
  },

  // ─── Simple/general entry — when no clear family applies ────────────────
  general_entry: {
    ar: 'وظائف عامة / مبسطة',
    en: 'General Entry-Level',
    hits: ['general', 'simple job', 'وظيفة بسيطة', 'وظيفه بسيطه', 'entry level', 'no experience', 'بدون خبرة'],
    titles: {
      fresh_grad: ['Cashier', 'Sales Associate', 'Receptionist', 'Office Assistant', 'Customer Service Representative'],
      junior:     ['Sales Associate', 'Receptionist', 'Office Assistant', 'Customer Service Representative'],
      mid:        ['Office Coordinator', 'Senior Sales Associate', 'Assistant Supervisor'],
      senior:     ['Supervisor', 'Office Manager'],
      senior_leadership: ['Manager'],
    },
    avoid: {
      fresh_grad: ['vp', 'chief', 'head of', 'director', 'senior'],
    },
    searchKeywords: ['entry level', 'sales associate', 'cashier', 'receptionist'],
  },

  // ─── Unknown — last-resort family used when we can't classify ──────────
  unknown: {
    ar: 'مسار غير محدد',
    en: 'Unspecified',
    hits: [],
    titles: { fresh_grad: [], junior: [], mid: [], senior: [], senior_leadership: [] },
    avoid:  { fresh_grad: [], junior: [], mid: [], senior: [], senior_leadership: [] },
    searchKeywords: [],
  },
};

// Order-stable list of family IDs.
const FAMILY_IDS = Object.keys(FAMILIES);

// Lower-cased + Arabic-normalized hit map. Built once at module load.
function _norm(s) {
  if (!s) return '';
  return String(s)
    .replace(/[ً-ٰٟ]/g, '') // strip diacritics
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .trim();
}

// Detect career family from {dreamRole, cvText, hintFamily}. hintFamily
// (from /api/darbi/resolve-intent) wins when supplied and valid.
function detectFamily({ dreamRole, cvText, hintFamily }) {
  if (hintFamily && FAMILIES[hintFamily]) {
    return { family: hintFamily, confidence: 95, source: 'hint' };
  }
  const dn = _norm(dreamRole);
  const cn = _norm(cvText).slice(0, 800);
  const combined = dn + ' ' + cn;

  let bestFam = 'unknown';
  let bestScore = 0;
  for (const fam of FAMILY_IDS) {
    if (fam === 'unknown') continue;
    let score = 0;
    for (const concept of FAMILIES[fam].hits) {
      const cnorm = _norm(concept);
      if (!cnorm) continue;
      if (dn.indexOf(cnorm) !== -1) score += 2;
      else if (combined.indexOf(cnorm) !== -1) score += 1;
    }
    if (score > bestScore) { bestScore = score; bestFam = fam; }
  }
  let confidence;
  if (bestScore === 0)      confidence = 18;
  else if (bestScore === 1) confidence = 45;
  else if (bestScore === 2) confidence = 62;
  else if (bestScore === 3) confidence = 74;
  else                       confidence = 82;
  return { family: bestFam, confidence, source: 'detect' };
}

// Detect seniority band from CV facts. The buildSearchProfile() caller can
// also pass an explicit seniorityHint (from the diagnosis).
function detectSeniorityBand({ cvText, dreamRole, cvFacts, hint }) {
  if (hint && ['fresh_grad','junior','mid','senior','senior_leadership'].includes(hint)) return hint;
  const cv = cvText || '';
  const facts = cvFacts || {};
  // Senior leadership signals — multiple required to upgrade past 'senior'.
  let leadershipSignals = 0;
  if (facts.yearsExp && facts.yearsExp >= 8) leadershipSignals++;
  if (/\b(head of|director|vp\b|vice president|chief|c-?level|cxo|cco|cmo|coo|cto|ceo|cfo|chro)\b/i.test(cv)) leadershipSignals++;
  if (/\bmanager of (csms|managers|managers and|the team|teams)\b/i.test(cv)) leadershipSignals++;
  if (/\b(arr|nrr|grr|mrr|retention rate|net retention)\b/i.test(cv) && /\b(80|100|50|30|200)\s*m\b/i.test(cv)) leadershipSignals++;
  if (facts.leadershipEvidence) leadershipSignals++;
  if (/\b(playbook|playbooks|health scoring|qbr|executive (review|reporting))\b/i.test(cv)) leadershipSignals++;
  if (leadershipSignals >= 2) return 'senior_leadership';

  // Plain seniority bands.
  if (facts.yearsExp && facts.yearsExp >= 7) return 'senior';
  if (facts.yearsExp && facts.yearsExp >= 3) return 'mid';
  if (facts.yearsExp && facts.yearsExp >= 1) return 'junior';
  if (/\b(fresh|graduate|تخرج|تخرجت|خريج|intern|تدريب|طالب|طالبه|student)\b/i.test(cv)) return 'fresh_grad';
  // Last-resort: dream-level. "Director" dream + thin CV usually means user
  // is wishful but should be treated as mid for safety.
  if (/\b(director|head of|vp\b|chief)\b/i.test(dreamRole || '')) return 'mid';
  return 'junior';
}

module.exports = {
  FAMILIES,
  FAMILY_IDS,
  detectFamily,
  detectSeniorityBand,
};
