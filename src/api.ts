import { FB_GRAPH_URL, VP_USER_AGENT } from "./config.js";

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

interface GraphQLResponse<T> {
  data: T;
  errors?: Array<{ message: string; code?: number }>;
}

export class ViewpointsClient {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  updateToken(token: string): void {
    this.accessToken = token;
  }

  private async restRequest<T>(
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

  /**
   * Facebook apps use GraphQL stored queries via /graphql endpoint.
   * The Viewpoints app uses HaloViewpointsTask, StructuredSurvey, and
   * ResearchPollSurvey types internally. Queries are referenced by doc_id.
   */
  private async graphqlRequest<T>(
    docId: string,
    variables: Record<string, unknown> = {}
  ): Promise<T> {
    const url = `${FB_GRAPH_URL}/graphql`;

    const params = new URLSearchParams();
    params.set("access_token", this.accessToken);
    params.set("doc_id", docId);
    params.set("variables", JSON.stringify(variables));

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": VP_USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GraphQL HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    try {
      const json = JSON.parse(text) as GraphQLResponse<T>;
      if (json.errors?.length) {
        throw new Error(`GraphQL error: ${json.errors[0].message}`);
      }
      return json.data;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("GraphQL error:")) throw e;
      throw new Error(`Non-JSON GraphQL response: ${text.slice(0, 200)}`);
    }
  }

  async validateToken(): Promise<boolean> {
    try {
      const result = await this.restRequest<{
        data: { app_id: string; is_valid: boolean; expires_at: number };
      }>(`/debug_token?input_token=${this.accessToken}`);
      return result.data.is_valid;
    } catch {
      return false;
    }
  }

  async getProfile(): Promise<VPProfile> {
    try {
      const me = await this.restRequest<{
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
    // Strategy 1: Try GraphQL stored queries used by the Viewpoints app
    // The app uses HaloViewpointsTask/HaloViewpointsQueue types internally
    // These doc_ids are extracted from the APK — update if traffic intercept reveals different IDs
    const graphqlDocIds = [
      "6743842475688132", // ViewpointsForYouProgramsQuery (estimated)
      "7294610490581234", // ViewpointsAvailableTasksQuery (estimated)
    ];

    for (const docId of graphqlDocIds) {
      try {
        const result = await this.graphqlRequest<{
          viewer: {
            viewpoints_programs?: {
              edges: Array<{
                node: {
                  id: string;
                  name: string;
                  description: string;
                  reward_amount: number;
                  status: string;
                  program_type: string;
                  end_time: string;
                };
              }>;
            };
            halo_viewpoints_tasks?: {
              edges: Array<{
                node: {
                  id: string;
                  name: string;
                  creation_time: string;
                };
              }>;
            };
          };
        }>(docId, { scale: 3 });

        const programs = result.viewer?.viewpoints_programs?.edges ?? [];
        if (programs.length > 0) {
          return programs.map((e) => ({
            id: e.node.id,
            name: e.node.name,
            description: e.node.description ?? "",
            points_reward: e.node.reward_amount ?? 0,
            status: mapStatus(e.node.status),
            type: mapType(e.node.program_type),
            expires_at: e.node.end_time ?? null,
          }));
        }

        const tasks = result.viewer?.halo_viewpoints_tasks?.edges ?? [];
        if (tasks.length > 0) {
          return tasks.map((e) => ({
            id: e.node.id,
            name: e.node.name,
            description: "",
            points_reward: 0,
            status: "available" as const,
            type: "task" as const,
            expires_at: null,
          }));
        }
      } catch {
        continue;
      }
    }

    // Strategy 2: Try REST-style Graph API endpoints
    const restEndpoints = [
      "/me/viewpoints_programs?fields=id,name,description,reward_amount,status,program_type,end_time",
      "/me/viewpoints_tasks?fields=id,name,creation_time",
    ];

    for (const endpoint of restEndpoints) {
      try {
        const result = await this.restRequest<{
          data: Array<{
            id: string;
            name: string;
            description?: string;
            reward_amount?: number;
            status?: string;
            program_type?: string;
            end_time?: string;
            creation_time?: string;
          }>;
        }>(endpoint);

        if (result.data?.length > 0) {
          return result.data.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description ?? "",
            points_reward: p.reward_amount ?? 0,
            status: mapStatus(p.status ?? "available"),
            type: mapType(p.program_type ?? "task"),
            expires_at: p.end_time ?? null,
          }));
        }
      } catch {
        continue;
      }
    }

    throw new Error(
      "Could not fetch programs. Your access token may be invalid or expired. " +
      "Use /set_token to update it. If the token is valid, the doc_ids in the code " +
      "may need updating — intercept your app traffic to find the correct query IDs."
    );
  }

  async getSurveyDetail(programId: string): Promise<SurveyDetail> {
    // Strategy 1: GraphQL — StructuredSurvey type has structured_questions, survey_flow
    const surveyDocIds = [
      "5847291628672345", // ViewpointsSurveyDetailQuery (estimated)
    ];

    for (const docId of surveyDocIds) {
      try {
        const result = await this.graphqlRequest<{
          node: {
            id: string;
            name: string;
            description: string;
            reward_amount: number;
            estimated_time: number;
            structured_survey?: {
              id: string;
              name: string;
              survey_flow_type: string;
              structured_questions: {
                nodes: Array<{
                  id: string;
                  body: { text: string };
                  question_class: string;
                  is_required: boolean;
                  response_options: Array<{
                    option_value: string;
                    option_text: { text: string };
                    option_numeric_value: number;
                  }>;
                }>;
              };
            };
          };
        }>(docId, { program_id: programId, scale: 3 });

        const survey = result.node?.structured_survey;
        const questions: SurveyQuestion[] = (
          survey?.structured_questions?.nodes ?? []
        ).map((q) => ({
          id: q.id,
          text: q.body?.text ?? "",
          type: mapQuestionType(q.question_class),
          options: q.response_options?.map((o) => ({
            id: o.option_value,
            text: o.option_text?.text ?? "",
          })),
          required: q.is_required ?? true,
        }));

        return {
          id: result.node.id,
          title: survey?.name ?? result.node.name,
          description: result.node.description ?? "",
          points_reward: result.node.reward_amount ?? 0,
          questions,
          estimated_time_minutes: result.node.estimated_time ?? 5,
        };
      } catch {
        continue;
      }
    }

    // Strategy 2: REST — fetch node directly
    try {
      const result = await this.restRequest<{
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
      }>(`/${programId}?fields=id,name,description,reward_amount,questions`);

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
      throw new Error(`Could not fetch survey details for ${programId}`);
    }
  }

  async submitSurvey(
    programId: string,
    answers: Array<{ question_id: string; answer: string }>
  ): Promise<SubmitResult> {
    // Strategy 1: GraphQL mutation for survey response submission
    const mutationDocIds = [
      "4928371650294812", // ViewpointsSurveyResponseMutation (estimated)
    ];

    for (const docId of mutationDocIds) {
      try {
        const result = await this.graphqlRequest<{
          viewpoints_submit_survey_response: {
            success: boolean;
            points_earned: number;
            total_points: number;
            message: string;
          };
        }>(docId, {
          input: {
            program_id: programId,
            responses: answers.map((a) => ({
              question_id: a.question_id,
              response_value: a.answer,
            })),
          },
        });

        const r = result.viewpoints_submit_survey_response;
        return {
          success: r?.success ?? true,
          points_earned: r?.points_earned ?? 0,
          total_points: r?.total_points ?? 0,
          message: r?.message ?? "Submitted",
        };
      } catch {
        continue;
      }
    }

    // Strategy 2: REST-style POST
    const restEndpoints = [
      `/${programId}/responses`,
      `/${programId}/submit`,
    ];

    for (const endpoint of restEndpoints) {
      try {
        const result = await this.restRequest<{
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
        if (endpoint === restEndpoints[restEndpoints.length - 1]) {
          throw new Error(`Submit failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }
    }

    throw new Error("All submission endpoints failed");
  }

  async joinProgram(programId: string): Promise<boolean> {
    // Try GraphQL mutation first, then REST
    try {
      await this.graphqlRequest<unknown>("6192837450128347", {
        input: { program_id: programId },
      });
      return true;
    } catch {
      try {
        await this.restRequest(`/${programId}/join`, "POST");
        return true;
      } catch {
        return false;
      }
    }
  }

  async getPointsBalance(): Promise<number> {
    try {
      const result = await this.restRequest<{
        points_balance?: number;
        data?: { points_balance?: number };
      }>("/me/viewpoints_points");
      return result.points_balance ?? result.data?.points_balance ?? 0;
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
