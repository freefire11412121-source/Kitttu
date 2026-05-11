import { FB_WEB_API, WEB_USER_AGENT } from "./config.js";
import { getEndpoint } from "./store.js";

export interface VPProgram {
  id: string;
  name: string;
  description: string;
  points_reward: number;
  status: "available" | "joined" | "completed" | "expired";
  type: "survey" | "task" | "study";
  expires_at: string | null;
}

export interface SurveyQuestion {
  id: string;
  text: string;
  type: "multiple_choice" | "free_text" | "rating" | "yes_no" | "slider";
  options?: Array<{ id: string; text: string }>;
  min_value?: number;
  max_value?: number;
  required: boolean;
}

export interface SurveyDetail {
  id: string;
  title: string;
  description: string;
  points_reward: number;
  questions: SurveyQuestion[];
  estimated_time_minutes: number;
}

export interface SubmitResult {
  success: boolean;
  points_earned: number;
  total_points: number;
  message: string;
}

export interface VPProfile {
  id: string;
  name: string;
  points_balance: number;
  surveys_completed: number;
  rewards_redeemed: number;
  member_since: string;
}

interface ParsedCookies {
  raw: string;
  cUser: string;
  xs: string;
  datr: string;
}

function parseFBCookies(cookieStr: string): ParsedCookies {
  const map: Record<string, string> = {};
  for (const part of cookieStr.split(";")) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      map[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
  }
  return {
    raw: cookieStr,
    cUser: map["c_user"] ?? "",
    xs: map["xs"] ?? "",
    datr: map["datr"] ?? "",
  };
}

export class ViewpointsClient {
  private cookies: ParsedCookies;
  private dtsg = "";

  constructor(cookieStr: string) {
    this.cookies = parseFBCookies(cookieStr);
  }

  updateCookies(cookieStr: string): void {
    this.cookies = parseFBCookies(cookieStr);
    this.dtsg = "";
  }

  private async fetchDtsg(): Promise<string> {
    if (this.dtsg) return this.dtsg;

    const res = await fetch("https://www.facebook.com/", {
      headers: {
        "User-Agent": WEB_USER_AGENT,
        Cookie: this.cookies.raw,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      },
    });
    const text = await res.text();
    const match = text.match(/"DTSGInitData"[^}]*"token":"([^"]+)"/);
    if (!match) {
      throw new Error("Could not extract DTSG token. Cookies may be expired.");
    }
    this.dtsg = match[1];
    return this.dtsg;
  }

  private async webGraphQL<T>(
    friendlyName: string,
    variables: Record<string, unknown> = {},
    docId?: string
  ): Promise<T> {
    const dtsg = await this.fetchDtsg();

    const params = new URLSearchParams();
    params.set("fb_dtsg", dtsg);
    params.set("fb_api_caller_class", "RelayModern");
    params.set("fb_api_req_friendly_name", friendlyName);
    params.set("variables", JSON.stringify(variables));
    params.set("server_timestamps", "true");
    if (docId) {
      params.set("doc_id", docId);
    }

    const res = await fetch(FB_WEB_API, {
      method: "POST",
      headers: {
        "User-Agent": WEB_USER_AGENT,
        Cookie: this.cookies.raw,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "*/*",
        Origin: "https://www.facebook.com",
        Referer: "https://www.facebook.com/",
      },
      body: params.toString(),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Web GraphQL HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    // Facebook may return multiple JSON objects separated by newlines
    const lines = text.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const json = JSON.parse(line) as {
          data?: T;
          errors?: Array<{ message: string }>;
        };
        if (json.errors?.length) {
          throw new Error(`GraphQL: ${json.errors[0].message}`);
        }
        if (json.data) return json.data;
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("GraphQL:")) throw e;
        continue;
      }
    }

    // If no data field found, try parsing the whole response
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Unexpected GraphQL response: ${text.slice(0, 200)}`);
    }
  }

  async validateCookies(): Promise<boolean> {
    try {
      await this.fetchDtsg();
      return true;
    } catch {
      return false;
    }
  }

  async getProfile(): Promise<VPProfile> {
    try {
      await this.fetchDtsg();
      const userId = this.cookies.cUser;
      if (!userId) throw new Error("No c_user in cookies");

      // Use the CometProfilePageQuery or similar to get user info
      const result = await this.webGraphQL<{
        user?: { id: string; name: string };
        node?: { id: string; name: string };
      }>("CometProfileTopAppSectionQuery", {
        userID: userId,
        scale: 1,
      });

      const user = result.user ?? result.node;
      return {
        id: user?.id ?? userId,
        name: user?.name ?? "Facebook User",
        points_balance: 0,
        surveys_completed: 0,
        rewards_redeemed: 0,
        member_since: "",
      };
    } catch {
      return {
        id: this.cookies.cUser,
        name: "User " + this.cookies.cUser,
        points_balance: 0,
        surveys_completed: 0,
        rewards_redeemed: 0,
        member_since: "",
      };
    }
  }

  async getAvailablePrograms(): Promise<VPProgram[]> {
    // Priority 1: Use user-configured doc_ids from /add_endpoint
    const savedEndpoint = getEndpoint("programs");
    if (savedEndpoint) {
      try {
        const vars = savedEndpoint.variables_template
          ? (JSON.parse(savedEndpoint.variables_template) as Record<string, unknown>)
          : {};
        const result = await this.webGraphQL<Record<string, unknown>>(
          "ViewpointsProgramsQuery",
          vars,
          savedEndpoint.doc_id
        );
        const programs = extractPrograms(result);
        if (programs.length > 0) return programs;
      } catch {
        // fall through to other approaches
      }
    }

    // Approach 1: Try known survey-related GraphQL queries
    const surveyQueries = [
      { name: "FBResearchSurveyRootQuery", vars: {} },
      { name: "ResearchPollSurveyQuery", vars: {} },
      { name: "StructuredSurveyRootQuery", vars: {} },
      { name: "CometViewpointsProgramsQuery", vars: { scale: 3 } },
      { name: "ViewpointsForYouTabQuery", vars: { scale: 3 } },
    ];

    for (const q of surveyQueries) {
      try {
        const result = await this.webGraphQL<Record<string, unknown>>(
          q.name,
          q.vars
        );

        const programs = extractPrograms(result);
        if (programs.length > 0) return programs;
      } catch {
        continue;
      }
    }

    // Approach 2: Try fetching the Viewpoints web page and parse any embedded data
    try {
      const res = await fetch("https://www.facebook.com/viewpoints/", {
        headers: {
          "User-Agent": WEB_USER_AGENT,
          Cookie: this.cookies.raw,
          Accept: "text/html",
        },
      });
      const html = await res.text();
      const programs = extractProgramsFromHTML(html);
      if (programs.length > 0) return programs;
    } catch {
      // ignore
    }

    // Approach 3: Scrape the Facebook research/survey pages
    try {
      const res = await fetch("https://www.facebook.com/research/surveys/", {
        headers: {
          "User-Agent": WEB_USER_AGENT,
          Cookie: this.cookies.raw,
          Accept: "text/html",
        },
      });
      const html = await res.text();
      const programs = extractProgramsFromHTML(html);
      if (programs.length > 0) return programs;
    } catch {
      // ignore
    }

    throw new Error(
      "Could not fetch programs. Cookies may be expired or no surveys are available. " +
      "Use /set_cookies to update."
    );
  }

  async getSurveyDetail(programId: string): Promise<SurveyDetail> {
    // Try to fetch survey detail via GraphQL
    const queries = [
      {
        name: "StructuredSurveyDetailQuery",
        vars: { survey_id: programId, scale: 3 },
      },
      {
        name: "ResearchPollDetailQuery",
        vars: { poll_id: programId, scale: 3 },
      },
    ];

    for (const q of queries) {
      try {
        const result = await this.webGraphQL<Record<string, unknown>>(
          q.name,
          q.vars
        );
        const detail = extractSurveyDetail(result, programId);
        if (detail) return detail;
      } catch {
        continue;
      }
    }

    // Fallback: try fetching the survey page directly
    try {
      const res = await fetch(`https://www.facebook.com/survey/${programId}/`, {
        headers: {
          "User-Agent": WEB_USER_AGENT,
          Cookie: this.cookies.raw,
          Accept: "text/html",
        },
      });
      const html = await res.text();
      const detail = extractSurveyDetailFromHTML(html, programId);
      if (detail) return detail;
    } catch {
      // ignore
    }

    throw new Error(`Could not fetch survey details for ${programId}`);
  }

  async submitSurvey(
    programId: string,
    answers: Array<{ question_id: string; answer: string }>
  ): Promise<SubmitResult> {
    // Try GraphQL mutation for survey submission
    const mutations = [
      {
        name: "StructuredSurveyResponseMutation",
        vars: {
          input: {
            survey_id: programId,
            responses: answers.map((a) => ({
              question_id: a.question_id,
              response_value: a.answer,
            })),
          },
        },
      },
      {
        name: "ResearchPollVoteMutation",
        vars: {
          input: {
            poll_id: programId,
            answers: answers.map((a) => ({
              question_id: a.question_id,
              response_id: a.answer,
            })),
          },
        },
      },
      {
        name: "ViewpointsSurveyCompleteMutation",
        vars: {
          input: {
            program_id: programId,
            responses: answers,
          },
        },
      },
    ];

    for (const m of mutations) {
      try {
        const result = await this.webGraphQL<Record<string, unknown>>(
          m.name,
          m.vars
        );
        return extractSubmitResult(result);
      } catch {
        continue;
      }
    }

    throw new Error("All submission methods failed. Survey may not be submittable from web.");
  }

  async joinProgram(programId: string): Promise<boolean> {
    try {
      await this.webGraphQL("ViewpointsJoinProgramMutation", {
        input: { program_id: programId },
      });
      return true;
    } catch {
      return false;
    }
  }

  async getPointsBalance(): Promise<number> {
    try {
      const result = await this.webGraphQL<{
        viewer?: { viewpoints_points?: { balance: number } };
      }>("ViewpointsPointsQuery", {});
      return result.viewer?.viewpoints_points?.balance ?? 0;
    } catch {
      return 0;
    }
  }
}

// Deep-search a JSON object for program/survey-like structures
function extractPrograms(obj: unknown): VPProgram[] {
  const programs: VPProgram[] = [];
  if (!obj || typeof obj !== "object") return programs;

  const record = obj as Record<string, unknown>;

  // Look for arrays of objects with id + name
  for (const val of Object.values(record)) {
    if (Array.isArray(val)) {
      for (const item of val) {
        if (
          typeof item === "object" &&
          item !== null &&
          "id" in item &&
          "name" in item
        ) {
          const node = item as Record<string, unknown>;
          programs.push({
            id: String(node.id),
            name: String(node.name ?? ""),
            description: String(node.description ?? ""),
            points_reward: Number(node.reward_amount ?? node.points ?? 0),
            status: mapStatus(String(node.status ?? "available")),
            type: mapType(String(node.program_type ?? node.type ?? "survey")),
            expires_at: node.end_time ? String(node.end_time) : null,
          });
        }
      }
    }
    // Check edges pattern
    if (typeof val === "object" && val !== null && "edges" in val) {
      const edges = (val as Record<string, unknown>).edges;
      if (Array.isArray(edges)) {
        for (const edge of edges) {
          const node = (edge as Record<string, unknown>).node as
            | Record<string, unknown>
            | undefined;
          if (node?.id && node?.name) {
            programs.push({
              id: String(node.id),
              name: String(node.name),
              description: String(node.description ?? ""),
              points_reward: Number(node.reward_amount ?? 0),
              status: mapStatus(String(node.status ?? "available")),
              type: mapType(String(node.program_type ?? "survey")),
              expires_at: node.end_time ? String(node.end_time) : null,
            });
          }
        }
      }
    }
    // Recurse into nested objects
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      programs.push(...extractPrograms(val));
    }
  }
  return programs;
}

function extractProgramsFromHTML(html: string): VPProgram[] {
  const programs: VPProgram[] = [];
  // Look for JSON data embedded in script tags
  const jsonMatches = html.matchAll(
    /data-sjs>\s*(\{.*?"require".*?\})\s*<\/script/g
  );
  for (const match of jsonMatches) {
    try {
      const data = JSON.parse(match[1]);
      programs.push(...extractPrograms(data));
    } catch {
      continue;
    }
  }
  return programs;
}

function extractSurveyDetail(
  obj: unknown,
  fallbackId: string
): SurveyDetail | null {
  if (!obj || typeof obj !== "object") return null;
  const record = obj as Record<string, unknown>;

  // Look for structured_questions or questions arrays
  for (const val of Object.values(record)) {
    if (typeof val !== "object" || val === null) continue;
    const node = val as Record<string, unknown>;

    if (node.structured_questions || node.questions) {
      const questionsData = (node.structured_questions ?? node.questions) as
        | { nodes?: unknown[] }
        | unknown[];
      const rawQuestions = Array.isArray(questionsData)
        ? questionsData
        : (questionsData as Record<string, unknown>).nodes ?? [];

      const questions: SurveyQuestion[] = (rawQuestions as Array<Record<string, unknown>>).map(
        (q) => ({
          id: String(q.id ?? q.question_id ?? ""),
          text: String(
            (q.body as Record<string, unknown>)?.text ?? q.question_text ?? q.text ?? ""
          ),
          type: mapQuestionType(String(q.question_class ?? q.question_type ?? "free_text")),
          options: extractOptions(q.response_options ?? q.options),
          required: Boolean(q.is_required ?? true),
        })
      );

      if (questions.length > 0) {
        return {
          id: String(node.id ?? fallbackId),
          title: String(node.name ?? node.title ?? "Survey"),
          description: String(node.description ?? ""),
          points_reward: Number(node.reward_amount ?? 0),
          questions,
          estimated_time_minutes: Number(node.estimated_time ?? 5),
        };
      }
    }

    // Recurse
    const nested = extractSurveyDetail(val, fallbackId);
    if (nested) return nested;
  }
  return null;
}

function extractSurveyDetailFromHTML(
  html: string,
  fallbackId: string
): SurveyDetail | null {
  const jsonMatches = html.matchAll(
    /data-sjs>\s*(\{.*?"require".*?\})\s*<\/script/g
  );
  for (const match of jsonMatches) {
    try {
      const data = JSON.parse(match[1]);
      const detail = extractSurveyDetail(data, fallbackId);
      if (detail) return detail;
    } catch {
      continue;
    }
  }
  return null;
}

function extractOptions(
  raw: unknown
): Array<{ id: string; text: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((o: Record<string, unknown>) => ({
    id: String(o.option_value ?? o.id ?? ""),
    text: String(
      (o.option_text as Record<string, unknown>)?.text ?? o.text ?? o.option_text ?? ""
    ),
  }));
}

function extractSubmitResult(obj: unknown): SubmitResult {
  if (!obj || typeof obj !== "object") {
    return { success: true, points_earned: 0, total_points: 0, message: "Submitted" };
  }
  const record = obj as Record<string, unknown>;
  // Search for success/points fields
  for (const val of Object.values(record)) {
    if (typeof val === "object" && val !== null) {
      const node = val as Record<string, unknown>;
      if ("success" in node || "points_earned" in node) {
        return {
          success: Boolean(node.success ?? true),
          points_earned: Number(node.points_earned ?? 0),
          total_points: Number(node.total_points ?? 0),
          message: String(node.message ?? "Submitted"),
        };
      }
    }
  }
  return { success: true, points_earned: 0, total_points: 0, message: "Submitted" };
}

function mapStatus(
  status: string
): "available" | "joined" | "completed" | "expired" {
  const s = (status ?? "").toLowerCase();
  if (s.includes("complete") || s.includes("done")) return "completed";
  if (s.includes("join") || s.includes("active") || s.includes("in_progress"))
    return "joined";
  if (s.includes("expir") || s.includes("closed")) return "expired";
  return "available";
}

function mapType(type: string): "survey" | "task" | "study" {
  const t = (type ?? "").toLowerCase();
  if (t.includes("survey") || t.includes("questionnaire")) return "survey";
  if (t.includes("study") || t.includes("research")) return "study";
  return "task";
}

function mapQuestionType(
  type: string
): "multiple_choice" | "free_text" | "rating" | "yes_no" | "slider" {
  const t = (type ?? "").toLowerCase();
  if (t.includes("multi") || t.includes("choice") || t.includes("select"))
    return "multiple_choice";
  if (t.includes("free") || t.includes("text") || t.includes("open"))
    return "free_text";
  if (t.includes("rating") || t.includes("star")) return "rating";
  if (t.includes("bool") || t.includes("yes") || t.includes("binary"))
    return "yes_no";
  if (t.includes("slider") || t.includes("scale") || t.includes("range"))
    return "slider";
  return "free_text";
}
