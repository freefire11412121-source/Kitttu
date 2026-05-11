import { FB_GRAPH_URL, VP_USER_AGENT, VP_APP_ID } from "./config.js";

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

export class ViewpointsClient {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  updateToken(token: string): void {
    this.accessToken = token;
  }

  private async graphRequest<T>(
    endpoint: string,
    method: "GET" | "POST" = "GET",
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = new URL(`${FB_GRAPH_URL}${endpoint}`);
    if (method === "GET") {
      url.searchParams.set("access_token", this.accessToken);
    }

    const headers: Record<string, string> = {
      "User-Agent": VP_USER_AGENT,
      Accept: "application/json",
    };

    let fetchBody: string | undefined;
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      const params = new URLSearchParams();
      params.set("access_token", this.accessToken);
      if (body) {
        for (const [k, v] of Object.entries(body)) {
          params.set(k, typeof v === "string" ? v : JSON.stringify(v));
        }
      }
      fetchBody = params.toString();
    }

    const res = await fetch(url.toString(), {
      method,
      headers,
      body: fetchBody,
    });

    const text = await res.text();
    if (!res.ok) {
      let errorMsg = `HTTP ${res.status}: ${text.slice(0, 300)}`;
      try {
        const errJson = JSON.parse(text) as { error?: { message?: string; code?: number } };
        if (errJson.error?.message) {
          errorMsg = `FB API Error ${errJson.error.code ?? res.status}: ${errJson.error.message}`;
        }
      } catch {
        // use raw text
      }
      throw new Error(errorMsg);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Non-JSON response: ${text.slice(0, 200)}`);
    }
  }

  async validateToken(): Promise<boolean> {
    try {
      const result = await this.graphRequest<{
        data: { app_id: string; is_valid: boolean; expires_at: number };
      }>(`/debug_token?input_token=${this.accessToken}`);
      return result.data.is_valid;
    } catch {
      return false;
    }
  }

  async getProfile(): Promise<VPProfile> {
    try {
      const me = await this.graphRequest<{
        id: string;
        name: string;
      }>("/me?fields=id,name");
      return {
        id: me.id,
        name: me.name,
        points_balance: 0,
        surveys_completed: 0,
        rewards_redeemed: 0,
        member_since: "",
      };
    } catch (e) {
      throw new Error(`Failed to get profile: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async getAvailablePrograms(): Promise<VPProgram[]> {
    // Viewpoints programs are served through Facebook's internal API
    // The app uses a combination of Graph API and internal endpoints
    // Primary endpoint pattern: /me/viewpoints_programs or /{app_id}/programs
    const endpoints = [
      `/${VP_APP_ID}/viewpoints_programs`,
      "/me/viewpoints_programs",
      `/${VP_APP_ID}/programs`,
    ];

    for (const endpoint of endpoints) {
      try {
        const result = await this.graphRequest<{
          data: Array<{
            id: string;
            name: string;
            description: string;
            reward_amount: number;
            status: string;
            program_type: string;
            end_time: string;
          }>;
        }>(`${endpoint}?fields=id,name,description,reward_amount,status,program_type,end_time`);

        return result.data.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description ?? "",
          points_reward: p.reward_amount ?? 0,
          status: mapStatus(p.status),
          type: mapType(p.program_type),
          expires_at: p.end_time ?? null,
        }));
      } catch {
        continue;
      }
    }

    // Fallback: try the generic Viewpoints API endpoint
    try {
      const result = await this.graphRequest<{
        programs: Array<{
          id: string;
          title: string;
          desc: string;
          points: number;
          state: string;
          kind: string;
          expiry: string;
        }>;
      }>(`/viewpoints/programs`);

      return (result.programs ?? []).map((p) => ({
        id: p.id,
        name: p.title,
        description: p.desc ?? "",
        points_reward: p.points ?? 0,
        status: mapStatus(p.state),
        type: mapType(p.kind),
        expires_at: p.expiry ?? null,
      }));
    } catch {
      // All endpoints failed
      throw new Error(
        "Could not fetch programs. Your access token may be invalid or expired. " +
        "Use /set_token to update it."
      );
    }
  }

  async getSurveyDetail(programId: string): Promise<SurveyDetail> {
    const endpoints = [
      `/${programId}?fields=id,name,description,reward_amount,questions`,
      `/${programId}/questions`,
    ];

    for (const endpoint of endpoints) {
      try {
        const result = await this.graphRequest<{
          id: string;
          name: string;
          description: string;
          reward_amount: number;
          estimated_time: number;
          questions: {
            data: Array<{
              id: string;
              question_text: string;
              question_type: string;
              options?: Array<{ id: string; option_text: string }>;
              min_value?: number;
              max_value?: number;
              is_required: boolean;
            }>;
          };
        }>(endpoint);

        const questions: SurveyQuestion[] = (result.questions?.data ?? []).map((q) => ({
          id: q.id,
          text: q.question_text,
          type: mapQuestionType(q.question_type),
          options: q.options?.map((o) => ({ id: o.id, text: o.option_text })),
          min_value: q.min_value,
          max_value: q.max_value,
          required: q.is_required ?? true,
        }));

        return {
          id: result.id,
          title: result.name,
          description: result.description ?? "",
          points_reward: result.reward_amount ?? 0,
          questions,
          estimated_time_minutes: result.estimated_time ?? 5,
        };
      } catch {
        continue;
      }
    }

    throw new Error(`Could not fetch survey details for ${programId}`);
  }

  async submitSurvey(
    programId: string,
    answers: Array<{ question_id: string; answer: string }>
  ): Promise<SubmitResult> {
    const endpoints = [
      `/${programId}/responses`,
      `/${programId}/submit`,
      `/viewpoints/programs/${programId}/complete`,
    ];

    for (const endpoint of endpoints) {
      try {
        const result = await this.graphRequest<{
          success: boolean;
          points_earned: number;
          total_points: number;
          message: string;
        }>(endpoint, "POST", {
          responses: JSON.stringify(answers),
        });

        return {
          success: result.success ?? true,
          points_earned: result.points_earned ?? 0,
          total_points: result.total_points ?? 0,
          message: result.message ?? "Survey submitted",
        };
      } catch (e) {
        if (endpoint === endpoints[endpoints.length - 1]) {
          throw new Error(`Submit failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }
    }

    throw new Error("All submission endpoints failed");
  }

  async joinProgram(programId: string): Promise<boolean> {
    try {
      await this.graphRequest(`/${programId}/join`, "POST");
      return true;
    } catch {
      return false;
    }
  }

  async getPointsBalance(): Promise<number> {
    try {
      const result = await this.graphRequest<{
        points_balance: number;
      }>(`/me/viewpoints_points`);
      return result.points_balance ?? 0;
    } catch {
      return 0;
    }
  }
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
