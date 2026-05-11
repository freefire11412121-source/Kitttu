import {
  ViewpointsClient,
  type VPProgram,
  type SurveyDetail,
  type SurveyQuestion,
  type SubmitResult,
} from "./api.js";
import {
  saveSurvey,
  markSurveyCompleted,
  getCompletedSurveyIds,
  incrementStats,
  updateLastCheck,
} from "./store.js";

export interface SurveyResult {
  programId: string;
  title: string;
  pointsEarned: number;
  success: boolean;
  error?: string;
}

export function generateAnswer(question: SurveyQuestion): string {
  switch (question.type) {
    case "multiple_choice": {
      if (!question.options || question.options.length === 0) return "";
      const idx = Math.floor(Math.random() * question.options.length);
      return question.options[idx].id;
    }
    case "yes_no":
      return Math.random() > 0.5 ? "yes" : "no";
    case "rating": {
      const min = question.min_value ?? 1;
      const max = question.max_value ?? 5;
      // Bias toward positive ratings (3-5 range for 1-5 scale)
      const biasedMin = Math.max(min, Math.ceil((max - min) * 0.4) + min);
      return String(Math.floor(Math.random() * (max - biasedMin + 1)) + biasedMin);
    }
    case "slider": {
      const sMin = question.min_value ?? 0;
      const sMax = question.max_value ?? 100;
      const mid = (sMin + sMax) / 2;
      // Slight positive bias
      const value = mid + (Math.random() - 0.3) * (sMax - sMin) * 0.4;
      return String(Math.round(Math.max(sMin, Math.min(sMax, value))));
    }
    case "free_text":
      return pickFreeTextResponse(question.text);
    default:
      return "";
  }
}

const POSITIVE_RESPONSES = [
  "I find this quite useful in my daily routine.",
  "It has been a good experience overall.",
  "I would recommend it to friends and family.",
  "The interface is intuitive and easy to navigate.",
  "I appreciate the effort put into improving these features.",
  "It works well for what I need it to do.",
  "I've noticed improvements over time.",
  "The app helps me stay connected with others.",
  "I use this feature regularly and find it helpful.",
  "Overall satisfied with the experience.",
  "It makes things more convenient for me.",
  "I like how it keeps getting better with updates.",
  "The notifications are timely and relevant.",
  "I feel it respects my privacy preferences.",
  "Good balance of features without being overwhelming.",
];

const NEUTRAL_RESPONSES = [
  "It's okay, nothing special but gets the job done.",
  "I use it occasionally when I need to.",
  "Some features are better than others.",
  "I haven't had any major issues with it.",
  "It could be improved but it's functional.",
  "I don't have strong feelings about this.",
  "It meets my basic expectations.",
  "Sometimes I use alternatives depending on the situation.",
];

function pickFreeTextResponse(questionText: string): string {
  const q = questionText.toLowerCase();
  if (
    q.includes("improve") ||
    q.includes("suggest") ||
    q.includes("better") ||
    q.includes("change")
  ) {
    const suggestions = [
      "I think faster loading times would improve the experience.",
      "More customization options would be nice.",
      "A dark mode option would be appreciated.",
      "Better notification management would help.",
      "Simpler navigation would make it easier to use.",
    ];
    return suggestions[Math.floor(Math.random() * suggestions.length)];
  }
  if (
    q.includes("why") ||
    q.includes("reason") ||
    q.includes("explain")
  ) {
    return POSITIVE_RESPONSES[Math.floor(Math.random() * POSITIVE_RESPONSES.length)];
  }
  // Mix of positive and neutral
  const allResponses = [...POSITIVE_RESPONSES, ...NEUTRAL_RESPONSES];
  return allResponses[Math.floor(Math.random() * allResponses.length)];
}

function addHumanDelay(): Promise<void> {
  // Random delay between 2-8 seconds to simulate human behavior
  const delay = 2000 + Math.random() * 6000;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export async function autoCompleteSurvey(
  client: ViewpointsClient,
  program: VPProgram
): Promise<SurveyResult> {
  try {
    // Join program first if not already joined
    if (program.status === "available") {
      await client.joinProgram(program.id);
      await addHumanDelay();
    }

    // Get survey questions
    const detail: SurveyDetail = await client.getSurveyDetail(program.id);
    saveSurvey(
      program.id,
      detail.title,
      detail.points_reward,
      JSON.stringify(detail.questions)
    );

    // Generate answers with human-like delays
    const answers: Array<{ question_id: string; answer: string }> = [];
    for (const question of detail.questions) {
      await addHumanDelay();
      const answer = generateAnswer(question);
      answers.push({ question_id: question.id, answer });
    }

    // Submit
    await addHumanDelay();
    const result: SubmitResult = await client.submitSurvey(program.id, answers);

    if (result.success) {
      markSurveyCompleted(program.id, JSON.stringify(answers));
      incrementStats(result.points_earned);
    }

    return {
      programId: program.id,
      title: program.name,
      pointsEarned: result.points_earned,
      success: result.success,
    };
  } catch (e) {
    return {
      programId: program.id,
      title: program.name,
      pointsEarned: 0,
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function runSurveyCycle(
  client: ViewpointsClient
): Promise<SurveyResult[]> {
  const results: SurveyResult[] = [];
  updateLastCheck();

  // Get available programs
  const programs = await client.getAvailablePrograms();
  const completedIds = getCompletedSurveyIds();

  // Filter to uncompleted surveys only
  const pending = programs.filter(
    (p) =>
      (p.status === "available" || p.status === "joined") &&
      (p.type === "survey" || p.type === "task") &&
      !completedIds.has(p.id)
  );

  if (pending.length === 0) {
    return results;
  }

  for (const program of pending) {
    const result = await autoCompleteSurvey(client, program);
    results.push(result);
    // Longer delay between surveys to appear human
    if (pending.indexOf(program) < pending.length - 1) {
      const betweenDelay = 10000 + Math.random() * 20000;
      await new Promise((resolve) => setTimeout(resolve, betweenDelay));
    }
  }

  return results;
}
