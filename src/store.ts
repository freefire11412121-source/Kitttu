import Database from "better-sqlite3";
import path from "node:path";

const DB_PATH = path.resolve(process.cwd(), "viewpoints.db");

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        id INTEGER PRIMARY KEY DEFAULT 1,
        fb_access_token TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS surveys (
        id TEXT PRIMARY KEY,
        title TEXT,
        points INTEGER DEFAULT 0,
        status TEXT DEFAULT 'available',
        questions_json TEXT,
        answers_json TEXT,
        completed_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS stats (
        id INTEGER PRIMARY KEY DEFAULT 1,
        total_surveys INTEGER DEFAULT 0,
        total_points INTEGER DEFAULT 0,
        last_check TEXT,
        last_complete TEXT
      );
    `);
    db.exec(`INSERT OR IGNORE INTO stats (id) VALUES (1)`);
  }
  return db;
}

export function saveToken(token: string): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO tokens (id, fb_access_token, updated_at) VALUES (1, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET fb_access_token = excluded.fb_access_token, updated_at = excluded.updated_at`
  ).run(token);
}

export function getToken(): string | null {
  const d = getDb();
  const row = d.prepare("SELECT fb_access_token FROM tokens WHERE id = 1").get() as
    | { fb_access_token: string }
    | undefined;
  return row?.fb_access_token ?? process.env.FB_ACCESS_TOKEN ?? null;
}

export function saveSurvey(
  id: string,
  title: string,
  points: number,
  questionsJson: string
): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO surveys (id, title, points, questions_json, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, points = excluded.points, questions_json = excluded.questions_json`
  ).run(id, title, points, questionsJson);
}

export function markSurveyCompleted(
  id: string,
  answersJson: string
): void {
  const d = getDb();
  d.prepare(
    `UPDATE surveys SET status = 'completed', answers_json = ?, completed_at = datetime('now') WHERE id = ?`
  ).run(answersJson, id);
}

export function getCompletedSurveyIds(): Set<string> {
  const d = getDb();
  const rows = d
    .prepare("SELECT id FROM surveys WHERE status = 'completed'")
    .all() as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

export function incrementStats(points: number): void {
  const d = getDb();
  d.prepare(
    `UPDATE stats SET total_surveys = total_surveys + 1, total_points = total_points + ?,
     last_complete = datetime('now') WHERE id = 1`
  ).run(points);
}

export function updateLastCheck(): void {
  const d = getDb();
  d.prepare("UPDATE stats SET last_check = datetime('now') WHERE id = 1").run();
}

export interface Stats {
  total_surveys: number;
  total_points: number;
  last_check: string | null;
  last_complete: string | null;
}

export function getStats(): Stats {
  const d = getDb();
  return d.prepare("SELECT * FROM stats WHERE id = 1").get() as Stats;
}

export function getRecentSurveys(limit = 10): Array<{
  id: string;
  title: string;
  points: number;
  status: string;
  completed_at: string | null;
}> {
  const d = getDb();
  return d
    .prepare("SELECT id, title, points, status, completed_at FROM surveys ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Array<{
    id: string;
    title: string;
    points: number;
    status: string;
    completed_at: string | null;
  }>;
}
