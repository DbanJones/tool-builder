// The kit's recursive interview library.
//
// IMPORTANT (per drift D-005): the question text and decision-table mapping
// here are PLACEHOLDERS inferred from the .builder/answers.json recorded
// answers. The original Build Spec Kit's authoritative library has not been
// sourced into this repo yet. Real questions + decision table will replace
// these strings without changing the schema.
//
// What is canonical here:
// - The 28 fast-path question ids (Q1-Q28).
// - The shape of `Question` and `DecisionTableEntry`.
// - The mapping of question id → topic.
//
// What is placeholder:
// - The exact `prompt` strings (a real interview will phrase these for novices).
// - The exhaustiveness of the decision table (only the most obvious entries
//   are seeded; the kit has more).

export type QuestionId =
  | "Q1" | "Q2" | "Q3" | "Q4" | "Q5" | "Q6" | "Q7"
  | "Q8" | "Q9" | "Q10" | "Q11" | "Q12" | "Q13" | "Q14"
  | "Q15" | "Q16" | "Q17" | "Q18" | "Q19" | "Q20" | "Q21"
  | "Q22" | "Q23" | "Q24" | "Q25" | "Q26" | "Q27" | "Q28"
  | "Q29" | "Q30" | "Q31" | "Q32"
  | "Q33" | "Q34" | "Q35";

export type QuestionType = "open" | "yes_no" | "single_select" | "multi_select" | "freeform_list";

export interface Question {
  id: QuestionId;
  topic: string;
  prompt: string;
  fastPath: boolean;
  type: QuestionType;
  influencesSpecSections: readonly string[];
}

export const QUESTION_LIBRARY: readonly Question[] = [
  {
    id: "Q1",
    topic: "elevator pitch",
    prompt:
      "In one sentence: what does this app do, who is the primary user, and what painful thing does it replace? Be specific — 'it's a CRM' is too vague; 'a CRM for solo plumbers who currently track jobs in WhatsApp' is right.",
    fastPath: true,
    type: "open",
    influencesSpecSections: ["§1", "§2"],
  },
  {
    id: "Q2",
    topic: "user accounts",
    prompt: "Will users have individual accounts? If yes, what do they sign in with (email, magic link, OAuth, API key, none)?",
    fastPath: true,
    type: "single_select",
    influencesSpecSections: ["§4", "§5"],
  },
  {
    id: "Q3",
    topic: "payments",
    prompt: "Will the app take payments from users? Subscription, one-off, or none?",
    fastPath: true,
    type: "single_select",
    influencesSpecSections: ["§5"],
  },
  {
    id: "Q4",
    topic: "marketplace",
    prompt: "Is this a marketplace or multi-vendor app where one party transacts with another?",
    fastPath: true,
    type: "yes_no",
    influencesSpecSections: ["§4"],
  },
  {
    id: "Q5",
    topic: "ai",
    prompt: "Will the app use AI/LLM features (chat, generation, summarisation)? If yes, central or peripheral?",
    fastPath: true,
    type: "single_select",
    influencesSpecSections: ["§5"],
  },
  {
    id: "Q6",
    topic: "background jobs",
    prompt: "Will the app run long-running background work (jobs, schedulers, queues)?",
    fastPath: true,
    type: "yes_no",
    influencesSpecSections: ["§5"],
  },
  {
    id: "Q7",
    topic: "webhooks",
    prompt: "Does the app receive inbound webhooks or events from third parties?",
    fastPath: true,
    type: "yes_no",
    influencesSpecSections: ["§5"],
  },
  {
    id: "Q8",
    topic: "file uploads",
    prompt: "Will users upload files (images, documents, data)?",
    fastPath: true,
    type: "yes_no",
    influencesSpecSections: ["§5"],
  },
  {
    id: "Q9",
    topic: "pii / gdpr",
    prompt: "Will the app process personal data of EU/UK users (names, emails, anything that identifies a person)?",
    fastPath: true,
    type: "yes_no",
    influencesSpecSections: ["§6"],
  },
  {
    id: "Q10",
    topic: "auth model",
    prompt: "How does the app gate access? Anonymous-OK, login-required, role-based, or some pages public and some private?",
    fastPath: true,
    type: "single_select",
    influencesSpecSections: ["§4"],
  },
  {
    id: "Q11",
    topic: "scale",
    prompt: "Roughly how many users do you expect in the first year? (under 100, under 1k, under 10k, more)",
    fastPath: true,
    type: "single_select",
    influencesSpecSections: ["§6"],
  },
  {
    id: "Q12",
    topic: "design",
    prompt: "Any design preferences? Pick one: clean and minimal, expressive and bold, professional/enterprise, or 'you choose'.",
    fastPath: true,
    type: "single_select",
    influencesSpecSections: ["§2"],
  },
  {
    id: "Q13",
    topic: "platforms",
    prompt: "Which platforms? Web, mobile, desktop, or some combination?",
    fastPath: true,
    type: "multi_select",
    influencesSpecSections: ["§2"],
  },
  {
    id: "Q14",
    topic: "accessibility",
    prompt: "Do you need accessibility compliance? (WCAG 2.2 AA is the default for the kit; say no only if you really mean it.)",
    fastPath: true,
    type: "yes_no",
    influencesSpecSections: ["§6"],
  },
  {
    id: "Q15",
    topic: "core flows",
    prompt:
      "List the 3-5 most important user flows for v1. For each, write one line in this shape: '<actor> <does what> so that <outcome>'. Example: 'A plumber adds a new job from a customer call so that they don't lose it before invoicing.' Skip nice-to-haves; only flows the app fails without.",
    fastPath: true,
    type: "freeform_list",
    influencesSpecSections: ["§3"],
  },
  {
    id: "Q16",
    topic: "acceptance criteria",
    prompt:
      "For your top flow from Q15, what does 'done' look like? Tell me: the start state, the user action, the visible end state, and the one failure case that must NOT happen. Plain language is fine.",
    fastPath: true,
    type: "open",
    influencesSpecSections: ["§3"],
  },
  {
    id: "Q17",
    topic: "integrations",
    prompt: "Which third-party services must this talk to? (Stripe, Anthropic, Vercel, GitHub, etc.)",
    fastPath: true,
    type: "freeform_list",
    influencesSpecSections: ["§5"],
  },
  {
    id: "Q18",
    topic: "tenancy",
    prompt: "Single-tenant (one customer per deployment), multi-tenant (one deployment serves many), or just-users (one app, many independent accounts)?",
    fastPath: true,
    type: "single_select",
    influencesSpecSections: ["§4"],
  },
  {
    id: "Q19",
    topic: "pricing",
    prompt: "Will there be paid tiers? If yes, free + paid, multiple paid tiers, or usage-based?",
    fastPath: true,
    type: "single_select",
    influencesSpecSections: ["§5"],
  },
  {
    id: "Q20",
    topic: "stack constraints",
    prompt: "Any hard stack constraints? (e.g. must be desktop, must use Postgres, must run on AWS.) If none, the kit defaults apply.",
    fastPath: true,
    type: "open",
    influencesSpecSections: ["§2"],
  },
  {
    id: "Q21",
    topic: "performance",
    prompt: "Any specific performance targets? (page load, API latency, app launch time.) Defaults: LCP <=2.5s, INP <=200ms.",
    fastPath: true,
    type: "open",
    influencesSpecSections: ["§6"],
  },
  {
    id: "Q22",
    topic: "test strategy",
    prompt: "How rigorous on testing? Smoke-only, smoke + critical paths, or full coverage on lib/?",
    fastPath: true,
    type: "single_select",
    influencesSpecSections: ["§6"],
  },
  {
    id: "Q23",
    topic: "telemetry",
    prompt: "Telemetry posture: none, opt-in (default), or opt-out by default?",
    fastPath: true,
    type: "single_select",
    influencesSpecSections: ["§6"],
  },
  {
    id: "Q24",
    topic: "cost ceiling",
    prompt: "Set a cost ceiling for LLM spend during development and per build.",
    fastPath: true,
    type: "open",
    influencesSpecSections: ["§6"],
  },
  {
    id: "Q25",
    topic: "build methodology",
    prompt: "Will this project follow the Build Spec Kit's rules and conventions?",
    fastPath: true,
    type: "yes_no",
    influencesSpecSections: ["§7"],
  },
  {
    id: "Q26",
    topic: "i18n",
    prompt: "Will the app be available in more than one language at launch?",
    fastPath: true,
    type: "yes_no",
    influencesSpecSections: ["§6"],
  },
  {
    id: "Q27",
    topic: "locales",
    prompt: "Which locales? (e.g. en-GB, en-US, fr-FR.)",
    fastPath: true,
    type: "freeform_list",
    influencesSpecSections: ["§6"],
  },
  {
    id: "Q28",
    topic: "destructive actions",
    prompt: "Which actions are irreversible and need a double-confirm? (delete account, drop project, force-push, etc.)",
    fastPath: true,
    type: "freeform_list",
    influencesSpecSections: ["§6"],
  },
  {
    id: "Q29",
    topic: "data entities",
    prompt:
      "What 'things' does the app track? List the nouns it stores and shows. Example for the plumber CRM: customers, jobs, invoices, parts. Aim for 3-7; if you have more, you probably have multiple apps.",
    fastPath: true,
    type: "freeform_list",
    influencesSpecSections: ["§4"],
  },
  {
    id: "Q30",
    topic: "key fields per entity",
    prompt:
      "For each thing from Q29, what 2-4 fields define it? Example: 'job: customer, address, status, scheduled_date'. Only the fields you'd lose sleep over if they were missing.",
    fastPath: true,
    type: "freeform_list",
    influencesSpecSections: ["§4"],
  },
  {
    id: "Q31",
    topic: "out of scope",
    prompt:
      "What are you explicitly NOT building in v1, even though it's tempting? List the features you'll resist adding so the agent doesn't drift into them. Example: 'no team accounts in v1, no mobile app yet, no reporting beyond a single CSV export'.",
    fastPath: true,
    type: "freeform_list",
    influencesSpecSections: ["§2"],
  },
  {
    id: "Q32",
    topic: "definition of done",
    prompt:
      "What is the minimum that has to work for you to call v1 'shipped' and put it in front of a real user? One paragraph. If you can't ship without feature X, X belongs in your top flows; everything else is v2.",
    fastPath: true,
    type: "open",
    influencesSpecSections: ["§3"],
  },
  {
    id: "Q33",
    topic: "deliverable artifact",
    prompt:
      "When this is built, what does the end user actually open, download, or look at? Be concrete about the form, not the features. Examples: 'an .xlsx file with tabs for assumptions, P&L, and a sensitivity table', 'a web dashboard with a calendar and a list view', 'an emailed PDF report', 'a desktop app window with a single form'. If the form is wrong, the build is wrong — even if every feature works.",
    fastPath: true,
    type: "open",
    influencesSpecSections: ["§3"],
  },
  {
    id: "Q34",
    topic: "reference anchors",
    prompt:
      "Name 1-3 existing tools, apps, or websites this should resemble, and for each say what's similar and what's different. Example: 'Like Notion's editor but for recipes; like Excel for the math but with form inputs instead of cells'. These anchors stop the agent from inventing a shape you didn't want.",
    fastPath: true,
    type: "freeform_list",
    influencesSpecSections: ["§2"],
  },
  {
    id: "Q35",
    topic: "non-negotiables",
    prompt:
      "What features or properties are non-negotiable for v1 — the things that, if missing, would make you reject the build outright? Be ruthless; this is the wall the agent must not cross. Example for a financial-model builder: 'must produce an .xlsx file (not a web view)', 'must include a sensitivity table', 'must let me edit assumptions and regenerate'.",
    fastPath: true,
    type: "freeform_list",
    influencesSpecSections: ["§3"],
  },
];

export const FAST_PATH_QUESTIONS: readonly Question[] = QUESTION_LIBRARY.filter(
  (q) => q.fastPath,
);

export function getQuestionById(id: QuestionId): Question | undefined {
  return QUESTION_LIBRARY.find((q) => q.id === id);
}

// -------- Decision table --------
//
// Maps an answer pattern on a question to rule ids that activate. This is a
// thin starter set; the real kit has more entries. The shape is what tests
// pin down so later population is type-safe.

export type AnswerPattern = "any" | "yes" | "no";

export interface DecisionTableEntry {
  questionId: QuestionId;
  answerPattern: AnswerPattern;
  appliesRules: readonly string[];
}

export const DECISION_TABLE: readonly DecisionTableEntry[] = [
  // PII / GDPR posture activates the data-minimisation rule and the audit log requirement.
  { questionId: "Q9", answerPattern: "yes", appliesRules: ["O18", "B3"] },
  // File uploads activate the per-type size limits and the PII guard pattern.
  { questionId: "Q8", answerPattern: "yes", appliesRules: ["B28"] },
  // Accessibility yes activates the F12-F18 set.
  {
    questionId: "Q14",
    answerPattern: "yes",
    appliesRules: ["F12", "F13", "F14", "F15", "F16", "F17", "F18"],
  },
  // Webhooks activate the signature-verification rule.
  { questionId: "Q7", answerPattern: "yes", appliesRules: ["B25"] },
  // Background jobs activate the orchestrator/idempotency rules.
  { questionId: "Q6", answerPattern: "yes", appliesRules: ["B22", "B23", "B24"] },
  // i18n activates the next-intl gating rule.
  { questionId: "Q26", answerPattern: "yes", appliesRules: ["O22"] },
];

// Format check: rule ids look like "X1" or "X12" (single uppercase letter + digits).
export const RULE_ID_PATTERN = /^[A-Z]\d+[a-z]?$/;
