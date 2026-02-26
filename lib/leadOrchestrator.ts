import type { LeadAnalysis } from '@/lib/leadAnalysis';
import type { LeadIntentResult } from '@/lib/leadIntent';

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
  missing?: Record<string, boolean>;
  followup_questions?: string[];
  confirmation?: string;
  error?: string;
}

export interface OrchestratorInput {
  text: string;
  state: ConversationState;
  analysis: LeadAnalyzeLikeResponse;
  intent?: LeadIntentResult;
}

export interface OrchestratorOutput {
  reply: string;
  newState: ConversationState;
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
 * Core orchestration logic for a single turn.
 *
 * This does NOT do any network/DB calls by itself – callers are expected
 * to handle things like "lead stored to DB" when they see state transitions
 * (e.g. from NEW → LEAD_CAPTURED after a positive confirmation).
 */
export function runLeadOrchestrator(input: OrchestratorInput): OrchestratorOutput {
  const { text, state, analysis, intent } = input;
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

    const needsLeadContext =
      intent.intent === 'ESTIMATION_FOR_EXISTING_LEAD' ||
      intent.intent === 'UPDATE_EXISTING_LEAD' ||
      intent.intent === 'LOG_MEASUREMENT';

    if (needsLeadContext && !state.leadId) {
      // We know user is talking about some existing job (estimate / update / measurement),
      // but conversation is not yet bound to a particular project. Ask them which project.
      const hintPart = intent.lead_hint
        ? `Aap shayad "${intent.lead_hint}" wale kaam ki baat kar rahe ho. `
        : '';

      const actionLabel =
        intent.intent === 'LOG_MEASUREMENT'
          ? 'measurement'
          : 'estimate / update';

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

  const missingKeys = analysis.missing ? Object.keys(analysis.missing) : [];
  const hasMissing = missingKeys.length > 0;

  // 4) Missing fields → NEW intent, ask follow‑up questions from analyzer.
  if (hasMissing) {
    const questions =
      analysis.followup_questions && analysis.followup_questions.length > 0
        ? analysis.followup_questions.join('\n')
        : 'Thoda aur detail share karo – customer ka naam, phone, location aur painting ka scope batao.';

    return {
      reply: questions,
      newState: {
        ...state,
        leadStatus: 'NEW',
        lastIntent: 'NEW',
      },
    };
  }

  // 5) No missing + analyzer gave a confirmation message → LEAD_CAPTURED intent (pending user yes/no).
  if (analysis.confirmation && state.leadStatus === 'NEW') {
    return {
      reply: analysis.confirmation,
      newState: {
        ...state,
        lastIntent: 'LEAD_CAPTURED',
      },
    };
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

