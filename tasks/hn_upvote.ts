import { Page } from 'playwright';
import { Task } from '../src/task.js';
import { LoginHandler, CookieLoginHandler } from '../src/loginHandler.js';

export class HNUpvoteTask implements Task {
  name = 'HN Upvote';
  startUrl = 'https://news.ycombinator.com';
  maxSteps = 20;
  loginHandler: LoginHandler = new CookieLoginHandler();

  systemPrompt = `You are a browser automation agent.
Your task is to upvote a story on Hacker News.
Go to https://news.ycombinator.com, find the top story, and click its upvote arrow.
Make sure to complete the task.`;

  private votedStoryId: string | null = null;

  isAuthWall(url: string): boolean {
    return /\/login|\/signin|\/auth|\/vote\?id=/.test(url);
  }

  // Called by the runner after login succeeds. Extracts the story ID from the
  // intercepted vote URL for later verification — the LLM handles the actual re-click.
  async onAuthResolved(_page: Page, interceptedUrl: string): Promise<void> {
    const idMatch = interceptedUrl.match(/vote\?id=(\d+)/);
    if (idMatch) this.votedStoryId = idMatch[1];
  }

  // DOM-state verification: after voting, HN adds class="nosee" to the upvote <a>.
  // An active (unvoted) link has no nosee class. Count = 0 means the vote registered.
  async verify(page: Page): Promise<{ passed: boolean; message: string }> {
    const url = page.url();

    if (this.isAuthWall(url)) {
      return { passed: false, message: 'FAILED — Blocked by authentication wall. The claimed action was never completed.' };
    }

    const title = await page.title();
    if (/\b(404|403|error|not found|forbidden|unauthorized)\b/i.test(title)) {
      return { passed: false, message: 'FAILED — Agent ended on an error page.' };
    }

    if (this.votedStoryId) {
      await page.goto('https://news.ycombinator.com');
      await page.waitForLoadState('load');
      const activeVoteLinks = await page.locator(`a[href*="vote?id=${this.votedStoryId}&how=up"]:not(.nosee)`).count();
      if (activeVoteLinks > 0) {
        return { passed: false, message: `FAILED — Active upvote link still present for story ${this.votedStoryId}. Vote did not register.` };
      }
      return { passed: true, message: `PASSED — Upvote confirmed: vote link is nosee (voted) for story ${this.votedStoryId}.` };
    }

    return { passed: true, message: 'PASSED — No known failure patterns detected.' };
  }
}
