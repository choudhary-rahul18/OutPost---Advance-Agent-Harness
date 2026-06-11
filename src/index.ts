import 'dotenv/config';
import { runTask } from './runner.js';
import { HNUpvoteTask } from '../tasks/hn_upvote.js';

import { Provider } from './llmAdapter.js';

const provider = (process.env.LLM_PROVIDER ?? 'anthropic') as Provider;

const task = new HNUpvoteTask();

// ── Campaign prompt — change this to change what the agent does ──────────────
// task.systemPrompt = `You are a browser automation agent.
// Your task is to read and summarize the top story on Hacker News.
// 1. Go to https://news.ycombinator.com and find the top story
// 2. Click the 2nd story title to open the article, but if it's not related to Anthropic, just come back to home page, and move to the next title.
// 3. Read the page content
// 4. Call done() with a clear summary of what the article is about`;

// task.systemPrompt = `You are a browser automation agent.
// Your task is to read and summarize the top story on Hacker News.
// 1. Go to https://news.ycombinator.com.
// 2. Open the third post which is related to Anthropic.
// 3. Read it all and make a detailed summary of it.
// 5. save your summary to a markdown file with any title you think is suitable.
// 4. Call done() when all tasks are completed.`;

task.systemPrompt = `You are a browser automation agent.
Your task is to read and collect information about a person.
1. Go to https://www.linkedin.com/in/rahul18-iitb.
2. Go to his Chat Section.
3. Read the profile of first person, if he is a sponsore, skip him and move to Next Person.
2. Read everything about the person.
3. Call done() with a clear summary with key details of person.`;

task.systemPrompt = `You are a browser automation agent.
Your task is to read and collect information about a person.
1. Go to https://www.linkedin.com/in/rahul18-iitb.
3. Search for Harish, maybe Harish Chand who is also Connected with him.
4. Go to his profile.
5. Read everything about the person.
6. Call done() with a clear summary with key details of person.`;


// task.systemPrompt = `You are a browser automation agent.
// Your task is to read and collect information about a person.
// 1. Go to https://www.linkedin.com/in/rahul18-iitb.
// 2. Go to his profile.
// 3. Read everything about the person.
// 4. Create a detailed summary with key details of person.
// 5. save your summary to a markdown file with any title you think is suitable.
// 4. Call done() when all tasks are completed.`;


await runTask(task, provider);
