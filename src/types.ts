export type Role = 'student' | 'admin';

/** Every quiz/exam is scored out of at most 10 points. */
export const MAX_TEST_POINTS = 10;

export interface UserAccount {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** scrypt hash — never sent to the client */
  passwordHash?: string;
  /** @deprecated legacy plaintext field, migrated to passwordHash on load */
  temporaryPassword?: string;
  isTemporaryPassword: boolean;
  createdAt?: string;
  lastLoginAt?: string;
  department?: string;
}

export interface AuthSession {
  user: UserAccount;
  token: string;
  mustChangePassword?: boolean;
}

export interface Student {
  id: string;
  name: string;
  email: string;
  avatar: string;
  enrolledAt: string;
  digestSubscribed: boolean;
  department: string;
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  subject: string;
  tags: string[];
  content: string;
  summary: string;
  createdAt: string;
  updatedAt?: string;
  lastUpdatedBy: string;
}

export type QuestionType = 'mcq' | 'short_answer' | 'essay_code';

export interface Question {
  id: string;
  type: QuestionType;
  prompt: string;
  options?: string[];
  correctAnswer?: string | number; // For MCQ: option index or value; For short answer: ideal answer
  rubric?: string; // Guidelines for grading
  gradingCriteria?: string;
  points: number;
  codeSnippet?: string;
  subjectContext?: string;
}

export interface Test {
  id: string;
  title: string;
  description: string;
  subject: string;
  instructions: string;
  durationMinutes: number;
  passingScore: number;
  totalPoints: number;
  startTime: string; // ISO String
  endTime: string; // ISO String
  status: 'upcoming' | 'active' | 'closed' | 'draft';
  questions: Question[];
  createdAt: string;
  createdBy: string;
}

export interface QuestionGrading {
  questionId: string;
  earnedPoints: number;
  maxPoints: number;
  feedback: string;
  isCorrect?: boolean;
  /** 'mcq_rule' and 'gemini_ai' only appear in data imported from the old server */
  autoGradedBy?: 'proctor_manual' | 'mcq_rule' | 'gemini_ai';
  /** true when AI grading failed or looked suspicious — lecturer must review */
  needsReview?: boolean;
}

export interface ProctorSummary {
  infractionsCount: number;
  awayTimeSeconds: number;
  tabHiddenCount: number;
  windowBlurCount: number;
  copyPasteAttempts: number;
  flagsRaised: string[];
  integrityStatus: 'clean' | 'minor_warnings' | 'flagged_suspicious';
  pausesUsed?: number;
  pauseCreditsRemaining?: number;
}

export interface TestSubmission {
  id: string;
  testId: string;
  testTitle: string;
  studentEmail: string;
  studentName: string;
  startedAt: string;
  submittedAt: string;
  answers: Record<string, string | number>;
  grading?: Record<string, QuestionGrading>;
  questionGradings?: Record<string, QuestionGrading>;
  totalScore: number;
  maxScore: number;
  percentage: number;
  passed: boolean;
  status: 'pending_review' | 'graded';
  gradedBy?: string;
  proctorSummary: ProctorSummary;
}

export type ProctorEventType =
  | 'tab_hidden'
  | 'tab_visible'
  | 'window_blur'
  | 'window_focus'
  | 'copy_attempt'
  | 'paste_attempt'
  | 'context_menu'
  | 'fullscreen_exit'
  | 'proctor_warning'
  | 'timer_expired'
  | 'exam_paused'
  | 'exam_resumed';

export interface ProctorEvent {
  id: string;
  timestamp: string;
  studentEmail: string;
  studentName: string;
  testId: string;
  testTitle: string;
  eventType: ProctorEventType;
  details: string;
  durationSeconds?: number;
  severity: 'low' | 'medium' | 'high';
}

export interface ActiveExamSession {
  studentEmail: string;
  studentName: string;
  testId: string;
  testTitle: string;
  joinedAt: string;
  lastHeartbeat: string;
  currentStatus: 'in_tab' | 'away_tab' | 'away_window' | 'warning_state' | 'submitted' | 'paused';
  infractionsCount: number;
  totalAwaySeconds: number;
  awayStartTime?: number | null;
  lastEvent?: ProctorEvent;
  pauseCreditsRemaining: number;
  totalPausesUsed: number;
  pausedAt?: string | null;
  pauseReason?: string | null;
}

export interface DailyDigest {
  id: string;
  date: string;
  subjectFocus: string;
  headline: string;
  summary: string;
  keyArticles: {
    title: string;
    source: string;
    summary: string;
    pedagogicalTakeaway: string;
    url?: string;
  }[];
  challengeQuestion: {
    question: string;
    options: string[];
    explanation: string;
  };
  generatedAt: string;
  sentToCount: number;
  recipients: string[];
  emailHtml: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  subject?: string;
  citations?: {
    docId: string;
    title: string;
    snippet: string;
  }[];
}

/** Server-side record of an exam attempt. The server — not the browser — owns the clock. */
export interface ExamAttempt {
  id: string;
  testId: string;
  studentEmail: string;
  startedAt: string;
  /** total milliseconds spent in approved pauses (extends the deadline) */
  pausedMs: number;
  pausedAt: string | null;
  pausesUsed: number;
  submittedAt: string | null;
}
