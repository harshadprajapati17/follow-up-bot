const PROJECT_FLOW = [
  {
    key: 'work_location' as const,
    text: 'कृपया बताइए कि पेंटिंग का काम कहाँ हो रहा है? (जैसे: दो बी एच के फ्लैट, बंगला, ऑफिस, सोसाइटी का विंग आदि)',
  },
  {
    key: 'rooms_count' as const,
    text: 'कितने कमरे पेंट करने हैं? (जैसे: दो कमरे, तीन कमरे, एक हॉल और दो बेडरूम आदि)',
  },
];

type ProjectQuestionKey = (typeof PROJECT_FLOW)[number]['key'];

type ConversationState = {
  step: number;
  answers: Partial<Record<ProjectQuestionKey, string>>;
  waitingForAssignConfirm?: boolean;
};

// Simple in-memory conversation state per chat.
// Note: in serverless environments this may reset between cold starts,
// which is acceptable for this limited-scope prototype.
const conversationState = new Map<number, ConversationState>();

export type ProjectConversationSavePayload = {
  work_location: string | null;
  rooms_count: string | null;
  assign_resources: boolean;
};

export type ProjectConversationResult = {
  replyText: string | null;
  /**
   * Present only when the conversation is fully completed
   * and we have a final yes/no decision about assigning resources.
   */
  savePayload?: ProjectConversationSavePayload;
};

export async function handleProjectConversation(params: {
  chatId: number;
  rawText: string | undefined | null;
  firstName?: string;
  messageDate?: number | null;
}): Promise<ProjectConversationResult> {
  const { chatId, rawText, firstName, messageDate } = params;
  const text = (rawText ?? '').trim();
  if (!text) return { replyText: null };

  // Start command: reset state and ask first question
  if (text === '/project') {
    const initialState: ConversationState = {
      step: 0,
      answers: {},
      waitingForAssignConfirm: false,
    };
    conversationState.set(chatId, initialState);
    const firstQuestion = PROJECT_FLOW[0];
    return { replyText: firstQuestion.text };
  }

  const state = conversationState.get(chatId);
  if (!state) {
    return { replyText: null };
  }

  // If we are waiting for confirmation about assigning 2 resources
  if (state.waitingForAssignConfirm) {
    const raw = text.trim();
    // Strip trailing/leading punctuation (e.g. "हाँ।" or "हाँ." from STT)
    const cleaned = raw.replace(/^[.\s।,]+|[.\s।,]+$/g, '').trim();
    const normalized = cleaned.toLowerCase();

    // Yes: prefer clear Hindi phrase like "कर दो", plus tolerant variants and legacy "haan/yes"
    const yesValues = [
      'कर दो', 'करदो', 'कर दीजिए', 'हाँ कर दो', 'haan kar do',
      'हाँ', 'हां', 'हा', 'जी', 'हाँ जी',
      'હા', 'હાં', 'હા જી', 'જી',         // Gujarati
      'ಹಾ', 'ಹಾಂ',                      // Kannada
      'haan', 'ha', 'haa', 'han', 'haana', 'hān',
      'yes', 'y', 'ye', 'ji',
    ];
    // No: prefer Hindi phrase like "मत करो", plus tolerant variants and legacy "नहीं/no"
    const noValues = [
      'मत करो', 'मत कर', 'मत कीजिए',
      'रद्द', 'रद', 'rad', 'cancel', 'कैंसल',
      'नहीं', 'नहि', 'मत',
      'ના', 'નહીં', 'નહિ',                 // Gujarati
      'nahin', 'nahi', 'na', 'no', 'n', 'mat',
    ];

    const isYes =
      yesValues.includes(normalized) ||
      yesValues.includes(cleaned) ||
      yesValues.includes(raw) ||
      (raw.length <= 15 && raw.includes('હા'));
    const isNo =
      noValues.includes(normalized) ||
      noValues.includes(cleaned) ||
      noValues.includes(raw) ||
      (raw.length <= 15 && (raw.includes('ना') || raw.includes('नहीं') || raw.includes('ના') || raw.includes('નહીં')));

    if (isYes) {
      const savePayload: ProjectConversationSavePayload = {
        work_location: state.answers.work_location ?? null,
        rooms_count: state.answers.rooms_count ?? null,
        assign_resources: true,
      };
      conversationState.delete(chatId);
      return {
        replyText: 'ठीक है, मैंने 2 रिसोर्स इस काम के लिए असाइन कर दिए हैं।',
        savePayload,
      };
    }

    if (isNo) {
      const savePayload: ProjectConversationSavePayload = {
        work_location: state.answers.work_location ?? null,
        rooms_count: state.answers.rooms_count ?? null,
        assign_resources: false,
      };
      conversationState.delete(chatId);
      return {
        replyText: 'ठीक है, मैं अभी कोई रिसोर्स असाइन नहीं कर रहा हूँ।',
        savePayload,
      };
    }

    // If user sends something else, gently reprompt with explicit words.
    return {
      replyText:
        'कृपया सिर्फ "कर दो" या "मत करो" में जवाब दें। क्या मैं 2 रिसोर्स इस काम के लिए असाइन कर दूँ?',
    };
  }

  // Normal question-answer flow
  const currentQuestion = PROJECT_FLOW[state.step];
  if (!currentQuestion) {
    // No more steps configured; fall back.
    conversationState.delete(chatId);
    return { replyText: null };
  }

  // Save answer to current question
  state.answers[currentQuestion.key] = text;
  state.step += 1;

  // If there is another question, ask it
  if (state.step < PROJECT_FLOW.length) {
    const nextQuestion = PROJECT_FLOW[state.step];
    return { replyText: nextQuestion.text };
  }

  // All questions answered → ask about assigning 2 resources, using explicit Hindi phrases
  state.waitingForAssignConfirm = true;
  const rooms = state.answers.rooms_count || 'कमरे';
  return {
    replyText:
      `ठीक है, आपने बताया कि यहाँ ${rooms} पेंट करने हैं। ` +
      'हमारे पास 2 पेंटिंग रिसोर्स उपलब्ध हैं, क्या मैं इन्हें इस काम के लिए असाइन कर दूँ? ' +
      'कृपया जवाब में सिर्फ "कर दो" या "मत करो" बोलें।',
  };
}

