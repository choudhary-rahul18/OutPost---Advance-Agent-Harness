import { Page } from 'playwright';
import { LoginHandler } from './loginHandler.js';

export interface Task {
  name: string;
  startUrl: string;
  systemPrompt: string;
  maxSteps: number;
  loginHandler: LoginHandler | null;
  isAuthWall(url: string): boolean;
  onAuthResolved(page: Page, interceptedUrl: string): Promise<void>;
  verify(page: Page): Promise<{ passed: boolean; message: string }>;
}
