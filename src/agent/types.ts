/** 流式输出进度 */
export interface QueryProgress {
  text: string;
  done: boolean;
}

export interface AgentSession {
  readonly cwd: string;
  readonly lastActivity: number;

  setCwd(cwd: string): void;
  sendMessage(prompt: string): AsyncGenerator<QueryProgress>;
  stop(): Promise<boolean>;
  reset(): void;
}

