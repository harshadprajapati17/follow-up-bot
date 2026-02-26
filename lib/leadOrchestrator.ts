import type { LeadAnalysis } from '@/lib/leadAnalysis';
import type { LeadIntentResult } from '@/lib/leadIntent';
import type { QuoteRequest } from '@/lib/quoteGenerator';

export type LeadStatus = 'NEW' | 'LEAD_CAPTURED';

export type ConversationIntent =
  | 'GREETING'
  | 'NEW'
  | 'LEAD_CAPTURED'
  | 'LEAD_MODIFICATION'
  | 'SCHEDULE_SITE_VISIT';

export interface ConversationState {
  leadStatus: LeadStatus;
  lastIntent?: ConversationIntent;
  leadId?: string;
}

export interface LeadAnalyzeLikeResponse {
  success: boolean;
  data?: LeadAnalysis;
  error?: string;
}

export interface MeasurementData {
  bhk?: number | null;
  sqft?: number | null;
  paintable_area?: number | null;
  ceilings?: boolean | null;
  coats?: number | null;
  putty_level?: string | null;
  dampness?: boolean | null;
  brand_preference?: string | null;
}

export interface OrchestratorInput {
  text: string;
  state: ConversationState;
  analysis: LeadAnalyzeLikeResponse;
  intent?: LeadIntentResult;
  measurements?: MeasurementData; // Optional measurement data for dependency checks
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type DependencyType = 
  | 'PROJECT_REQUIRED'
  | 'MEASUREMENT_REQUIRED'
  | 'BHK_REQUIRED'
  | 'SQFT_REQUIRED'
  | 'PAINTABLE_AREA_REQUIRED';

export interface Dependency {
  type: DependencyType;
  message: string;
  action?: string; // Optional action hint like "LOG_MEASUREMENT" or "SELECT_PROJECT"
}

export interface OrchestratorOutput {
  reply: string;
  newState: ConversationState;
  toolCall?: ToolCall;
  dependencies?: Dependency[];
  missing?: Record<string, boolean>; // Optional: missing fields for UI display
}

// Very simple greeting detector – you can extend this over time.
export function detectGreeting(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;

  const greetings = [
    'hi',
    'hello',
    'hey',
    'namaste',
    'namaskar',
    'good morning',
    'good evening',
    'good afternoon',
    'राम राम',
    'jai shree krishna',
    'जय श्री कृष्ण',
  ];

  return greetings.some((g) => normalized === g || normalized.startsWith(g + ' '));
}

// Very lightweight yes/no detector for confirmation step.
export function detectYes(text: string): boolean {
  const raw = text.trim();
  const cleaned = raw.replace(/^[.\s।,]+|[.\s।,]+$/g, '').trim().toLowerCase();
  const yesWords = ['haan', 'ha', 'haa', 'yes', 'y', 'जी', 'हाँ', 'हां', 'कर दो', 'करदो', 'कर दीजिए'];
  return yesWords.some((y) => cleaned === y || raw.includes(y));
}

export function detectNo(text: string): boolean {
  const raw = text.trim();
  const cleaned = raw.replace(/^[.\s।,]+|[.\s।,]+$/g, '').trim().toLowerCase();
  const noWords = ['nahi', 'nahin', 'na', 'no', 'n', 'मत', 'मत करो', 'मत कर', 'नहीं'];
  return noWords.some((n) => cleaned === n || raw.includes(n));
}

/**
 * Generate followup questions based on missing fields and intent.
 * Skips questions that are not relevant for certain intents (e.g., GENERATE_QUOTE_OPTIONS).
 */
function generateFollowupQuestions(
  analysis: LeadAnalysis,
  intent?: LeadIntentResult
): { missing: Record<string, boolean>; questions: string[] } {
  const missing: Record<string, boolean> = {};
  const questions: string[] = [];

  // Skip customer/location questions for GENERATE_QUOTE_OPTIONS (already in project)
  if (intent?.intent !== 'GENERATE_QUOTE_OPTIONS') {
    if (!analysis.customer.name) {
      missing.customer_name = true;
      questions.push('Customer ka naam kya hai?');
    }
    if (!analysis.customer.phone) {
      missing.customer_phone = true;
      questions.push('Customer ka mobile number share karoge? (+91 se start ho sakta hai)');
    }
    if (!analysis.location_text) {
      missing.location_text = true;
      questions.push('Site ka exact location batao (area + street / landmark).');
    }
  }

  // Skip job_type question for GENERATE_QUOTE_OPTIONS (covered by measurements)
  if (intent?.intent !== 'GENERATE_QUOTE_OPTIONS') {
    if (analysis.job_type === 'unknown') {
      missing.job_type = true;
      questions.push(
        'Painting ka exact kaam batao – kis area mein (room / poora ghar / office / exterior), kaunsi surface (wall, ceiling, door/window, metal, wood) aur purana paint ki condition kaisi hai?'
      );
    }
  }

  // Urgency might not be needed for quote generation
  if (intent?.intent !== 'GENERATE_QUOTE_OPTIONS') {
    if (analysis.urgency === 'unknown') {
      missing.urgency = true;
      questions.push('Ye kaam kab tak karwana hai? (aaj, kal, iss hafte, next week, etc.)');
    }
  }

  return { missing, questions };
}

/**
 * Generate confirmation message when all required fields are present.
 */
function generateConfirmation(analysis: LeadAnalysis): string | undefined {
  const summaryParts: string[] = [];
  if (analysis.customer.name) {
    summaryParts.push(`Customer: ${analysis.customer.name}`);
  }
  if (analysis.location_text) {
    summaryParts.push(`Location: ${analysis.location_text}`);
  }
  if (analysis.job_type && analysis.job_type !== 'unknown') {
    summaryParts.push(`Job: ${analysis.job_type}`);
  }
  if (analysis.urgency && analysis.urgency !== 'unknown') {
    summaryParts.push(`Urgency: ${analysis.urgency}`);
  }

  const recap = summaryParts.length ? ` Quick recap – ${summaryParts.join(', ')}.` : '';
  return `Mere hisaab se painting ka kaam samajh aa gaya hai aur saari important details mil gayi hain.${recap} Kya yeh sahi hai?`;
}

/**
 * Core orchestration logic for a single turn.
 *
 * This does NOT do any network/DB calls by itself – callers are expected
 * to handle things like "lead stored to DB" when they see state transitions
 * (e.g. from NEW → LEAD_CAPTURED after a positive confirmation).
 */
export function runLeadOrchestrator(input: OrchestratorInput): OrchestratorOutput {
  const { text, state, analysis, intent, measurements } = input;
  const trimmed = text.trim();

  // 0) High-level intent from LLM (if provided) can short-circuit some flows.
  if (intent) {
    if (intent.intent === 'GREETING') {
      return {
        reply:
          'Namaste! Main aapka painting assistant hoon. ' +
          'Aap bata sakte ho kis type ka painting ka kaam chahiye (ghar, office, interior, exterior) aur location kaha hai?',
        newState: { ...state, lastIntent: 'GREETING' },
      };
    }

    if (intent.intent === 'GENERAL_QUESTION') {
      return {
        reply:
          'Ye ek general sawaal lag raha hai. Agar yeh kisi specific project ke baare mein hai, ' +
          'to please customer ka naam aur area (jaise HSR, Whitefield, JP Nagar) batao taaki sahi project pe baat ho sake.',
        newState: { ...state, lastIntent: 'GREETING' },
      };
    }

    // Handle GENERATE_QUOTE_OPTIONS - check dependencies first
    if (intent.intent === 'GENERATE_QUOTE_OPTIONS') {
      const dependencies: Dependency[] = [];
      
      // Check for project/leadId dependency
      if (!state.leadId) {
        dependencies.push({
          type: 'PROJECT_REQUIRED',
          message: 'Quote generate karne ke liye pehle project select karna hoga.',
          action: 'SELECT_PROJECT',
        });
      }
      
      // Check for measurement dependencies
      const hasBasicMeasurement = measurements && (
        measurements.bhk != null ||
        measurements.sqft != null ||
        measurements.paintable_area != null
      );
      
      if (!hasBasicMeasurement) {
        dependencies.push({
          type: 'MEASUREMENT_REQUIRED',
          message: 'Quote generate karne ke liye measurement details chahiye (BHK, sqft, ya paintable area).',
          action: 'LOG_MEASUREMENT',
        });
      } else {
        // Check for specific measurement fields if needed
        if (!measurements?.sqft && !measurements?.paintable_area) {
          dependencies.push({
            type: 'SQFT_REQUIRED',
            message: 'Quote generate karne ke liye sqft ya paintable area chahiye.',
            action: 'LOG_MEASUREMENT',
          });
        }
      }
      
      // If dependencies are missing, return with dependency list
      if (dependencies.length > 0) {
        const dependencyMessages = dependencies.map(d => d.message).join(' ');
        return {
          reply: `Quote generate karne ke liye kuch details chahiye: ${dependencyMessages} Kripya pehle ye details provide karein.`,
          newState: { ...state, lastIntent: 'NEW' },
          dependencies,
        };
      }
      
      // All dependencies satisfied, proceed with quote generation
      // Extract requirements from the text
      const normalizedText = text.toLowerCase();
      
      // Extract number of options (e.g., "3 options", "3 option")
      const optionsMatch = normalizedText.match(/(\d+)\s*options?/);
      const numOptions = optionsMatch ? parseInt(optionsMatch[1], 10) : 3;
      
      // Extract timeline (e.g., "5 days", "timeline 5 days")
      const timelineMatch = normalizedText.match(/timeline\s*(\d+\s*(?:days?|weeks?|months?))/i) ||
                            normalizedText.match(/(\d+\s*(?:days?|weeks?|months?))/);
      const timeline = timelineMatch ? timelineMatch[1] : undefined;
      
      // Extract advance percentage (e.g., "advance 30%", "30% advance")
      const advanceMatch = normalizedText.match(/(?:advance|advance\s*payment)\s*(\d+)\s*%/i) ||
                           normalizedText.match(/(\d+)\s*%\s*(?:advance|advance\s*payment)/i);
      const advance = advanceMatch ? parseInt(advanceMatch[1], 10) : undefined;
      
      // Check for labour + material
      const labourAndMaterial = normalizedText.includes('labour') && 
                                (normalizedText.includes('material') || normalizedText.includes('material'));
      
      const quoteRequest: QuoteRequest = {
        leadId: state.leadId!,
        jobType: analysis.data?.job_type || undefined,
        location: analysis.data?.location_text || undefined,
        requirements: {
          options: numOptions,
          timeline,
          advance,
          labour_and_material: labourAndMaterial,
        },
      };
      
      return {
        reply: 'Theek hai, main aapke liye quote options generate kar raha hoon. Thoda wait karein...',
        newState: { ...state, lastIntent: 'NEW' },
        toolCall: {
          name: 'generate_quote_options',
          arguments: {
            leadId: quoteRequest.leadId,
            jobType: quoteRequest.jobType,
            location: quoteRequest.location,
            requirements: quoteRequest.requirements,
          },
        },
      };
    }

    const needsLeadContext =
      intent.intent === 'UPDATE_EXISTING_LEAD' ||
      intent.intent === 'LOG_MEASUREMENT';

    if (needsLeadContext && !state.leadId) {
      // We know user is talking about some existing job (update / measurement),
      // but conversation is not yet bound to a particular project. Ask them which project.
      const hintPart = intent.lead_hint
        ? `Aap shayad "${intent.lead_hint}" wale kaam ki baat kar rahe ho. `
        : '';

      const actionLabel =
        intent.intent === 'LOG_MEASUREMENT'
          ? 'measurement'
          : 'update';

      return {
        reply:
          hintPart +
          `Ye ${actionLabel} kisi purane project ke liye lag raha hai. ` +
          'Please batao kis project ke liye – customer ka naam, area (HSR / Whitefield / JP Nagar) ' +
          'ya approximate date (jaise kal ka site visit) taaki main sahi project choose kar saku.',
        newState: { ...state, lastIntent: 'NEW' },
      };
    }

    if (intent.intent === 'LOG_MEASUREMENT' && state.leadId) {
      // In a real system, this is where you would call a measurement-extraction
      // tool and persist details against the bound leadId. Here we just keep
      // the conversation moving.
      return {
        reply:
          'Theek hai, maine measurement note kar liya hai. Agar kuch aur detail (colour, coats, area breakup) add karna ho to batao, ya phir estimate ke baare mein puch sakte ho.',
        newState: { ...state, lastIntent: 'NEW' },
      };
    }
  }

  // 1) Greeting handling – no need to look at analysis in that case.
  if (detectGreeting(trimmed)) {
    return {
      reply:
        'Namaste! Main aapka painting assistant hoon. ' +
        'Aap bata sakte ho kis type ka painting ka kaam chahiye (ghar, office, interior, exterior) aur location kaha hai?',
      newState: { ...state, lastIntent: 'GREETING' },
    };
  }

  // 2) Handle explicit yes/no after a LEAD_CAPTURED confirmation message.
  if (state.lastIntent === 'LEAD_CAPTURED' && state.leadStatus === 'NEW') {
    if (detectYes(trimmed)) {
      // The caller can treat this transition as the point to persist lead in DB.
      const newState: ConversationState = {
        ...state,
        leadStatus: 'LEAD_CAPTURED',
        lastIntent: 'SCHEDULE_SITE_VISIT',
      };
      return {
        reply:
          'Theek hai, lead confirm ho gaya hai. Ab site visit schedule karte hain – ' +
          'aapko kaunse din aur kis time convenient hoga customer location par?',
        newState,
      };
    }

    if (detectNo(trimmed)) {
      const newState: ConversationState = {
        ...state,
        lastIntent: 'LEAD_MODIFICATION',
      };
      return {
        reply:
          'Theek hai, batao kya change karna hai – location, area, customer detail ya painting ka scope?',
        newState,
      };
    }
  }

  // 3) If analysis failed, surface a friendly error.
  if (!analysis.success) {
    return {
      reply:
        analysis.error ??
        'Lead analyze karte waqt kuch problem aayi. Thodi der baad phir se try karoge?',
      newState: state,
    };
  }

  // 4) Generate questions based on missing fields and intent (if analysis data is available).
  if (analysis.success && analysis.data) {
    const { missing, questions } = generateFollowupQuestions(analysis.data, intent);
    const hasMissing = Object.keys(missing).length > 0;

    // Missing fields → NEW intent, ask follow‑up questions.
    if (hasMissing) {
      const questionText =
        questions.length > 0
          ? questions.join('\n')
          : 'Thoda aur detail share karo – customer ka naam, phone, location aur painting ka scope batao.';

      return {
        reply: questionText,
        newState: {
          ...state,
          leadStatus: 'NEW',
          lastIntent: 'NEW',
        },
        missing,
      };
    }

    // 5) No missing + generate confirmation message → LEAD_CAPTURED intent (pending user yes/no).
    if (state.leadStatus === 'NEW') {
      const confirmation = generateConfirmation(analysis.data);
      if (confirmation) {
        return {
          reply: confirmation,
          newState: {
            ...state,
            lastIntent: 'LEAD_CAPTURED',
          },
        };
      }
    }
  }

  // 6) If we are already in SCHEDULE_SITE_VISIT, keep guiding for visit details.
  if (state.lastIntent === 'SCHEDULE_SITE_VISIT' && state.leadStatus === 'LEAD_CAPTURED') {
    return {
      reply:
        'Site visit ke liye ek clear date aur time batao (jaise: kal dupahar 3 baje, Sunday morning 10 baje).',
      newState: state,
    };
  }

  // 7) Fallback – analyzer says everything is fine but no explicit confirmation text.
  return {
    reply:
      'Mujhe painting ka kaam samajh aa gaya hai. Agar kuch aur specific chahiye ' +
      'to batao, warna hum site visit schedule kar sakte hain.',
    newState: state,
  };
}

