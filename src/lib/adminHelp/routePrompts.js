// Admin Help Assistant — deterministic route -> suggested-prompt mapping.
// No LLM involved in choosing suggestions; this is a plain lookup table.

export const GENERIC_STARTER_PROMPTS = [
  'What should I do next?',
  'What should I upload first?',
  'How do I invite my team?',
  'Who can see the knowledge I upload?',
  'What’s the difference between a Client Admin and a Client User?',
];

const ROUTE_PROMPTS = {
  '/admin': [
    'How should I use the Setup Checklist?',
    'How do I configure an Operational Process?',
    'What does Review Cadence mean?',
  ],
  '/continuity': [
    'What does Coverage mean?',
    'What does key-person resilience mean?',
    'What should I address first?',
  ],
  '/library': [
    'How should I organize knowledge?',
    'What’s the difference between firm-wide and client-specific?',
    'What should I upload first?',
  ],
  '/chat': [
    'How does the AI Assistant decide what to answer?',
    'Why might the assistant say it doesn’t know something?',
    'How do I make knowledge client-specific?',
  ],
  '/setup': [
    'What should I do next?',
    'How do I invite my team?',
    'What should I upload first?',
  ],
  '/manage': [
    'How do I add knowledge?',
    'Who can see knowledge I upload?',
  ],
  '/processes': [
    'What should I do here?',
    'What’s the difference between an Owner and an SME?',
    'What does Review Cadence mean?',
  ],
  '/team': [
    'What’s the difference between a Client Admin and a Client User?',
    'How do I invite my team?',
  ],
};

/**
 * Deterministic route -> starter prompts. Any route not explicitly mapped
 * (including /training/:id) falls back to the generic set — never an empty
 * list, and never anything derived from live data.
 *
 * @param {string} route
 * @returns {string[]}
 */
export function getStarterPrompts(route) {
  return ROUTE_PROMPTS[route] || GENERIC_STARTER_PROMPTS;
}