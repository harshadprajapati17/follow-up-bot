export type AnalyzeSessionV1 = {
  current_intent: string | null;
  entities: Record<string, unknown>;
  missing_fields: string[];
  active_lead_id: string | null;
  /**
   * If set, user asked for a different intent while another flow was incomplete.
   * We then ask for confirmation before switching.
   */
  pending_intent_switch_to?: string | null;
  /**
   * If set, we guessed this might be the user's phone number (10 digits)
   * and we're waiting for them to confirm "theek hai"/"theek nahi".
   */
  pending_phone_candidate?: string | null;
  /**
   * If set, we're waiting for user to confirm this text as customer name
   * ("theek hai"/"theek nahi").
   */
  pending_name_candidate?: string | null;
};

export const DEFAULT_SESSION: AnalyzeSessionV1 = {
  current_intent: null,
  entities: {},
  missing_fields: [],
  active_lead_id: null,
  pending_intent_switch_to: null,
  pending_phone_candidate: null,
  pending_name_candidate: null,
};

export type OrchestratorInput = {
  session: AnalyzeSessionV1;
  intents: string[];
  entities: Record<string, unknown>;
  /**
   * Raw user text for lightweight heuristics (name/phone, confirmations, etc.).
   */
  text: string;
};

export type OrchestratorResult =
  | {
      status: "incomplete";
      question: string;
      question_examples?: string[];
      session: any;
    }
  | { status: "ready"; session: any }
  | { status: "noop"; session: any };

const LOG_MEASUREMENT_REQUIRED_FIELDS = [
  "active_lead_id",
  "paintable_area_sqft",
  "ceiling_included",
  "prep_level",
  "damp_issue",
  "scrape_required",
  "brand_preference",
  "finish",
] as const;

type MeasurementIssueType =
  | "DAMP"
  | "CRACK"
  | "PLASTER_DAMAGE"
  | "FUNGUS"
  | "ROUGH_WALL"
  | "WOODWORK"
  | "METALWORK"
  | "TERRACE_DAMP"
  | "HIGHLIGHT_WALL"
  | "CEILING_ISSUE";

export interface MeasurementIssue {
  type?: MeasurementIssueType;
  description?: string;
  locations?: string;
}

export interface RecommendedAddon {
  id: string;
  label: string;
  reason?: string;
  related_issue_type?: MeasurementIssueType;
}

const ISSUE_KEYWORDS: {
  type: MeasurementIssueType;
  keywords: string[];
}[] = [
  {
    type: "DAMP",
    keywords: [
      "seelan",
      "damp",
      "dampness",
      "pani aa raha",
      "bubbles",
      "paint phool",
      "leak",
    ],
  },
  {
    type: "CRACK",
    keywords: ["crack", "cracks", "darar", "line pad", "cracked"],
  },
  {
    type: "PLASTER_DAMAGE",
    keywords: [
      "plaster",
      "khokhla",
      "hollow",
      "uneven",
      "tuta",
      "toota",
      "damage",
    ],
  },
  {
    type: "FUNGUS",
    keywords: [
      "fungus",
      "mould",
      "mold",
      "kaale daag",
      "black spots",
      "gila smell",
      "bad smell",
    ],
  },
  {
    type: "ROUGH_WALL",
    keywords: [
      "rough",
      "uneven finish",
      "smooth nahi",
      "premium finish",
      "putty zyada",
    ],
  },
  {
    type: "WOODWORK",
    keywords: ["door", "window", "windows", "furniture", "wood", "polish"],
  },
  {
    type: "METALWORK",
    keywords: [
      "grill",
      "grills",
      "railings",
      "railing",
      "gate",
      "metal",
      "rust",
      "rusted",
    ],
  },
  {
    type: "TERRACE_DAMP",
    keywords: [
      "terrace",
      "balcony",
      "outer wall",
      "baarish",
      "seepage",
      "bahar ki wall",
    ],
  },
  {
    type: "HIGHLIGHT_WALL",
    keywords: ["highlight wall", "feature wall", "texture", "designer"],
  },
  {
    type: "CEILING_ISSUE",
    keywords: ["ceiling", "chhat", "ceiling pe", "roof pe"],
  },
];

const ISSUE_ADDON_MAPPING: Record<
  MeasurementIssueType,
  { id: string; label: string }
> = {
  DAMP: {
    id: "DAMP_WATERPROOFING",
    label: "Damp treatment / waterproofing",
  },
  CRACK: {
    id: "CRACK_REPAIR",
    label: "Crack repair",
  },
  PLASTER_DAMAGE: {
    id: "PLASTER_REPAIR",
    label: "Plaster repair",
  },
  FUNGUS: {
    id: "ANTI_FUNGAL_TREATMENT",
    label: "Anti-fungal treatment",
  },
  ROUGH_WALL: {
    id: "EXTRA_PUTTY_PREMIUM_FINISH",
    label: "Extra putty / premium finish",
  },
  WOODWORK: {
    id: "WOODWORK_DOORS_WINDOWS",
    label: "Woodwork – doors/windows/furniture",
  },
  METALWORK: {
    id: "METALWORK_GRILLS_RAILINGS",
    label: "Metalwork – grills/railings/gates",
  },
  TERRACE_DAMP: {
    id: "TERRACE_WATERPROOFING",
    label: "Terrace/balcony waterproofing",
  },
  HIGHLIGHT_WALL: {
    id: "HIGHLIGHT_TEXTURE_WALL",
    label: "Highlight / texture wall",
  },
  CEILING_ISSUE: {
    id: "CEILING_REPAIR_REPAINT",
    label: "Ceiling repair / repaint",
  },
};

function inferIssueTypeFromText(text: string): MeasurementIssueType | undefined {
  const lower = text.toLowerCase();

  for (const rule of ISSUE_KEYWORDS) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      return rule.type;
    }
  }

  return undefined;
}

function normalizeIssues(raw: unknown): MeasurementIssue[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const issues: MeasurementIssue[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    const description =
      typeof obj.description === "string"
        ? obj.description.trim()
        : typeof obj.text === "string"
        ? obj.text.trim()
        : "";

    const locations =
      typeof obj.locations === "string"
        ? obj.locations.trim()
        : typeof obj.location === "string"
        ? obj.location.trim()
        : undefined;

    if (!description) continue;

    let type: MeasurementIssueType | undefined;
    if (typeof obj.type === "string") {
      type = obj.type as MeasurementIssueType;
    } else {
      type = inferIssueTypeFromText(`${description} ${locations ?? ""}`);
    }

    issues.push({
      type,
      description,
      locations,
    });
  }

  return issues.length > 0 ? issues : undefined;
}

function buildRecommendedAddonsFromIssues(
  issues: MeasurementIssue[] | undefined
): RecommendedAddon[] | undefined {
  if (!issues || issues.length === 0) return undefined;

  const addons: RecommendedAddon[] = [];
  const seenIds = new Set<string>();

  for (const issue of issues) {
    if (!issue.type) continue;
    const mapping = ISSUE_ADDON_MAPPING[issue.type];
    if (!mapping) continue;
    if (seenIds.has(mapping.id)) continue;

    seenIds.add(mapping.id);
    addons.push({
      id: mapping.id,
      label: mapping.label,
      related_issue_type: issue.type,
      reason: issue.description
        ? `Suggested for issue: ${issue.description}`
        : undefined,
    });
  }

  return addons.length > 0 ? addons : undefined;
}

function deriveIssuesAndAddonsFromEntities(entities: Record<string, unknown>): {
  issues?: MeasurementIssue[];
  recommended_addons?: RecommendedAddon[];
} {
  // If the LLM already sent structured recommended_addons, trust it and pass through.
  if (Array.isArray(entities["recommended_addons"])) {
    const existingIssues = normalizeIssues(entities["issues"]);
    return {
      issues: existingIssues,
      recommended_addons: entities[
        "recommended_addons"
      ] as RecommendedAddon[],
    };
  }

  const issues = normalizeIssues(entities["issues"]);
  const recommended_addons = buildRecommendedAddonsFromIssues(issues);

  return { issues, recommended_addons };
}

const REQUIRED_FIELDS_BY_INTENT: Record<string, string[]> = {
  NEW_LEAD: [
    "customer_name",
    "customer_phone",
    "location_text",            
    "job_scope",
    "property_size_type",
    "is_repaint",
    "start_timing",
    "finish_quality",
  ],
  SCHEDULE_VISIT: ["active_lead_id", "date", "time"],
  LOG_MEASUREMENT: [...LOG_MEASUREMENT_REQUIRED_FIELDS],
  GENERATE_QUOTE_OPTIONS: [
    "active_lead_id",
    "quote_type",
    "rate_band",
    "timeline_days",
    "advance",
  ],
  UPDATE_EXISTING_LEAD: ["active_lead_id"],
};

type FieldQuestionConfig = {
  text: string;
  examples?: string[];
};

/** Hindi/Hinglish questions per intent, one per missing field. All intents with required fields must be covered here (scoped system). */
const FIELD_QUESTIONS_BY_INTENT: Record<
  string,
  Partial<Record<string, FieldQuestionConfig>>
> = {
  NEW_LEAD: {
    job_scope: {
      text: "Theek hai. Aapka ghar paint karwana hai—interior, exterior ya dono?",
      examples: ["Sirf interior", "Exterior + thoda interior touch‑up"],
    },
    property_size_type: {
      text: "Ghar kitna hai—1BHK/2BHK/3BHK ya area approx bata sakte hain?",
      examples: ["2BHK", "Approx 1200 sqft 3BHK"],
    },
    is_repaint: {
      text: "Naya ghar hai ya repaint karwana hai (pehle se painted walls)?",
      examples: ["Repaint hai", "Naya ghar hai, first time paint"],
    },
    start_timing: {
      text: "Kab start karna hai—iss week, next week, ya koi date fixed hai?",
      examples: ["Next week se", "15 March se start karna hai"],
    },
    finish_quality: {
      text:
        "Aapko basic finish chahiye ya premium look (thoda high-end finish)?",
      examples: ["Basic finish theek hai", "Premium finish chahiye"],
    },
    location_text: {
      text:
        "Location / society ka naam bata dijiye. Kis area mein kaam karwana hai?",
      examples: ["Hiranandani Powai, Mumbai", "Wakad, Pune"],
    },
    customer_name: {
      text: "Customer ka naam kya hai?",
    },
    customer_phone: {
      text:
        "Client ka WhatsApp / phone number share kar dijiye, taaki hum client se contact kar sakein.",
      examples: ["9876543210"],
    },
    site_visit_preference: {
      text: "Site visit kab convenient hai—morning, evening, ya anytime?",
      examples: ["Morning best rahega", "Evening after 6pm"],
    },
  },
  SCHEDULE_VISIT: {
    active_lead_id: {
      text:
        "Kaunse lead ke liye visit schedule karni hai? Lead ID ya naam bata dijiye.",
      examples: ["69a5868bf92a1f76fba82e92", "Powai 2BHK Sharma ji"],
    },
    date: {
      text: "Visit ka date kab rakhna hai? (e.g. kal, 15 March)",
      examples: ["Kal", "15 March"],
    },
    time: {
      text: "Visit ka time kya rahega—morning, afternoon ya evening?",
      examples: ["Morning", "Evening 5 baje ke baad"],
    },
  },
  LOG_MEASUREMENT: {
    active_lead_id: {
      text:
        "Kaunse lead ke liye measurement log karna hai? Lead ID ya naam bata dijiye.",
      examples: ["69a5868bf92a1f76fba82e92", "Powai 2BHK Sharma ji"],
    },
    paintable_area_sqft: {
      text:
        "Aap rough paintable area bata dijiye ya rooms count share kijiye—main estimate bana deta hoon.",
      examples: [
        "2BHK approx 1200 sqft",
        "living 150 sqft, bedroom 120 sqft, kitchen 80 sqft",
      ],
    },
    ceiling_included: {
      text: "Ceiling bhi include karna hai painting mein, ya sirf walls?",
      examples: ["Ceiling + walls", "Sirf walls"],
    },
    prep_level: {
      text:
        "Putty/primer ka kaam kitna lag raha hai? 1 coat/2 coat ya koi special prep?",
      examples: ["1 coat putty, 1 coat primer", "2 coat putty, 2 coat primer"],
    },
    damp_issue: {
      text:
        "Cracks ya dampness (seelan) kahin dikhi? Agar haan, kis room/diwaar par hai bata dijiye.",
      examples: [
        "Bedroom ki ek wall pe seelan hai",
        "Kahin dampness ya cracks nahi hai",
      ],
    },
    scrape_required: {
      text:
        "Old paint pura scrape karwana hai ya sirf sanding karke repaint chalega?",
      examples: ["Pura scrape karwana hai", "Sirf sanding chalega"],
    },
    brand_preference: {
      text:
        "Brand preference hai—Asian Paints / Berger / Nerolac / Dulux ya aap chahte hain hum suggest karein?",
      examples: ["Asian Paints", "Koi bhi aap suggest karo"],
    },
    finish: {
      text:
        "Wall finish kaisi chahiye—matt, satin, shine/gloss ya texture finish?",
      examples: ["Matt finish", "Satin finish", "Texture ek feature wall pe"],
    },
  },
  GENERATE_QUOTE_OPTIONS: {
    active_lead_id: {
      text:
        "Kaunse lead ke liye quote options chahiye? Lead ID ya naam bata dijiye.",
      examples: ["69a5868bf92a1f76fba82e92", "Thane 3BHK Gupta ji"],
    },
    quote_type: {
      text:
        "Aap labour-only quote dena chahte ho ya labour+material dono include karna hai?",
      examples: ["Sirf labour-only", "Labour + material dono"],
    },
    rate_band: {
      text:
        "Rate band kya rakhna hai—basic, standard ya premium? Main 3 options bana deta hoon.",
      examples: ["Basic", "Standard", "Premium"],
    },
    timeline_days: {
      text:
        "Client ko timeline kitne din bolni hai? Approx kitne din mein kaam complete ho jayega?",
      examples: ["7 din", "10–12 din", "2 week"],
    },
    advance: {
      text:
        "Advance kitna loge—percentage jaise 30% ya koi fixed amount? Please clear batao.",
      examples: ["30% advance", "20000 advance", "50% start mein"],
    },
  },
  UPDATE_EXISTING_LEAD: {
    active_lead_id: {
      text:
        "Kaunse purane lead ko update karna hai? Lead ID ya naam bata dijiye.",
      examples: ["69a5868bf92a1f76fba82e92", "Old Powai 2BHK lead"],
    },
  },
};

/** All confirmation/flow questions in one place. Use these instead of inline strings. */
const ORCHESTRATOR_QUESTIONS = {
  intentSwitchPending: (currentIntent: string, pendingSwitch: string) =>
    `Abhi hum ${currentIntent} ka flow chala rahe hain, aapne ${pendingSwitch} bola tha. Kya hum ${pendingSwitch} pe switch karein? "Theek hai" bolein toh switch karenge, "Theek nahi" bolein toh current flow continue rahega.`,
  intentSwitchNew: (currentIntent: string, topIntent: string) =>
    `Abhi hum ${currentIntent} ka flow chala rahe hain, lekin aapne abhi ${topIntent} bola. Kya hum ${topIntent} pe switch karein? "Theek hai" bolein toh switch karenge, "Theek nahi" bolein toh current flow continue rahega.`,
};

function buildQuestionForMissingFields(
  intent: string,
  missing: string[]
): FieldQuestionConfig {
  const mapping = FIELD_QUESTIONS_BY_INTENT[intent] ?? {};
  const questions = missing
    .map((field) => mapping[field])
    .filter((q): q is FieldQuestionConfig => !!q);

  if (questions.length === 0) {
    throw new Error(
      `Orchestrator: missing FIELD_QUESTIONS_BY_INTENT for intent "${intent}", fields: ${missing.join(", ")}. Add questions for this intent in FIELD_QUESTIONS_BY_INTENT.`
    );
  }
  return questions[0];
}

function normalizeYesNo(text: string) {
  const lower = text.toLowerCase();
  // Yes: only "theek hai" / "thik hai" to avoid TTS confusion with "haan"/"ha"
  const yesWords = ["theek hai", "thik hai"];
  // No: direct opposite of "theek hai" + explicit rejections
  const noWords = [
    "theek nahi",
    "thik nahi",
    "nahi theek",
    "theek nahin",
    "thik nahin",
    "nahi",
    "nahin",
    "no",
    "mat",
    "cancel",
    "chhod",
    "back",
  ];

  const isYes = yesWords.some((w) => lower.includes(w));
  const isNo = noWords.some((w) => lower.includes(w));

  return { isYes, isNo };
}

type FlowContinueOrEarly =
  | {
      kind: "continue";
      session: AnalyzeSessionV1;
      entities: Record<string, unknown>;
    }
  | {
      kind: "early";
      result: OrchestratorResult;
    };

function handleIntentSwitchFlow(params: {
  session: AnalyzeSessionV1;
  intents: string[];
  text: string;
  hasOngoingFlow: boolean;
}): FlowContinueOrEarly {
  const { intents, text, hasOngoingFlow } = params;
  let { session } = params;

  if (!hasOngoingFlow) {
    return { kind: "continue", session, entities: {} };
  }

  const topIntent = intents[0] ?? null;
  const pendingSwitch = session.pending_intent_switch_to ?? null;

  if (pendingSwitch) {
    const { isYes, isNo } = normalizeYesNo(text);

    if (!isYes && !isNo) {
      return {
        kind: "early",
        result: {
          status: "incomplete",
          question: ORCHESTRATOR_QUESTIONS.intentSwitchPending(
            session.current_intent ?? "",
            pendingSwitch
          ),
          session,
        },
      };
    }

    if (isYes) {
      session = {
        ...DEFAULT_SESSION,
        current_intent: pendingSwitch,
        entities: {},
        missing_fields: [],
        active_lead_id: session.active_lead_id ?? null,
        pending_intent_switch_to: null,
      };
    } else if (isNo) {
      session = {
        ...session,
        pending_intent_switch_to: null,
      };
    }

    return { kind: "continue", session, entities: {} };
  }

  if (
    topIntent &&
    topIntent !== session.current_intent &&
    topIntent !== "GREETING"
  ) {
    // Avoid interrupting an in‑progress NEW_LEAD flow with UPDATE_EXISTING_LEAD
    // unless the user explicitly talks about updating/changing something.
    // This prevents simple answers like "15 March se start karna hai" to the
    // "Kab start karna hai..." question from being treated as an update.
    if (
      topIntent === "UPDATE_EXISTING_LEAD" &&
      session.current_intent === "NEW_LEAD" &&
      hasOngoingFlow
    ) {
      const lower = text.toLowerCase();
      const explicitUpdateKeywords = [
        "update",
        "badal",
        "change",
        "reschedule",
        "date change",
        "date badal",
        "slot change",
      ];

      const hasExplicitUpdateWord = explicitUpdateKeywords.some((kw) =>
        lower.includes(kw)
      );

      if (!hasExplicitUpdateWord) {
        return { kind: "continue", session, entities: {} };
      }
    }

    session = {
      ...session,
      pending_intent_switch_to: topIntent,
    };

    return {
      kind: "early",
      result: {
        status: "incomplete",
        question: ORCHESTRATOR_QUESTIONS.intentSwitchNew(
          session.current_intent ?? "",
          topIntent
        ),
        session,
      },
    };
  }

  return { kind: "continue", session, entities: {} };
}

function maybeRestartCompletedNewLead(params: {
  session: AnalyzeSessionV1;
  intents: string[];
}): AnalyzeSessionV1 {
  const { session, intents } = params;

  const completedNewLead =
    session.current_intent === "NEW_LEAD" &&
    session.missing_fields.length === 0;
  const wantsNewLead = intents.includes("NEW_LEAD");

  if (!completedNewLead || !wantsNewLead) {
    return session;
  }

  return {
    ...DEFAULT_SESSION,
    current_intent: "NEW_LEAD",
    entities: {},
    missing_fields: [],
    active_lead_id: null,
  };
}

/**
 * If the previous flow is already complete (no missing fields) and the user now
 * clearly asks for a different intent, we can safely auto‑switch without
 * confirmation. This keeps the UX snappy for follow‑up commands like
 * "measurement log karo" right after finishing NEW_LEAD.
 */
function maybeAutoSwitchAfterCompletedFlow(params: {
  session: AnalyzeSessionV1;
  intents: string[];
}): AnalyzeSessionV1 {
  const { session, intents } = params;

  const topIntent = intents[0] ?? null;

  if (!topIntent || topIntent === "GREETING") {
    return session;
  }

  const hasCompletedFlow =
    session.current_intent !== null && session.missing_fields.length === 0;

  if (!hasCompletedFlow) {
    return session;
  }

  if (topIntent === session.current_intent) {
    return session;
  }

  return {
    ...session,
    current_intent: topIntent,
    // Keep entities + active_lead_id so downstream intents like LOG_MEASUREMENT
    // can reuse the just‑created lead, but clear any pending intent switch.
    pending_intent_switch_to: null,
  };
}

function validateAndBuildResult(params: {
  session: AnalyzeSessionV1;
  intents: string[];
  entities: Record<string, unknown>;
}): OrchestratorResult {
  const { session, intents, entities } = params;
  const topIntent = intents[0];

  /**
   * Decide which intent we should validate against.
   *
   * Default behaviour: prefer existing session.current_intent when present,
   * otherwise fall back to the top LLM intent.
   *
   * Special case: if the LLM now classifies the message as GREETING and the
   * previous flow is already complete (no missing fields), treat this turn as
   * a GREETING-only turn instead of re‑validating the old workflow intent.
   * This prevents neutral messages like "hey there" from repeatedly marking a
   * completed NEW_LEAD as "ready" and triggering unnecessary DB writes.
   */
  let intentForValidation = session.current_intent ?? topIntent;

  const hasCompletedFlow =
    session.current_intent !== null && session.missing_fields.length === 0;

  if (topIntent === "GREETING" && hasCompletedFlow) {
    intentForValidation = "GREETING";
  }

  const mergedEntities: Record<string, unknown> = {
    ...session.entities,
    ...entities,
  };

  let normalizedEntities: Record<string, unknown> = {
    ...mergedEntities,
    customer_name: mergedEntities.customer_name ?? mergedEntities.name,
    customer_phone:
      mergedEntities.customer_phone ?? mergedEntities.phone_number,
    location_text: mergedEntities.location_text ?? mergedEntities.location,
    job_scope:
      mergedEntities.job_scope ??
      mergedEntities.paint_scope ??
      mergedEntities.scope,
    property_size_type:
      mergedEntities.property_size_type ??
      mergedEntities.bhk ??
      mergedEntities.size_type,
    start_timing:
      mergedEntities.start_timing ??
      mergedEntities.timing ??
      mergedEntities.when_start ??
      mergedEntities.start_date,
    finish_quality:
      mergedEntities.finish_quality ??
      mergedEntities.quality ??
      mergedEntities.finish,
  };


  if (intentForValidation === "LOG_MEASUREMENT") {
    const { issues, recommended_addons } =
      deriveIssuesAndAddonsFromEntities(normalizedEntities);

    normalizedEntities = {
      ...normalizedEntities,
      ...(issues ? { issues } : {}),
      ...(recommended_addons ? { recommended_addons } : {}),
    };
  }

  const updatedSession: AnalyzeSessionV1 = {
    ...session,
    // If we're treating this turn as a pure GREETING over a completed flow,
    // explicitly set the current intent to GREETING so downstream logic and
    // the API layer don't re‑run NEW_LEAD persistence side‑effects.
    current_intent:
      intentForValidation === "GREETING"
        ? "GREETING"
        : session.current_intent ?? topIntent,
    entities: normalizedEntities,
  };

  const requiredFields = REQUIRED_FIELDS_BY_INTENT[intentForValidation] ?? [];

  if (requiredFields.length === 0) {
    return {
      status: "ready",
      session: {
        ...updatedSession,
        missing_fields: [],
      },
    };
  }

  const missing: string[] = [];

  for (const field of requiredFields) {
    let value: unknown;

    if (field === "active_lead_id") {
      value =
        updatedSession.active_lead_id ?? normalizedEntities["active_lead_id"];
    } else {
      value = normalizedEntities[field];
    }

    let isMissing =
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "");

    // Special case for LOG_MEASUREMENT: if room-wise areas are present, treat
    // paintable_area_sqft as satisfied so we don't keep repeating the same
    // "area ya rooms batao" question. Downstream, the DB layer can either
    // derive a total from rooms or rely on room-wise data directly.
    if (
      isMissing &&
      intentForValidation === "LOG_MEASUREMENT" &&
      field === "paintable_area_sqft"
    ) {
      const rooms = normalizedEntities["rooms"];
      if (Array.isArray(rooms) && rooms.length > 0) {
        isMissing = false;
      }
    }

    if (isMissing) {
      missing.push(field);
    }
  }

  if (missing.length > 0) {
    const sessionWithMissing: AnalyzeSessionV1 = {
      ...updatedSession,
      missing_fields: missing,
    };

    const questionConfig = buildQuestionForMissingFields(
      intentForValidation,
      missing
    );

    return {
      status: "incomplete",
      question: questionConfig.text,
      question_examples: questionConfig.examples,
      session: sessionWithMissing,
    };
  }

  const readySession: AnalyzeSessionV1 = {
    ...updatedSession,
    missing_fields: [],
  };

  return {
    status: "ready",
    session: readySession,
  };
}

export function orchestrateV1(input: OrchestratorInput): OrchestratorResult {
  const { session, intents } = input;
  const entities = input.entities ?? {};
  const textStr = typeof input.text === "string" ? input.text.trim() : "";

  if (!Array.isArray(intents) || intents.length === 0) {
    return {
      status: "noop",
      session,
    };
  }

  let sessionForOrchestrator: AnalyzeSessionV1 = { ...session };

  // If the previous flow is already complete and the user is now asking for a
  // different workflow (e.g. "measurement log karo" after NEW_LEAD), auto
  // switch to the new intent without an extra confirmation step.
  sessionForOrchestrator = maybeAutoSwitchAfterCompletedFlow({
    session: sessionForOrchestrator,
    intents,
  });

  const topIntent = intents[0] ?? null;
  const hasOngoingFlow =
    sessionForOrchestrator.current_intent !== null &&
    sessionForOrchestrator.missing_fields.length > 0;

  // Clear stale intent-switch requests if the model is back on the original intent.
  if (
    hasOngoingFlow &&
    topIntent &&
    topIntent === sessionForOrchestrator.current_intent &&
    sessionForOrchestrator.pending_intent_switch_to
  ) {
    sessionForOrchestrator = {
      ...sessionForOrchestrator,
      pending_intent_switch_to: null,
    };
  }

  // 1) Intent switch confirmation flow, if a different intent is detected mid‑flow.
  const intentOutcome = handleIntentSwitchFlow({
    session: sessionForOrchestrator,
    intents,
    text: textStr,
    hasOngoingFlow,
  });

  if (intentOutcome.kind === "early") {
    return intentOutcome.result;
  }

  sessionForOrchestrator = intentOutcome.session;
  // intentOutcome.entities is just passthrough for now.

  // 2) If user asks for a new lead again after finishing, start a fresh NEW_LEAD flow.
  sessionForOrchestrator = maybeRestartCompletedNewLead({
    session: sessionForOrchestrator,
    intents,
  });

  // 3) Validate required fields and decide whether we are ready or need to ask more.
  return validateAndBuildResult({
    session: sessionForOrchestrator,
    intents,
    entities,
  });
}

